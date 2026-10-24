// Detector and punch-type tuning, ported from cv-mvp (core/config.py, punch_type.py).
// Keys keep the Python snake_case names so the same JSON files load on both sides.
// game.json is a copy of cv-mvp/configs/game.json; keep the two in step.

import game from './game.json';

export interface DetectorConfig {
  window_ms: number;
  growth_enter: number; // fractional palm-size change / second
  speed_enter: number; // image widths / second
  cooldown_ms: number; // independent for each hand
  release_fraction: number;
  release_ms: number;
  max_gap_ms: number;
  min_handedness_score: number; // identity evidence, not punch confidence
  head_init_ms: number;
  min_visibility: number;
  min_body_width: number;
  max_body_width: number;
  head_jitter: number; // shoulder widths
  smoothing_ms: number; // head only
  dodge_enter: number;
  dodge_exit: number;
  dodge_hold_ms: number;
  rearm_ms: number;
  recalibrate_after_loss_ms: number;
}

export const HARNESS_CONFIG: DetectorConfig = {
  window_ms: 120,
  growth_enter: 1.5,
  speed_enter: 0.25,
  cooldown_ms: 170,
  release_fraction: 0.5,
  release_ms: 40,
  max_gap_ms: 250,
  min_handedness_score: 0.6,
  head_init_ms: 500,
  min_visibility: 0.65,
  min_body_width: 0.1,
  max_body_width: 0.65,
  head_jitter: 0.08,
  smoothing_ms: 35,
  dodge_enter: 0.24,
  dodge_exit: 0.1,
  dodge_hold_ms: 65,
  rearm_ms: 150,
  recalibrate_after_loss_ms: 2000,
};

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Game timing: shorter per-hand cooldown/release than the harness defaults. */
export const GAME_CONFIG: DetectorConfig = validateDetector({ ...HARNESS_CONFIG, ...game });

export function validateDetector(c: DetectorConfig): DetectorConfig {
  for (const [key, value] of Object.entries(c)) {
    if (!finite(value) || value < 0) throw new Error(`${key} must be a finite nonnegative number`);
  }
  if (Math.min(c.window_ms, c.growth_enter, c.speed_enter, c.head_init_ms, c.max_gap_ms) <= 0) {
    throw new Error('History, activation thresholds and head initialization must be positive');
  }
  if (!(0 < c.release_fraction && c.release_fraction < 1) || !(0 < c.min_handedness_score && c.min_handedness_score <= 1)) {
    throw new Error('Invalid release fraction or handedness threshold');
  }
  if (!(0 < c.dodge_exit && c.dodge_exit < c.dodge_enter) || !(0 < c.min_visibility && c.min_visibility <= 1)) {
    throw new Error('Invalid dodge/confidence thresholds');
  }
  if (!(0 < c.min_body_width && c.min_body_width < c.max_body_width && c.max_body_width < 1)) {
    throw new Error('Invalid framing bounds');
  }
  return c;
}

/** Optional logistic model written by cv-mvp/scripts/fit_punch_types.py. */
export interface PunchModel {
  features: string[];
  mean: number[];
  std: number[];
  weights: number[];
  bias: number;
}

export interface PunchTypeConfig {
  window_ms: number; // lookback for classifying a fired punch
  defer_ms: number; // max wait for a hook's sweep after a raised elbow / wide wrist
  hook_elbow_angle: number; // degrees from hanging down; 90 = shoulder level
  min_upper_arm: number; // shoulder widths on screen; shorter = pointing at camera
  hook_wrist_outside: number; // wrist near (or past) the shoulder line = wide
  hook_sweep: number; // inward wrist travel (shoulder widths) from its widest point
  hook_min_inward: number; // path fallback when the wrist/shoulders are not measured
  hook_growth_ratio: number; // inward must beat log palm growth by this
  min_elbow_visibility: number;
  hook_trigger: boolean; // fire flat hooks the core growth rule misses
  trigger_window_ms: number;
  trigger_speed: number; // shoulder widths / second toward the midline
  max_gap_ms: number;
  model: PunchModel | null;
}

export const PUNCH_FEATURES = [
  'inwardBodyWidths', 'logPalmGrowth', 'inwardSpeed', 'lateralPathRatio',
  'wristOutward', 'wristHeight', 'elbowHeight', 'elbowAngleDeg', 'upperArmLength',
  'forearmLength', 'forearmDx', 'forearmAngleDeg', 'elbowOutward',
  'knuckleRatio', 'knuckleDepth',
];

export const PUNCH_TYPE_CONFIG: PunchTypeConfig = {
  window_ms: 200,
  defer_ms: 150,
  hook_elbow_angle: 55,
  min_upper_arm: 0.3,
  hook_wrist_outside: -0.1,
  hook_sweep: 0.1,
  hook_min_inward: 0.4,
  hook_growth_ratio: 1.2,
  min_elbow_visibility: 0.5,
  hook_trigger: true,
  trigger_window_ms: 120,
  trigger_speed: 1.6,
  max_gap_ms: 250,
  model: null,
};

export function validatePunchType(c: PunchTypeConfig): PunchTypeConfig {
  for (const [key, value] of Object.entries(c)) {
    if (key === 'hook_trigger' || key === 'model' || key === 'hook_wrist_outside') continue; // may be negative
    if (!finite(value) || value <= 0) throw new Error(`${key} must be a finite positive number`);
  }
  if (typeof c.hook_trigger !== 'boolean') throw new Error('hook_trigger must be true or false');
  const m = c.model;
  if (m) {
    const n = Array.isArray(m.features) ? m.features.length : 0;
    if (!n || m.features.some(f => !PUNCH_FEATURES.includes(f))
      || [m.mean, m.std, m.weights].some(a => !Array.isArray(a) || a.length !== n) || !finite(m.bias)) {
      throw new Error('model needs features, mean, std, weights of equal length and a bias');
    }
  }
  return c;
}
