"""The only translation between the frozen harness and the MVP wire contract."""

from copy import deepcopy
import math
from .core.config import Config
from .core.detector import Detector

CONTRACT_VERSION = 1
EVENT_TYPES = (
    "punch_left",
    "punch_right",
    "dodge_left",
    "dodge_right",
    "return_neutral",
)


class CvAdapter:
    def __init__(self, config=None, session_id=None):
        self.detector = Detector(config or Config(), session_id=session_id)
        self.session_id = self.detector.session_id
        self.seq = 0
        self.reset_generation = 0

    def reset(self):
        self.detector.reset_calibration()
        self.reset_generation += 1

    def process(self, record, available_ms=None, source="live", trace=None):
        """No networking. Returns an unstamped sample for a sink or WebSocket mailbox."""
        native, native_events = self.detector.process(record, available_ms)
        t = record["timestamp_ms"]
        valid = {
            key: bool(native["validity"].get(key, False))
            for key in ("dodge", "punch_left", "punch_right")
        }
        if all(valid.values()):
            state = "good"
        elif any(valid.values()):
            state = "degraded"
        elif native["dodgeReadiness"]["state"] == "warming":
            state = "calibrating"
        else:
            state = "lost"
        # Contract markers are wrists, while the harness's hand marker is a palm center.
        markers = {}
        if valid["dodge"] and "head" in native["markers"]:
            head = native["markers"]["head"]
            if all(math.isfinite(head[k]) and 0 <= head[k] <= 1 for k in ("x", "y")):
                markers["head"] = {k: head[k] for k in ("x", "y")}
        for side in ("left", "right"):
            if not valid["punch_" + side]:
                continue
            hs = [
                h
                for h in record.get("hands", [])
                if str(h.get("model_handedness", "")).lower() == side
            ]
            if len(hs) == 1:
                wrist = hs[0]["landmarks"][0]
                if all(
                    math.isfinite(wrist[k]) and 0 <= wrist[k] <= 1 for k in ("x", "y")
                ):
                    markers[side] = {k: wrist[k] for k in ("x", "y")}
        observation = dict(
            schemaVersion=1,
            kind="observation",
            sessionId=self.session_id,
            timestampMs=t,
            availableMs=t if available_ms is None else max(t, available_ms),
            trackingState=state,
            validity=valid,
            calibrationId=native["calibrationId"],
            markers=markers,
            features=native["features"],
            qualityScore=None,
            qualityKind="not_estimated",
            confidence=None,
            reason=None if state == "good" else native["dodgeReadiness"].get("reason"),
            phases=native["phases"],
            punchReadiness=native["punchReadiness"],
            dodgeReadiness=native["dodgeReadiness"],
        )
        events = []
        for e in native_events:
            if e["type"] not in EVENT_TYPES:
                raise ValueError("Unsupported detector event")
            events.append(
                {
                    **e,
                    "schemaVersion": 1,
                    "trackingState": state,
                    "confidence": None,
                    "resetGeneration": self.reset_generation,
                }
            )
        self.seq += 1
        return dict(
            seq=self.seq,
            source=source,
            observation=observation,
            events=events,
            trace=trace or {},
            producer=dict(
                detector="recent_hand_motion",
                nativeSchemaVersion=2,
                resetGeneration=self.reset_generation,
                coordinateSpace="canonical_unmirrored_image",
            ),
        )

    @staticmethod
    def envelope(sample, fight_id, round_id, first_seq=None):
        for name, value in [("fightId", fight_id), ("roundId", round_id)]:
            if not isinstance(value, str) or not value.strip() or len(value) > 128:
                raise ValueError(
                    name + " must be a nonempty string of at most 128 characters"
                )
        sample = deepcopy(sample)
        return dict(
            contractVersion=CONTRACT_VERSION,
            kind="cv_sample",
            fightId=fight_id,
            roundId=round_id,
            **sample,
            batch=dict(
                firstSeq=sample["seq"] if first_seq is None else first_seq,
                lastSeq=sample["seq"],
                coalescedObservations=sample["seq"]
                - (sample["seq"] if first_seq is None else first_seq),
            )
        )
