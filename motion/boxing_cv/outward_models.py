"""Select frozen outward bundles by independent earbud and punching-hand IDs."""
import hashlib
import json
from pathlib import Path


REGISTRY = Path(__file__).resolve().parents[1] / 'models' / 'outward-pairs.json'


def resolve_model(hand, bud, explicit=None, registry=REGISTRY):
    if hand not in ('left', 'right') or bud not in ('left', 'right'):
        raise ValueError('Outward mode requires explicit punching hand and earbud')
    registry = Path(registry)
    # Custom bundles remain supported; their loader checks target, hand and weights.
    if not registry.exists():
        if explicit is not None:
            return Path(explicit)
        raise ValueError(f'No outward model registry at {registry}; supply --airpod-model')
    entries = json.loads(registry.read_text())['models']
    requested = None if explicit is None else Path(explicit).resolve()
    if requested is None:
        matches = [e for e in entries if e['punchingHand'] == hand and e['earbud'] == bud]
    else:
        matches = [e for e in entries if (registry.parent/e['bundle']).resolve() == requested]
        if not matches:
            return requested
    if len(matches) != 1:
        raise ValueError(f'No unique outward bundle for earbud={bud}, hand={hand}; supply a trained --airpod-model')
    entry = matches[0]
    if (entry['punchingHand'], entry['earbud']) != (hand, bud):
        raise ValueError('Registered outward model does not match the selected earbud/hand pair')
    bundle = (registry.parent/entry['bundle']).resolve()
    info = json.loads((bundle/'model.json').read_text())
    checksum = hashlib.sha256((bundle/'weights.pt').read_bytes()).hexdigest()
    if (info.get('punchingHand') != hand or info.get('modelType') != 'outward_gru'
            or info.get('weightsSha256') != checksum or entry['weightsSha256'] != checksum):
        raise ValueError('Registered outward bundle identity or checksum mismatch')
    return bundle
