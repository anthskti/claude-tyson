// Rolling hand bursts and independent head dodges. No camera/model dependencies.
// Port of cv-mvp core/detector.py; keep the two in step.

import { validateDetector, type DetectorConfig } from './config';
import { bodyFeatures, handFeatures, SIDES, type HandFeature, type LandmarkFrame, type Side } from './features';

export interface MotionEvent {
  schemaVersion: number;
  eventId: string;
  sessionId: string;
  type: string;
  onsetMs: number;
  sampleMs: number;
  detectedMs: number;
  sideConvention: 'player_anatomical';
  trackingState: string;
  qualityScore: null;
  qualityKind: 'not_estimated';
  features: Record<string, unknown>;
  calibrationId: string | null;
  experimental: true;
  punchType?: 'straight' | 'hook';
  [extra: string]: unknown;
}

export interface HandState {
  history: [number, number, number, number][]; // t, x, y, size
  lastFire: number;
  latched: boolean;
  releaseSince: number | null;
}

interface Calibration {
  id: string;
  timestamp_ms: number;
  head_x: number;
  scale: number;
}

type DodgePhase = 'unarmed' | 'ready' | 'active';

export interface NativeOutput {
  features: Record<string, unknown>;
  markers: Record<string, { x: number; y: number }>;
  validity: Record<string, boolean>;
  dodgeReadiness: Record<string, unknown> & { state: string; reason?: string };
  calibrationId: string | null;
  phases: Record<string, string>;
  punchReadiness: Record<string, string>;
}

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

function median(values: number[]) {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Least-squares slopes use real source seconds, not assumed camera FPS. */
function regression(history: HandState['history']): [number, number] {
  const times = history.map(v => (v[0] - history[0][0]) / 1000);
  const meanT = mean(times);
  let variance = 0;
  for (const t of times) variance += (t - meanT) ** 2;
  const slopes = [1, 2, 3].map(i => {
    const m = mean(history.map(row => row[i]));
    let s = 0;
    history.forEach((v, j) => (s += (times[j] - meanT) * (v[i] - m)));
    return s / variance;
  });
  return [slopes[2] / mean(history.map(v => v[3])), Math.hypot(slopes[0], slopes[1])];
}

export const randomSessionId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(6)), b => b.toString(16).padStart(2, '0')).join('');

export class Detector {
  readonly cfg: DetectorConfig;
  readonly sessionId: string;
  serial = 0;
  private calibrationSerial = 0;
  private lastT: number | null = null;
  hands: Record<Side, HandState>;
  calibration: Calibration | null = null;
  private headSamples: [number, number, number, number][] = [];
  private headFilter: [number, number] | null = null;
  private bodyLossSince: number | null = null;
  dodge: { phase: DodgePhase; since: number | null; side: Side | null };

  constructor(config: DetectorConfig, sessionId = randomSessionId()) {
    this.cfg = validateDetector({ ...config });
    this.sessionId = sessionId;
    this.hands = { left: Detector.handState(), right: Detector.handState() };
    this.resetCalibration();
  }

  private static handState(lastFire = -1e12): HandState {
    return { history: [], lastFire, latched: false, releaseSince: null };
  }

  private freshHands() {
    this.hands = { left: Detector.handState(this.hands.left.lastFire), right: Detector.handState(this.hands.right.lastFire) };
  }

  resetCalibration() {
    // Manual reset starts fresh history but cannot bypass an existing cooldown.
    this.freshHands();
    this.calibration = null;
    this.headSamples = [];
    this.headFilter = null;
    this.bodyLossSince = null;
    this.dodge = { phase: 'unarmed', since: null, side: null };
  }

  event(kind: string, onset: number, t: number, detected: number, features: Record<string, unknown>): MotionEvent {
    this.serial += 1;
    const punch = kind.startsWith('punch_');
    return {
      schemaVersion: 2, eventId: `${this.sessionId}-${String(this.serial).padStart(6, '0')}`, sessionId: this.sessionId,
      type: kind, onsetMs: onset, sampleMs: t, detectedMs: detected,
      sideConvention: 'player_anatomical', trackingState: punch ? 'hand_valid' : 'body_valid',
      qualityScore: null, qualityKind: 'not_estimated', features,
      calibrationId: punch ? null : this.calibration!.id, experimental: true,
    };
  }

  private punch(side: Side, hand: HandFeature | undefined, t: number, detected: number) {
    const c = this.cfg;
    let s = this.hands[side];
    if (!hand) {
      this.hands[side] = Detector.handState(s.lastFire);
      return { phase: 'warming', event: null, growthRate: undefined, movementSpeed: undefined };
    }
    let history = s.history;
    if (history.length && t - history[history.length - 1][0] > c.max_gap_ms) {
      s = this.hands[side] = Detector.handState(s.lastFire);
      history = s.history;
    }
    history.push([t, hand.x, hand.y, hand.size]);
    while (history.length > 2 && history[1][0] <= t - c.window_ms) history.shift();
    const span = t - history[0][0];
    const ready = history.length >= 4 && span >= c.window_ms;
    const [growth, speed] = ready ? regression(history) : [0, 0];
    // Release refers only to a local slowdown, never a position or guard size.
    if (s.latched && ready) {
      if (growth < c.growth_enter * c.release_fraction) {
        s.releaseSince ??= t;
        if (t - s.releaseSince >= c.release_ms) {
          s.latched = false;
          s.releaseSince = null;
        }
      } else {
        s.releaseSince = null;
      }
    }
    const elapsed = t - s.lastFire;
    const fired = span >= c.window_ms && history.length >= 4 && growth >= c.growth_enter && speed >= c.speed_enter
      && Math.max(0, c.cooldown_ms - elapsed) <= 0 && !s.latched;
    let event: MotionEvent | null = null;
    if (fired) {
      event = this.event(`punch_${side}`, history[0][0], t, detected, {
        rule: 'recent_hand_motion', growthRate: growth, movementSpeed: speed,
        windowSpanMs: span, handednessScore: hand.handednessScore,
      });
      s.latched = true;
      s.releaseSince = null;
      s.lastFire = t;
    }
    const phase = !ready ? 'warming' : s.latched ? 'latched' : elapsed < c.cooldown_ms ? 'cooldown' : 'ready';
    return { phase, event, growthRate: growth, movementSpeed: speed };
  }

  private head(record: LandmarkFrame, t: number, detected: number, out: NativeOutput): MotionEvent[] {
    const c = this.cfg;
    const { body, reason } = bodyFeatures(record, c);
    if (!body) {
      this.headSamples = [];
      this.headFilter = null;
      this.dodge = { phase: 'unarmed', since: null, side: null };
      this.bodyLossSince ??= t;
      if (t - this.bodyLossSince >= c.recalibrate_after_loss_ms) this.calibration = null;
      out.dodgeReadiness = { state: 'unavailable', reason };
      return [];
    }
    this.bodyLossSince = null;
    if (!this.calibration) {
      const samples = this.headSamples;
      samples.push([t, body.head.x, body.head.y, body.scale]);
      while (samples.length > 2 && samples[1][0] <= t - c.head_init_ms) samples.shift();
      const scale = median(samples.map(v => v[3]));
      const stable = Math.max(...[1, 2, 3].map(i => {
        const values = samples.map(v => v[i]);
        return (Math.max(...values) - Math.min(...values)) * (i === 2 ? record.height / record.width : 1) / scale;
      })) <= c.head_jitter;
      if (t - samples[0][0] >= c.head_init_ms && samples.length >= 4 && stable) {
        this.calibrationSerial += 1;
        this.calibration = {
          id: `${this.sessionId}-head-${this.calibrationSerial}`, timestamp_ms: t,
          head_x: median(samples.map(v => v[1])), scale,
        };
      } else {
        out.dodgeReadiness = { state: 'warming', reason: 'Hold head centered briefly', elapsedMs: t - samples[0][0], stable };
        return [];
      }
    }
    out.validity.dodge = true;
    out.dodgeReadiness = { state: 'ready', reason: 'Head reference available' };
    out.markers.head = body.head;
    let x = -(body.head.x - this.calibration.head_x) / this.calibration.scale;
    if (this.headFilter) {
      const [oldT, oldX] = this.headFilter;
      const alpha = !c.smoothing_ms ? 1 : 1 - Math.exp(-(t - oldT) / c.smoothing_ms);
      x = oldX + alpha * (x - oldX);
    }
    this.headFilter = [t, x];
    out.features.lateralDisplacementBodyWidths = x;
    const s = this.dodge;
    const events: MotionEvent[] = [];
    if (s.phase === 'unarmed') {
      if (Math.abs(x) <= c.dodge_exit) {
        s.since ??= t;
        if (t - s.since >= c.rearm_ms) Object.assign(s, { phase: 'ready', since: null });
      } else {
        s.since = null;
      }
    } else if (s.phase === 'ready') {
      if (Math.abs(x) >= c.dodge_enter) {
        const side: Side = x < 0 ? 'left' : 'right';
        if (s.side !== side || s.since === null) Object.assign(s, { side, since: t });
        if (t - s.since >= c.dodge_hold_ms) {
          events.push(this.event(`dodge_${side}`, s.since, t, detected, { lateralDisplacementBodyWidths: x }));
          Object.assign(s, { phase: 'active', since: null });
        }
      } else {
        Object.assign(s, { since: null, side: null });
      }
    } else if (Math.abs(x) <= c.dodge_exit) {
      s.since ??= t;
      if (t - s.since >= c.rearm_ms) {
        events.push(this.event('return_neutral', s.since, t, detected, { fromSide: s.side }));
        Object.assign(s, { phase: 'ready', since: null, side: null });
      }
    } else {
      s.since = null;
    }
    return events;
  }

  process(record: LandmarkFrame, detectedMs?: number): [NativeOutput, MotionEvent[]] {
    const t = record.timestamp_ms;
    if (!Number.isFinite(t) || (this.lastT !== null && t <= this.lastT)) {
      throw new Error('Detector requires strictly increasing finite timestamps');
    }
    if (record.width <= 0 || record.height <= 0) throw new Error('Frame dimensions must be positive');
    if (this.lastT !== null && t - this.lastT > this.cfg.max_gap_ms) {
      this.freshHands();
      this.headSamples = [];
      this.headFilter = null;
      this.dodge = { phase: 'unarmed', since: null, side: null };
      if (t - this.lastT >= this.cfg.recalibrate_after_loss_ms) this.calibration = null;
    }
    this.lastT = t;
    const detected = detectedMs ?? t;
    const { hands } = handFeatures(record, this.cfg);
    const out: NativeOutput = {
      features: {}, markers: {}, validity: {}, dodgeReadiness: { state: 'unavailable' },
      calibrationId: null, phases: {}, punchReadiness: {},
    };
    const events: MotionEvent[] = [];
    const phases: Record<string, string> = {};
    for (const side of SIDES) {
      const hand = hands[side];
      const d = this.punch(side, hand, t, detected);
      phases[side] = d.phase;
      out.validity[`punch_${side}`] = !!hand;
      out.features[side] = { growthRate: d.growthRate ?? 0, movementSpeed: d.movementSpeed ?? 0 };
      if (hand) out.markers[side] = hand.marker;
      if (d.event) events.push(d.event);
    }
    events.push(...this.head(record, t, detected, out));
    out.calibrationId = this.calibration?.id ?? null;
    out.phases = { dodge: this.dodge.phase, ...phases };
    out.punchReadiness = phases;
    return [out, events];
  }
}
