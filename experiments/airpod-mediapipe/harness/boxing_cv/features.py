import math
def point_ok(point, threshold=0):
    return (all(isinstance(point.get(k), (int, float)) and math.isfinite(point[k])
                and 0 <= point[k] <= 1 for k in ('x', 'y'))
            and all(isinstance(point.get(k, 0), (int, float)) and math.isfinite(point.get(k, 0))
                    and point.get(k, 0) >= threshold for k in ('visibility', 'presence')))

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
