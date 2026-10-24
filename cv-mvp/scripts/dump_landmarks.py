"""Run MediaPipe on a recording and write its landmark frames as JSONL (no pixels).

The output is what `python -m cv_mvp --replay` reads, and what
scripts/export_parity_fixtures.py --clip turns into a parity fixture.

    python scripts/dump_landmarks.py punches.mp4 --out punches.landmarks.jsonl
"""

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cv_mvp.core.capture import Capture  # noqa: E402
from cv_mvp.core.inference import Inference  # noqa: E402


def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("video", type=Path)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--models", type=Path, default=ROOT / "models")
    p.add_argument("--variant", choices=["lite", "full"], default="lite")
    p.add_argument("--input-mirrored", action="store_true", help="The recording is a mirrored selfie view")
    a = p.parse_args()
    if a.out.exists():
        raise SystemExit(f"{a.out} exists; refusing to overwrite")
    inference = Inference(a.models, a.variant, True, schedule="sequential")
    capture = Capture(str(a.video), time.perf_counter(), input_mirrored=a.input_mirrored).start()
    frames = 0
    try:
        with a.out.open("w") as f:
            while True:
                item = capture.take()
                if item is None:
                    if capture.finished:
                        if capture.error:
                            raise RuntimeError(capture.error)
                        break
                    continue
                _, stamp, pixels, _ = item
                record = inference.process(pixels, stamp)
                record.pop("timings_ms", None)
                f.write(json.dumps(record, separators=(",", ":")) + "\n")
                frames += 1
    finally:
        capture.close()
        inference.close()
    print(f"{frames} frames -> {a.out}")


if __name__ == "__main__":
    main()
