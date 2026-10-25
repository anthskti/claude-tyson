import json
from pathlib import Path
import shutil

import numpy as np
import pytest

from boxing_cv.cnn_baseline import CLASSES, load_model, predict

ROOT = Path(__file__).resolve().parents[1] / 'models'


@pytest.mark.parametrize('name', ['airpod-left-cnn-v1', 'airpod-left-cnn-1500-v1'])
def test_reload_class_order_and_invalid_value_invariance(name):
    model, info = load_model(ROOT / name)
    x = np.random.default_rng(42).normal(size=(50, 6))
    mask = np.ones(50, dtype=bool)
    mask[20:22] = False
    expected = predict(model, info, x, mask)
    x[~mask] = np.nan
    reloaded, metadata = load_model(ROOT / name)
    assert predict(reloaded, metadata, x, mask) == expected
    assert list(expected['probabilities']) == CLASSES
    assert sum(expected['probabilities'].values()) == pytest.approx(1)
    x[0] = np.nan
    with pytest.raises(ValueError, match='nonfinite'):
        predict(model, info, x, mask)
    with pytest.raises(ValueError, match='eight'):
        predict(model, info, np.zeros((10, 6)), np.ones(10, dtype=bool))


def test_bad_bundle_rejected(tmp_path):
    root = tmp_path / 'bundle'
    shutil.copytree(ROOT / 'airpod-left-cnn-v1', root)
    info = json.loads((root / 'model.json').read_text())
    info['classes'] = ['non_punch', 'straight', 'hook']
    (root / 'model.json').write_text(json.dumps(info))
    with pytest.raises(ValueError, match='identity'):
        load_model(root)
