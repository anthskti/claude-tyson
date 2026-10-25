"""Inference-only loader; verifies identity, channels, normalization and weights."""
import hashlib, json
from pathlib import Path
import numpy as np
import torch
from .imu_stateful import CompletionGRU, EventSettings, CLASSES, ARCHITECTURE
TARGET = 'outward_strike_v1'

def load_model(root, hand=None, *, target=TARGET):
    if target != TARGET:
        raise ValueError('Unsupported model target')
    root = Path(root); info=json.loads((root/'model.json').read_text())
    if (info.get('targetMeaning') != target or info.get('modelType') != 'outward_gru' or info.get('architecture') != ARCHITECTURE or
            info.get('classes') != CLASSES or (hand is not None and hand != info['punchingHand']) or
            hashlib.sha256((root/'weights.pt').read_bytes()).hexdigest() != info['weightsSha256']):
        raise ValueError('Outward model bundle, target, hand, or checksum mismatch')
    if info.get('channelNames') != ['a_forward', 'a_side', 'a_up', 'w_forward', 'w_side', 'w_up']:
        raise ValueError('Stateful channel order mismatch')
    mean, scale = np.asarray(info['normalization']['mean']), np.asarray(info['normalization']['scale'])
    if (mean.shape != (6,) or scale.shape != (6,) or not np.isfinite(mean).all() or
            not np.isfinite(scale).all() or (scale <= 0).any()):
        raise ValueError('Invalid stateful normalization')
    EventSettings(**info['eventPolicy'])
    torch.set_num_threads(1)
    torch.manual_seed(info['seed'])
    model = CompletionGRU(); model.load_state_dict(torch.load(root/'weights.pt', weights_only=True, map_location='cpu')); model.eval()
    return model, info
