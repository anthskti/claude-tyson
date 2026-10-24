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
        # v1.1 hook trigger events are additive; core events must pass through intact.
        actual += [
            (e["type"], e["sampleMs"])
            for e in packet["events"]
            if e["features"].get("rule") != "hook_lateral"
        ]
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
    assert sample["events"] == expected and len(expected) == 5
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


def typed_events(adapter, start=0, end=12000):
    return [
        (e["type"], e["punchType"], e["features"]["rule"])
        for t in range(start, end, 33)
        for e in adapter.process(frame(t), t + 25)["events"]
        if e["type"].startswith("punch_")
    ]


def test_straight_and_hook_types_with_single_hook():
    from cv_mvp.punch_type import PunchTypeConfig

    events = typed_events(CvAdapter(session_id="types"), end=6000)
    assert events == [
        ("punch_left", "straight", "recent_hand_motion"),
        ("punch_right", "straight", "recent_hand_motion"),
        ("punch_left", "hook", "hook_lateral"),
    ]
    # A stricter elbow angle than the synthetic hook's ~100 degrees turns it off.
    strict = CvAdapter(punch_config=PunchTypeConfig(hook_elbow_angle=120))
    assert [e[1] for e in typed_events(strict, end=6000)] == ["straight", "straight"]


def test_hook_trigger_can_be_disabled_and_reset_clears_history():
    from cv_mvp.punch_type import PunchTypeConfig

    off = CvAdapter(punch_config=PunchTypeConfig(hook_trigger=False))
    assert [e[1] for e in typed_events(off, end=6000)] == ["straight", "straight"]
    a = CvAdapter()
    for t in range(4800, 4900, 33):
        a.process(frame(t), t)
    a.reset()
    assert all(not h for h in a.punch_typer.history.values())


def arm(raised=None, wrist_out=None):
    return dict(forearmLength=None, forearmDx=None, forearmAngleDeg=None, elbowOutward=None,
                elbowRaised=raised, elbowHeight=None if raised is None else (0.0 if raised else -0.8),
                elbowAngleDeg=None if raised is None else (80.0 if raised else 20.0),
                upperArmLength=None if raised is None else 0.7, wristX=None,
                knuckleRatio=None, knuckleDepth=None, wristOutward=wrist_out, wristHeight=None,
                forearmMissing=None)


def typer_with(side, xs, sizes, arm_state, config=None):
    from cv_mvp.punch_type import PunchTyper
    from cv_mvp.core.config import Config

    typer = PunchTyper(config, detector_config=Config())
    typer.scale = 0.3
    for i, (x, size) in enumerate(zip(xs, sizes)):
        typer.history[side].append((i * 33, x, size, arm_state))
    return typer, typer._measure(side, 33 * (len(xs) - 1), 200)


def test_hook_needs_raised_elbow_and_outside_in_wrist():
    sweep = [0.75 - 0.02 * i for i in range(7)]  # left wrist moving inward
    flat = [0.04] * 7
    # Raised elbow + wrist wide of the shoulder + inward sweep: hook.
    typer, m = typer_with("left", sweep, flat, arm(True, 0.3))
    assert typer._decide(m) == "hook"
    # Elbow down: straight, no wait. Raised elbow but wrist in front: wait, then straight.
    typer, m = typer_with("left", sweep, flat, arm(False, 0.3))
    assert typer._decide(m) == "straight"
    typer, m = typer_with("left", sweep, flat, arm(True, -0.2))
    assert typer._decide(m) is None and typer._final(m) == "straight"
    # Wide + raised but no sweep yet (windup): wait; still no sweep at the end: straight.
    still = [0.75] * 7
    typer, m = typer_with("left", still, flat, arm(True, 0.3))
    assert typer._decide(m) is None and typer._final(m) == "straight"
    # Elbow never visible: the wrist path decides.
    typer, m = typer_with("left", sweep, flat, arm(None, 0.3))
    assert typer._decide(m) == "hook"


def test_fitted_model_replaces_rule():
    from cv_mvp.punch_type import PunchTypeConfig

    model = dict(features=["wristOutward"], mean=[0.5], std=[0.2], weights=[4.0], bias=0.0)
    cfg = PunchTypeConfig(model=model)
    sweep, flat = [0.70 - 0.02 * i for i in range(7)], [0.04] * 7
    typer, m = typer_with("left", sweep, flat, arm(True, 0.9), cfg)
    assert typer._decide(m) == "hook" and m["hookProbability"] > 0.9
    typer, m = typer_with("left", sweep, flat, arm(True, 0.1), cfg)
    assert typer._decide(m) == "straight"
    typer, m = typer_with("left", sweep, flat, arm(True, 0.52), cfg)
    assert typer._decide(m) is None
    with pytest.raises(ValueError):
        PunchTypeConfig(model=dict(features=["nope"], mean=[0], std=[1], weights=[1], bias=0)).validate()


def test_ambiguous_punch_is_held_then_labeled():
    from cv_mvp.punch_type import PunchTyper
    from cv_mvp.core.config import Config
    from cv_mvp.core.detector import Detector

    typer = PunchTyper(detector_config=Config())
    detector = Detector(session_id="hold")
    base = dict(arm(True, 0.3), logPalmGrowth=0.1, lateralPathRatio=1, windowSpanMs=200, elbowRaisedAny=True)
    measures = [dict(base, inwardBodyWidths=0.0, inwardSpeed=-0.5),
                dict(base, inwardBodyWidths=0.5, inwardSpeed=3.0)]
    typer._measure = lambda side, t, w: dict(measures[0] if t < 1033 else measures[1])
    times = iter([1000, 1033])
    typer._observe = lambda record: (next(times), {"left": {}})
    event = dict(type="punch_left", sampleMs=1000, features={})
    assert typer.process({}, [event], detector, None) == []
    out = typer.process({}, [], detector, None)
    assert out == [event] and event["punchType"] == "hook"
    assert event["features"]["punchClass"]["deferredMs"] == 33


def test_invalid_punch_config_rejected():
    from cv_mvp.punch_type import PunchTypeConfig

    for bad in (dict(hook_elbow_angle=0), dict(trigger_speed=0), dict(hook_trigger="yes")):
        with pytest.raises(ValueError):
            PunchTypeConfig(**bad).validate()


def test_fit_script_learns_forearm_split(tmp_path):
    import random
    import subprocess
    import sys
    from cv_mvp.punch_type import FEATURES, PunchTypeConfig

    rng = random.Random(4)
    punches = []
    # Old jab/cross labels must still count as straights.
    for label, dx, angle, n in [("jab", 0.2, 65, 15), ("straight", 0.25, 60, 15), ("hook", 0.8, 15, 15)]:
        for i in range(n):
            f = {k: rng.gauss(0.3, 0.2) for k in FEATURES}
            f.update(forearmDx=rng.gauss(dx, 0.1), forearmAngleDeg=rng.gauss(angle, 10), knuckleDepth=None)
            side = "punch_right" if label == "straight" else "punch_left"
            punches.append(dict(label=label, type=side, punchType="straight",
                                features=f, eventId=f"{label}{i}"))
    data = tmp_path / "labeled.json"
    data.write_text(json.dumps(dict(version=1, punches=punches)))
    out = tmp_path / "punch-types.json"
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run([sys.executable, str(root / "scripts/fit_punch_types.py"), str(data), "--out", str(out)],
                            capture_output=True, text=True, check=True)
    assert "leave-one-out" in result.stdout and "knuckleDepth" not in json.loads(out.read_text())["model"]["features"]
    cfg = PunchTypeConfig.load(out)
    w = dict(zip(cfg.model["features"], cfg.model["weights"]))
    assert w["forearmDx"] > 0 and w["forearmAngleDeg"] < 0
    acc = [l for l in result.stdout.splitlines() if "accuracy" in l][-1]
    assert int(acc.split("=")[1].strip().rstrip("%")) >= 90


def test_blurred_fist_is_followed_by_pose_wrist():
    from cv_mvp.punch_type import PunchTyper
    from cv_mvp.core.config import Config

    typer = PunchTyper(detector_config=Config())
    for t in range(1200, 1300, 33):
        typer._observe(frame(t))
    before = len(typer.history["left"])
    blurred = frame(1300)
    wrist = blurred["hands"][0]["landmarks"][0]
    blurred["hands"] = []
    blurred["pose"][15] = dict(wrist, visibility=0.9, presence=0.9)
    typer._observe(blurred)
    entry = typer.history["left"][-1]
    assert len(typer.history["left"]) == before + 1 and entry[2] is None and entry[1] == wrist["x"]
    lost = frame(1600)
    lost["hands"] = []
    for i in (15, 16):
        lost["pose"][i] = dict(lost["pose"][i], visibility=0.1)
    typer._observe(lost)
    assert not typer.history["left"]  # neither model sees it past max_gap_ms


def test_game_timing_counts_each_punch_once():
    from cv_mvp.core.config import Config

    root = Path(__file__).resolve().parents[1]
    a = CvAdapter(Config.load(root / "configs/game.json"), session_id="game")
    punches = [
        (e["type"], e["punchType"])
        for t in range(0, 12000, 33)
        for e in a.process(frame(t), t + 25)["events"]
        if e["type"].startswith("punch_")
    ]
    one_loop = [("punch_left", "straight"), ("punch_right", "straight"), ("punch_left", "hook")]
    assert punches == one_loop * 2
