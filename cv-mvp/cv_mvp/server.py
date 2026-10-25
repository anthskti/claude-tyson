"""Loopback WebSocket transport. Networking never runs inside detector callbacks."""

import asyncio
import json
import math
import re
import sys
from threading import Lock, Thread
from .adapter import CvAdapter
from .transport import Mailbox


def encode(value):
    return json.dumps(value, allow_nan=False, separators=(",", ":"))


class Bridge:
    def __init__(self, pipeline, *, event_limit=128, freshness_ms=250, sample_log=None):
        self.pipeline = pipeline
        self.event_limit = event_limit
        self.freshness_ms = freshness_ms
        self.sample_log = sample_log
        self.loop = None
        self.wake = None
        self.thread = None
        self.lock = Lock()
        self.mailbox = None
        self.active = False
        self.done = False

    def notify(self):
        if self.loop and not self.loop.is_closed():
            self.loop.call_soon_threadsafe(self.wake.set)

    def publish(self, sample):
        sample["trace"]["enqueuedMs"] = self.pipeline.now_ms()
        if self.sample_log:
            # Local debug log has no invented fight/round context or transport timing.
            self.sample_log.write(encode(dict(kind="producer_sample", **sample)) + "\n")
        with self.lock:
            box = self.mailbox
        if box and box.offer(sample):
            self.notify()

    def start(self):
        if self.thread:
            return

        def work():
            try:
                self.pipeline.run(self.publish)
            except Exception as exc:
                print("CV producer failed: " + str(exc), file=sys.stderr, flush=True)
            finally:
                self.done = True
                self.notify()

        self.thread = Thread(target=work, name="cv-producer", daemon=True)
        self.thread.start()

    async def close(self):
        self.pipeline.stop.set()
        if self.thread:
            await asyncio.to_thread(self.thread.join, 5)
            if self.thread.is_alive():
                raise RuntimeError("Native inference did not stop within five seconds")
        if self.sample_log:
            self.sample_log.flush()

    async def handler(self, ws):
        if self.active:
            await ws.close(1013, "One game client at a time")
            return
        self.active = True
        self.loop = asyncio.get_running_loop()
        self.wake = asyncio.Event()
        context = None
        send_lock = asyncio.Lock()

        async def send(value):
            await asyncio.wait_for(ws.send(encode(value)), self.freshness_ms / 1000)

        try:
            await send(self.pipeline.hello())
        except Exception:
            self.active = False
            return

        async def sender():
            while True:
                await self.wake.wait()
                self.wake.clear()
                async with send_lock:
                    with self.lock:
                        box = self.mailbox
                    if context is None or box is None:
                        continue
                    try:
                        item = box.pop()
                    except BufferError as exc:
                        await send(
                            dict(
                                contractVersion=1,
                                kind="cv_status",
                                status="coverage_uncertain",
                                reason=str(exc),
                            )
                        )
                        await ws.close(1013, "CV event buffer overflow")
                        return
                    if item:
                        sample, first = item
                        # A stale sample/event is a transport failure, never a delayed hit.
                        if sample["source"] == "live" and (
                            self.pipeline.now_ms()
                            - sample["observation"]["timestampMs"]
                            > self.freshness_ms
                            or any(
                                self.pipeline.now_ms() - e["sampleMs"]
                                > self.freshness_ms
                                for e in sample["events"]
                            )
                        ):
                            await send(
                                dict(
                                    contractVersion=1,
                                    kind="cv_status",
                                    status="coverage_uncertain",
                                    reason="Producer data is stale",
                                )
                            )
                            await ws.close(1013, "Stale CV data")
                            return
                        sample["trace"]["sentMs"] = self.pipeline.now_ms()
                        await send(
                            CvAdapter.envelope(sample, *context, first_seq=first)
                        )
                    if self.done:
                        await send(self.pipeline.summary())
                        await ws.close(
                            1000 if not self.pipeline.error else 1011,
                            "Producer finished",
                        )
                        return

        task = asyncio.create_task(sender())

        async def sender_failure(future):
            try:
                future.result()
            except asyncio.CancelledError:
                return
            except Exception:
                await ws.close(1013, "CV send failed or timed out")

        task.add_done_callback(lambda f: asyncio.create_task(sender_failure(f)))
        try:
            async for raw in ws:
                received = self.pipeline.now_ms()
                msg = None
                try:
                    msg = json.loads(raw)
                    if not isinstance(msg, dict) or msg.get("contractVersion") != 1:
                        raise ValueError("Require contractVersion 1")
                    kind = msg.get("kind")
                    request = msg.get("requestId")
                    if not isinstance(request, str) or not 1 <= len(request) <= 64:
                        raise ValueError("Require requestId string (1..64 chars)")
                    if kind == "clock_sync":
                        stamp = msg.get("clientSendMs")
                        if (
                            isinstance(stamp, bool)
                            or not isinstance(stamp, (int, float))
                            or not math.isfinite(stamp)
                        ):
                            raise ValueError("Require finite clientSendMs")
                        await send(
                            dict(
                                contractVersion=1,
                                kind="clock_sync",
                                requestId=request,
                                clientSendMs=msg.get("clientSendMs"),
                                serverReceiveMs=received,
                                serverSendMs=self.pipeline.now_ms(),
                            )
                        )
                    elif kind == "set_context":
                        # Validate before discarding the old context or publishing any data.
                        proposed = (msg.get("fightId"), msg.get("roundId"))
                        CvAdapter.envelope(dict(seq=0), *proposed)
                        async with send_lock:
                            context = proposed
                            with self.lock:
                                self.mailbox = Mailbox(self.event_limit)
                            await send(
                                dict(
                                    contractVersion=1,
                                    kind="cv_ack",
                                    operation=kind,
                                    requestId=request,
                                    fightId=context[0],
                                    roundId=context[1],
                                    sessionId=self.pipeline.adapter.session_id,
                                )
                            )
                            self.start()
                            if self.done:
                                self.wake.set()
                    elif kind == "reset_calibration":
                        if context is None:
                            raise ValueError("Set fight/round context first")
                        target = self.pipeline.request_reset()
                        await send(
                            dict(
                                contractVersion=1,
                                kind="cv_ack",
                                operation=kind,
                                requestId=request,
                                status="queued",
                                targetResetGeneration=target,
                            )
                        )
                    else:
                        raise ValueError("Unsupported control command")
                except (ValueError, TypeError, KeyError) as exc:
                    await send(
                        dict(
                            contractVersion=1,
                            kind="cv_error",
                            requestId=(
                                msg.get("requestId")
                                if isinstance(locals().get("msg"), dict)
                                else None
                            ),
                            reason=str(exc),
                        )
                    )
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            with self.lock:
                self.mailbox = None
            self.active = False


async def serve(
    pipeline,
    host="127.0.0.1",
    port=8765,
    *,
    event_limit=128,
    freshness_ms=250,
    origins=(),
    sample_log=None,
):
    from websockets.asyncio.server import serve as websocket_serve

    bridge = Bridge(
        pipeline,
        event_limit=event_limit,
        freshness_ms=freshness_ms,
        sample_log=sample_log,
    )
    allowed = [
        None,
        re.compile(r"^http://(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$"),
        *origins,
    ]
    try:
        async with websocket_serve(
            bridge.handler,
            host,
            port,
            origins=allowed,
            max_size=4096,
            max_queue=8,
            write_limit=16384,
            ping_interval=10,
            ping_timeout=10,
            close_timeout=1,
        ):
            print(
                f"CV bridge: ws://{host}:{port} (awaiting frontend context)",
                file=sys.stderr,
                flush=True,
            )
            await asyncio.Future()
    finally:
        await bridge.close()
