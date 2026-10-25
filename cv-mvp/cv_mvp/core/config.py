"""The active detector's tuning. All durations use source milliseconds."""
from dataclasses import asdict, dataclass
import json
import math
from pathlib import Path


@dataclass
class Config:
    window_ms: int = 120
    growth_enter: float = 1.5           # fractional palm-size change / second
    speed_enter: float = 0.25           # image widths / second
    cooldown_ms: int = 170              # independent for each hand
    release_fraction: float = 0.5
    release_ms: int = 40
    max_gap_ms: int = 250
    min_handedness_score: float = 0.6   # identity evidence, not punch confidence
    head_init_ms: int = 500
    min_visibility: float = 0.65
    min_body_width: float = 0.10
    max_body_width: float = 0.65
    head_jitter: float = 0.08           # shoulder widths
    smoothing_ms: float = 35           # head only
    dodge_enter: float = 0.24
    dodge_exit: float = 0.10
    dodge_hold_ms: int = 65
    rearm_ms: int = 150
    recalibrate_after_loss_ms: int = 2000

    def validate(self):
        for key, value in asdict(self).items():
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
                raise ValueError(f'{key} must be a finite nonnegative number')
        if min(self.window_ms, self.growth_enter, self.speed_enter, self.head_init_ms, self.max_gap_ms) <= 0:
            raise ValueError('History, activation thresholds and head initialization must be positive')
        if not 0 < self.release_fraction < 1 or not 0 < self.min_handedness_score <= 1:
            raise ValueError('Invalid release fraction or handedness threshold')
        if not 0 < self.dodge_exit < self.dodge_enter or not 0 < self.min_visibility <= 1:
            raise ValueError('Invalid dodge/confidence thresholds')
        if not 0 < self.min_body_width < self.max_body_width < 1:
            raise ValueError('Invalid framing bounds')
        return self

    @classmethod
    def load(cls, path=None):
        return cls(**(json.loads(Path(path).read_text()) if path else {})).validate()
