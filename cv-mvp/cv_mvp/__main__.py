import argparse
import asyncio
import json
from pathlib import Path
import sys
from .core.config import Config
from .pipeline import Pipeline
from .punch_type import PunchTypeConfig

ROOT = Path(__file__).resolve().parents[1]


def main():
    p = argparse.ArgumentParser(
        description="Local boxing CV provider: current harness + contract adapter"
    )
    src = p.add_mutually_exclusive_group()
    src.add_argument("--camera", type=int, default=0)
    src.add_argument("--video", type=Path)
    src.add_argument("--replay", type=Path)
    src.add_argument("--synthetic", action="store_true")
    # Game timing: shorter per-hand cooldown/release than the harness default.json.
    p.add_argument("--config", type=Path, default=ROOT / "configs" / "game.json")
    p.add_argument(
        "--punch-config",
        type=Path,
        default=None,
        help="Punch-type JSON (stance, hook thresholds, hook_trigger)",
    )
    p.add_argument(
        "--preview-port",
        type=int,
        default=0,
        help="Serve a local debug view of the camera with landmarks (e.g. 8766); off by default",
    )
    p.add_argument("--models", type=Path, default=Path("models"))
    p.add_argument("--variant", choices=["lite", "full"], default="lite")
    p.add_argument("--transport", choices=["ws", "jsonl"], default="ws")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument(
        "--origin",
        action="append",
        default=[],
        help="Additional exact allowed browser Origin",
    )
    p.add_argument("--fight-id")
    p.add_argument("--round-id")
    p.add_argument("--width", type=int, default=640)
    p.add_argument("--height", type=int, default=480)
    p.add_argument("--fps", type=float, default=30)
    p.add_argument("--seconds", type=float, default=0)
    p.add_argument("--unpaced", action="store_true")
    p.add_argument("--input-mirrored", action="store_true")
    p.add_argument("--event-buffer", type=int, default=128)
    p.add_argument("--freshness-ms", type=float, default=250)
    p.add_argument(
        "--log",
        type=Path,
        help="Optional new producer-sample JSONL file; raw pixels never logged",
    )
    a = p.parse_args()
    if (
        a.width <= 0
        or a.height <= 0
        or not 1 <= a.fps <= 240
        or a.seconds < 0
        or a.event_buffer < 1
        or a.freshness_ms <= 0
    ):
        p.error("Invalid dimensions, FPS, duration, buffer size or freshness")
    if a.transport == "jsonl" and (not a.fight_id or not a.round_id):
        p.error("JSONL requires frontend-provided --fight-id and --round-id")
    preview = None
    if a.preview_port:
        from .preview import Preview

        preview = Preview(a.preview_port, a.host).start()
        print(
            f"CV preview: http://{a.host}:{a.preview_port}/ (local debug view)",
            file=sys.stderr,
            flush=True,
        )
    pipeline = Pipeline(
        Config.load(a.config),
        camera=a.camera,
        video=a.video,
        replay=a.replay,
        synthetic=a.synthetic,
        models=a.models,
        variant=a.variant,
        width=a.width,
        height=a.height,
        fps=a.fps,
        seconds=a.seconds,
        realtime=not a.unpaced,
        input_mirrored=a.input_mirrored,
        punch_config=PunchTypeConfig.load(a.punch_config),
        preview=preview,
    )
    log = a.log.open("x") if a.log else None
    try:
        if a.transport == "ws":
            from .server import serve

            asyncio.run(
                serve(
                    pipeline,
                    a.host,
                    a.port,
                    event_limit=a.event_buffer,
                    freshness_ms=a.freshness_ms,
                    origins=a.origin,
                    sample_log=log,
                )
            )
        else:
            from .adapter import CvAdapter

            def write(sample):
                sample["trace"]["sentMs"] = pipeline.now_ms()
                message = CvAdapter.envelope(sample, a.fight_id, a.round_id)
                line = (
                    json.dumps(message, allow_nan=False, separators=(",", ":")) + "\n"
                )
                sys.stdout.write(line)
                sys.stdout.flush()
                if log:
                    log.write(line)

            pipeline.run(write)
    except KeyboardInterrupt:
        pass
    except BrokenPipeError:
        pass
    finally:
        pipeline.stop.set()
        if log:
            log.close()
        print(json.dumps(pipeline.summary()), file=sys.stderr, flush=True)
    if pipeline.error:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
