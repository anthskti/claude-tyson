// Bridge between chuck-test's SpacetimeDB rows and the LiveCoach's expected interfaces.
// LiveCoach was built against main's `fight` + `combat_event` tables; this file adapts
// chuck-test's `fightMatch` + `fighter` + `attack` rows to the same shapes.

import type { RawEvent, FightRowLike } from '../../coach/adapter';
import type { AttackRow, MatchRow, FighterRow } from './net/server';

// ─── punch type mapping ────────────────────────────────────────────────────
// main engine names: jab, cross, hook_l, hook_r, upper_l, upper_r
// chuck-test names:  jab/straight/hook/uppercut × left/right hand

function punchName(punchType: string, hand: string): string {
  if (punchType === 'jab') return 'jab';
  if (punchType === 'straight') return hand === 'right' ? 'cross' : 'jab';
  if (punchType === 'hook') return hand === 'left' ? 'hook_l' : 'hook_r';
  if (punchType === 'uppercut') return hand === 'left' ? 'upper_l' : 'upper_r';
  return 'jab'; // unclassified
}

// outcome: chuck-test 'landed' → 'hit'; rest map 1:1
function outcomeOf(result: string): string {
  if (result === 'landed') return 'hit';
  return result; // 'blocked' | 'dodged' | 'unscorable'
}

// fight-relative ms since match.startedAt
function fightMs(ts: { microsSinceUnixEpoch: bigint }, match: MatchRow): number {
  return Number((ts.microsSinceUnixEpoch - match.startedAt.microsSinceUnixEpoch) / 1000n);
}

/**
 * Convert a resolved AttackRow to a RawEvent for LiveCoach.ingest().
 * Only resolved attacks (result !== 'pending' | 'cancelled') make sense here.
 */
export function attackToRawEvent(atk: AttackRow, match: MatchRow, me: FighterRow): RawEvent {
  const seq = Number(atk.id); // stable unique sequence number
  const t = fightMs(atk.impactAt, match);
  const attacker = atk.attackerSlot === me.slot ? 'player' : 'cpu';
  return {
    seq,
    t,
    type: 'punch',
    attacker,
    punch: punchName(atk.punchType, atk.hand),
    outcome: outcomeOf(atk.result),
    damage: atk.damage,
    defenderHp: undefined, // not available in attack row; coach doesn't require it
  };
}

/**
 * Convert the current match/fighter rows into a FightRowLike for LiveCoach.update().
 */
export function matchToFightRow(match: MatchRow, me: FighterRow, opponent: FighterRow): FightRowLike {
  const startMs = Number(match.startedAt.microsSinceUnixEpoch / 1000n);
  const endsMs = Number(match.endsAt.microsSinceUnixEpoch / 1000n);
  const now = Date.now();
  const t = Math.max(0, now - startMs);
  const roundEndsAt = endsMs - startMs;
  const paused = me.trackingState === 'lost';

  // Map chuck-test match status to main branch status names
  let status: string;
  if (match.status === 'active') status = paused ? 'fighting' : 'fighting';
  else status = 'decision';

  return {
    status,
    paused,
    t,
    roundEndsAt,
    playerHp: me.health,
    playerStamina: 100, // chuck-test has no stamina
    cpuHp: opponent.health,
    cpuStamina: 100,
    cpuPhase: 'idle',  // not exposed; coach only reads this for display, not logic
    cpuMove: '',
    cpuGuard: false,
  };
}
