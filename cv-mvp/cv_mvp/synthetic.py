"""Deterministic test landmarks. Generated locally; never represent camera evidence."""

import math


def frame(t):
    phase = (t % 6000) / 1000

    def pt(x, y):
        return dict(x=x, y=y, z=0.0, visibility=0.99, presence=0.99)

    pose = [pt(0.5, 0.5) for _ in range(33)]
    pose[0] = pt(0.62 if 3.4 < phase < 4.1 else 0.5, 0.25)
    pose[11], pose[12] = pt(0.65, 0.50), pt(0.35, 0.50)
    hands = []
    for side, center, start, direction in [
        ("Left", 0.65, 1.2, -1),
        ("Right", 0.35, 2.3, 1),
    ]:
        u = phase - start
        amount = max(0, min(u, 0.25)) if u < 0.45 else max(0, 0.25 - (u - 0.45))
        size = 0.04 * math.exp(4 * amount)
        x = center + direction * amount * 0.6
        points = [pt(x, 0.4) for _ in range(21)]
        for i, dx, dy in [
            (0, 0, 0.8),
            (5, -0.6, 0),
            (9, 0, -0.6),
            (13, 0.3, -0.3),
            (17, 0.6, 0),
        ]:
            points[i] = pt(x + dx * size, 0.4 + dy * size)
        hands.append(
            dict(landmarks=points, model_handedness=side, handedness_score=0.99)
        )
    return dict(
        kind="frame",
        synthetic=True,
        timestamp_ms=t,
        width=640,
        height=480,
        pose=pose,
        hands=hands,
    )
