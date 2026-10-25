// Authoritative, deterministic combat rules for the online match reducers.
// Damage uses tenths of a health point so the contract can express 0.5 / 1.3.

export type Body = 'neutral' | 'lean_left' | 'lean_right';
export type Guard = 'neutral' | 'block';
export type Hand = 'left' | 'right';
export type PunchType = 'left_straight' | 'right_straight' | 'left_hook' | 'right_hook';

export interface PunchSpec {
  damage: number;
  startupMs: number;
  recoveryMs: number;
  stamina: number;
  telegraphScale: number;
}

// Damage is tenths of an HP. Costs, startup, recovery and telegraphs are first-pass tuning.
export const PUNCHES: Record<PunchType, PunchSpec> = {
  left_straight: { damage: 5, startupMs: 120, recoveryMs: 220, stamina: 5, telegraphScale: 0.65 },
  right_straight: { damage: 13, startupMs: 200, recoveryMs: 320, stamina: 12, telegraphScale: 0.9 },
  left_hook: { damage: 10, startupMs: 220, recoveryMs: 360, stamina: 16, telegraphScale: 1.05 },
  right_hook: { damage: 10, startupMs: 220, recoveryMs: 360, stamina: 16, telegraphScale: 1.05 },
};

export const MAX_STAMINA = 200;
export const STAMINA_REGEN_PER_SEC = 18;
export const BLOCK_DRAIN_PER_SEC = 4;
export const DODGE_COST = 20;
export const COUNTER_SCALE = 1.5;
export const COUNTER_WINDOW_MS = 700;

export const PUNCH_TYPES = Object.keys(PUNCHES) as PunchType[];
export function asPunchType(value: string): PunchType | undefined {
  return (PUNCH_TYPES as string[]).includes(value) ? value as PunchType : undefined;
}
export function asBody(value: string): Body {
  return value === 'lean_left' || value === 'lean_right' ? value : 'neutral';
}
export function asGuard(value: string): Guard {
  return value === 'block' ? 'block' : 'neutral';
}

export interface DefenderState {
  body: Body;
  blocking: boolean;
}

export type Detail = 'clean' | 'slipped' | 'blocked' | 'hook_beats_block' | 'hook_beat_slip' | 'slipped_into_hook';
export interface Outcome {
  result: 'landed' | 'blocked' | 'dodged';
  detail: Detail;
  damageScale: number;
  opensCounter: boolean;
}

export function resolvePunch(type: PunchType, d: DefenderState): Outcome {
  if (d.body !== 'neutral') {
    if (type.endsWith('_straight')) return { result: 'dodged', detail: 'slipped', damageScale: 0, opensCounter: true };
    const dodgeDirection = d.body === 'lean_left' ? 'left' : 'right';
    const hookDirection = type === 'left_hook' ? 'left' : 'right';
    if (dodgeDirection === hookDirection) {
      return { result: 'dodged', detail: 'slipped', damageScale: 0, opensCounter: true };
    }
    return {
      result: 'landed',
      detail: 'hook_beat_slip',
      damageScale: 1.5,
      opensCounter: false,
    };
  }
  if (d.blocking && type.endsWith('_straight')) {
    return { result: 'blocked', detail: 'blocked', damageScale: 0, opensCounter: false };
  }
  if (d.blocking && type.endsWith('_hook')) {
    return { result: 'landed', detail: 'hook_beats_block', damageScale: 1, opensCounter: false };
  }
  return { result: 'landed', detail: 'clean', damageScale: 1, opensCounter: false };
}
