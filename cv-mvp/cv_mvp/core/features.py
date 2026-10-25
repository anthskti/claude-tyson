"""Independent 2D hand and body measurements; inferred z never gates scoring."""
import math

SIDES = ('left', 'right')
PALM = (0, 5, 9, 13, 17)


def display_xy(point, mirror=True):
    return (1-point['x'] if mirror else point['x'], point['y'])


def point_ok(point, threshold=0):
    return (all(isinstance(point.get(k), (int, float)) and math.isfinite(point[k])
                and 0 <= point[k] <= 1 for k in ('x', 'y'))
            and all(isinstance(point.get(k, 0), (int, float)) and math.isfinite(point.get(k, 0))
                    and point.get(k, 0) >= threshold for k in ('visibility', 'presence')))


def hand_features(record, cfg):
    """Tasks handedness names are retained as anatomical sides on canonical input.

    No index-based identity and no Pose dependency. Duplicate side assignments are
    rejected rather than joining two people's/hands' motion histories.
    """
    aspect = record['height']/record['width']
    candidates = {s: [] for s in SIDES}
    unknown = False
    for hand in record.get('hands', []):
        side = str(hand.get('model_handedness', '')).lower()
        if side not in candidates:
            unknown = True
        else:
            candidates[side].append(hand)
    result, reasons = {}, {}
    for side, hands in candidates.items():
        reason = 'Ambiguous handedness' if unknown else 'No hand detected' if not hands else None
        if len(hands) > 1:
            reason = 'Duplicate handedness assignment'
        if reason:
            reasons[side] = reason
            continue
        hand = hands[0]
        score = hand.get('handedness_score', 0)
        if not isinstance(score, (int, float)) or not math.isfinite(score) or score < cfg.min_handedness_score:
            reasons[side] = 'Handedness uncertain'
            continue
        pts = hand.get('landmarks', [])
        if len(pts) < 18 or not all(point_ok(pts[i]) for i in PALM):
            reasons[side] = 'Palm points missing, invalid or outside image'
            continue
        distance = lambda a, b: math.hypot(a['x']-b['x'], aspect*(a['y']-b['y']))
        size = math.sqrt((sum(distance(pts[0], pts[i])**2 for i in PALM[1:])
                          + distance(pts[5], pts[17])**2)/5)
        if size < 1e-5:
            reasons[side] = 'Palm size too small to measure'
            continue
        center = {k: sum(pts[i][k] for i in PALM)/len(PALM) for k in ('x', 'y')}
        result[side] = {'x': center['x'], 'y': aspect*center['y'], 'size': size,
                        'marker': center, 'handednessScore': score}
    return result, reasons


def body_features(record, cfg):
    pose = record.get('pose', [])
    if len(pose) != 33 or not all(point_ok(pose[i], cfg.min_visibility) for i in (0, 11, 12)):
        return None, 'Head/shoulders unavailable'
    aspect = record['height']/record['width']
    width = math.hypot(pose[11]['x']-pose[12]['x'], aspect*(pose[11]['y']-pose[12]['y']))
    if not cfg.min_body_width <= width <= cfg.max_body_width:
        return None, 'Body framing outside supported range'
    if pose[11]['x'] <= pose[12]['x']:
        return None, 'Face camera; check input orientation'
    return {'head': pose[0], 'scale': width}, None
