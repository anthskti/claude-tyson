// Combat rules: one place that decides what beats what.
//
// The design is a loop where every defence has exactly one punch that beats it:
//
//   SLIP (lean left/right) ── beaten by ── HOOK      (it wraps around to where you moved)
//   LEAN BACK              ── beaten by ── STRAIGHT  (longest reach, follows you back)
//   BLOCK                  ── beaten by ── UPPERCUT  (comes up between the gloves)
//   NEUTRAL                ── beaten by ── everything
//
// JAB beats no defence but is fast and cheap: use it to probe and to bait a reaction.
//
// Details that make it feel right:
//   - Hooks arrive from one side. A block only stops a hook on the side it comes from,
//     and slipping *into* a hook hurts more than slipping away from it.
//   - A straight into a guard still does chip damage. A jab into a guard does none.
//   - The punch that beats a defence does bonus damage ("caught").
//   - A successful slip or lean-back opens a short counter window: your next punch
//     does bonus damage. Blocking is the safe option, so it gives no counter.
//   - Throwing a punch drops that hand's guard until it returns.

export type Body = 'neutral' | 'lean_left' | 'lean_right' | 'lean_back';
export type Guard = 'neutral' | 'block';
export type Hand = 'left' | 'right';
// 'unclassified' is for CV that detects a punch but not its type (current kit). It
// fights like a jab, so we never pretend we know the player threw a hook.
export type PunchType = 'jab' | 'straight' | 'hook' | 'uppercut' | 'unclassified';

export const BODIES: readonly Body[] = ['neutral', 'lean_left', 'lean_right', 'lean_back'];
export const GUARDS: readonly Guard[] = ['neutral', 'block'];
export const PUNCH_TYPES: readonly PunchType[] = ['jab', 'straight', 'hook', 'uppercut', 'unclassified'];

export interface PunchSpec {
  damage: number;
  windupMs: number; // cue → impact for player punches
  cooldownMs: number; // hand can't punch or block again until this passes
  telegraphScale: number; // bot wind-up = strategy.telegraphMs × this
}

// Fast and weak → slow and strong. The slower punch is easier to see coming.
export const PUNCHES: Record<PunchType, PunchSpec> = {
  jab: { damage: 5, windupMs: 150, cooldownMs: 300, telegraphScale: 0.6 },
  straight: { damage: 9, windupMs: 240, cooldownMs: 500, telegraphScale: 0.9 },
  hook: { damage: 13, windupMs: 340, cooldownMs: 650, telegraphScale: 1.1 },
  uppercut: { damage: 15, windupMs: 400, cooldownMs: 750, telegraphScale: 1.25 },
  unclassified: { damage: 5, windupMs: 150, cooldownMs: 300, telegraphScale: 0.6 },
};

export const CAUGHT_SCALE = 1.25; // the punch that beats your defence
export const SLIPPED_INTO_HOOK_SCALE = 1.5; // leaned straight into it
export const STRAIGHT_CHIP_SCALE = 0.25; // straight into a guard
export const COUNTER_SCALE = 1.5; // punch thrown inside your counter window
export const COUNTER_WINDOW_MS = 700;

export interface DefenderState {
  body: Body;
  leftGuard: Guard; // already 'neutral' if that hand is mid-punch
  rightGuard: Guard;
}

export type Detail =
  | 'clean' // hit a neutral defender
  | 'slipped' // slip beat a jab/straight/uppercut
  | 'leaned_back' // lean back beat a jab/hook/uppercut
  | 'blocked' // guard fully stopped it
  | 'chip' // straight into a guard
  | 'hook_beat_slip' // slipped away, hook wrapped around
  | 'slipped_into_hook' // slipped toward the hook
  | 'straight_beat_lean' // straight reached a lean-back
  | 'around_guard' // hook came from the unguarded side
  | 'through_guard'; // uppercut split the guard

export interface Outcome {
  result: 'landed' | 'blocked' | 'dodged';
  detail: Detail;
  damageScale: number;
  opensCounter: boolean; // defender earns a counter window
}

/** Which side of the defender's head a hook from `hand` arrives on (fighters face each other). */
export function arrivalSide(hand: Hand): Hand {
  return hand === 'left' ? 'right' : 'left';
}

export function resolvePunch(type: PunchType, hand: Hand, d: DefenderState): Outcome {
  const kind = type === 'unclassified' ? 'jab' : type;
  const side = arrivalSide(hand);
  let scale = 1;
  let caught: Detail | undefined;

  // 1. Body movement: get out of the way entirely, unless this is the punch that beats it.
  if (d.body === 'lean_left' || d.body === 'lean_right') {
    if (kind !== 'hook') return dodge('slipped');
    const leanSide: Hand = d.body === 'lean_left' ? 'left' : 'right';
    caught = leanSide === side ? 'slipped_into_hook' : 'hook_beat_slip';
    scale = leanSide === side ? SLIPPED_INTO_HOOK_SCALE : CAUGHT_SCALE;
  } else if (d.body === 'lean_back') {
    if (kind !== 'straight') return dodge('leaned_back');
    caught = 'straight_beat_lean';
    scale = CAUGHT_SCALE;
  }

  // 2. Guard: absorb what got past the body.
  const anyGuard = d.leftGuard === 'block' || d.rightGuard === 'block';
  if (anyGuard) {
    const sideGuard = side === 'left' ? d.leftGuard : d.rightGuard;
    switch (kind) {
      case 'jab':
        return { result: 'blocked', detail: 'blocked', damageScale: 0, opensCounter: false };
      case 'straight':
        return { result: 'blocked', detail: 'chip', damageScale: STRAIGHT_CHIP_SCALE * scale, opensCounter: false };
      case 'hook':
        if (sideGuard === 'block') return { result: 'blocked', detail: 'blocked', damageScale: 0, opensCounter: false };
        return land('around_guard', scale);
      case 'uppercut':
        return land('through_guard', CAUGHT_SCALE * scale);
    }
  }

  // 3. Nothing stopped it.
  return land(caught ?? 'clean', scale);
}

function dodge(detail: Detail): Outcome {
  return { result: 'dodged', detail, damageScale: 0, opensCounter: true };
}

function land(detail: Detail, damageScale: number): Outcome {
  return { result: 'landed', detail, damageScale, opensCounter: false };
}

/** Coerce untrusted strings from clients into the rule vocabulary. */
export function asBody(s: string): Body {
  return (BODIES as readonly string[]).includes(s) ? (s as Body) : 'neutral';
}
export function asGuard(s: string): Guard {
  return s === 'block' ? 'block' : 'neutral';
}
export function asPunchType(s: string): PunchType {
  return (PUNCH_TYPES as readonly string[]).includes(s) ? (s as PunchType) : 'unclassified';
}
