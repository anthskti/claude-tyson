"""v1.1 punch types layered on the frozen core detector. core/ stays unedited.

Two types: straight (either hand) and hook (either hand). A hook needs:
  1. a raised elbow: upper arm (shoulder -> elbow) at least hook_elbow_angle from
     hanging straight down (0 = down, 90 = level with the shoulder), and long
     enough on screen that it is out to the side, not pointing at the camera;
  2. the wrist moving from the shoulder line or wider back toward the midline.
Straights keep the elbow down or the wrist in front, so they are labeled the
moment the core detector fires. The core often fires during a hook's windup,
before the inward sweep, so a raised elbow or wide wrist waits up to defer_ms.
The wrist is followed with the pose model when a fast fist blurs out of the hand
model. Without a visible elbow the wrist path decides alone. A fitted model from
scripts/fit_punch_types.py replaces the rule. Hooks too flat for the core growth
rule fire through a lateral trigger that shares the core hand cooldown.
"""

from collections import deque
from dataclasses import asdict, dataclass, field
import json
import math
from pathlib import Path
from .core.features import SIDES, hand_features, point_ok

PUNCH_TYPES = ("straight", "hook")
SHOULDER = {"left": 11, "right": 12}
ELBOW = {"left": 13, "right": 14}
POSE_WRIST = {"left": 15, "right": 16}
# Canonical unmirrored image: the player's left hand sits at larger x, so moving
# toward the midline decreases x for the left hand and increases it for the right.
INWARD = {"left": -1, "right": 1}
# Every measured feature, in the order the fit script and model use them.
FEATURES = ("inwardBodyWidths", "logPalmGrowth", "inwardSpeed", "lateralPathRatio",
            "wristOutward", "wristHeight", "elbowHeight", "elbowAngleDeg", "upperArmLength",
            "forearmLength", "forearmDx", "forearmAngleDeg", "elbowOutward",
            "knuckleRatio", "knuckleDepth")
TEXT_FIELDS = ("hook_trigger", "model")


@dataclass
class PunchTypeConfig:
    window_ms: int = 200                 # lookback for classifying a fired punch
    defer_ms: int = 150                  # max wait for a hook's sweep after a raised
                                         # elbow / wide wrist; straights never wait
    # Hook rule
    hook_elbow_angle: float = 55         # degrees from hanging down; 90 = shoulder level
    min_upper_arm: float = 0.30          # shoulder widths on screen; shorter = pointing at camera
    hook_wrist_outside: float = -0.10    # wrist near (or past) the shoulder line = wide
    hook_sweep: float = 0.10             # inward wrist travel (shoulder widths) from its widest point
    # Path fallback when the wrist/shoulders are not measured
    hook_min_inward: float = 0.40
    hook_growth_ratio: float = 1.2       # inward must beat log palm growth by this
    min_elbow_visibility: float = 0.5
    hook_trigger: bool = True            # fire flat hooks the core growth rule misses
    trigger_window_ms: int = 120
    trigger_speed: float = 1.6           # shoulder widths / second toward the midline
    max_gap_ms: int = 250
    # Optional logistic model written by scripts/fit_punch_types.py
    model: dict = field(default=None)

    def validate(self):
        for key, value in asdict(self).items():
            if key in TEXT_FIELDS or key == "hook_wrist_outside":  # may be negative
                continue
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
                raise ValueError(f"{key} must be a finite positive number")
        if not isinstance(self.hook_trigger, bool):
            raise ValueError("hook_trigger must be true or false")
        if self.model is not None:
            m = self.model
            names = m.get("features") if isinstance(m, dict) else None
            if (not isinstance(names, list) or not names or any(n not in FEATURES for n in names)
                    or any(len(m.get(k, [])) != len(names) for k in ("mean", "std", "weights"))
                    or not isinstance(m.get("bias"), (int, float))):
                raise ValueError("model needs features, mean, std, weights of equal length and a bias")
        return self

    @classmethod
    def load(cls, path=None):
        return cls(**(json.loads(Path(path).read_text()) if path else {})).validate()


def slope(points):
    """Least-squares d(value)/d(seconds) over (t_ms, value) pairs."""
    times = [(t - points[0][0]) / 1000 for t, _ in points]
    mean_t = sum(times) / len(times)
    mean_v = sum(v for _, v in points) / len(points)
    variance = sum((t - mean_t) ** 2 for t in times)
    return sum((t - mean_t) * (v - mean_v) for t, (_, v) in zip(times, points)) / variance if variance else 0.0


class PunchTyper:
    def __init__(self, config=None, detector_config=None):
        self.cfg = (config or PunchTypeConfig()).validate()
        self.detector_cfg = detector_config
        self.reset()

    def reset(self):
        # Pending punches belong to the old reset generation, so they are dropped.
        self.history = {s: deque() for s in SIDES}
        self.pending = []
        # Trigger lock per hand: set by any punch on that hand, cleared once the
        # inward sweep slows, so one sweep never fires twice whatever the cooldown.
        self.sweep_lock = {s: False for s in SIDES}
        self.scale = None
        self.last_t = None

    def _arm(self, record, side, aspect, pose, shoulders_ok):
        """Per-frame forearm and fist-orientation measurements, None when not visible."""
        out = dict(forearmLength=None, forearmDx=None, forearmAngleDeg=None, elbowOutward=None,
                   elbowRaised=None, knuckleRatio=None, knuckleDepth=None, forearmMissing=None,
                   wristOutward=None, wristHeight=None, elbowHeight=None, elbowAngleDeg=None,
                   upperArmLength=None, wristX=None)
        hs = [h for h in record.get("hands", []) if str(h.get("model_handedness", "")).lower() == side]
        pts = hs[0].get("landmarks", []) if len(hs) == 1 else []
        wrist = pts[0] if len(pts) >= 18 and point_ok(pts[0]) else None
        if wrist is None and len(pose) == 33 and point_ok(pose[POSE_WRIST[side]], self.cfg.min_elbow_visibility):
            wrist = pose[POSE_WRIST[side]]  # fast fists blur out of the hand model
        if wrist is not None:
            out["wristX"] = wrist["x"]
        if len(pts) >= 18 and all(point_ok(pts[i]) for i in (0, 5, 9, 17)):
            dist = lambda a, b: math.hypot(a["x"] - b["x"], aspect * (a["y"] - b["y"]))
            length = dist(pts[0], pts[9])
            if length > 1e-5:
                # Knuckles face the camera in a straight (wide 5-17 span); a hook turns the fist side-on.
                out["knuckleRatio"] = dist(pts[5], pts[17]) / length
                out["knuckleDepth"] = abs(pts[5].get("z", 0) - pts[17].get("z", 0)) / length
        if not shoulders_ok or not self.scale:
            out["forearmMissing"] = "shoulders_not_visible"
            return out
        shoulder = pose[SHOULDER[side]]
        if wrist is not None:
            # Needs only shoulders, which dodge tracking already requires. A hook's
            # windup takes the wrist wide of the shoulder line; a straight stays in front.
            out["wristOutward"] = -INWARD[side] * (wrist["x"] - shoulder["x"]) / self.scale
            out["wristHeight"] = aspect * (shoulder["y"] - wrist["y"]) / self.scale
        elbow = pose[ELBOW[side]]
        if not point_ok(elbow, self.cfg.min_elbow_visibility):
            # Usually the elbow is below the frame: step back from the camera.
            out["forearmMissing"] = "elbow_out_of_frame" if not 0 <= elbow.get("y", 2) <= 1 else "elbow_low_visibility"
            out["elbowVisibility"] = elbow.get("visibility")
            return out
        out["elbowHeight"] = aspect * (shoulder["y"] - elbow["y"]) / self.scale  # + = above shoulder
        ux, uy = elbow["x"] - shoulder["x"], aspect * (elbow["y"] - shoulder["y"])
        out["upperArmLength"] = math.hypot(ux, uy) / self.scale
        # 0 = hanging straight down, 90 = level with the shoulder, 180 = straight up.
        out["elbowAngleDeg"] = math.degrees(math.atan2(abs(ux), uy))
        out["elbowRaised"] = (out["elbowAngleDeg"] >= self.cfg.hook_elbow_angle
                              and out["upperArmLength"] >= self.cfg.min_upper_arm)
        out["elbowOutward"] = -INWARD[side] * (elbow["x"] - shoulder["x"]) / self.scale
        if wrist is None:
            out["forearmMissing"] = "wrist_not_visible"
            return out
        dx = (wrist["x"] - elbow["x"]) / self.scale
        dy = aspect * (wrist["y"] - elbow["y"]) / self.scale
        out["forearmLength"] = math.hypot(dx, dy)
        out["forearmDx"] = abs(dx)
        out["forearmAngleDeg"] = math.degrees(math.atan2(abs(dy), abs(dx)))
        return out

    def _observe(self, record):
        t = record["timestamp_ms"]
        if self.last_t is not None and t - self.last_t > self.cfg.max_gap_ms:
            self.history = {s: deque() for s in SIDES}
        self.last_t = t
        aspect = record["height"] / record["width"]
        pose = record.get("pose", [])
        cfg = self.detector_cfg
        shoulders_ok = len(pose) == 33 and all(point_ok(pose[i], cfg.min_visibility) for i in SHOULDER.values())
        if shoulders_ok:
            width = math.hypot(pose[11]["x"] - pose[12]["x"], aspect * (pose[11]["y"] - pose[12]["y"]))
            if cfg.min_body_width <= width <= cfg.max_body_width:
                self.scale = width
        hands, _ = hand_features(record, cfg)
        for side in SIDES:
            hand = hands.get(side)
            h = self.history[side]
            arm = self._arm(record, side, aspect, pose, shoulders_ok)
            if arm["wristX"] is None:
                # Neither model sees the wrist: keep the motion so far unless it
                # stays lost past the gap limit.
                if h and t - h[-1][0] > self.cfg.max_gap_ms:
                    h.clear()
                continue
            # Palm size (for growth) only exists when the hand model sees the fist.
            h.append((t, arm["wristX"], hand["size"] if hand else None, arm))
            while len(h) > 2 and h[1][0] <= t - self.cfg.window_ms:
                h.popleft()
        return t, hands

    def _measure(self, side, t, window_ms):
        h = [v for v in self.history[side] if v[0] >= t - window_ms]
        if len(h) < 3 or not self.scale:
            return None
        xs = [v[1] for v in h]
        end = xs[-1]
        # Inward travel from the window's most outward point, so the arc's start counts.
        inward = ((max(xs) - end) if INWARD[side] < 0 else (end - min(xs))) / self.scale
        sizes = [v[2] for v in h if v[2] is not None]
        growth = math.log(sizes[-1] / min(sizes)) if len(sizes) >= 2 else 0.0
        path = sum(abs(b - a) for a, b in zip(xs, xs[1:])) / self.scale
        m = dict(inwardBodyWidths=inward, logPalmGrowth=growth,
                 inwardSpeed=INWARD[side] * slope([(v[0], v[1]) for v in h]) / self.scale,
                 lateralPathRatio=path / max(abs(growth), 0.05),
                 windowSpanMs=h[-1][0] - h[0][0])
        m.update(h[-1][3])
        # A hook is widest at the top of its windup/arc: take the forearm frame with
        # the largest horizontal span (dx and angle together) and the widest wrist.
        arms = [v[3] for v in h if v[3]["forearmDx"] is not None and v[3]["forearmAngleDeg"] is not None]
        if arms:
            widest = max(arms, key=lambda a: a["forearmDx"])
            m.update({k: widest[k] for k in ("forearmDx", "forearmAngleDeg", "forearmLength", "elbowOutward")},
                     forearmMissing=None)
        wide = [v[3]["wristOutward"] for v in h if v[3]["wristOutward"] is not None]
        m["wristOutward"] = max(wide) if wide else None
        # Raised at any point in the window (None = elbow never visible).
        raised = [v[3]["elbowRaised"] for v in h if v[3]["elbowRaised"] is not None]
        m["elbowRaisedAny"] = any(raised) if raised else None
        for key in ("elbowHeight", "elbowAngleDeg", "upperArmLength"):
            values = [v[3][key] for v in h if v[3][key] is not None]
            m[key] = max(values) if values else None
        m["elbowAngleNow"] = h[-1][3]["elbowAngleDeg"]
        return m

    def _path_hook(self, m):
        return (m["inwardBodyWidths"] >= self.cfg.hook_min_inward
                and m["inwardBodyWidths"] >= self.cfg.hook_growth_ratio * max(m["logPalmGrowth"], 0))

    def _decide(self, m):
        """'hook', 'straight', or None when the evidence is in the ambiguous band."""
        if m is None:
            return "straight"
        c, model = self.cfg, self.cfg.model
        if model:
            z = model["bias"]
            for name, mean, std, w in zip(model["features"], model["mean"], model["std"], model["weights"]):
                value = m.get(name)
                z += w * (0 if value is None else (value - mean) / (std or 1))
            p = 1 / (1 + math.exp(-max(-30, min(30, z))))
            m["hookProbability"] = p
            return "hook" if p >= 0.65 else "straight" if p <= 0.35 else None
        if m["wristOutward"] is None:
            return "hook" if self._path_hook(m) else "straight"
        raised, wide = m["elbowRaisedAny"], m["wristOutward"] >= c.hook_wrist_outside
        # Elbow down, or (elbow unseen and) wrist in front: a straight, no wait.
        if raised is False or (raised is None and not wide):
            return "straight"
        # Raised elbow or wide wrist: a hook once the wrist sweeps in from wide.
        return "hook" if wide and self._sweeping(m) else None

    def _sweeping(self, m, fraction=1.0):
        return m["inwardBodyWidths"] >= self.cfg.hook_sweep * fraction and m["inwardSpeed"] > 0

    def _final(self, m):
        label = self._decide(m)
        if label is not None:
            return label
        if m.get("hookProbability") is not None:
            return "hook" if m["hookProbability"] >= 0.5 else "straight"
        # Out of time: a partial sweep in from wide still counts as a hook.
        wide = m["wristOutward"] is not None and m["wristOutward"] >= self.cfg.hook_wrist_outside
        return "hook" if wide and self._sweeping(m, 0.5) else "straight"

    def _label(self, event, side, m, final, waited):
        label = self._final(m) if final else self._decide(m)
        if label is None:
            return False
        event["punchType"] = label
        event["features"]["punchClass"] = dict(m or {}, deferredMs=waited)
        return True

    def process(self, record, native_events, detector, detected_ms):
        """Returns the events to publish now: non-punch events, labeled punches
        (some held from earlier frames), and extra hook trigger events."""
        t, hands = self._observe(record)
        out, busy = [], set()
        still = []
        for event, side in self.pending:
            waited = t - event["sampleMs"]
            final = waited >= self.cfg.defer_ms
            if self._label(event, side, self._measure(side, t, self.cfg.window_ms), final, waited):
                out.append(event)
            else:
                still.append((event, side))
            busy.add(side)  # this hand already has a punch; never add a trigger hook
        self.pending = still
        for e in native_events:
            if not e["type"].startswith("punch_"):
                out.append(e)
                continue
            side = e["type"][len("punch_"):]
            if self._label(e, side, self._measure(side, t, self.cfg.window_ms), self.cfg.defer_ms <= 0, 0):
                out.append(e)
            else:
                self.pending.append((e, side))
                busy.add(side)
            busy.add(side)
        if self.cfg.hook_trigger:
            out.extend(self._trigger(t, hands, detector, detected_ms, busy))
        return out

    def _trigger(self, t, hands, detector, detected_ms, busy):
        extra = []
        for side in SIDES:
            if side in busy:
                self.sweep_lock[side] = True
            elif self.sweep_lock[side]:
                m = self._measure(side, t, self.cfg.trigger_window_ms)
                if m is None or m["inwardSpeed"] < self.cfg.trigger_speed * 0.5:
                    self.sweep_lock[side] = False
                continue
            state = detector.hands[side]
            if side in busy or not self.history[side] or state["latched"] or t - state["last_fire"] < detector.cfg.cooldown_ms:
                continue
            m = self._measure(side, t, self.cfg.trigger_window_ms)
            # Stricter than classification: a fast inward sweep the rule calls a clear hook.
            if m is None or m["windowSpanMs"] < self.cfg.trigger_window_ms * 0.75:
                continue
            if m["inwardSpeed"] < self.cfg.trigger_speed or self._decide(m) != "hook":
                continue
            onset = next((v[0] for v in self.history[side] if v[0] >= t - self.cfg.trigger_window_ms), t)
            event = detector._event("punch_" + side, onset, t, detected_ms if detected_ms is not None else t,
                                    dict(rule="hook_lateral", handednessScore=hands.get(side, {}).get("handednessScore"),
                                         punchClass=dict(m, deferredMs=0)))
            event["punchType"] = "hook"
            # Share the core per-hand cooldown/release so one hook never fires twice.
            state.update(latched=True, release_since=None, last_fire=t)
            self.sweep_lock[side] = True
            extra.append(event)
        return extra

    def metadata(self):
        return dict(config=asdict(self.cfg), types=list(PUNCH_TYPES), features=list(FEATURES))
