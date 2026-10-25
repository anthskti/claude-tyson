from dataclasses import dataclass

@dataclass
class Config:
    max_gap_ms: int = 250
    head_init_ms: int = 500
    min_visibility: float = 0.65
    min_body_width: float = 0.10
    max_body_width: float = 0.65
    head_jitter: float = 0.08
    smoothing_ms: float = 35
    dodge_enter: float = 0.24
    dodge_exit: float = 0.10
    dodge_hold_ms: int = 65
    rearm_ms: int = 150
    recalibrate_after_loss_ms: int = 2000
