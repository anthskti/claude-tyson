// Claude Tyson — authoritative fight server.
//
// Covers the server half of the integration flow:
//   1. Match creation      — startBotMatch / joinPvpQueue, each match in one of RING_COUNT rings;
//                            a bot exhibition fills a spare ring until a real fight needs it
//   2. Motion input        — updatePose (body + guard state) + submitMotionEvent (punches)
//   3. Combat resolution   — attacks resolve at their scheduled impact time against the
//                            defender's *current* body/guard via rules.ts
//   4. AI adaptation       — fightWindow rows every ~6 s feed the strategist; applyStrategyUpdate
//                            validates/clamps the returned tuning for the bot controller
//   5. Persistence         — fightResult + fighterProfile updated when the match ends

import {
  schema,
  table,
  t,
  SenderError,
  type InferSchema,
  type ReducerCtx,
} from 'spacetimedb/server';
import { ScheduleAt, Timestamp, type Identity } from 'spacetimedb';
import {
  COUNTER_WINDOW_MS,
  PUNCHES,
  BLOCK_DRAIN_PER_SEC,
  DODGE_COST,
  MAX_STAMINA,
  STAMINA_REGEN_PER_SEC,
  asBody,
  asGuard,
  asPunchType,
  resolvePunch,
  type Body,
  type DefenderState,
  type Guard,
  type Hand,
  type PunchType,
} from './rules';

// ─── Tuning ────────────────────────────────────────────────────────────────

const MAX_HEALTH = 100;
const ROUND_MS = 60_000;
const POSE_FRESH_MS = 250;
const DODGE_WINDOW_MS = 350;
const DODGE_STARTUP_MS = 100;
const BLOCK_STARTUP_MS = 80;
const MAX_DEFENSE_HOLD_MS = 2_000;
const BLOCK_MAX_MS = MAX_DEFENSE_HOLD_MS;
const BLOCK_COOLDOWN_MS = 300;
const DODGE_COOLDOWN_MS = 260;
const WINDOW_MS = 6_000;
const BOT_PAUSED_RETRY_MS = 500;
const BOT_COUNTER_DELAY_MS = 250;
// Keep in step with RING_COUNT in src/game/scene/arena.ts.
const RING_COUNT = 4;
const ARENA_TICK_MS = 3_000;
// A finished exhibition stays visible this long before its rows are deleted.
const EXHIBITION_LINGER_MS = 8_000;

const BOT_DEFAULTS = {
  aggression: 0.5,
  punchIntervalMs: 1600,
  jabWeight: 0.4,
  straightWeight: 0.25,
  hookWeight: 0.2,
  uppercutWeight: 0,
  leftBias: 0.5,
  defenseRate: 0.3,
  telegraphMs: 650,
};

// What the bot does when it decides to defend. Equal odds, so the player can't
// learn one answer; the strategist can make it "read" better via defenseRate.
const BOT_DEFENSES: { body: Body; blocking: boolean }[] = [
  { body: 'lean_left', blocking: false },
  { body: 'lean_right', blocking: false },
  { body: 'neutral', blocking: true },
];

const PLAYER_SLOT = 0;
const OPPONENT_SLOT = 1;

// ─── Tables ────────────────────────────────────────────────────────────────

const player = table(
  { name: 'player', public: true },
  {
    identity: t.identity().primaryKey(),
    name: t.string(),
    online: t.bool(),
    createdAt: t.timestamp(),
  }
);

// Persistent fighting profile, updated after every finished match.
const fighterProfile = table(
  { name: 'fighter_profile', public: true },
  {
    identity: t.identity().primaryKey(),
    matchesPlayed: t.u32(),
    wins: t.u32(),
    losses: t.u32(),
    leftAttempts: t.u32(),
    rightAttempts: t.u32(),
    jabs: t.u32(),
    straights: t.u32(),
    hooks: t.u32(),
    uppercuts: t.u32(),
    unclassified: t.u32(),
    punchesLanded: t.u32(),
    counters: t.u32(),
    defenseOpportunities: t.u32(),
    slips: t.u32(),
    leanBacks: t.u32(),
    blocks: t.u32(),
    hitsTaken: t.u32(),
    lastAnalysis: t.string(),
    updatedAt: t.timestamp(),
  }
);

const queueEntry = table(
  { name: 'queue_entry', public: true },
  {
    identity: t.identity().primaryKey(),
    joinedAt: t.timestamp(),
  }
);

const fightMatch = table(
  { name: 'fight_match', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    mode: t.string(), // 'bot' | 'pvp' | 'exhibition' (bot vs bot)
    status: t.string().index('btree'), // 'active' | 'finished'
    startedAt: t.timestamp(),
    endsAt: t.timestamp(),
    ring: t.u8().default(0), // 0..RING_COUNT-1; at most one active match per ring
  }
);

// One row per fighter slot in a match. Slot 0 is whoever created/was first in queue.
const fighter = table(
  { name: 'fighter', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    matchId: t.u64().index('btree'),
    slot: t.u8(),
    identity: t.option(t.identity()), // none = bot
    health: t.i32(),
    stamina: t.f32(),
    staminaAt: t.timestamp(),
    // Latest pose from CV. Server receipt time is used for freshness.
    bodyState: t.string(), // rules.Body
    leftGuard: t.string(), // rules.Guard
    rightGuard: t.string(),
    defenseStartedAt: t.timestamp(),
    blockReadyAt: t.timestamp(),
    blockLockedUntilRelease: t.bool(),
    dodgeReadyAt: t.timestamp(),
    lateral: t.f32(), // continuous, for rendering only
    trackingState: t.string(),
    dodgeValid: t.bool(),
    punchLeftValid: t.bool(),
    punchRightValid: t.bool(),
    cvSessionId: t.string(),
    calibrationId: t.string(),
    poseAt: t.timestamp(),
    // Both timestamps lock the fighter until the current punch recovery ends.
    leftReadyAt: t.timestamp(),
    rightReadyAt: t.timestamp(),
    counterUntil: t.timestamp(),
    windowPoseSamples: t.u32(),
    windowGoodSamples: t.u32(),
  }
);

// An attack is both the pending wind-up (clients animate it) and, once resolved,
// the authoritative CombatEvent (contract §5).
const attack = table(
  { name: 'attack', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    matchId: t.u64().index('btree'),
    attackerSlot: t.u8(),
    hand: t.string(), // 'left' | 'right'
    punchType: t.string(), // rules.PunchType
    counter: t.bool(), // thrown inside the attacker's counter window
    cvEventId: t.string(), // '' for bot attacks
    cueAt: t.timestamp(),
    impactAt: t.timestamp(),
    result: t.string(), // 'pending' | 'landed' | 'blocked' | 'dodged' | 'unscorable' | 'cancelled'
    detail: t.string(), // rules.Detail, '' while pending
    damage: t.i32(),
    defenderBody: t.string(),
    defenderGuard: t.string(), // 'none' | 'left' | 'right' | 'both'
  }
);

const attackImpact = table(
  { name: 'attack_impact' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    attackId: t.u64(),
  }
);

// Dedup key `${cvSessionId}:${eventId}` (contract §4 rule 4).
const seenCvEvent = table(
  { name: 'seen_cv_event' },
  {
    key: t.string().primaryKey(),
    matchId: t.u64().index('btree'),
  }
);

const botStrategy = table(
  { name: 'bot_strategy', public: true },
  {
    matchId: t.u64().primaryKey(),
    revision: t.u32(),
    sourceWindowId: t.u64(),
    aggression: t.f32(),
    punchIntervalMs: t.u32(),
    jabWeight: t.f32(),
    straightWeight: t.f32(),
    hookWeight: t.f32(),
    uppercutWeight: t.f32(),
    leftBias: t.f32(),
    defenseRate: t.f32(),
    telegraphMs: t.u32(),
    explanation: t.string(),
    updatedAt: t.timestamp(),
  }
);

const botTick = table(
  { name: 'bot_tick' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    matchId: t.u64().index('btree'),
  }
);

const roundTimer = table(
  { name: 'round_timer' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    matchId: t.u64().index('btree'),
  }
);

const windowTimer = table(
  { name: 'window_timer' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    matchId: t.u64().index('btree'),
    windowStart: t.timestamp(),
  }
);

// Aggregated evidence for the strategist (contract §5 FightWindow). Slot 0 = human.
const fightWindow = table(
  { name: 'fight_window', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    matchId: t.u64().index('btree'),
    startAt: t.timestamp(),
    endAt: t.timestamp(),
    strategyRevision: t.u32(),
    // Player offence
    playerJabs: t.u32(),
    playerStraights: t.u32(),
    playerHooks: t.u32(),
    playerUppercuts: t.u32(),
    playerUnclassified: t.u32(),
    playerLeftAttempts: t.u32(),
    playerRightAttempts: t.u32(),
    playerLanded: t.u32(),
    playerCounters: t.u32(),
    // Player defence against bot punches
    botAttacks: t.u32(),
    playerSlips: t.u32(),
    playerLeanBacks: t.u32(),
    playerBlocks: t.u32(),
    playerCaught: t.u32(), // hit by the punch that beats the defence they chose
    playerHitsTaken: t.u32(),
    unscorable: t.u32(),
    trackingCoverage: t.f32(),
    playerHealth: t.i32(),
    botHealth: t.i32(),
  }
);

// Starts an exhibition in a spare ring and pairs the queue.
const arenaTimer = table(
  { name: 'arena_timer' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
  }
);

// One-shot: deletes a finished exhibition after EXHIBITION_LINGER_MS.
const exhibitionCleanup = table(
  { name: 'exhibition_cleanup' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    matchId: t.u64(),
  }
);

const fightResult = table(
  { name: 'fight_result', public: true },
  {
    matchId: t.u64().primaryKey(),
    winnerSlot: t.option(t.u8()), // none = draw
    reason: t.string(), // 'ko' | 'decision' | 'forfeit'
    finishedAt: t.timestamp(),
    analysis: t.string(),
  }
);

const spacetimedb = schema({
  player,
  fighterProfile,
  queueEntry,
  fightMatch,
  fighter,
  attack,
  attackImpact,
  seenCvEvent,
  botStrategy,
  botTick,
  roundTimer,
  windowTimer,
  fightWindow,
  arenaTimer,
  exhibitionCleanup,
  fightResult,
});
export default spacetimedb;

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;
type Fighter = NonNullable<ReturnType<Ctx['db']['fighter']['id']['find']>>;
type Match = NonNullable<ReturnType<Ctx['db']['fightMatch']['id']['find']>>;
type Attack = NonNullable<ReturnType<Ctx['db']['attack']['id']['find']>>;
type Strategy = NonNullable<ReturnType<Ctx['db']['botStrategy']['matchId']['find']>>;

// ─── Helpers ───────────────────────────────────────────────────────────────

function nowMicros(ctx: Ctx): bigint {
  return ctx.timestamp.microsSinceUnixEpoch;
}

function after(ctx: Ctx, ms: number): Timestamp {
  return new Timestamp(nowMicros(ctx) + BigInt(Math.round(ms)) * 1000n);
}

function msSince(ctx: Ctx, ts: Timestamp): number {
  return Number(nowMicros(ctx) - ts.microsSinceUnixEpoch) / 1000;
}

function isPast(ctx: Ctx, ts: Timestamp): boolean {
  return nowMicros(ctx) >= ts.microsSinceUnixEpoch;
}

function fighterActionReady(ctx: Ctx, f: Fighter): boolean {
  return isPast(ctx, f.leftReadyAt) && isPast(ctx, f.rightReadyAt)
    && isPast(ctx, f.blockReadyAt) && isPast(ctx, f.dodgeReadyAt);
}

function hasGuard(f: Fighter): boolean {
  return asGuard(f.leftGuard) === 'block' || asGuard(f.rightGuard) === 'block';
}

/** Server-side safety release for defenses that remain held past the 2s cap. */
function releaseExpiredDefense(ctx: Ctx, f: Fighter): Fighter {
  const active = asBody(f.bodyState) !== 'neutral' || hasGuard(f);
  if (!active || msSince(ctx, f.defenseStartedAt) < MAX_DEFENSE_HOLD_MS) return f;
  const cooldownMs = hasGuard(f) ? BLOCK_COOLDOWN_MS : DODGE_COOLDOWN_MS;
  const cooldown = new Timestamp(
    f.defenseStartedAt.microsSinceUnixEpoch
      + BigInt(MAX_DEFENSE_HOLD_MS + cooldownMs) * 1000n,
  );
  return ctx.db.fighter.id.update({
    ...f,
    bodyState: 'neutral',
    leftGuard: 'neutral',
    rightGuard: 'neutral',
    blockReadyAt: cooldown,
    dodgeReadyAt: cooldown,
    blockLockedUntilRelease: hasGuard(f),
  });
}

/** A block takes both gloves up; one glove alone is not a guard. */
function bothGuards(left: string, right: string): boolean {
  return asGuard(left) === 'block' && asGuard(right) === 'block';
}

/** Both gloves up, and neither out throwing a punch. */
function guardReady(ctx: Ctx, f: Fighter): boolean {
  return bothGuards(f.leftGuard, f.rightGuard) && isPast(ctx, f.leftReadyAt) && isPast(ctx, f.rightReadyAt);
}

function refreshStamina(ctx: Ctx, f: Fighter): Fighter {
  const elapsedMs = Math.max(0, msSince(ctx, f.staminaAt));
  if (elapsedMs === 0) return f;
  const blocking = guardReady(ctx, f)
    && !f.blockLockedUntilRelease
    && msSince(ctx, f.defenseStartedAt) <= BLOCK_MAX_MS;
  const dodging = asBody(f.bodyState) !== 'neutral';
  const attacking = !isPast(ctx, f.leftReadyAt) || !isPast(ctx, f.rightReadyAt);
  const delta = blocking
    ? -(BLOCK_DRAIN_PER_SEC * elapsedMs) / 1000
    : !dodging && !attacking ? (STAMINA_REGEN_PER_SEC * elapsedMs) / 1000 : 0;
  const stamina = clamp(f.stamina + delta, 0, MAX_STAMINA);
  const row = ctx.db.fighter.id.update({
    ...f,
    stamina,
    staminaAt: ctx.timestamp,
    ...(stamina <= 0 && blocking ? {
      leftGuard: 'neutral', rightGuard: 'neutral', blockLockedUntilRelease: true,
    } : {}),
  });
  return row;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function fightersOf(ctx: Ctx, matchId: bigint): Fighter[] {
  return [...ctx.db.fighter.matchId.filter(matchId)].sort((a, b) => a.slot - b.slot);
}

function activeMatches(ctx: Ctx): Match[] {
  return [...ctx.db.fightMatch.status.filter('active')];
}

function activeMatchFor(ctx: Ctx, who: Identity): Match | undefined {
  for (const m of ctx.db.fightMatch.status.filter('active')) {
    if (fightersOf(ctx, m.id).some(f => f.identity?.equals(who))) return m;
  }
  return undefined;
}

function requireMyFighter(ctx: Ctx, matchId: bigint): { match: Match; me: Fighter } {
  const match = ctx.db.fightMatch.id.find(matchId);
  if (!match) throw new SenderError('match not found');
  if (match.status !== 'active') throw new SenderError('match not active');
  const me = fightersOf(ctx, matchId).find(f => f.identity?.equals(ctx.sender));
  if (!me) throw new SenderError('not a fighter in this match');
  return { match, me };
}

function ensureProfile(ctx: Ctx, who: Identity) {
  const existing = ctx.db.fighterProfile.identity.find(who);
  if (existing) return existing;
  return ctx.db.fighterProfile.insert({
    identity: who,
    matchesPlayed: 0,
    wins: 0,
    losses: 0,
    leftAttempts: 0,
    rightAttempts: 0,
    jabs: 0,
    straights: 0,
    hooks: 0,
    uppercuts: 0,
    unclassified: 0,
    punchesLanded: 0,
    counters: 0,
    defenseOpportunities: 0,
    slips: 0,
    leanBacks: 0,
    blocks: 0,
    hitsTaken: 0,
    lastAnalysis: '',
    updatedAt: ctx.timestamp,
  });
}

function insertFighter(ctx: Ctx, matchId: bigint, slot: number, identity: Identity | undefined) {
  const epoch = new Timestamp(0n);
  ctx.db.fighter.insert({
    id: 0n,
    matchId,
    slot,
    identity,
    health: MAX_HEALTH,
    stamina: MAX_STAMINA,
    staminaAt: ctx.timestamp,
    bodyState: 'neutral',
    leftGuard: 'neutral',
    rightGuard: 'neutral',
    defenseStartedAt: ctx.timestamp,
    blockReadyAt: epoch,
    blockLockedUntilRelease: false,
    dodgeReadyAt: epoch,
    lateral: 0,
    // Bots are always "tracked"; humans start calibrating until their first pose arrives.
    trackingState: identity ? 'calibrating' : 'good',
    dodgeValid: !identity,
    punchLeftValid: !identity,
    punchRightValid: !identity,
    cvSessionId: '',
    calibrationId: '',
    poseAt: ctx.timestamp,
    leftReadyAt: epoch,
    rightReadyAt: epoch,
    counterUntil: epoch,
    windowPoseSamples: 0,
    windowGoodSamples: 0,
  });
}

/** Rings with no active match, lowest first. */
function freeRings(ctx: Ctx): number[] {
  const used = new Set(activeMatches(ctx).map(m => m.ring));
  return Array.from({ length: RING_COUNT }, (_, ring) => ring).filter(ring => !used.has(ring));
}

/** The lowest free ring for a real fight. With none free, the exhibition gives up its ring. */
function claimRing(ctx: Ctx): number | undefined {
  const free = freeRings(ctx);
  if (free.length > 0) return free[0];
  const exhibition = activeMatches(ctx).find(m => m.mode === 'exhibition');
  if (!exhibition) return undefined;
  finishMatch(ctx, exhibition, undefined, 'stopped');
  return exhibition.ring;
}

/** Pair the two longest-waiting players while a ring is free. */
function pairQueue(ctx: Ctx) {
  for (;;) {
    const waiting = [...ctx.db.queueEntry.iter()]
      .sort((a, b) => Number(a.joinedAt.microsSinceUnixEpoch - b.joinedAt.microsSinceUnixEpoch));
    if (waiting.length < 2) return;
    const ring = claimRing(ctx);
    if (ring === undefined) return;
    const [a, b] = waiting;
    ctx.db.queueEntry.identity.delete(a.identity);
    ctx.db.queueEntry.identity.delete(b.identity);
    createMatch(ctx, 'pvp', ring, a.identity, b.identity);
  }
}

type Mode = 'bot' | 'pvp' | 'exhibition';

function createMatch(ctx: Ctx, mode: Mode, ring: number, p0: Identity | undefined, p1: Identity | undefined): Match {
  const match = ctx.db.fightMatch.insert({
    id: 0n,
    mode,
    status: 'active',
    startedAt: ctx.timestamp,
    endsAt: after(ctx, ROUND_MS),
    ring,
  });
  insertFighter(ctx, match.id, PLAYER_SLOT, p0);
  insertFighter(ctx, match.id, OPPONENT_SLOT, p1);
  if (p0) ensureProfile(ctx, p0);
  if (p1) ensureProfile(ctx, p1);

  ctx.db.roundTimer.insert({
    scheduledId: 0n,
    scheduledAt: ScheduleAt.time(match.endsAt.microsSinceUnixEpoch),
    matchId: match.id,
  });

  if (mode !== 'pvp') {
    ctx.db.botStrategy.insert({
      matchId: match.id,
      revision: 0,
      sourceWindowId: 0n,
      ...BOT_DEFAULTS,
      explanation: 'baseline',
      updatedAt: ctx.timestamp,
    });
    scheduleBot(ctx, match.id, 2000);
  }
  // Only a human's fight feeds the strategist.
  if (mode === 'bot') {
    ctx.db.windowTimer.insert({
      scheduledId: 0n,
      scheduledAt: ScheduleAt.interval(BigInt(WINDOW_MS) * 1000n),
      matchId: match.id,
      windowStart: ctx.timestamp,
    });
  }
  return match;
}

function scheduleBot(ctx: Ctx, matchId: bigint, delayMs: number) {
  ctx.db.botTick.insert({
    scheduledId: 0n,
    scheduledAt: ScheduleAt.time(after(ctx, delayMs).microsSinceUnixEpoch),
    matchId,
  });
}

function rescheduleBot(ctx: Ctx, matchId: bigint, delayMs: number) {
  for (const r of [...ctx.db.botTick.matchId.filter(matchId)]) ctx.db.botTick.scheduledId.delete(r.scheduledId);
  scheduleBot(ctx, matchId, delayMs);
}

function throwPunch(
  ctx: Ctx,
  attacker: Fighter,
  hand: Hand,
  punchType: PunchType,
  cvEventId: string,
  windupMs: number
) {
  const spec = PUNCHES[punchType];
  const impactAt = after(ctx, windupMs);
  // The punching hand leaves the guard until it's back and rearmed.
  const readyAt = after(ctx, Math.max(spec.recoveryMs, windupMs + 150));
  ctx.db.fighter.id.update({
    ...attacker,
    // Punches occupy the whole fighter, not just the throwing hand.
    leftReadyAt: readyAt,
    rightReadyAt: readyAt,
  });
  const row = ctx.db.attack.insert({
    id: 0n,
    matchId: attacker.matchId,
    attackerSlot: attacker.slot,
    hand,
    punchType,
    counter: !isPast(ctx, attacker.counterUntil),
    cvEventId,
    cueAt: ctx.timestamp,
    impactAt,
    result: 'pending',
    detail: '',
    damage: 0,
    defenderBody: '',
    defenderGuard: '',
  });
  ctx.db.attackImpact.insert({
    scheduledId: 0n,
    scheduledAt: ScheduleAt.time(impactAt.microsSinceUnixEpoch),
    attackId: row.id,
  });
}

function poseIsUsable(ctx: Ctx, f: Fighter): boolean {
  if (!f.identity) return true;
  return f.dodgeValid && (f.trackingState === 'good' || f.trackingState === 'degraded')
    && msSince(ctx, f.poseAt) <= POSE_FRESH_MS;
}

/** A guard only counts with both gloves up and neither out throwing a punch. */
function defenderState(ctx: Ctx, f: Fighter): DefenderState {
  const age = msSince(ctx, f.defenseStartedAt);
  const body = age >= DODGE_STARTUP_MS && age <= DODGE_WINDOW_MS ? asBody(f.bodyState) : 'neutral';
  return {
    body,
    blocking: age >= BLOCK_STARTUP_MS && age <= BLOCK_MAX_MS && isPast(ctx, f.blockReadyAt)
      && !f.blockLockedUntilRelease && body === 'neutral' && guardReady(ctx, f),
  };
}

function botDefense(ctx: Ctx, bot: Fighter, strat: Strategy | undefined): DefenderState {
  if (ctx.random() >= (strat?.defenseRate ?? BOT_DEFAULTS.defenseRate)) {
    return { body: 'neutral', blocking: false };
  }
  const d = BOT_DEFENSES[ctx.random.integerInRange(0, BOT_DEFENSES.length - 1)];
  // The bot follows the same one-action rule as a player.
  const punching = !isPast(ctx, bot.leftReadyAt) || !isPast(ctx, bot.rightReadyAt);
  if (punching) return { body: 'neutral', blocking: false };
  return { body: d.body, blocking: d.blocking };
}

function guardLabel(d: DefenderState): string {
  return d.blocking ? 'both' : 'none';
}

function pickPunchType(ctx: Ctx, s: Strategy, hand: Hand): PunchType {
  const weights: [PunchType, number][] = [
    hand === 'left' ? ['left_straight', s.jabWeight] : ['right_straight', s.straightWeight],
    hand === 'left' ? ['left_hook', s.hookWeight] : ['right_hook', s.hookWeight],
  ];
  const total = weights.reduce((sum, [, w]) => sum + w, 0);
  if (total <= 0) return hand === 'left' ? 'left_straight' : 'right_straight';
  let roll = ctx.random() * total;
  for (const [type, w] of weights) {
    roll -= w;
    if (roll < 0) return type;
  }
  return hand === 'left' ? 'left_straight' : 'right_straight';
}

function deleteAll<R>(rows: Iterable<R>, del: (r: R) => unknown) {
  for (const r of [...rows]) del(r);
}

// Landed because the defender picked the wrong answer (or blocked the wrong side).
const isCaught = (a: Attack) => a.result === 'landed' && a.detail !== 'clean';

function finishMatch(ctx: Ctx, match: Match, winnerSlot: number | undefined, reason: string) {
  if (match.status !== 'active') return;
  ctx.db.fightMatch.id.update({ ...match, status: 'finished' });

  deleteAll(ctx.db.botTick.matchId.filter(match.id), r => ctx.db.botTick.scheduledId.delete(r.scheduledId));
  deleteAll(ctx.db.roundTimer.matchId.filter(match.id), r => ctx.db.roundTimer.scheduledId.delete(r.scheduledId));
  deleteAll(ctx.db.windowTimer.matchId.filter(match.id), r => ctx.db.windowTimer.scheduledId.delete(r.scheduledId));
  deleteAll(ctx.db.seenCvEvent.matchId.filter(match.id), r => ctx.db.seenCvEvent.key.delete(r.key));
  for (const a of [...ctx.db.attack.matchId.filter(match.id)]) {
    if (a.result === 'pending') ctx.db.attack.id.update({ ...a, result: 'cancelled' });
  }

  ctx.db.fightResult.insert({
    matchId: match.id,
    winnerSlot,
    reason,
    finishedAt: ctx.timestamp,
    analysis: '',
  });

  const attacks = [...ctx.db.attack.matchId.filter(match.id)].filter(
    a => a.result !== 'cancelled' && a.result !== 'unscorable'
  );
  for (const f of fightersOf(ctx, match.id)) {
    if (!f.identity) continue;
    const p = ensureProfile(ctx, f.identity);
    const mine = attacks.filter(a => a.attackerSlot === f.slot);
    // 'unscorable' attacks are excluded from success-rate denominators (contract §5).
    const incoming = attacks.filter(a => a.attackerSlot !== f.slot);
    const count = (rows: Attack[], pred: (a: Attack) => boolean) => rows.filter(pred).length;
    ctx.db.fighterProfile.identity.update({
      ...p,
      matchesPlayed: p.matchesPlayed + 1,
      wins: p.wins + (winnerSlot === f.slot ? 1 : 0),
      losses: p.losses + (winnerSlot !== undefined && winnerSlot !== f.slot ? 1 : 0),
      leftAttempts: p.leftAttempts + count(mine, a => a.hand === 'left'),
      rightAttempts: p.rightAttempts + count(mine, a => a.hand === 'right'),
      jabs: p.jabs,
      straights: p.straights + count(mine, a => a.punchType.endsWith('_straight')),
      hooks: p.hooks + count(mine, a => a.punchType.endsWith('_hook')),
      uppercuts: p.uppercuts,
      unclassified: p.unclassified,
      punchesLanded: p.punchesLanded + count(mine, a => a.result === 'landed'),
      counters: p.counters + count(mine, a => a.counter && a.result === 'landed'),
      defenseOpportunities: p.defenseOpportunities + incoming.length,
      slips: p.slips + count(incoming, a => a.detail === 'slipped'),
      leanBacks: p.leanBacks + count(incoming, a => a.detail === 'leaned_back'),
      blocks: p.blocks + count(incoming, a => a.result === 'blocked'),
      hitsTaken: p.hitsTaken + count(incoming, a => a.result === 'landed'),
      updatedAt: ctx.timestamp,
    });
  }

  if (match.mode === 'exhibition') {
    ctx.db.exhibitionCleanup.insert({
      scheduledId: 0n,
      scheduledAt: ScheduleAt.time(after(ctx, EXHIBITION_LINGER_MS).microsSinceUnixEpoch),
      matchId: match.id,
    });
  } else {
    // A real fight freed its ring: someone in the queue may be waiting for it.
    pairQueue(ctx);
  }
}

/** Exhibitions leave no profile or history; drop every row once spectators have seen the end. */
function deleteMatch(ctx: Ctx, matchId: bigint) {
  deleteAll(ctx.db.attack.matchId.filter(matchId), r => ctx.db.attack.id.delete(r.id));
  deleteAll(ctx.db.fighter.matchId.filter(matchId), r => ctx.db.fighter.id.delete(r.id));
  deleteAll(ctx.db.botTick.matchId.filter(matchId), r => ctx.db.botTick.scheduledId.delete(r.scheduledId));
  deleteAll(ctx.db.roundTimer.matchId.filter(matchId), r => ctx.db.roundTimer.scheduledId.delete(r.scheduledId));
  ctx.db.botStrategy.matchId.delete(matchId);
  ctx.db.fightResult.matchId.delete(matchId);
  ctx.db.fightMatch.id.delete(matchId);
}

function ensureArenaTimer(ctx: Ctx) {
  if ([...ctx.db.arenaTimer.iter()].length > 0) return;
  ctx.db.arenaTimer.insert({
    scheduledId: 0n,
    scheduledAt: ScheduleAt.interval(BigInt(ARENA_TICK_MS) * 1000n),
  });
}

// ─── Lifecycle ─────────────────────────────────────────────────────────────

export const init = spacetimedb.init(ctx => {
  ensureArenaTimer(ctx);
});

export const onConnect = spacetimedb.clientConnected(ctx => {
  // init only runs on a fresh database; an upgraded one gets its timer here.
  ensureArenaTimer(ctx);
  const existing = ctx.db.player.identity.find(ctx.sender);
  if (existing) {
    ctx.db.player.identity.update({ ...existing, online: true });
  } else {
    ctx.db.player.insert({ identity: ctx.sender, name: '', online: true, createdAt: ctx.timestamp });
  }
});

export const onDisconnect = spacetimedb.clientDisconnected(ctx => {
  const existing = ctx.db.player.identity.find(ctx.sender);
  if (existing) ctx.db.player.identity.update({ ...existing, online: false });
  ctx.db.queueEntry.identity.delete(ctx.sender);

  const match = activeMatchFor(ctx, ctx.sender);
  if (match) {
    const me = fightersOf(ctx, match.id).find(f => f.identity?.equals(ctx.sender))!;
    finishMatch(ctx, match, me.slot === PLAYER_SLOT ? OPPONENT_SLOT : PLAYER_SLOT, 'forfeit');
  }
});

// ─── 1. Match creation ─────────────────────────────────────────────────────

export const setName = spacetimedb.reducer({ name: t.string() }, (ctx, { name }) => {
  const trimmed = name.trim().slice(0, 24);
  if (!trimmed) throw new SenderError('name required');
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) throw new SenderError('not connected');
  ctx.db.player.identity.update({ ...p, name: trimmed });
});

export const startBotMatch = spacetimedb.reducer(ctx => {
  if (activeMatchFor(ctx, ctx.sender)) throw new SenderError('already in a match');
  const ring = claimRing(ctx);
  if (ring === undefined) throw new SenderError('all rings are full');
  ctx.db.queueEntry.identity.delete(ctx.sender);
  createMatch(ctx, 'bot', ring, ctx.sender, undefined);
});

// With every ring taken, players stay queued and are paired when a fight ends.
export const joinPvpQueue = spacetimedb.reducer(ctx => {
  if (activeMatchFor(ctx, ctx.sender)) throw new SenderError('already in a match');
  if (ctx.db.queueEntry.identity.find(ctx.sender)) return;
  ctx.db.queueEntry.insert({ identity: ctx.sender, joinedAt: ctx.timestamp });
  pairQueue(ctx);
});

export const leavePvpQueue = spacetimedb.reducer(ctx => {
  ctx.db.queueEntry.identity.delete(ctx.sender);
});

export const forfeit = spacetimedb.reducer({ matchId: t.u64() }, (ctx, { matchId }) => {
  const { match, me } = requireMyFighter(ctx, matchId);
  finishMatch(ctx, match, me.slot === PLAYER_SLOT ? OPPONENT_SLOT : PLAYER_SLOT, 'forfeit');
});

// ─── 2. Motion input (normalized CV data only, never frames) ───────────────

export const updatePose = spacetimedb.reducer(
  {
    matchId: t.u64(),
    cvSessionId: t.string(),
    calibrationId: t.string(),
    trackingState: t.string(),
    dodgeValid: t.bool(),
    punchLeftValid: t.bool(),
    punchRightValid: t.bool(),
    bodyState: t.string(),
    leftGuard: t.string(),
    rightGuard: t.string(),
    lateral: t.f32(),
  },
  (ctx, args) => {
    const { me: initial } = requireMyFighter(ctx, args.matchId);
    if (!['good', 'degraded', 'lost', 'calibrating'].includes(args.trackingState)) {
      throw new SenderError('invalid tracking state');
    }
    if (!Number.isFinite(args.lateral)) throw new SenderError('invalid lateral input');
    let me = releaseExpiredDefense(ctx, refreshStamina(ctx, initial));
    let bodyState = args.dodgeValid ? asBody(args.bodyState) : 'neutral';
    let leftGuard = args.punchLeftValid ? asGuard(args.leftGuard) : 'neutral';
    let rightGuard = args.punchRightValid ? asGuard(args.rightGuard) : 'neutral';
    const blockReleased = leftGuard === 'neutral' && rightGuard === 'neutral';
    let stamina = me.stamina;
    const wasDodging = asBody(me.bodyState) !== 'neutral';
    const wasBlocking = hasGuard(me);
    const punchBusy = !isPast(ctx, me.leftReadyAt) || !isPast(ctx, me.rightReadyAt);
    let endedDefense = false;

    // A held defense can be released, but cannot turn into another action in-place.
    if (wasDodging) {
      if (bodyState === 'neutral') endedDefense = true;
      else bodyState = asBody(me.bodyState);
      leftGuard = 'neutral';
      rightGuard = 'neutral';
    } else if (wasBlocking) {
      if (bodyState !== 'neutral') {
        bodyState = 'neutral';
        leftGuard = asGuard(me.leftGuard);
        rightGuard = asGuard(me.rightGuard);
      } else if (leftGuard === 'neutral' && rightGuard === 'neutral') {
        endedDefense = true;
      } else {
        leftGuard = asGuard(me.leftGuard);
        rightGuard = asGuard(me.rightGuard);
      }
    }

    const startsDodge = !wasDodging && bodyState !== 'neutral';
    const startsBlock = !wasBlocking && (leftGuard !== 'neutral' || rightGuard !== 'neutral');
    if (startsDodge || startsBlock) {
      if (punchBusy || !fighterActionReady(ctx, me) || me.blockLockedUntilRelease || stamina <= 0) {
        bodyState = 'neutral';
        leftGuard = 'neutral';
        rightGuard = 'neutral';
      } else if (startsDodge) {
        if (!args.dodgeValid || stamina < DODGE_COST) bodyState = 'neutral';
        else stamina -= DODGE_COST;
        leftGuard = 'neutral';
        rightGuard = 'neutral';
      }
    }

    if (endedDefense) {
      const cooldown = after(ctx, wasBlocking ? BLOCK_COOLDOWN_MS : DODGE_COOLDOWN_MS);
      me = { ...me, blockReadyAt: cooldown, dodgeReadyAt: cooldown, blockLockedUntilRelease: false };
    }
    const defenseStarted = !wasDodging && !wasBlocking
      && (bodyState !== 'neutral' || leftGuard !== 'neutral' || rightGuard !== 'neutral');
    const defenseStartedAt = defenseStarted ? ctx.timestamp : me.defenseStartedAt;
    const canBlock = bodyState === 'neutral' && stamina > 0 && !punchBusy
      && isPast(ctx, me.blockReadyAt) && !me.blockLockedUntilRelease;
    const good = args.trackingState === 'good' || (args.trackingState === 'degraded' && args.dodgeValid);
    const blockLockedUntilRelease = me.blockLockedUntilRelease
      ? !blockReleased
      : false;
    const dodgeReadyAt = me.dodgeReadyAt;
    me = ctx.db.fighter.id.update({
      ...me,
      // Untracked inputs can't defend: an invalid wrist is never a block.
      bodyState,
      leftGuard: canBlock ? leftGuard : 'neutral',
      rightGuard: canBlock ? rightGuard : 'neutral',
      defenseStartedAt,
      blockReadyAt: me.blockReadyAt,
      blockLockedUntilRelease,
      dodgeReadyAt,
      stamina,
      staminaAt: ctx.timestamp,
      lateral: clamp(args.lateral, -3, 3),
      trackingState: args.trackingState,
      dodgeValid: args.dodgeValid,
      punchLeftValid: args.punchLeftValid,
      punchRightValid: args.punchRightValid,
      cvSessionId: args.cvSessionId,
      calibrationId: args.calibrationId,
      poseAt: ctx.timestamp,
      windowPoseSamples: me.windowPoseSamples + 1,
      windowGoodSamples: me.windowGoodSamples + (good ? 1 : 0),
    });
  }
);

export const submitMotionEvent = spacetimedb.reducer(
  {
    matchId: t.u64(),
    cvSessionId: t.string(),
    eventId: t.string(),
    eventType: t.string(),
    punchType: t.string(), // '' when the CV can't classify → 'unclassified'
  },
  (ctx, { matchId, cvSessionId, eventId, eventType, punchType }) => {
    let { me } = requireMyFighter(ctx, matchId);
    me = releaseExpiredDefense(ctx, refreshStamina(ctx, me));
    if (!cvSessionId || cvSessionId.length > 128 || !eventId || eventId.length > 128) {
      throw new SenderError('invalid motion event id');
    }

    const key = `${cvSessionId}:${eventId}`;
    if (ctx.db.seenCvEvent.key.find(key)) return; // duplicate delivery
    ctx.db.seenCvEvent.insert({ key, matchId });

    // Events from a previous CV session / calibration must not trigger new hits.
    if (me.cvSessionId && cvSessionId !== me.cvSessionId) return;
    if (!poseIsUsable(ctx, me)) return;

    // Body movement and guards are resolved from continuous pose; only punches start attacks.
    if (eventType !== 'punch_left' && eventType !== 'punch_right') return;
    const hand: Hand = eventType === 'punch_left' ? 'left' : 'right';
    if (hand === 'left' ? !me.punchLeftValid : !me.punchRightValid) return;
    if (asBody(me.bodyState) !== 'neutral') return; // no swinging mid-lean
    if (!fighterActionReady(ctx, me)) return; // locked actions are rejected, never buffered
    if (hasGuard(me)) return; // no punch while blocking

    const type = asPunchType(punchType) ?? (hand === 'left' ? 'left_straight' : 'right_straight');
    if ((type.startsWith('left_') ? 'left' : 'right') !== hand) return;
    const spec = PUNCHES[type];
    if (me.stamina < spec.stamina) return;
    const readyToPunch = ctx.db.fighter.id.update({ ...me, stamina: me.stamina - spec.stamina, staminaAt: ctx.timestamp });
    throwPunch(ctx, readyToPunch, hand, type, eventId, spec.startupMs);
  }
);

// ─── 3. Combat resolution ──────────────────────────────────────────────────

export const resolveAttack = spacetimedb.reducer(
  { onSchedule: attackImpact },
  { timer: attackImpact.rowType },
  (ctx, { timer }) => {
    const atk = ctx.db.attack.id.find(timer.attackId);
    if (!atk || atk.result !== 'pending') return;
    const match = ctx.db.fightMatch.id.find(atk.matchId);
    if (!match || match.status !== 'active') {
      ctx.db.attack.id.update({ ...atk, result: 'cancelled' });
      return;
    }
    const defender = fightersOf(ctx, atk.matchId).find(f => f.slot !== atk.attackerSlot)!;

    if (!poseIsUsable(ctx, defender)) {
      // Never count an unobserved interval as a failed dodge.
      ctx.db.attack.id.update({ ...atk, result: 'unscorable', detail: '' });
      return;
    }

    const strat = ctx.db.botStrategy.matchId.find(atk.matchId) ?? undefined;
    const state = defender.identity ? defenderState(ctx, defender) : botDefense(ctx, defender, strat);
    const attackType = asPunchType(atk.punchType);
    if (!attackType) {
      ctx.db.attack.id.update({ ...atk, result: 'cancelled' });
      return;
    }
    const outcome = resolvePunch(attackType, state);

    const scale = outcome.damageScale;
    const damage = Math.round(PUNCHES[attackType].damage * scale);
    ctx.db.attack.id.update({
      ...atk,
      result: outcome.result,
      detail: outcome.detail,
      damage,
      defenderBody: state.body,
      defenderGuard: guardLabel(state),
    });

    const health = Math.max(0, defender.health - damage);
    ctx.db.fighter.id.update({
      ...defender,
      health,
      counterUntil: outcome.opensCounter ? after(ctx, COUNTER_WINDOW_MS) : defender.counterUntil,
    });
    if (health === 0) {
      finishMatch(ctx, match, atk.attackerSlot, 'ko');
      return;
    }
    // A bot that slips or leans back fires straight back inside its counter window.
    if (!defender.identity && outcome.opensCounter) rescheduleBot(ctx, match.id, BOT_COUNTER_DELAY_MS);
  }
);

export const endRound = spacetimedb.reducer(
  { onSchedule: roundTimer },
  { timer: roundTimer.rowType },
  (ctx, { timer }) => {
    const match = ctx.db.fightMatch.id.find(timer.matchId);
    if (!match) return;
    const [a, b] = fightersOf(ctx, match.id);
    const winner = a.health === b.health ? undefined : a.health > b.health ? a.slot : b.slot;
    finishMatch(ctx, match, winner, 'decision');
  }
);

// Keeps the arena alive: fill ALL spare rings with bot exhibitions while someone is online.
// Real fights preempt exhibitions via claimRing; PvP queue gets priority over new exhibitions.
export const arenaTick = spacetimedb.reducer(
  { onSchedule: arenaTimer },
  { timer: arenaTimer.rowType },
  ctx => {
    pairQueue(ctx);
    // Let finished exhibitions clear before starting fresh ones.
    if ([...ctx.db.exhibitionCleanup.iter()].length > 0) return;
    if (![...ctx.db.player.iter()].some(p => p.online)) return;
    // PvP queue entries get rings when matched; don't start new exhibitions meanwhile.
    if ([...ctx.db.queueEntry.iter()].length > 0) return;
    const free = freeRings(ctx);
    if (free.length === 0) return;
    // Fill every free ring with an exhibition (real fights preempt via claimRing).
    for (const ring of free) {
      createMatch(ctx, 'exhibition', ring, undefined, undefined);
    }
  }
);

export const cleanupExhibition = spacetimedb.reducer(
  { onSchedule: exhibitionCleanup },
  { timer: exhibitionCleanup.rowType },
  (ctx, { timer }) => {
    const match = ctx.db.fightMatch.id.find(timer.matchId);
    if (match?.mode === 'exhibition' && match.status === 'finished') deleteMatch(ctx, match.id);
  }
);

// ─── 4. Bot controller + strategist interface ──────────────────────────────

export const botAct = spacetimedb.reducer(
  { onSchedule: botTick },
  { timer: botTick.rowType },
  (ctx, { timer }) => {
    const match = ctx.db.fightMatch.id.find(timer.matchId);
    if (!match || match.status !== 'active') return;
    const fighters = fightersOf(ctx, match.id);
    let human: Fighter; // the target; another bot in an exhibition
    let bot: Fighter;
    if (match.mode === 'exhibition') {
      // A bot inside its counter window fires back; otherwise either corner leads.
      bot = fighters.find(f => !isPast(ctx, f.counterUntil)) ?? fighters[ctx.random.integerInRange(0, 1)];
      human = fighters.find(f => f.slot !== bot.slot)!;
    } else {
      [human, bot] = fighters;
    }

    // Pause bot offence while the player's tracking is unusable (contract §3).
    if (!poseIsUsable(ctx, human)) {
      scheduleBot(ctx, match.id, BOT_PAUSED_RETRY_MS);
      return;
    }

    if (!isPast(ctx, bot.leftReadyAt) || !isPast(ctx, bot.rightReadyAt)) {
      const readyAt = bot.leftReadyAt.microsSinceUnixEpoch > bot.rightReadyAt.microsSinceUnixEpoch
        ? bot.leftReadyAt : bot.rightReadyAt;
      const remainingMs = Number(readyAt.microsSinceUnixEpoch - nowMicros(ctx)) / 1000;
      scheduleBot(ctx, match.id, Math.max(1, remainingMs));
      return;
    }

    const s = ctx.db.botStrategy.matchId.find(match.id)!;
    const counter = !isPast(ctx, bot.counterUntil);
    // Counters are fast straight shots; otherwise follow the strategy's punch mix.
    const hand: Hand = ctx.random() < s.leftBias ? 'left' : 'right';
    const refreshedBot = refreshStamina(ctx, bot);
    const type: PunchType = counter
      ? (hand === 'left' ? 'left_straight' : 'right_straight')
      : pickPunchType(ctx, s, hand);
    const spec = PUNCHES[type];
    if (refreshedBot.stamina < spec.stamina) {
      scheduleBot(ctx, match.id, 500);
      return;
    }
    const readyToPunch = ctx.db.fighter.id.update({ ...refreshedBot, stamina: refreshedBot.stamina - spec.stamina, staminaAt: ctx.timestamp });
    const telegraph = Math.max(250, s.telegraphMs * spec.telegraphScale * (counter ? 0.7 : 1));
    throwPunch(ctx, readyToPunch, hand, type, '', telegraph);

    // Higher aggression shortens the gap; jitter keeps it from being metronomic.
    const jitter = 0.75 + ctx.random() * 0.5;
    // Two bots share one tick in an exhibition, so it ticks faster.
    const gap = s.punchIntervalMs * (1.5 - s.aggression) * jitter * (match.mode === 'exhibition' ? 0.6 : 1);
    scheduleBot(ctx, match.id, Math.max(telegraph + 150, gap));
  }
);

export const closeWindow = spacetimedb.reducer(
  { onSchedule: windowTimer },
  { timer: windowTimer.rowType },
  (ctx, { timer }) => {
    const match = ctx.db.fightMatch.id.find(timer.matchId);
    if (!match || match.status !== 'active') return;
    const [human, bot] = fightersOf(ctx, match.id);
    const start = timer.windowStart.microsSinceUnixEpoch;
    const inWindow = [...ctx.db.attack.matchId.filter(match.id)].filter(
      a => a.result !== 'pending' && a.result !== 'cancelled' && a.impactAt.microsSinceUnixEpoch >= start
    );
    const scorable = inWindow.filter(a => a.result !== 'unscorable');
    const mine = scorable.filter(a => a.attackerSlot === PLAYER_SLOT);
    const theirs = scorable.filter(a => a.attackerSlot === OPPONENT_SLOT);
    const count = (rows: Attack[], pred: (a: Attack) => boolean) => rows.filter(pred).length;
    const strat = ctx.db.botStrategy.matchId.find(match.id);

    ctx.db.fightWindow.insert({
      id: 0n,
      matchId: match.id,
      startAt: timer.windowStart,
      endAt: ctx.timestamp,
      strategyRevision: strat?.revision ?? 0,
      playerJabs: 0, // game uses left_straight / right_straight / left_hook / right_hook only
      playerStraights: count(mine, a => a.punchType.includes('straight')),
      playerHooks: count(mine, a => a.punchType.includes('hook')),
      playerUppercuts: 0,
      playerUnclassified: 0,
      playerLeftAttempts: count(mine, a => a.hand === 'left'),
      playerRightAttempts: count(mine, a => a.hand === 'right'),
      playerLanded: count(mine, a => a.result === 'landed'),
      playerCounters: count(mine, a => a.counter && a.result === 'landed'),
      botAttacks: theirs.length,
      playerSlips: count(theirs, a => a.detail === 'slipped'),
      playerLeanBacks: count(theirs, a => a.detail === 'leaned_back'),
      playerBlocks: count(theirs, a => a.result === 'blocked'),
      playerCaught: count(theirs, isCaught),
      playerHitsTaken: count(theirs, a => a.result === 'landed'),
      unscorable: count(inWindow, a => a.result === 'unscorable'),
      trackingCoverage: human.windowPoseSamples === 0 ? 0 : human.windowGoodSamples / human.windowPoseSamples,
      playerHealth: human.health,
      botHealth: bot.health,
    });

    ctx.db.fighter.id.update({ ...human, windowPoseSamples: 0, windowGoodSamples: 0 });
    // Interval timers keep their row; roll the window start forward.
    ctx.db.windowTimer.scheduledId.update({ ...timer, windowStart: ctx.timestamp });
  }
);

// Called by the strategist (Claude) with a proposed tuning. Values are clamped and
// stale/foreign updates rejected; the bot picks them up on its next swing.
export const applyStrategyUpdate = spacetimedb.reducer(
  {
    matchId: t.u64(),
    sourceWindowId: t.u64(),
    baseRevision: t.u32(),
    aggression: t.f32(),
    punchIntervalMs: t.u32(),
    jabWeight: t.f32(),
    straightWeight: t.f32(),
    hookWeight: t.f32(),
    uppercutWeight: t.f32(),
    leftBias: t.f32(),
    defenseRate: t.f32(),
    telegraphMs: t.u32(),
    explanation: t.string(),
  },
  (ctx, args) => {
    requireMyFighter(ctx, args.matchId);
    const s = ctx.db.botStrategy.matchId.find(args.matchId);
    if (!s) throw new SenderError('not a bot match');
    if (args.baseRevision !== s.revision) throw new SenderError('stale strategy revision');
    const win = ctx.db.fightWindow.id.find(args.sourceWindowId);
    if (!win || win.matchId !== args.matchId) throw new SenderError('unknown source window');

    const w = [args.jabWeight, args.straightWeight, args.hookWeight, args.uppercutWeight].map(v => clamp(v, 0, 1));
    const mix = w.some(v => v > 0) ? w : [BOT_DEFAULTS.jabWeight, BOT_DEFAULTS.straightWeight, BOT_DEFAULTS.hookWeight, BOT_DEFAULTS.uppercutWeight];

    ctx.db.botStrategy.matchId.update({
      ...s,
      revision: s.revision + 1,
      sourceWindowId: args.sourceWindowId,
      aggression: clamp(args.aggression, 0, 1),
      punchIntervalMs: clamp(args.punchIntervalMs, 600, 4000),
      jabWeight: mix[0],
      straightWeight: mix[1],
      hookWeight: mix[2],
      uppercutWeight: mix[3],
      leftBias: clamp(args.leftBias, 0, 1),
      defenseRate: clamp(args.defenseRate, 0, 0.8),
      telegraphMs: clamp(args.telegraphMs, 350, 1200),
      explanation: args.explanation.slice(0, 500),
      updatedAt: ctx.timestamp,
    });
  }
);

// ─── 5. Post-match persistence ─────────────────────────────────────────────

export const submitFightAnalysis = spacetimedb.reducer(
  { matchId: t.u64(), analysis: t.string() },
  (ctx, { matchId, analysis }) => {
    const result = ctx.db.fightResult.matchId.find(matchId);
    if (!result) throw new SenderError('match not finished');
    const me = fightersOf(ctx, matchId).find(f => f.identity?.equals(ctx.sender));
    if (!me) throw new SenderError('not a fighter in this match');
    const text = analysis.slice(0, 4000);
    ctx.db.fightResult.matchId.update({ ...result, analysis: text });
    const p = ensureProfile(ctx, ctx.sender);
    ctx.db.fighterProfile.identity.update({ ...p, lastAnalysis: text, updatedAt: ctx.timestamp });
  }
);
