import hashlib
import json
from pathlib import Path

import pytest

from boxing_cv.outward_models import resolve_model


@pytest.fixture
def registry(tmp_path):
    entries = []
    for side in ('left', 'right'):
        root = tmp_path/side
        root.mkdir()
        payload = side.encode()
        (root/'weights.pt').write_bytes(payload)
        checksum = hashlib.sha256(payload).hexdigest()
        (root/'model.json').write_text(json.dumps(dict(
            punchingHand=side, modelType='outward_gru', weightsSha256=checksum)))
        entries.append(dict(earbud=side, punchingHand=side, bundle=side, weightsSha256=checksum))
    path = tmp_path/'outward-pairs.json'
    path.write_text(json.dumps(dict(models=entries)))
    return path


def test_selects_independent_weights_by_both_ids(registry):
    for side in ('left', 'right'):
        assert resolve_model(side, side, registry=registry) == registry.parent/side
    with pytest.raises(ValueError, match='No unique'):
        resolve_model('left', 'right', registry=registry)


def test_explicit_registered_bundle_cannot_use_wrong_pair(registry):
    for hand, bud in [('right', 'right'), ('left', 'right'), ('right', 'left')]:
        with pytest.raises(ValueError, match='does not match'):
            resolve_model(hand, bud, registry.parent/'left', registry)


def test_changed_weights_are_rejected(registry):
    (registry.parent/'right'/'weights.pt').write_bytes(b'changed')
    with pytest.raises(ValueError, match='checksum mismatch'):
        resolve_model('right', 'right', registry=registry)


def test_explicit_custom_bundle_still_supported(registry):
    custom = registry.parent/'custom'
    assert resolve_model('right', 'left', custom, registry) == custom
    assert resolve_model('left', 'left', custom, registry.parent/'missing') == custom
    with pytest.raises(ValueError, match='No outward model registry'):
        resolve_model('left', 'left', registry=registry.parent/'missing')


def test_real_pair_bundles_load_and_are_hand_specific():
    root = Path(__file__).resolve().parents[1]
    path = root/'models/outward-pairs.json'
    if not path.exists():
        pytest.skip('Local paired model registry not supplied')
    from boxing_cv.airpod_outward import OutwardExperiment
    from boxing_cv.calibrated_airpod import Settings
    from boxing_cv.model_bundle import load_model
    hashes = []
    for side in ('left', 'right'):
        bundle = resolve_model(side, side, registry=path)
        model, info = load_model(bundle, side)
        hashes.append(info['weightsSha256'])
        assert not model.training
        engine = OutwardExperiment(Settings(), bud=side, hand=side)
        assert engine.hand == side and engine.bud == side and engine.detector.hand == side
        assert Path(engine.detector.model_path) == bundle
        with pytest.raises(ValueError):
            load_model(bundle, 'left' if side == 'right' else 'right')
    assert len(set(hashes)) == 2
