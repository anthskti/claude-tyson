// Block detection for camera input, from the head and wrist markers the CV bridge already
// streams. Each wrist is measured relative to the head and compared against the player's
// own calibrated stance and block positions, so it works for any guard style.

import type { Guard, Marker } from './contract';

type Hand = 'left' | 'right';
type Vec = { x: number; y: number };

export interface CameraMarkers {
  head?: Marker;
  left?: Marker;
  right?: Marker;
}

export interface GuardCalibrationData {
  stance: Record<Hand, Vec>;
  block: Record<Hand, Vec>;
}

const HANDS: Hand[] = ['left', 'right'];
const HEAD_HOLD_MS = 1500; // a raised glove often hides the nose; reuse the last head briefly
const HAND_HOLD_MS = 400; // keep a block through short hand-tracking dropouts
// Ratio of distance-to-block over distance-to-stance. Hysteresis stops flicker at the midpoint.
const BLOCK_ENTER = 0.7;
const BLOCK_EXIT = 1.0;
const MIN_SEPARATION = 0.04; // normalized image units between stance and block centroids

const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);

/** Wrist position relative to the head, falling back to the last head seen. */
class Relative {
  private head?: Marker;
  private headAt = -Infinity;

  of(m: CameraMarkers, hand: Hand, now: number): Vec | undefined {
    if (m.head) {
      this.head = m.head;
      this.headAt = now;
    }
    const wrist = m[hand];
    if (!wrist || !this.head || now - this.headAt > HEAD_HOLD_MS) return undefined;
    return { x: wrist.x - this.head.x, y: wrist.y - this.head.y };
  }
}

export class GuardClassifier {
  private rel = new Relative();
  private state: Record<Hand, Guard> = { left: 'neutral', right: 'neutral' };
  private seenAt: Record<Hand, number> = { left: -Infinity, right: -Infinity };

  constructor(private calib: GuardCalibrationData) {}

  update(m: CameraMarkers, now: number): Record<Hand, Guard> {
    for (const hand of HANDS) {
      const v = this.rel.of(m, hand, now);
      if (!v) {
        if (now - this.seenAt[hand] > HAND_HOLD_MS) this.state[hand] = 'neutral';
        continue;
      }
      this.seenAt[hand] = now;
      const ratio = dist(v, this.calib.block[hand]) / Math.max(1e-6, dist(v, this.calib.stance[hand]));
      if (this.state[hand] === 'neutral' && ratio < BLOCK_ENTER) this.state[hand] = 'block';
      else if (this.state[hand] === 'block' && ratio > BLOCK_EXIT) this.state[hand] = 'neutral';
    }
    return { ...this.state };
  }
}

// ─── Calibration ──────────────────────────────────────────────────────────────

export type CalibrationStep = 'frame' | 'stance' | 'block' | 'done';

export interface CalibrationView {
  step: CalibrationStep;
  title: string;
  hint: string;
  progress: number; // 0..1 within the step
  seen: { head: boolean; left: boolean; right: boolean };
  error?: string;
}

const IN_FRAME_MS = 600;
const PREP_MS = 1000; // time to get into position before capture starts
const CAPTURE_MS = 1500;
const MIN_SAMPLES = 8;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/**
 * Three quick steps, fed with every camera observation: get in frame, hold your stance,
 * hold your block. `onStance` fires when the stance step begins so the bridge can reset
 * its head reference (dodge neutral) while the player stands still.
 */
export class GuardCalibration {
  private step: CalibrationStep = 'frame';
  private stepAt = performance.now();
  private framedSince: number | null = null;
  private samples: Record<Hand, Vec[]> = { left: [], right: [] };
  private stance?: Record<Hand, Vec>;
  private error?: string;
  private rel = new Relative();
  private seen = { head: false, left: false, right: false };

  constructor(private hooks: { onStance(): void; onDone(data: GuardCalibrationData): void }) {}

  view(): CalibrationView {
    const now = performance.now();
    const base = { step: this.step, seen: this.seen, error: this.error };
    switch (this.step) {
      case 'frame':
        return { ...base, title: 'Step into frame', hint: 'Stand back until your head and both hands show in the camera box.',
          progress: this.framedSince === null ? 0 : Math.min(1, (now - this.framedSince) / IN_FRAME_MS) };
      case 'stance':
        return { ...base, title: 'Fighting stance', hint: 'Hands in your normal guard. Hold still.', progress: this.captureProgress(now) };
      case 'block':
        return { ...base, title: 'Block', hint: 'Gloves up, covering your face. Hold it.', progress: this.captureProgress(now) };
      case 'done':
        return { ...base, title: 'Calibrated', hint: '', progress: 1 };
    }
  }

  feed(m: CameraMarkers, now: number) {
    this.seen = { head: !!m.head, left: !!m.left, right: !!m.right };
    if (this.step === 'frame') {
      const framed = this.seen.head && this.seen.left && this.seen.right;
      this.framedSince = framed ? (this.framedSince ?? now) : null;
      if (this.framedSince !== null && now - this.framedSince >= IN_FRAME_MS) {
        this.next('stance', now);
        this.hooks.onStance();
      }
      return;
    }
    if (this.step !== 'stance' && this.step !== 'block') return;
    const elapsed = now - this.stepAt;
    if (elapsed < PREP_MS) return;
    for (const hand of HANDS) {
      const v = this.rel.of(m, hand, now);
      if (v) this.samples[hand].push(v);
    }
    if (elapsed < PREP_MS + CAPTURE_MS) return;

    if (HANDS.some(h => this.samples[h].length < MIN_SAMPLES)) {
      this.retry(now, "Couldn't see both hands. Keep them in the camera box and try again.");
      return;
    }
    const centroid = Object.fromEntries(
      HANDS.map(h => [h, { x: median(this.samples[h].map(v => v.x)), y: median(this.samples[h].map(v => v.y)) }]),
    ) as Record<Hand, Vec>;
    if (this.step === 'stance') {
      this.stance = centroid;
      this.next('block', now);
      return;
    }
    if (HANDS.some(h => dist(centroid[h], this.stance![h]) < MIN_SEPARATION)) {
      this.retry(now, 'Your block looked like your stance. Bring both gloves up to your face.');
      return;
    }
    this.next('done', now);
    this.hooks.onDone({ stance: this.stance!, block: centroid });
  }

  private captureProgress(now: number) {
    return Math.max(0, Math.min(1, (now - this.stepAt - PREP_MS) / CAPTURE_MS));
  }

  private next(step: CalibrationStep, now: number) {
    this.step = step;
    this.stepAt = now;
    this.samples = { left: [], right: [] };
    this.error = undefined;
  }

  private retry(now: number, error: string) {
    this.stepAt = now;
    this.samples = { left: [], right: [] };
    this.error = error;
  }
}
