import type {
  Body,
  CvProvider,
  Guard,
  MotionEvent,
  MotionEventType,
  Observation,
  PunchType,
  TrackingState,
} from './contract';

// Keyboard stand-in for the real CV provider. Emits contract-shaped observations at
// ~30 Hz and discrete MotionEvents, so the rest of the game can't tell the difference.
//
//   Body (hold)    A slip left · D slip right
//   Guard (hold)   Q left block · E right block · W both
//   Left fist      J left straight · U left hook
//   Right fist     K right straight · I right hook
//   T toggle tracking lost · C recalibrate

export const SIM_KEYS: Record<string, { hand: 'left' | 'right'; type: PunchType }> = {
  j: { hand: 'left', type: 'left_straight' },
  u: { hand: 'left', type: 'left_hook' },
  k: { hand: 'right', type: 'right_straight' },
  i: { hand: 'right', type: 'right_hook' },
};

const SAMPLE_HZ = 30;
const SLIP_TARGET = 0.6; // body widths
const DODGE_ENTER = 0.35;
const DODGE_EXIT = 0.15;
const PUNCH_EXTEND_MS: Record<PunchType, number> = {
  left_straight: 160, right_straight: 230, left_hook: 300, right_hook: 300,
};
const CALIBRATION_MS = 800;

export class SimulatedCvProvider implements CvProvider {
  readonly source = 'synthetic' as const;

  private sessionId = `sim-${Math.random().toString(36).slice(2, 8)}`;
  private calibrationId: string | null = null;
  private calibratingUntil = 0;
  private trackingLost = false;
  private lateral = 0;
  private dodgeSide: 'left' | 'right' | null = null;
  private held = new Set<string>();
  /** Physical keys ignored by the keyboard listener (e.g. punches/slips while the camera drives them). */
  blockedKeys = new Set<string>();
  private punchUntil = { left: 0, right: 0 };
  private pending: MotionEvent[] = [];
  private eventSeq = 0;
  private timer = 0;
  private lastTick = 0;

  start(onSample: (observation: Observation, events: MotionEvent[]) => void) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    this.recalibrate();
    this.lastTick = performance.now();
    this.timer = window.setInterval(() => {
      const now = performance.now();
      this.step(now, (now - this.lastTick) / 1000);
      this.lastTick = now;
      const events = this.pending;
      this.pending = [];
      onSample(this.observe(now), events);
    }, 1000 / SAMPLE_HZ);
  }

  stop() {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    clearInterval(this.timer);
  }

  /** Press a control key. The keyboard and the CV bridge (cv/bridge.ts) both drive input through here. */
  press(key: string) {
    const k = key.toLowerCase();
    this.held.add(k);
    const punch = SIM_KEYS[k];
    if (punch) this.punch(punch.hand, punch.type);
    if (k === 't') this.trackingLost = !this.trackingLost;
    if (k === 'c') this.recalibrate();
  }

  release(key: string) {
    this.held.delete(key.toLowerCase());
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat || this.blockedKeys.has(e.key.toLowerCase())) return;
    this.press(e.key);
  };

  private onKeyUp = (e: KeyboardEvent) => {
    if (!this.blockedKeys.has(e.key.toLowerCase())) this.release(e.key);
  };

  // Keys released while the window is unfocused never fire keyup.
  private onBlur = () => this.held.clear();

  private recalibrate() {
    this.calibrationId = `cal-${Math.random().toString(36).slice(2, 8)}`;
    this.calibratingUntil = 0;
    this.lateral = 0;
    this.dodgeSide = null;
  }

  private trackingState(now: number): TrackingState {
    if (this.trackingLost) return 'lost';
    if (now < this.calibratingUntil || !this.calibrationId) return 'calibrating';
    return 'good';
  }

  private body(): Body {
    const left = this.held.has('a');
    const right = this.held.has('d');
    // No leaning while a punch is out (the server rejects it too).
    if (left === right || this.punchUntil.left || this.punchUntil.right) return 'neutral';
    return left ? 'lean_left' : 'lean_right';
  }

  private guard(hand: 'left' | 'right', now: number): Guard {
    if (this.punchUntil[hand] > now) return 'neutral'; // punching drops that guard
    return this.held.has('w') || this.held.has(hand === 'left' ? 'q' : 'e') ? 'block' : 'neutral';
  }

  private step(now: number, dt: number) {
    if (!this.calibrationId && now >= this.calibratingUntil) {
      this.calibrationId = `cal-${Math.random().toString(36).slice(2, 8)}`;
    }
    if (this.trackingState(now) !== 'good') return;

    // Negative lateral = player-left (contract §2A).
    const body = this.body();
    const target = body === 'lean_left' ? -SLIP_TARGET : body === 'lean_right' ? SLIP_TARGET : 0;
    this.lateral += (target - this.lateral) * Math.min(1, dt * 14);

    const abs = Math.abs(this.lateral);
    if (!this.dodgeSide && abs > DODGE_ENTER) {
      this.dodgeSide = this.lateral < 0 ? 'left' : 'right';
      this.emit(this.dodgeSide === 'left' ? 'dodge_left' : 'dodge_right', now);
    } else if (this.dodgeSide && abs < DODGE_EXIT) {
      this.dodgeSide = null;
      this.emit('return_neutral', now);
    }

    for (const hand of ['left', 'right'] as const) {
      const until = this.punchUntil[hand];
      if (until && now >= until) {
        this.punchUntil[hand] = 0;
        this.emit(hand === 'left' ? 'guard_return_left' : 'guard_return_right', now);
      }
    }
  }

  private punch(hand: 'left' | 'right', type: PunchType) {
    const now = performance.now();
    // Detector owns rearming: no new punch until the previous one returned to guard.
    if (this.trackingState(now) !== 'good' || this.punchUntil[hand]) return;
    if (this.dodgeSide || this.body() !== 'neutral') return; // no swinging mid-lean
    this.punchUntil[hand] = now + PUNCH_EXTEND_MS[type];
    this.emit(hand === 'left' ? 'punch_left' : 'punch_right', now, type);
  }

  private emit(type: MotionEventType, now: number, punchType?: PunchType) {
    this.pending.push({
      schemaVersion: 1,
      eventId: `${this.sessionId}-e${++this.eventSeq}`,
      sessionId: this.sessionId,
      type,
      onsetMs: now - 30,
      sampleMs: now,
      detectedMs: now,
      sideConvention: 'player_anatomical',
      trackingState: 'good',
      qualityScore: 1,
      qualityKind: 'synthetic',
      calibrationId: this.calibrationId,
      experimental: type.startsWith('punch') || type.startsWith('guard'),
      punchType,
    });
  }

  private observe(now: number): Observation {
    const state = this.trackingState(now);
    const tracked = state === 'good';
    const body = this.body();
    // Unmirrored camera: the player's anatomical left shows up on image-right.
    const headX = 0.5 - this.lateral * 0.15;
    const headY = 0.3;
    const wrist = (hand: 'left' | 'right') => {
      const side = hand === 'left' ? 1 : -1;
      const extending = this.punchUntil[hand] > now;
      const blocking = this.guard(hand, now) === 'block';
      return {
        x: headX + side * (extending ? 0.04 : blocking ? 0.05 : 0.1),
        y: extending ? 0.38 : blocking ? 0.33 : 0.5,
      };
    };
    return {
      schemaVersion: 1,
      kind: 'observation',
      sessionId: this.sessionId,
      timestampMs: now,
      availableMs: now,
      trackingState: state,
      validity: { dodge: tracked, punch_left: tracked, punch_right: tracked },
      calibrationId: this.calibrationId,
      markers: tracked ? { head: { x: headX, y: headY }, left: wrist('left'), right: wrist('right') } : {},
      features: tracked ? { lateralDisplacementBodyWidths: this.lateral } : {},
      qualityScore: tracked ? 1 : 0,
      reason: state === 'lost' ? 'simulated tracking loss (T)' : undefined,
      pose: tracked
        ? { body, guards: { left: this.guard('left', now), right: this.guard('right', now) } }
        : undefined,
    };
  }
}
