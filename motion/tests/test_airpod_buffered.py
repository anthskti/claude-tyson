from dataclasses import asdict

import numpy as np
import pytest
import torch

from boxing_cv.airpod_buffered import PriorityHistory, BufferedDetector
from boxing_cv.calibrated_airpod import Settings
from boxing_cv.imu_stateful import CompletionGRU, EventSettings


def sample(t, motion=0.):
    return dict(t=t, a=np.array([motion, 0., 0.]), w=np.zeros(3), up=np.array([0., 0., 1.]),
                ageMs=0, received=100000+t, sequence=t//40)


def test_priority_order_time_expiry_and_snapshot_ownership():
    h = PriorityHistory()
    x = np.ones(6)
    for t in (120, 0, 80, 40): h.push(t, x)
    x[:] = 99
    assert [t for t, _ in h.snapshot(120)] == [0, 40, 80, 120]
    assert np.array_equal(h.snapshot(120)[0][1], np.ones(6))
    assert [t for t, _ in h.snapshot(80)] == [0, 40, 80]  # no future leakage
    h.push(2080, np.zeros(6))
    assert [t for t, _ in h.snapshot(2080)] == [80, 120, 2080]
    assert not h.push(79, np.zeros(6))
    assert len(h) == 3


def test_consumption_preserves_newer_samples_and_rejects_consumed_late_arrivals():
    h = PriorityHistory()
    for t in (0, 40, 80, 120): h.push(t, np.zeros(6))
    assert h.consume_through(80) == 3
    assert [t for t, _ in h.snapshot(120)] == [120]
    assert not h.push(80, np.zeros(6))
    assert h.consume_through(80) == 0


def test_equal_priorities_do_not_compare_numpy_arrays():
    h = PriorityHistory()
    h.push(40, np.ones(6)); h.push(40, np.zeros(6))
    assert len(h.snapshot(40)) == 2
    assert h.consume_through(40) == 2


@pytest.fixture
def detector(monkeypatch):
    import boxing_cv.airpod_stateful as live
    class ControlledModel:
        def step(self, x, valid, state=None):
            # Deterministic confidence bursts isolate queue/event behavior from
            # learned weights; an actual GRU is tested separately below.
            value = float(x[0, 0])
            p = [1/3]*3 if value == .5 else [.98, .01, .01] if value == 0 else [.01, .98, .01] if value > 0 else [.01, .01, .98]
            return torch.log(torch.tensor([p])), None
    info = dict(eventPolicy=asdict(EventSettings(confirmations=2)),
                normalization=dict(mean=[0]*6, scale=[1]*6), weightsSha256='test',
                stream=dict(shortGapMaxMs=200, recoveryValidSamples=2))
    monkeypatch.setattr(live, 'load_model', lambda *args: (ControlledModel(), info))
    d = BufferedDetector('test', 'left', Settings())
    d.profile = dict(hand='left', forward=[1,0,0], sideways=[0,1,0], up=[0,0,1], accelBiasReferenceG=[0,0,0])
    return d


def test_background_retains_history_confirmed_event_consumes_then_rearms(detector):
    for t in (0, 40): assert detector.process(sample(t))[1] is None
    assert len(detector.history) == 2 and detector.armed
    assert detector.process(sample(80, 1))[1] is None
    f, e = detector.process(sample(120, 1))
    assert e['punchType'] == 'straight'
    assert e['modelWindowStartSensorTimestampSec'] == 0
    assert e['modelWindowEndSensorTimestampSec'] == .12
    assert f['consumedSamples'] == 4 and f['bufferSamplesAfterDecision'] == 0
    assert len(detector.history) == 0 and detector.state is None and not detector.armed
    # Consumed samples cannot be revisited; new background must rearm.
    for t in (160, 200, 240, 280, 320, 360): detector.process(sample(t))
    assert detector.armed
    detector.process(sample(400, -1))
    _, e = detector.process(sample(440, -1))
    assert e['punchType'] == 'hook' and e['modelWindowStartSensorTimestampSec'] == .16
    assert len(detector.history) == 0


def test_disabled_emission_does_not_consume(detector):
    detector.process(sample(0)); detector.process(sample(40))
    detector.emission_enabled = False
    for t in (80, 120, 160): assert detector.process(sample(t, 1))[1] is None
    assert len(detector.history) == 5


def test_abstention_keeps_preceding_motion_available(detector):
    detector.process(sample(0)); detector.process(sample(40))
    detector.process(sample(80, 1))
    f, event = detector.process(sample(120, .5))
    assert f['classification'] == 'abstain' and event is None
    assert len(detector.history) == 4 and f['consumedSamples'] == 0


def test_short_gap_preserves_queue_long_gap_clears_and_no_full_window_wait(detector):
    detector.process(sample(0)); detector.process(sample(40))
    f, _ = detector.process(sample(160))
    assert f['windowMissingUpdates'] == 2 and f['state'] == 'recovering'
    assert len(detector.history) == 3
    assert detector.process(sample(200))[0]['state'] == 'prediction'
    f, _ = detector.process(sample(440))
    assert f['recovery'] == 'long_gap_state_reset' and f['bufferSamples'] == 1
    assert detector.process(sample(480))[0]['state'] == 'prediction'


def test_real_gru_uses_only_snapshot_and_never_retains_hidden_state(detector):
    torch.set_num_threads(1); torch.manual_seed(42)
    detector.model = CompletionGRU().eval()
    detector.emission_enabled = False
    for t in range(0, 2401, 40):
        f, _ = detector.process(sample(t, np.sin(t/100)))
    snapshot = detector.history.snapshot(2400)
    assert snapshot[0][0] == 400 and len(snapshot) == 51
    assert f['historySpanMs'] == 2000 and detector.state is None
    x = torch.from_numpy(np.stack([x for _, x in snapshot]))[None]
    with torch.inference_mode():
        logits, _ = detector.model(x, torch.ones(1, len(snapshot), dtype=torch.bool))
        p = logits[0, -1].softmax(-1).numpy()
    np.testing.assert_allclose(list(f['probabilities'].values()), p, rtol=1e-6)
    detector.reset()
    assert len(detector.history) == 0
