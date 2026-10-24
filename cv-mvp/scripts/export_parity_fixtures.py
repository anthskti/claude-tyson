"""Write landmark streams and the adapter's exact output for each, for ports of the detector.

Each scenario produces two gzip files in the output directory:
  <name>.landmarks.jsonl.gz  one landmark frame (or reset marker) per line: the input
  <name>.expected.jsonl.gz   the adapter's observation and events for each frame: the output

Inputs are rounded to 6 decimals before processing, so a port reading the same file sees
exactly what this detector saw. Synthetic scenarios exercise the logic only; record real
clips with scripts/dump_landmarks.py and pass them with --clip for camera evidence.

    python scripts/export_parity_fixtures.py --out ../src/game/cv/local/fixtures
"""

import argparse
from copy import deepcopy
import gzip
import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cv_mvp.adapter import CvAdapter  # noqa: E402
from cv_mvp.core.config import Config  # noqa: E402
from cv_mvp.synthetic import frame  # noqa: E402

GAME = ROOT / "configs" / "game.json"
DEFAULT = ROOT / "configs" / "default.json"


def rounded(value):
    if isinstance(value, float):
        return round(value, 6)
    if isinstance(value, dict):
        return {k: rounded(v) for k, v in value.items()}
    if isinstance(value, list):
        return [rounded(v) for v in value]
    return value


def jitter(record, rng, sigma):
    for p in record["pose"]:
        p["x"] += rng.gauss(0, sigma)
        p["y"] += rng.gauss(0, sigma)
    for hand in record["hands"]:
        for p in hand["landmarks"]:
            p["x"] += rng.gauss(0, sigma)
            p["y"] += rng.gauss(0, sigma)
    return record


def times(end, rng=None, step=33, spread=0):
    t, out = 0, []
    while t < end:
        out.append(t)
        t += step + (rng.randint(-spread, spread) if rng else 0)
    return out


def clean():
    return [frame(t) for t in times(12000)]


def noisy():
    rng = random.Random(7)
    return [jitter(frame(t), rng, 0.0015) for t in times(12000, rng, spread=4)]


def dropouts():
    rng = random.Random(11)
    out = []
    for t in times(14000, rng, spread=3):
        # A 400 ms freeze (past max_gap_ms) and a 2.5 s one (past recalibrate_after_loss_ms).
        if 5000 < t < 5400 or 8000 < t < 10500:
            continue
        r = jitter(frame(t), rng, 0.001)
        phase = (t % 6000) / 1000
        if 1.25 < phase < 1.33:
            # Blurred fist: the hand model loses it, the pose wrist follows.
            wrist = r["hands"][0]["landmarks"][0]
            r["hands"] = r["hands"][1:]
            r["pose"][15] = dict(wrist, visibility=0.9, presence=0.9)
        if 0.4 < phase < 0.6:
            r["hands"] = []
        if 3.0 < phase < 3.2:
            for i in (0, 11, 12):
                r["pose"][i]["visibility"] = 0.3
        out.append(r)
    return out


def resets():
    out = []
    for t in times(12000):
        if t in (1188, 4785, 7590):
            out.append({"kind": "reset_calibration"})
        out.append(frame(t))
    return out


def edges():
    rng = random.Random(3)
    out = []
    for t in times(12000, rng, spread=2):
        r = frame(t)
        k = (t // 33) % 40
        if k == 3:
            r["hands"][1]["model_handedness"] = "Left"  # duplicate assignment
        elif k == 7:
            r["hands"][0]["handedness_score"] = 0.4
        elif k == 11:
            r["hands"][0]["model_handedness"] = "Unknown"
        elif k == 15:
            r["pose"][11], r["pose"][12] = r["pose"][12], r["pose"][11]  # facing away
        elif k == 19:
            for i in (11, 12):
                r["pose"][i]["x"] = 0.5 + (r["pose"][i]["x"] - 0.5) * 0.2  # too far away
        elif k == 23:
            r["hands"][1]["landmarks"][0]["x"] = 1.2  # wrist outside the image
        elif k == 27:
            r["pose"][13]["visibility"] = 0.2  # elbow unseen
        elif k == 31:
            r["pose"][13]["y"] = 1.4  # elbow below the frame
        elif k == 35:
            r["hands"][0]["landmarks"] = r["hands"][0]["landmarks"][:10]
        out.append(r)
    return out


def thresholds():
    """Each 6 s loop is slower, with a smaller dodge, a narrower hook sweep and a lower
    hook elbow than the last, so each threshold is crossed part way through."""
    rng = random.Random(5)
    out, t = [], 0
    for k in range(24):
        stretch, amp = 1 + 0.06 * k, 0.45 + 0.02 * k
        sweep, raise_ = 1 - 0.04 * k, 1 - 0.025 * k
        local = 0
        while local < 6000 * stretch:
            r = frame(int(local / stretch))
            r["timestamp_ms"] = t
            head = r["pose"][0]
            head["x"] = 0.5 + (head["x"] - 0.5) * amp
            if 4.8 <= (local / stretch % 6000) / 1000 < 5.7:
                # Narrow the hook's sweep and lower its elbow toward the guard position.
                for pt in r["hands"][0]["landmarks"]:
                    pt["x"] = 0.75 + (pt["x"] - 0.75) * sweep
                elbow = r["pose"][13]
                elbow["x"] = 0.66 + (elbow["x"] - 0.66) * raise_
                elbow["y"] = 0.75 + (elbow["y"] - 0.75) * raise_
            out.append(r)
            step = 33 + rng.randint(-3, 3)
            local += step
            t += step
    return out


SCENARIOS = {
    "thresholds": (thresholds, GAME),
    "clean": (clean, GAME),
    "noisy": (noisy, GAME),
    "dropouts": (dropouts, GAME),
    "resets": (resets, GAME),
    "edges": (edges, GAME),
    "harness-timing": (clean, DEFAULT),
}


def expected(packet):
    obs = packet["observation"]
    return dict(
        timestampMs=obs["timestampMs"],
        observation={k: obs[k] for k in (
            "trackingState", "validity", "calibrationId", "markers", "features",
            "reason", "phases", "punchReadiness", "dodgeReadiness")},
        events=packet["events"],
        resetGeneration=packet["producer"]["resetGeneration"],
    )


def export(name, records, config_path, out):
    adapter = CvAdapter(Config.load(config_path), session_id="fixture")
    inputs, outputs = [], []
    for record in records:
        if record.get("kind") == "reset_calibration":
            adapter.reset()
            inputs.append(record)
            continue
        record = rounded(deepcopy(record))
        record.pop("synthetic", None)
        inputs.append(record)
        t = record["timestamp_ms"]
        outputs.append(expected(adapter.process(record, t, "replay")))
    write(out / f"{name}.landmarks.jsonl.gz", inputs)
    write(out / f"{name}.expected.jsonl.gz", outputs)
    events = [e for o in outputs for e in o["events"]]
    kinds = {}
    for e in events:
        key = e["type"] + (f" {e['punchType']}" if "punchType" in e else "")
        kinds[key] = kinds.get(key, 0) + 1
    print(f"{name}: {len(outputs)} frames, {len(events)} events {kinds} ({config_path.name})")


def write(path, rows):
    # mtime=0 keeps re-exports byte-identical when nothing changed.
    with open(path, "wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as f:
        for row in rows:
            f.write((json.dumps(row, separators=(",", ":")) + "\n").encode())


def clip_records(path):
    opener = gzip.open if str(path).endswith(".gz") else open
    with opener(path, "rt") as f:
        return [json.loads(line) for line in f if line.strip()]


def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--clip", type=Path, action="append", default=[],
                   help="Landmark JSONL from scripts/dump_landmarks.py, exported with configs/game.json")
    a = p.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    for name, (make, config_path) in SCENARIOS.items():
        export(name, make(), config_path, a.out)
    for clip in a.clip:
        export("clip-" + clip.name.split(".")[0], clip_records(clip), GAME, a.out)


if __name__ == "__main__":
    main()
