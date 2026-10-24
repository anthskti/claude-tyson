// Claude Tyson — authoritative fight server.
//
// Covers the server half of the integration flow:
//   1. Match creation      — startBotMatch / joinPvpQueue
//   2. Motion input        — updatePose (body + guard state) + submitMotionEvent (punches)
//   3. Combat resolution   — attacks resolve at their scheduled impact time against the
//                            defender's *current* body/guard via rules.ts
//   4. AI adaptation       — fightWindow rows every ~6 s feed the strategist; applyStrategyUpdate
//                            validates/clamps the returned tuning for the bot controller
//   5. Persistence         — fightResult + fighterProfile updated when the match ends
//   6. Coach               — coachCue + coachEffect rows (spectators see captions; effect measurement)

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
  COUNTER_SCALE,
  COUNTER_WINDOW_MS,
  PUNCHES,
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
const ROUND_MS = 180_000;
const POSE_FRESH_MS = 250;
const WINDOW_MS = 6_000;
const BOT_PAUSED_RETRY_MS = 500;
const BOT_COUNTER_DELAY_MS = 250;

const BOT_DEFAULTS = {
  aggression: 0.5,
  punchIntervalMs: 1600,
  jabWeight: 0.4,
  straightWeight: 0.25,
  hookWeight: 0.2,
  uppercutWeight: 0.15,
  leftBias: 0.5,
  defenseRate: 0.3,
  telegraphMs: 650,
};

// What the bot does when it decides to defend. Equal odds, so the player can't
// learn one answer; the strategist can make it "read" better via defenseRate.
const BOT_DEFENSES: { body: Body; left: Guard; right: Guard }[] = [
  { body: 'lean_left', left: 'neutral', right: 'neutral' },
  { body: 'lean_right', left: 'neutral', right: 'neutral' },
  { body: 'lean_back', left: 'neutral', right: 'neutral' },
  { body: 'neutral', left: 'block', right: 'block' },
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
    mode: t.string(), // 'bot' | 'pvp'
    status: t.string().index('btree'), // 'active' | 'finished'
    startedAt: t.timestamp(),
    endsAt: t.timestamp(),
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
    // Latest pose from CV. Server receipt time is used for freshness.
    bodyState: t.string(), // rules.Body
    leftGuard: t.string(), // rules.Guard
    rightGuard: t.string(),
    lateral: t.f32(), // continuous, for rendering only
    trackingState: t.string(),
    dodgeValid: t.bool(),
    punchLeftValid: t.bool(),
    punchRightValid: t.bool(),
    cvSessionId: t.string(),
    calibrationId: t.string(),
    poseAt: t.timestamp(),
    // A hand that is punching can't block or punch again until it's ready.
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

// ─── Coach tables (v1.1) ───────────────────────────────────────────────────

// Coach lines — spectator phones see these as captions.
const coachCue = table(
  { name: 'coach_cue', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    matchId: t.u64().index('btree'),
    cueId: t.string(),
    atMs: t.u32(),
    persona: t.string(), // 'coach' | 'opponent'
    trigger: t.string(), // 'proactive' | 'fight_end' | ...
    text: t.string(),
    priority: t.string(),
    source: t.string(), // 'rules' | 'claude' | 'offline'
    evidence: t.string(), // JSON string[]
    tactic: t.string(),
  }
);

// "Did the advice help?" — AdaptationResult with cueId as strategyId.
const coachEffect = table(
  { name: 'coach_effect', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    matchId: t.u64().index('btree'),
    cueId: t.string(),
    appliedAtMs: t.u32(),
    evaluatedAtMs: t.u32(),
    outcome: t.string(), // 'improved' | 'worsened' | 'inconclusive'
    nextDecision: t.string(), // 'keep' | 'adjust' | 'revert'
    beforeHitRate: t.f32(), // -1 = not measurable
    afterHitRate: t.f32(),
    confidence: t.f32(),
    notes: t.string(),
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
  fightResult,
  coachCue,
  coachEffect,
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

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function fightersOf(ctx: Ctx, matchId: bigint): Fighter[] {
  return [...ctx.db.fighter.matchId.filter(matchId)].sort((a, b) => a.slot - b.slot);
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

// For coach tables: the match may already be finished (fight_end cue).
function requireFighter(ctx: Ctx, matchId: bigint): Match {
  const match = ctx.db.fightMatch.id.find(matchId);
  if (!match) throw new SenderError('match not found');
  const fighter = fightersOf(ctx, matchId).find(f => f.identity?.equals(ctx.sender));
  if (!fighter) throw new SenderError('not your match');
  return match;
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
    bodyState: 'neutral',
    leftGuard: 'neutral',
    rightGuard: 'neutral',
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

function createMatch(ctx: Ctx, mode: 'bot' | 'pvp', p0: Identity, p1: Identity | undefined): Match {
  const match = ctx.db.fightMatch.insert({
    id: 0n,
    mode,
    status: 'active',
    startedAt: ctx.timestamp,
    endsAt: after(ctx, ROUND_MS),
  });
  insertFighter(ctx, match.id, PLAYER_SLOT, p0);
  insertFighter(ctx, match.id, OPPONENT_SLOT, p1);
  ensureProfile(ctx, p0);
  if (p1) ensureProfile(ctx, p1);

  ctx.db.roundTimer.insert({
    scheduledId: 0n,
    scheduledAt: ScheduleAt.time(match.endsAt.microsSinceUnixEpoch),
    matchId: match.id,
  });

  if (mode === 'bot') {
    ctx.db.botStrategy.insert({
      matchId: match.id,
      revision: 0,
      sourceWindowId: 0n,
      ...BOT_DEFAULTS,
      explanation: 'baseline',
      updatedAt: ctx.timestamp,
    });
    scheduleBot(ctx, match.id, 2000);
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
  const readyAt = after(ctx, Math.max(spec.cooldownMs, windupMs + 150));
  ctx.db.fighter.id.update({
    ...attacker,
    leftReadyAt: hand === 'left' ? readyAt : attacker.leftReadyAt,
    rightReadyAt: hand === 'right' ? readyAt : attacker.rightReadyAt,
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
  return f.dodgeValid && f.trackingState !== 'lost' && f.trackingState !== 'calibrating'
    && msSince(ctx, f.poseAt) <= POSE_FRESH_MS;
}

/** A guard only counts if that hand isn't currently out throwing a punch. */
function defenderState(ctx: Ctx, f: Fighter): DefenderState {
  return {
    body: asBody(f.bodyState),
    leftGuard: isPast(ctx, f.leftReadyAt) ? asGuard(f.leftGuard) : 'neutral',
    rightGuard: isPast(ctx, f.rightReadyAt) ? asGuard(f.rightGuard) : 'neutral',
  };
}

function botDefense(ctx: Ctx, strat: Strategy | undefined): DefenderState {
  if (ctx.random() >= (strat?.defenseRate ?? BOT_DEFAULTS.defenseRate)) {
    return { body: 'neutral', leftGuard: 'neutral', rightGuard: 'neutral' };
  }
  const d = BOT_DEFENSES[ctx.random.integerInRange(0, BOT_DEFENSES.length - 1)];
  return { body: d.body, leftGuard: d.left, rightGuard: d.right };
}

function guardLabel(d: DefenderState): string {
  const l = d.leftGuard === 'block';
  const r = d.rightGuard === 'block';
  return l && r ? 'both' : l ? 'left' : r ? 'right' : 'none';
}

function pickPunchType(ctx: Ctx, s: Strategy): PunchType {
  const weights: [PunchType, number][] = [
    ['jab', s.jabWeight],
    ['straight', s.straightWeight],
    ['hook', s.hookWeight],
    ['uppercut', s.uppercutWeight],
  ];
  const total = weights.reduce((sum, [, w]) => sum + w, 0);
  if (total <= 0) return 'jab';
  let roll = ctx.random() * total;
  for (const [type, w] of weights) {
    roll -= w;
    if (roll < 0) return type;
  }
  return 'jab';
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
      jabs: p.jabs + count(mine, a => a.punchType === 'jab'),
      straights: p.straights + count(mine, a => a.punchType === 'straight'),
      hooks: p.hooks + count(mine, a => a.punchType === 'hook'),
      uppercuts: p.uppercuts + count(mine, a => a.punchType === 'uppercut'),
      unclassified: p.unclassified + count(mine, a => a.punchType === 'unclassified'),
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
}

// ─── Lifecycle ─────────────────────────────────────────────────────────────

export const onConnect = spacetimedb.clientConnected(ctx => {
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
  ctx.db.queueEntry.identity.delete(ctx.sender);
  createMatch(ctx, 'bot', ctx.sender, undefined);
});

export const joinPvpQueue = spacetimedb.reducer(ctx => {
  if (activeMatchFor(ctx, ctx.sender)) throw new SenderError('already in a match');
  if (ctx.db.queueEntry.identity.find(ctx.sender)) return;

  const waiting = [...ctx.db.queueEntry.iter()]
    .sort((a, b) => Number(a.joinedAt.microsSinceUnixEpoch - b.joinedAt.microsSinceUnixEpoch))[0];
  if (waiting) {
    ctx.db.queueEntry.identity.delete(waiting.identity);
    createMatch(ctx, 'pvp', waiting.identity, ctx.sender);
  } else {
    ctx.db.queueEntry.insert({ identity: ctx.sender, joinedAt: ctx.timestamp });
  }
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
    const { me } = requireMyFighter(ctx, args.matchId);
    const good = args.trackingState === 'good' || (args.trackingState === 'degraded' && args.dodgeValid);
    ctx.db.fighter.id.update({
      ...me,
      // Untracked inputs can't defend: an invalid wrist is never a block.
      bodyState: args.dodgeValid ? asBody(args.bodyState) : 'neutral',
      leftGuard: args.punchLeftValid ? asGuard(args.leftGuard) : 'neutral',
      rightGuard: args.punchRightValid ? asGuard(args.rightGuard) : 'neutral',
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
    const { me } = requireMyFighter(ctx, matchId);

    const key = `${cvSessionId}:${eventId}`;
    if (ctx.db.seenCvEvent.key.find(key)) return; // duplicate delivery
    ctx.db.seenCvEvent.insert({ key, matchId });

    // Events from a previous CV session / calibration must not trigger new hits.
    if (me.cvSessionId && cvSessionId !== me.cvSessionId) return;

    // Body movement and guards are resolved from continuous pose; only punches start attacks.
    if (eventType !== 'punch_left' && eventType !== 'punch_right') return;
    const hand: Hand = eventType === 'punch_left' ? 'left' : 'right';
    if (hand === 'left' ? !me.punchLeftValid : !me.punchRightValid) return;
    if (!isPast(ctx, hand === 'left' ? me.leftReadyAt : me.rightReadyAt)) return; // hand still busy

    const type = asPunchType(punchType);
    throwPunch(ctx, me, hand, type, eventId, PUNCHES[type].windupMs);
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
    const state = defender.identity ? defenderState(ctx, defender) : botDefense(ctx, strat);
    const outcome = resolvePunch(asPunchType(atk.punchType), atk.hand as Hand, state);

    const scale = outcome.damageScale * (atk.counter && outcome.result !== 'dodged' ? COUNTER_SCALE : 1);
    const damage = Math.round(PUNCHES[asPunchType(atk.punchType)].damage * scale);
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

// ─── 4. Bot controller + strategist interface ──────────────────────────────

export const botAct = spacetimedb.reducer(
  { onSchedule: botTick },
  { timer: botTick.rowType },
  (ctx, { timer }) => {
    const match = ctx.db.fightMatch.id.find(timer.matchId);
    if (!match || match.status !== 'active') return;
    const [human, bot] = fightersOf(ctx, match.id);

    // Pause bot offence while the player's tracking is unusable (contract §3).
    if (!poseIsUsable(ctx, human)) {
      scheduleBot(ctx, match.id, BOT_PAUSED_RETRY_MS);
      return;
    }

    const s = ctx.db.botStrategy.matchId.find(match.id)!;
    const counter = !isPast(ctx, bot.counterUntil);
    // Counters are fast straight shots; otherwise follow the strategy's punch mix.
    const type: PunchType = counter ? 'straight' : pickPunchType(ctx, s);
    const hand: Hand = ctx.random() < s.leftBias ? 'left' : 'right';
    const telegraph = Math.max(250, s.telegraphMs * PUNCHES[type].telegraphScale * (counter ? 0.7 : 1));
    throwPunch(ctx, bot, hand, type, '', telegraph);

    // Higher aggression shortens the gap; jitter keeps it from being metronomic.
    const jitter = 0.75 + ctx.random() * 0.5;
    const gap = s.punchIntervalMs * (1.5 - s.aggression) * jitter;
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
      playerJabs: count(mine, a => a.punchType === 'jab'),
      playerStraights: count(mine, a => a.punchType === 'straight'),
      playerHooks: count(mine, a => a.punchType === 'hook'),
      playerUppercuts: count(mine, a => a.punchType === 'uppercut'),
      playerUnclassified: count(mine, a => a.punchType === 'unclassified'),
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

// ─── 6. Coach (v1.1) ───────────────────────────────────────────────────────

/** The player's client posts each coach line it speaks, so spectators see the same captions. */
export const postCoachCue = spacetimedb.reducer(
  {
    matchId: t.u64(), cueId: t.string(), atMs: t.u32(), persona: t.string(), trigger: t.string(),
    text: t.string(), priority: t.string(), source: t.string(), evidence: t.string(), tactic: t.string(),
  },
  (ctx, a) => {
    requireFighter(ctx, a.matchId);
    if (!a.text || a.text.length > 240) throw new SenderError('bad text');
    if (a.evidence.length > 600) throw new SenderError('evidence too long');
    if (!['rules', 'claude', 'offline'].includes(a.source)) throw new SenderError('bad source');
    ctx.db.coachCue.insert({ id: 0n, ...a, cueId: a.cueId.slice(0, 120) });
  }
);

export const postCoachEffect = spacetimedb.reducer(
  {
    matchId: t.u64(), cueId: t.string(), appliedAtMs: t.u32(), evaluatedAtMs: t.u32(), outcome: t.string(),
    nextDecision: t.string(), beforeHitRate: t.f32(), afterHitRate: t.f32(), confidence: t.f32(), notes: t.string(),
  },
  (ctx, a) => {
    requireFighter(ctx, a.matchId);
    if (!['improved', 'worsened', 'inconclusive'].includes(a.outcome)) throw new SenderError('bad outcome');
    ctx.db.coachEffect.insert({ id: 0n, ...a, cueId: a.cueId.slice(0, 120), notes: a.notes.slice(0, 300) });
  }
);
