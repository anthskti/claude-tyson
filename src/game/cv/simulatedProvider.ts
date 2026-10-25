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
//   Body (hold)    A dodge left · D dodge right
//   Guard (hold)   B both gloves
//   Left fist      J left straight · Q left hook
//   Right fist     C right straight · E right hook
//   T toggle tracking lost · X recalibrate

export const SIM_KEYS: Record<string, { hand: 'left' | 'right'; type: PunchType }> = {
  j: { hand: 'left', type: 'left_straight' },
  c: { hand: 'right', type: 'right_straight' },
  q: { hand: 'left', type: 'left_hook' },
  e: { hand: 'right', type: 'right_hook' },
};
const CV_GUARD_KEYS = { left: 'cv_guard_left', right: 'cv_guard_right' } as const;

const SAMPLE_HZ = 30;
const SLIP_TARGET = 0.6; // body widths
const DODGE_ENTER = 0.35;
const DODGE_EXIT = 0.15;
const PUNCH_EXTEND_MS: Record<PunchType, number> = {
  left_straight: 160, right_straight: 230, left_hook: 300, right_hook: 300,
};
const PUNCH_LOCK_MS: Record<PunchType, { startup: number; recovery: number }> = {
  left_straight: { startup: 120, recovery: 220 },
  right_straight: { startup: 200, recovery: 320 },
  left_hook: { startup: 220, recovery: 360 },
  right_hook: { startup: 220, recovery: 360 },
};
const PUNCH_STAMINA: Record<PunchType, number> = {
  left_straight: 5,
  right_straight: 12,
  left_hook: 16,
  right_hook: 16,
};
const DODGE_STAMINA = 20;
const BLOCK_DRAIN_PER_SEC = 4;
const MAX_STAMINA = 200;
const MAX_DEFENSE_HOLD_MS = 2000;
const BLOCK_COOLDOWN_MS = 300;
const DODGE_COOLDOWN_MS = 260;
type Defense = 'block' | 'dodge_left' | 'dodge_right';
const BLOCK_INPUTS = ['b', CV_GUARD_KEYS.left, CV_GUARD_KEYS.right];
const CALIBRATION_MS = 800;

export class SimulatedCvProvider implements CvProvider {
  readonly source = 'synthetic' as const;

  constructor(private readonly now: () => number = () => performance.now()) {}

  private sessionId = `sim-${Math.random().toString(36).slice(2, 8)}`;
  private calibrationId: string | null = null;
  private calibratingUntil = 0;
  private trackingLost = false;
  private lateral = 0;
  private dodgeSide: 'left' | 'right' | null = null;
  private actionReadyAt = 0;
  private activeDefense: { action: Defense; startedAt: number } | null = null;
  private stamina = 0;
  private held = new Set<string>();
  private ignoreUntilRelease = new Set<string>();
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
    this.lastTick = this.now();
    this.timer = window.setInterval(() => {
      const now = this.now();
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
    this.held.clear();
    this.ignoreUntilRelease.clear();
    this.pending = [];
    this.activeDefense = null;
    this.actionReadyAt = 0;
    this.dodgeSide = null;
    this.lateral = 0;
    this.punchUntil = { left: 0, right: 0 };
  }

  /** Press a control key. The keyboard and the CV bridge (cv/bridge.ts) both drive input through here. */
  press(key: string) {
    const k = key.toLowerCase();
    if (this.ignoreUntilRelease.has(k)) return;
    this.held.add(k);
    const punch = SIM_KEYS[k];
    if (punch) this.punch(punch.hand, punch.type);
    if (k === 't') this.trackingLost = !this.trackingLost;
    if (k === 'x') this.recalibrate();
  }

  release(key: string) {
    const k = key.toLowerCase();
    this.held.delete(k);
    this.ignoreUntilRelease.delete(k);
  }

  /** Updated from subscribed server state; affordability remains server-authoritative. */
  setStamina(stamina: number) {
    this.stamina = Math.max(0, Math.min(MAX_STAMINA, stamina));
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat || this.blockedKeys.has(e.key.toLowerCase())) return;
    this.press(e.key);
  };

  private onKeyUp = (e: KeyboardEvent) => {
    if (!this.blockedKeys.has(e.key.toLowerCase())) this.release(e.key);
  };

  // Keys released while the window is unfocused never fire keyup.
  private onBlur = () => {
    this.held.clear();
    this.ignoreUntilRelease.clear();
  };

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
    if (this.activeDefense?.action === 'dodge_left') return 'lean_left';
    if (this.activeDefense?.action === 'dodge_right') return 'lean_right';
    return 'neutral';
  }

  private guard(hand: 'left' | 'right', now: number): Guard {
    if (this.punchUntil[hand] > now) return 'neutral'; // punching drops that guard
    return this.activeDefense?.action === 'block' ? 'block' : 'neutral';
  }

  private step(now: number, dt: number) {
    if (!this.calibrationId && now >= this.calibratingUntil) {
      this.calibrationId = `cal-${Math.random().toString(36).slice(2, 8)}`;
    }
    if (this.trackingState(now) !== 'good') {
      if (this.activeDefense) this.endDefense(now);
      this.lateral = 0;
      this.dodgeSide = null;
      return;
    }

    this.updateDefense(now);

    if (this.activeDefense?.action === 'block') {
      this.stamina = Math.max(0, this.stamina - BLOCK_DRAIN_PER_SEC * Math.max(0, dt));
      if (this.stamina === 0) {
        const heldInputs = BLOCK_INPUTS.filter(key => this.held.has(key));
        for (const key of heldInputs) {
          this.held.delete(key);
          this.ignoreUntilRelease.add(key);
        }
        this.activeDefense = null;
        this.dodgeSide = null;
      }
    }

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
    const now = this.now();
    // Match the server's fighter-wide lock. Discrete punch events during recovery drop.
    if (this.trackingState(now) !== 'good' || now < this.actionReadyAt) return;
    if (this.stamina < PUNCH_STAMINA[type]) return;
    if (this.activeDefense || this.requestedDefense()) return;
    if (this.punchUntil[hand] > now) return;
    const timing = PUNCH_LOCK_MS[type];
    this.actionReadyAt = now + Math.max(timing.recovery, timing.startup + 150);
    this.stamina -= PUNCH_STAMINA[type];
    this.punchUntil[hand] = now + PUNCH_EXTEND_MS[type];
    this.emit(hand === 'left' ? 'punch_left' : 'punch_right', now, type);
  }

  private requestedDefense(): Defense | null {
    const left = this.held.has('a');
    const right = this.held.has('d');
    if (left !== right) return left ? 'dodge_left' : 'dodge_right';
    if (BLOCK_INPUTS.some(key => this.held.has(key))) return 'block';
    return null;
  }

  private updateDefense(now: number) {
    const bodyRequested = this.held.has('a') !== this.held.has('d');
    const blockRequested = BLOCK_INPUTS.some(key => this.held.has(key));

    if (this.activeDefense) {
      const { action, startedAt } = this.activeDefense;
      if (now - startedAt >= MAX_DEFENSE_HOLD_MS) {
        const heldInputs = action === 'block'
          ? BLOCK_INPUTS.filter(key => this.held.has(key))
          : [action === 'dodge_left' ? 'a' : 'd'].filter(key => this.held.has(key));
        for (const key of heldInputs) {
          this.held.delete(key);
          this.ignoreUntilRelease.add(key);
        }
        this.endDefense(now);
        return;
      }

      // A defense cannot switch directly into another one; the current pose must end first.
      const stillHeld = action === 'block' ? bodyRequested || blockRequested : bodyRequested;
      if (!stillHeld) this.endDefense(now);
      return;
    }

    const requested = this.requestedDefense();
    if (requested && now >= this.actionReadyAt) {
      if (this.stamina <= 0 || (requested.startsWith('dodge_') && this.stamina < DODGE_STAMINA)) return;
      this.activeDefense = { action: requested, startedAt: now };
      if (requested.startsWith('dodge_')) this.stamina -= DODGE_STAMINA;
    }
  }

  private endDefense(now: number) {
    if (!this.activeDefense) return;
    const cooldown = this.activeDefense.action === 'block' ? BLOCK_COOLDOWN_MS : DODGE_COOLDOWN_MS;
    this.actionReadyAt = Math.max(this.actionReadyAt, now + cooldown);
    this.activeDefense = null;
    this.dodgeSide = null;
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
