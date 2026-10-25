"""Inference-only access to the archived complete-trial CNN–GRU bundles.

Input is one already calibrated, 25 Hz physical-unit sequence, not raw API axes.
No resampling, calibration fitting, window detection, or live event emission.
"""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import torch

from .imu_cnn_model import ARCHITECTURE, MotionClassifier

CHANNELS = ['a_forward', 'a_side', 'a_up', 'w_forward', 'w_side', 'w_up']
CLASSES = ['hook', 'non_punch', 'straight']


def load_model(root):
    root = Path(root)
    info = json.loads((root / 'model.json').read_text())
    quality = info.get('quality', {})
    if (info.get('schemaVersion') != 1 or info.get('architecture') != ARCHITECTURE
            or info.get('modelType') not in ('cnn', 'cnn_gru')
            or info.get('channelNames') != CHANNELS or info.get('classes') != CLASSES
            or info.get('punchingHand') != 'left' or info.get('sampleRateHz') != 25
            or info.get('preprocessingVersion') != 'imu-cnn-preprocessing-v1'
            or quality.get('kernels') != [5, 3] or quality.get('minRecurrentUpdates') != 8
            or not 0 < quality.get('minValidFraction', 0) <= 1
            or hashlib.sha256((root / 'weights.pt').read_bytes()).hexdigest() != info.get('weightsSha256')):
        raise ValueError('CNN bundle identity, quality, or checksum mismatch')
    mean = np.asarray(info['normalization']['mean'], dtype=float)
    scale = np.asarray(info['normalization']['scale'], dtype=float)
    if (mean.shape != (6,) or scale.shape != (6,) or not np.isfinite(mean).all()
            or not np.isfinite(scale).all() or (scale <= 0).any()):
        raise ValueError('Invalid CNN normalization')
    for key in ('minProbability', 'minMargin'):
        if not 0 <= info.get('decision', {}).get(key, -1) <= 1:
            raise ValueError('Invalid CNN decision policy')
    torch.set_num_threads(1)
    model = MotionClassifier(info['modelType'])
    model.load_state_dict(torch.load(root / 'weights.pt', map_location='cpu', weights_only=True))
    model.eval()
    return model, info


def predict(model, info, x, mask):
    x, mask = np.asarray(x, dtype=np.float64), np.asarray(mask)
    if x.ndim != 2 or x.shape[1] != 6 or mask.shape != (len(x),) or mask.dtype != np.bool_:
        raise ValueError('Expected x[T,6] and boolean mask[T] for one unpadded trial')
    if not len(x) or not np.isfinite(x[mask]).all():
        raise ValueError('Empty trial or nonfinite valid input')
    if mask.mean() < info['quality']['minValidFraction']:
        raise ValueError('Insufficient valid timesteps')
    recurrent = mask.copy()
    for kernel in info['quality']['kernels']:
        recurrent = np.convolve(recurrent.astype(int), np.ones(kernel, dtype=int), 'full')[:len(mask)] == kernel
    if recurrent.sum() < info['quality']['minRecurrentUpdates']:
        raise ValueError('Fewer than eight usable recurrent updates')
    mean, scale = (np.asarray(info['normalization'][key]) for key in ('mean', 'scale'))
    x = ((np.where(mask[:, None], x, mean) - mean) / scale).astype(np.float32)
    x[~mask] = 0
    with torch.inference_mode():
        probs = model(torch.from_numpy(x[None]), torch.from_numpy(mask[None].copy())).softmax(-1)[0].numpy()
    if not np.isfinite(probs).all():
        raise ValueError('Nonfinite model output')
    order = np.argsort(probs)
    best = int(order[-1])
    policy = info['decision']
    accepted = probs[best] >= policy['minProbability'] and probs[best] - probs[order[-2]] >= policy['minMargin']
    return dict(label=CLASSES[best] if accepted else 'abstain', argmax=CLASSES[best],
                probabilities=dict(zip(CLASSES, map(float, probs))), punchingHand=info['punchingHand'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', type=Path, required=True)
    parser.add_argument('--trial', type=Path, required=True, help='NPZ with x[T,6] and boolean mask[T], without batch padding')
    args = parser.parse_args()
    model, info = load_model(args.model)
    with np.load(args.trial, allow_pickle=False) as trial:
        result = predict(model, info, trial['x'], trial['mask'])
    print(json.dumps(result, indent=2, allow_nan=False))


if __name__ == '__main__':
    main()
