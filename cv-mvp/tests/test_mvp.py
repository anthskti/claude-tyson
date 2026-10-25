import asyncio
from copy import deepcopy
import json
from pathlib import Path
import time
import pytest
from cv_mvp.adapter import CvAdapter
from cv_mvp.pipeline import Pipeline
from cv_mvp.synthetic import frame
from cv_mvp.transport import Mailbox


def samples():
    a = CvAdapter(session_id="test")
    return [a.process(frame(t), t + 25, "live") for t in range(0, 5000, 33)]


def test_contract_shape_and_wrist_semantics():
    packets = samples()
    sample = packets[30]
    o = sample["observation"]
    assert (
        o["schemaVersion"] == 1
        and o["kind"] == "observation"
        and o["sessionId"] == "test"
    )
    assert o["trackingState"] == "good" and all(o["validity"].values())
    assert o["qualityScore"] is None and o["confidence"] is None
    assert set(o["markers"]["head"]) == {"x", "y"}
    assert o["markers"]["left"] == {
        k: frame(990)["hands"][0]["landmarks"][0][k] for k in ("x", "y")
    }
    assert o["markers"]["left"] != frame(990)["pose"][15]
    envelope = CvAdapter.envelope(sample, "fight-1", "round-1")
    assert envelope["fightId"] == "fight-1" and envelope["roundId"] == "round-1"
    assert envelope["batch"]["firstSeq"] == envelope["seq"]
    json.dumps(envelope, allow_nan=False)


def test_current_detector_outputs_survive_adapter():
    from cv_mvp.core.detector import Detector

    native = Detector(session_id="native")
    adapter = CvAdapter(session_id="adapter")
    expected = []
    actual = []
    for t in range(0, 5000, 33):
        record = frame(t)
        _, events = native.process(record, t + 25)
        expected += [(e["type"], e["sampleMs"]) for e in events]
        packet = adapter.process(record, t + 25)
        actual += [(e["type"], e["sampleMs"]) for e in packet["events"]]
    assert actual == expected
    assert {e[0] for e in actual} == {
        "punch_left",
        "punch_right",
        "dodge_left",
        "return_neutral",
    }


def test_loss_omits_markers_and_pose_loss_does_not_block_hands():
    a = CvAdapter()
    r = frame(0)
    r["pose"] = []
    o = a.process(r)["observation"]
    assert o["trackingState"] == "degraded" and not o["validity"]["dodge"]
    assert "head" not in o["markers"] and "left" in o["markers"]
    r = frame(33)
    r["pose"] = []
    r["hands"] = []
    o = a.process(r)["observation"]
    assert o["trackingState"] == "lost" and o["markers"] == {}


def test_invalid_fight_context_rejected():
    for value in (None, "", 42, "x" * 129):
        with pytest.raises(ValueError):
            CvAdapter.envelope(dict(seq=1), value, "round")


def test_pose_coalescing_keeps_all_intervening_events_and_times():
    packets = samples()
    mail = Mailbox()
    expected = []
    for packet in packets:
        mail.offer(packet)
        expected.extend(packet["events"])
    sample, first = mail.pop()
    assert sample["seq"] == len(packets) and first == 1
    assert sample["events"] == expected and len(expected) == 4
    assert mail.pop() is None
    message = CvAdapter.envelope(sample, "f", "r", first)
    assert message["batch"]["coalescedObservations"] == len(packets) - 1


def test_overflow_signals_uncertain_coverage_instead_of_losing_events():
    packet = next(p for p in samples() if p["events"])
    mail = Mailbox(limit=1)
    mail.offer(packet)
    mail.offer(packet)
    with pytest.raises(BufferError, match="coverage uncertain"):
        mail.pop()


def test_reset_tags_new_generation_without_reusing_old_events():
    a = CvAdapter()
    old = []
    for t in range(0, 1800, 33):
        old += a.process(frame(t))["events"]
    assert old and all(e["resetGeneration"] == 0 for e in old)
    a.reset()
    new = a.process(frame(1815))
    assert new["producer"]["resetGeneration"] == 1 and new["events"] == []
    assert new["seq"] > 1


def test_reset_target_matches_the_generation_applied_by_worker():
    p = Pipeline(synthetic=True)
    assert p.request_reset() == 1
    assert (
        p.request_reset() == 1
    )  # Requests coalesce until the worker reaches a frame boundary.
    p.apply_requested_reset()
    assert p.adapter.reset_generation == 1 and not p.reset_requested.is_set()
    assert p.request_reset() == 2
    p.apply_requested_reset()
    assert p.adapter.reset_generation == 2


def test_optional_wrist_marker_is_omitted_when_outside_image():
    r = frame(0)
    r["hands"][0]["landmarks"][0]["x"] = -0.05
    sample = CvAdapter().process(r)
    assert "left" not in sample["observation"]["markers"]


def test_pipeline_synthetic_and_replay_have_no_native_dependency(tmp_path):
    path = tmp_path / "landmarks.jsonl"
    path.write_text("".join(json.dumps(frame(t)) + "\n" for t in range(0, 5000, 33)))
    p = Pipeline(replay=path, realtime=False)
    packets = []
    p.run(packets.append)
    assert p.status == "complete" and len(packets) > 100
    assert all(
        x["source"] == "synthetic" for x in packets
    )  # fixture provenance is retained
    assert all(not x["trace"]["liveLatencyMeasurable"] for x in packets)
    assert all("readToResultMs" not in x["trace"] for x in packets)


def test_websocket_handshake_clock_context_events_and_clean_shutdown():
    from websockets.asyncio.client import connect
    from websockets.asyncio.server import serve
    from cv_mvp.server import Bridge

    async def exercise():
        pipeline = Pipeline(synthetic=True, seconds=1.8, fps=30)
        bridge = Bridge(pipeline)
        async with serve(bridge.handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            async with connect(f"ws://127.0.0.1:{port}") as ws:
                hello = json.loads(await ws.recv())
                assert hello["kind"] == "cv_hello"
                assert pipeline.status == "idle"
                await ws.send(
                    json.dumps(
                        dict(
                            contractVersion=1,
                            kind="clock_sync",
                            requestId="1",
                            clientSendMs=123,
                        )
                    )
                )
                clock = json.loads(await ws.recv())
                assert clock["clientSendMs"] == 123
                assert clock["serverSendMs"] >= clock["serverReceiveMs"]
                await ws.send(
                    json.dumps(
                        dict(
                            contractVersion=1,
                            kind="set_context",
                            requestId="2",
                            fightId="f",
                            roundId="r",
                        )
                    )
                )
                ack = json.loads(await ws.recv())
                assert ack["operation"] == "set_context"
                events = []
                last = 0
                async for text in ws:
                    packet = json.loads(text)
                    if packet["kind"] == "cv_status":
                        assert packet["status"] == "complete"
                        break
                    assert packet["fightId"] == "f" and packet["roundId"] == "r"
                    assert packet["seq"] > last
                    last = packet["seq"]
                    events += packet["events"]
                assert [e["type"] for e in events] == ["punch_left"]
        await bridge.close()

    asyncio.run(exercise())
