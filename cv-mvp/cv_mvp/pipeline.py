"""A single ordered detector owner; camera and native hand inference have bounded work."""

from dataclasses import asdict
import json
from pathlib import Path
from threading import Event, Lock
import time
import uuid
from .adapter import CvAdapter, EVENT_TYPES
from .core.config import Config
from .synthetic import frame as synthetic_frame


class Pipeline:
    def __init__(
        self,
        config=None,
        *,
        camera=0,
        video=None,
        replay=None,
        synthetic=False,
        models=None,
        variant="lite",
        width=640,
        height=480,
        fps=30,
        seconds=0,
        realtime=True,
        input_mirrored=False
    ):
        self.config = config or Config()
        self.adapter = CvAdapter(self.config, session_id=uuid.uuid4().hex[:12])
        self.camera, self.video, self.replay, self.synthetic = (
            camera,
            video,
            replay,
            synthetic,
        )
        self.models, self.variant = models, variant
        self.width, self.height, self.fps = width, height, fps
        self.seconds, self.realtime, self.input_mirrored = (
            seconds,
            realtime,
            input_mirrored,
        )
        self.stop = Event()
        self.reset_requested = Event()
        self.reset_lock = Lock()
        self.origin = time.perf_counter()
        self.status = "idle"
        self.error = None
        self.capture = None
        self.info = {}
        self.processed = 0

    def now_ms(self):
        return (time.perf_counter() - self.origin) * 1000

    def request_reset(self):
        # Publish the target before the worker can apply the reset.
        with self.reset_lock:
            target = self.adapter.reset_generation + 1
            self.reset_requested.set()
            return target

    def apply_requested_reset(self):
        with self.reset_lock:
            if self.reset_requested.is_set():
                self.adapter.reset()
                self.reset_requested.clear()

    def hello(self):
        return dict(
            contractVersion=1,
            kind="cv_hello",
            sessionId=self.adapter.session_id,
            observationSchemaVersion=1,
            motionSchemaVersion=1,
            clock="producer_monotonic_ms",
            capabilities=dict(
                events=list(EVENT_TYPES),
                markers=["head", "left", "right"],
                metricDepth=False,
                hitDetection=False,
                punchCalibrationRequired=False,
                dodgeCalibrationRequired=True,
            ),
            detector=dict(name="recent_hand_motion", config=asdict(self.config)),
            source=(
                "synthetic"
                if self.synthetic
                else "replay" if self.video or self.replay else "live"
            ),
        )

    def run(self, publish):
        inference = replay_file = None
        self.status = "running"
        first = None
        pace_start = None
        index = 0
        capture_started = None
        try:
            if self.replay:
                replay_file = Path(self.replay).open()
            elif not self.synthetic:
                from .core.capture import Capture
                from .core.inference import Inference

                inference = Inference(
                    self.models, self.variant, True, schedule="parallel"
                )
                self.capture = Capture(
                    str(self.video) if self.video else self.camera,
                    self.origin,
                    self.width,
                    self.height,
                    self.fps,
                    self.input_mirrored,
                ).start()
                self.info = self.capture.info
                capture_started = time.perf_counter()
            while not self.stop.is_set():
                trace = dict(
                    clock="producer_monotonic_ms",
                    inputKind=(
                        "synthetic"
                        if self.synthetic
                        else (
                            "landmark_replay"
                            if self.replay
                            else "video" if self.video else "camera"
                        )
                    ),
                )
                if replay_file:
                    line = replay_file.readline()
                    if not line:
                        break
                    record = json.loads(line)
                    if record.get("kind") in ("reset_history", "reset_calibration"):
                        self.adapter.reset()
                        continue
                    if record.get("kind") != "frame":
                        continue
                elif self.synthetic:
                    record = synthetic_frame(round(index * 1000 / self.fps))
                    index += 1
                else:
                    item = self.capture.take()
                    if item is None:
                        if first is None and time.perf_counter() - capture_started > 15:
                            raise TimeoutError("No camera result after 15 seconds")
                        if self.capture.finished:
                            if self.capture.error:
                                raise RuntimeError(self.capture.error)
                            break
                        continue
                    capture_index, stamp, pixels, read_time = item
                    trace.update(
                        captureIndex=capture_index,
                        captureReadMs=(read_time - self.origin) * 1000,
                        inferenceStartMs=self.now_ms(),
                    )
                    record = inference.process(pixels, stamp)
                    trace.update(
                        inferenceEndMs=self.now_ms(),
                        inferenceTimingsMs=record["timings_ms"],
                    )
                t = record["timestamp_ms"]
                if first is None:
                    first = t
                    pace_start = time.perf_counter()
                if self.seconds and t - first > self.seconds * 1000:
                    break
                source = (
                    "synthetic"
                    if self.synthetic or record.get("synthetic")
                    else "replay" if self.replay or self.video else "live"
                )
                if self.realtime and source != "live":
                    remaining = (t - first) / 1000 - (time.perf_counter() - pace_start)
                    if remaining > 0 and self.stop.wait(remaining):
                        break
                self.apply_requested_reset()
                available = self.now_ms() if source == "live" else t
                packet = self.adapter.process(record, available, source, trace)
                trace.update(
                    detectionEndMs=self.now_ms(), liveLatencyMeasurable=source == "live"
                )
                if source == "live":
                    packet["observation"]["availableMs"] = trace["detectionEndMs"]
                    for event in packet["events"]:
                        event["detectedMs"] = max(
                            event["sampleMs"], trace["detectionEndMs"]
                        )
                    trace["readToResultMs"] = (
                        trace["detectionEndMs"] - trace["captureReadMs"]
                    )
                self.processed += 1
                publish(packet)
            self.status = "complete" if not self.stop.is_set() else "stopped"
        except Exception as exc:
            self.error = str(exc)
            self.status = "error"
            raise
        finally:
            if self.capture:
                self.capture.close()
            if inference:
                inference.close()
            if replay_file:
                replay_file.close()

    def summary(self):
        return dict(
            kind="cv_status",
            contractVersion=1,
            status=self.status,
            error=self.error,
            frames=self.processed,
            sessionId=self.adapter.session_id,
            capture=self.info,
            captureReads=self.capture.reads if self.capture else None,
            overwrittenPendingFrames=self.capture.overwritten if self.capture else None,
        )
