// Punch types layered on the core detector. Port of cv-mvp punch_type.py; keep the two
// in step.
//
// Two types: straight (either hand) and hook (either hand). A hook needs:
//   1. a raised elbow: upper arm (shoulder -> elbow) at least hook_elbow_angle from
//      hanging straight down (0 = down, 90 = level with the shoulder), and long enough
//      on screen that it is out to the side, not pointing at the camera;
//   2. the wrist moving from the shoulder line or wider back toward the midline.
// Straights keep the elbow down or the wrist in front, so they are labeled the moment
// the core detector fires. The core often fires during a hook's windup, before the
// inward sweep, so a raised elbow or wide wrist waits up to defer_ms. The wrist is
// followed with the pose model when a fast fist blurs out of the hand model. Without a
// visible elbow the wrist path decides alone. Hooks too flat for the core growth rule
// fire through a lateral trigger that shares the core hand cooldown.

import { validatePunchType, type DetectorConfig, type PunchTypeConfig } from './config';
import type { Detector, MotionEvent } from './detector';
import { handFeatures, pointOk, SIDES, type HandFeature, type Landmark, type LandmarkFrame, type Side } from './features';

const SHOULDER: Record<Side, number> = { left: 11, right: 12 };
const ELBOW: Record<Side, number> = { left: 13, right: 14 };
const POSE_WRIST: Record<Side, number> = { left: 15, right: 16 };
// Canonical unmirrored image: the player's left hand sits at larger x, so moving toward
// the midline decreases x for the left hand and increases it for the right.
const INWARD: Record<Side, number> = { left: -1, right: 1 };
const DEGREES = 180 / Math.PI;

export type PunchType = 'straight' | 'hook';

/** Per-frame forearm and fist measurements; null when not visible. */
type Arm = Record<string, number | boolean | string | null>;
type Measure = Record<string, unknown> & {
  inwardBodyWidths: number;
  logPalmGrowth: number;
  inwardSpeed: number;
  windowSpanMs: number;
  wristOutward: number | null;
  elbowRaisedAny: boolean | null;
  hookProbability?: number;
};
type Entry = [number, number, number | null, Arm]; // t, wrist x, palm size, arm

/** Least-squares d(value)/d(seconds) over (t_ms, value) pairs. */
function slope(points: [number, number][]) {
  const times = points.map(([t]) => (t - points[0][0]) / 1000);
  let sumT = 0;
  for (const t of times) sumT += t;
  let sumV = 0;
  for (const [, v] of points) sumV += v;
  const meanT = sumT / times.length;
  const meanV = sumV / points.length;
  let variance = 0;
  for (const t of times) variance += (t - meanT) ** 2;
  let s = 0;
  points.forEach(([, v], i) => (s += (times[i] - meanT) * (v - meanV)));
  return variance ? s / variance : 0;
}

const maxOf = (values: number[]) => (values.length ? Math.max(...values) : null);

export class PunchTyper {
  readonly cfg: PunchTypeConfig;
  history: Record<Side, Entry[]>;
  pending: [MotionEvent, Side][];
  private sweepLock: Record<Side, boolean>;
  scale: number | null;
  private lastT: number | null;

  constructor(config: PunchTypeConfig, private detectorCfg: DetectorConfig) {
    this.cfg = validatePunchType({ ...config });
    this.reset();
  }

  reset() {
    // Pending punches belong to the old reset generation, so they are dropped.
    this.history = { left: [], right: [] };
    this.pending = [];
    // Trigger lock per hand: set by any punch on that hand, cleared once the inward
    // sweep slows, so one sweep never fires twice whatever the cooldown.
    this.sweepLock = { left: false, right: false };
    this.scale = null;
    this.lastT = null;
  }

  private arm(record: LandmarkFrame, side: Side, aspect: number, pose: Landmark[], shouldersOk: boolean): Arm {
    const out: Arm = {
      forearmLength: null, forearmDx: null, forearmAngleDeg: null, elbowOutward: null,
      elbowRaised: null, knuckleRatio: null, knuckleDepth: null, forearmMissing: null,
      wristOutward: null, wristHeight: null, elbowHeight: null, elbowAngleDeg: null,
      upperArmLength: null, wristX: null,
    };
    const hs = (record.hands ?? []).filter(h => String(h.model_handedness ?? '').toLowerCase() === side);
    const pts = hs.length === 1 ? hs[0].landmarks ?? [] : [];
    let wrist = pts.length >= 18 && pointOk(pts[0]) ? pts[0] : null;
    if (!wrist && pose.length === 33 && pointOk(pose[POSE_WRIST[side]], this.cfg.min_elbow_visibility)) {
      wrist = pose[POSE_WRIST[side]]; // fast fists blur out of the hand model
    }
    if (wrist) out.wristX = wrist.x;
    if (pts.length >= 18 && [0, 5, 9, 17].every(i => pointOk(pts[i]))) {
      const dist = (a: Landmark, b: Landmark) => Math.hypot(a.x - b.x, aspect * (a.y - b.y));
      const length = dist(pts[0], pts[9]);
      if (length > 1e-5) {
        // Knuckles face the camera in a straight (wide 5-17 span); a hook turns the fist side-on.
        out.knuckleRatio = dist(pts[5], pts[17]) / length;
        out.knuckleDepth = Math.abs((pts[5].z ?? 0) - (pts[17].z ?? 0)) / length;
      }
    }
    if (!shouldersOk || !this.scale) {
      out.forearmMissing = 'shoulders_not_visible';
      return out;
    }
    const shoulder = pose[SHOULDER[side]];
    if (wrist) {
      // Needs only shoulders, which dodge tracking already requires. A hook's windup
      // takes the wrist wide of the shoulder line; a straight stays in front.
      out.wristOutward = (-INWARD[side] * (wrist.x - shoulder.x)) / this.scale;
      out.wristHeight = (aspect * (shoulder.y - wrist.y)) / this.scale;
    }
    const elbow = pose[ELBOW[side]];
    if (!pointOk(elbow, this.cfg.min_elbow_visibility)) {
      // Usually the elbow is below the frame: step back from the camera.
      const y = elbow.y ?? 2;
      out.forearmMissing = !(y >= 0 && y <= 1) ? 'elbow_out_of_frame' : 'elbow_low_visibility';
      out.elbowVisibility = elbow.visibility ?? null;
      return out;
    }
    out.elbowHeight = (aspect * (shoulder.y - elbow.y)) / this.scale; // + = above shoulder
    const ux = elbow.x - shoulder.x;
    const uy = aspect * (elbow.y - shoulder.y);
    const upperArm = Math.hypot(ux, uy) / this.scale;
    // 0 = hanging straight down, 90 = level with the shoulder, 180 = straight up.
    const angle = Math.atan2(Math.abs(ux), uy) * DEGREES;
    out.upperArmLength = upperArm;
    out.elbowAngleDeg = angle;
    out.elbowRaised = angle >= this.cfg.hook_elbow_angle && upperArm >= this.cfg.min_upper_arm;
    out.elbowOutward = (-INWARD[side] * (elbow.x - shoulder.x)) / this.scale;
    if (!wrist) {
      out.forearmMissing = 'wrist_not_visible';
      return out;
    }
    const dx = (wrist.x - elbow.x) / this.scale;
    const dy = (aspect * (wrist.y - elbow.y)) / this.scale;
    out.forearmLength = Math.hypot(dx, dy);
    out.forearmDx = Math.abs(dx);
    out.forearmAngleDeg = Math.atan2(Math.abs(dy), Math.abs(dx)) * DEGREES;
    return out;
  }

  private observe(record: LandmarkFrame) {
    const t = record.timestamp_ms;
    if (this.lastT !== null && t - this.lastT > this.cfg.max_gap_ms) this.history = { left: [], right: [] };
    this.lastT = t;
    const aspect = record.height / record.width;
    const pose = record.pose ?? [];
    const cfg = this.detectorCfg;
    const shouldersOk = pose.length === 33 && Object.values(SHOULDER).every(i => pointOk(pose[i], cfg.min_visibility));
    if (shouldersOk) {
      const width = Math.hypot(pose[11].x - pose[12].x, aspect * (pose[11].y - pose[12].y));
      if (cfg.min_body_width <= width && width <= cfg.max_body_width) this.scale = width;
    }
    const { hands } = handFeatures(record, cfg);
    for (const side of SIDES) {
      const hand = hands[side];
      const h = this.history[side];
      const arm = this.arm(record, side, aspect, pose, shouldersOk);
      if (arm.wristX === null) {
        // Neither model sees the wrist: keep the motion so far unless it stays lost
        // past the gap limit.
        if (h.length && t - h[h.length - 1][0] > this.cfg.max_gap_ms) h.length = 0;
        continue;
      }
      // Palm size (for growth) only exists when the hand model sees the fist.
      h.push([t, arm.wristX as number, hand ? hand.size : null, arm]);
      while (h.length > 2 && h[1][0] <= t - this.cfg.window_ms) h.shift();
    }
    return { t, hands };
  }

  measure(side: Side, t: number, windowMs: number): Measure | null {
    const h = this.history[side].filter(v => v[0] >= t - windowMs);
    if (h.length < 3 || !this.scale) return null;
    const xs = h.map(v => v[1]);
    const end = xs[xs.length - 1];
    // Inward travel from the window's most outward point, so the arc's start counts.
    const inward = (INWARD[side] < 0 ? Math.max(...xs) - end : end - Math.min(...xs)) / this.scale;
    const sizes = h.map(v => v[2]).filter((v): v is number => v !== null);
    const growth = sizes.length >= 2 ? Math.log(sizes[sizes.length - 1] / Math.min(...sizes)) : 0;
    let path = 0;
    for (let i = 1; i < xs.length; i++) path += Math.abs(xs[i] - xs[i - 1]);
    path /= this.scale;
    const m: Measure = {
      inwardBodyWidths: inward,
      logPalmGrowth: growth,
      inwardSpeed: (INWARD[side] * slope(h.map(v => [v[0], v[1]]))) / this.scale,
      lateralPathRatio: path / Math.max(Math.abs(growth), 0.05),
      windowSpanMs: h[h.length - 1][0] - h[0][0],
      wristOutward: null, // both set below, after the latest frame's arm fields
      elbowRaisedAny: null,
    };
    Object.assign(m, h[h.length - 1][3]);
    // A hook is widest at the top of its windup/arc: take the forearm frame with the
    // largest horizontal span (dx and angle together) and the widest wrist.
    const arms = h.map(v => v[3]).filter(a => a.forearmDx !== null && a.forearmAngleDeg !== null);
    if (arms.length) {
      let widest = arms[0];
      for (const a of arms) if ((a.forearmDx as number) > (widest.forearmDx as number)) widest = a;
      for (const k of ['forearmDx', 'forearmAngleDeg', 'forearmLength', 'elbowOutward']) m[k] = widest[k];
      m.forearmMissing = null;
    }
    m.wristOutward = maxOf(h.map(v => v[3].wristOutward).filter((v): v is number => v !== null));
    // Raised at any point in the window (null = elbow never visible).
    const raised = h.map(v => v[3].elbowRaised).filter(v => v !== null);
    m.elbowRaisedAny = raised.length ? raised.some(Boolean) : null;
    for (const key of ['elbowHeight', 'elbowAngleDeg', 'upperArmLength']) {
      m[key] = maxOf(h.map(v => v[3][key]).filter((v): v is number => v !== null));
    }
    m.elbowAngleNow = h[h.length - 1][3].elbowAngleDeg;
    return m;
  }

  private pathHook(m: Measure) {
    return m.inwardBodyWidths >= this.cfg.hook_min_inward
      && m.inwardBodyWidths >= this.cfg.hook_growth_ratio * Math.max(m.logPalmGrowth, 0);
  }

  /** 'hook', 'straight', or null when the evidence is in the ambiguous band. */
  decide(m: Measure | null): PunchType | null {
    if (!m) return 'straight';
    const c = this.cfg;
    const model = c.model;
    if (model) {
      let z = model.bias;
      model.features.forEach((name, i) => {
        const value = m[name] as number | null | undefined;
        z += model.weights[i] * (value == null ? 0 : (value - model.mean[i]) / (model.std[i] || 1));
      });
      const p = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
      m.hookProbability = p;
      return p >= 0.65 ? 'hook' : p <= 0.35 ? 'straight' : null;
    }
    if (m.wristOutward === null) return this.pathHook(m) ? 'hook' : 'straight';
    const raised = m.elbowRaisedAny;
    const wide = m.wristOutward >= c.hook_wrist_outside;
    // Elbow down, or (elbow unseen and) wrist in front: a straight, no wait.
    if (raised === false || (raised === null && !wide)) return 'straight';
    // Raised elbow or wide wrist: a hook once the wrist sweeps in from wide.
    return wide && this.sweeping(m) ? 'hook' : null;
  }

  private sweeping(m: Measure, fraction = 1) {
    return m.inwardBodyWidths >= this.cfg.hook_sweep * fraction && m.inwardSpeed > 0;
  }

  final(m: Measure | null): PunchType {
    const label = this.decide(m);
    if (label !== null) return label;
    if (m.hookProbability != null) return m.hookProbability >= 0.5 ? 'hook' : 'straight';
    // Out of time: a partial sweep in from wide still counts as a hook.
    const wide = m.wristOutward !== null && m.wristOutward >= this.cfg.hook_wrist_outside;
    return wide && this.sweeping(m, 0.5) ? 'hook' : 'straight';
  }

  private label(event: MotionEvent, m: Measure | null, final: boolean, waited: number) {
    const label = final ? this.final(m) : this.decide(m);
    if (label === null) return false;
    event.punchType = label;
    event.features.punchClass = { ...(m ?? {}), deferredMs: waited };
    return true;
  }

  /**
   * The events to publish now: non-punch events, labeled punches (some held from
   * earlier frames), and extra hook trigger events.
   */
  process(record: LandmarkFrame, nativeEvents: MotionEvent[], detector: Detector, detectedMs?: number): MotionEvent[] {
    const { t, hands } = this.observe(record);
    const out: MotionEvent[] = [];
    const busy = new Set<Side>();
    const still: [MotionEvent, Side][] = [];
    for (const [event, side] of this.pending) {
      const waited = t - event.sampleMs;
      const final = waited >= this.cfg.defer_ms;
      if (this.label(event, this.measure(side, t, this.cfg.window_ms), final, waited)) out.push(event);
      else still.push([event, side]);
      busy.add(side); // this hand already has a punch; never add a trigger hook
    }
    this.pending = still;
    for (const e of nativeEvents) {
      if (!e.type.startsWith('punch_')) {
        out.push(e);
        continue;
      }
      const side = e.type.slice('punch_'.length) as Side;
      if (this.label(e, this.measure(side, t, this.cfg.window_ms), this.cfg.defer_ms <= 0, 0)) out.push(e);
      else this.pending.push([e, side]);
      busy.add(side);
    }
    if (this.cfg.hook_trigger) out.push(...this.trigger(t, hands, detector, detectedMs, busy));
    return out;
  }

  private trigger(t: number, hands: Partial<Record<Side, HandFeature>>, detector: Detector, detectedMs: number | undefined, busy: Set<Side>) {
    const extra: MotionEvent[] = [];
    const window = this.cfg.trigger_window_ms;
    for (const side of SIDES) {
      if (busy.has(side)) {
        this.sweepLock[side] = true;
      } else if (this.sweepLock[side]) {
        const m = this.measure(side, t, window);
        if (!m || m.inwardSpeed < this.cfg.trigger_speed * 0.5) this.sweepLock[side] = false;
        continue;
      }
      const state = detector.hands[side];
      if (busy.has(side) || !this.history[side].length || state.latched || t - state.lastFire < detector.cfg.cooldown_ms) continue;
      const m = this.measure(side, t, window);
      // Stricter than classification: a fast inward sweep the rule calls a clear hook.
      if (!m || m.windowSpanMs < window * 0.75) continue;
      if (m.inwardSpeed < this.cfg.trigger_speed || this.decide(m) !== 'hook') continue;
      const onset = this.history[side].find(v => v[0] >= t - window)?.[0] ?? t;
      const event = detector.event(`punch_${side}`, onset, t, detectedMs ?? t, {
        rule: 'hook_lateral', handednessScore: hands[side]?.handednessScore ?? null,
        punchClass: { ...m, deferredMs: 0 },
      });
      event.punchType = 'hook';
      // Share the core per-hand cooldown/release so one hook never fires twice.
      Object.assign(state, { latched: true, releaseSince: null, lastFire: t });
      this.sweepLock[side] = true;
      extra.push(event);
    }
    return extra;
  }
}
