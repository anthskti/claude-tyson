// Claude Tyson SpacetimeDB module.
// The fight lives here: SpacetimeDB owns the authoritative fight state, runs the CPU
// opponent on a 50ms scheduled tick, and every client (the player's game screen,
// the phone "ringside" spectator screen, the live coach, later the Claude strategist) just subscribes.
// Team contract: shared/contracts.ts (coach/adapter.ts maps these rows to contract types).

import { schema, t, table, SenderError, ScheduleAt } from "spacetimedb/server";
import type { ReducerCtx, InferSchema } from "spacetimedb/server";
import {
  createFight, advance, applyInput, drainEvents,
  type FightState, type Input,
} from "./engine";
import { parseAction } from "./actions";

// ---------- Tables ----------

// One row per fight. Flat columns are what renderers/spectators read;
// `state` is the full engine snapshot the reducers load and save.
const fight = table(
  { name: "fight", public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    owner: t.identity(),
    createdMicros: t.u64(), // server time the fight was created
    status: t.string(), // countdown | fighting | ko | decision
    winner: t.string(), // "" | player | cpu | draw
    t: t.u32(), // engine clock, ms since created
    fightStartsAt: t.u32(),
    roundEndsAt: t.u32(),
    playerHp: t.f32(),
    playerStamina: t.f32(),
    playerPhase: t.string(), // idle | windup | active | recovery | dodge | stunned | ko
    playerMove: t.string(), // punch name, "dodge_L"/"dodge_R", or ""
    playerGuard: t.bool(),
    cpuHp: t.f32(),
    cpuStamina: t.f32(),
    cpuPhase: t.string(),
    cpuMove: t.string(),
    cpuGuard: t.bool(),
    paused: t.bool(), // player tracking lost: fight clock frozen
    capabilities: t.string(), // comma list of Capability the player's input provides (contract v1.1)
    tickId: t.u64(), // scheduled tick row driving this fight
    state: t.string(), // JSON FightState
  }
);

// Append-only log: punch outcomes, KO / time up, and player defense events
// (guard, dodge, lean, guard_check, pause/resume). Contract: CombatEvent / MotionEvent.
// Drives hit sounds, HUD popups, the spectator feed, and post-fight analysis.
const combatEvent = table(
  { name: "combat_event", public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    fightId: t.u64().index(),
    seq: t.u32(),
    t: t.u32(),
    type: t.string(),
    who: t.string(), // subject of guard/dodge/lean/guard_check
    on: t.bool(), // guard on / guard back up
    dir: t.string(), // L | R | ""
    attacker: t.string(),
    punch: t.string(),
    outcome: t.string(),
    damage: t.f32(),
    defenderHp: t.f32(),
    winner: t.string(),
  }
);

// Schedule table: each row makes SpacetimeDB call `tick` every 50ms for one fight.
const fightTick = table(
  { name: "fight_tick" },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    fightId: t.u64(),
  }
);

// Coach lines (contract VoiceCue + where it came from). Spectator phones show these as captions.
const coachCue = table(
  { name: "coach_cue", public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    fightId: t.u64().index(),
    cueId: t.string(),
    atMs: t.u32(),
    persona: t.string(), // coach | opponent
    trigger: t.string(), // proactive | fight_end | ...
    text: t.string(),
    priority: t.string(),
    source: t.string(), // rules | claude | offline
    evidence: t.string(), // JSON string[]
    tactic: t.string(),
  }
);

// "Did the advice help?" Contract AdaptationResult with strategyId = cueId.
const coachEffect = table(
  { name: "coach_effect", public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    fightId: t.u64().index(),
    cueId: t.string(),
    appliedAtMs: t.u32(),
    evaluatedAtMs: t.u32(),
    outcome: t.string(), // improved | worsened | inconclusive
    nextDecision: t.string(), // keep | adjust | revert
    beforeHitRate: t.f32(), // -1 = not measurable
    afterHitRate: t.f32(),
    confidence: t.f32(),
    notes: t.string(),
  }
);

const spacetimedb = schema({ fight, combatEvent, fightTick, coachCue, coachEffect });
export default spacetimedb;

const TICK_MICROS = 50_000n;
type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;

// ---------- Helpers ----------

type FightRow = NonNullable<ReturnType<typeof findFight>>;
function findFight(ctx: Ctx, id: bigint) {
  return ctx.db.fight.id.find(id);
}

function nowMs(ctx: Ctx, row: { createdMicros: bigint }): number {
  return Number((ctx.timestamp.microsSinceUnixEpoch - row.createdMicros) / 1000n);
}

function moveOf(f: FightState["player"]): string {
  if (f.punch) return f.punch;
  if (f.dodgeDir) return `dodge_${f.dodgeDir}`;
  return "";
}

/** Write engine state back to the row + log new events. */
function save(ctx: Ctx, row: FightRow, s: FightState) {
  for (const e of drainEvents(s)) {
    ctx.db.combatEvent.insert({
      id: 0n, fightId: row.id, seq: e.seq, t: e.t, type: e.type,
      who: e.who ?? "", on: e.on ?? false, dir: e.dir ?? "",
      attacker: e.attacker ?? "", punch: e.punch ?? "", outcome: e.outcome ?? "",
      damage: e.damage ?? 0, defenderHp: e.defenderHp ?? 0, winner: e.winner ?? "",
    });
  }
  const over = s.status === "ko" || s.status === "decision";
  if (over && row.tickId !== 0n) {
    ctx.db.fightTick.scheduledId.delete(row.tickId); // stop ticking finished fights
  }
  ctx.db.fight.id.update({
    ...row,
    status: s.status,
    winner: s.winner ?? "",
    t: s.t,
    playerHp: s.player.hp, playerStamina: s.player.stamina,
    playerPhase: s.player.phase, playerMove: moveOf(s.player),
    playerGuard: s.player.guardHeld && s.player.phase === "idle",
    cpuHp: s.cpu.hp, cpuStamina: s.cpu.stamina,
    cpuPhase: s.cpu.phase, cpuMove: moveOf(s.cpu),
    cpuGuard: s.cpu.guardHeld && s.cpu.phase === "idle",
    paused: s.paused,
    tickId: over ? 0n : row.tickId,
    state: JSON.stringify(s),
  });
}

// ---------- Reducers ----------

const CAPS = ["punch_coarse", "punch_types", "dodge", "lean", "guard"];

/**
 * Player starts a new fight. `capabilities`: comma list of what their input can detect,
 * e.g. "punch_coarse,dodge,lean" for the CV kit, "punch_types,guard,dodge" for keyboard.
 * The client sees the new `fight` row appear.
 */
export const startFight = spacetimedb.reducer({ capabilities: t.string() }, (ctx, { capabilities }) => {
  const caps = capabilities.split(",").map((c) => c.trim()).filter((c) => CAPS.includes(c)).join(",");
  const created = ctx.timestamp.microsSinceUnixEpoch;
  const seed = Number(created % 2147483647n);
  const s = createFight(seed);
  const row = ctx.db.fight.insert({
    id: 0n, owner: ctx.sender, createdMicros: created,
    status: s.status, winner: "", t: 0,
    fightStartsAt: s.fightStartsAt, roundEndsAt: s.roundEndsAt,
    playerHp: s.player.hp, playerStamina: s.player.stamina, playerPhase: "idle", playerMove: "", playerGuard: false,
    cpuHp: s.cpu.hp, cpuStamina: s.cpu.stamina, cpuPhase: "idle", cpuMove: "", cpuGuard: false,
    paused: false, capabilities: caps,
    tickId: 0n, state: JSON.stringify(s),
  });
  const tick = ctx.db.fightTick.insert({
    scheduledId: 0n, scheduledAt: ScheduleAt.interval(TICK_MICROS), fightId: row.id,
  });
  ctx.db.fight.id.update({ ...row, tickId: tick.scheduledId });
});

/**
 * Player input. `action` is one of:
 *   jab | cross | hook_l | hook_r | upper_l | upper_r | guard_on | guard_off | dodge_L | dodge_R
 *   lean_L | lean_R | lean_off (held dodge) | tracking_lost | tracking_ok (pause/resume)
 * `eventId`: the CV event id (sessionId:eventId) or "" ; repeats are ignored (one punch = one attack).
 */
export const act = spacetimedb.reducer(
  { fightId: t.u64(), action: t.string(), eventId: t.string() },
  (ctx, { fightId, action, eventId }) => {
    const row = findFight(ctx, fightId);
    if (!row) throw new SenderError("no such fight");
    if (!row.owner.isEqual(ctx.sender)) throw new SenderError("not your fight");
    const parsed = parseAction(action);
    if (!parsed) throw new SenderError(`unknown action ${action}`);
    const input: Input = eventId ? { ...parsed, eventId: eventId.slice(0, 80) } : parsed;

    const s: FightState = JSON.parse(row.state);
    applyInput(s, input, nowMs(ctx, row));
    save(ctx, row, s);
  }
);

/** Runs every 50ms per active fight: advances time, which is when the CPU thinks and punches land. */
export const tick = spacetimedb.reducer(
  { onSchedule: fightTick },
  { arg: fightTick.rowType },
  (ctx, { arg }) => {
    const row = findFight(ctx, arg.fightId);
    if (!row) {
      ctx.db.fightTick.scheduledId.delete(arg.scheduledId);
      return;
    }
    const s: FightState = JSON.parse(row.state);
    advance(s, nowMs(ctx, row));
    save(ctx, row, s);
  }
);

/** Forfeit / leave: ends the fight so the tick stops. */
export const forfeit = spacetimedb.reducer({ fightId: t.u64() }, (ctx, { fightId }) => {
  const row = findFight(ctx, fightId);
  if (!row || !row.owner.isEqual(ctx.sender)) throw new SenderError("not your fight");
  const s: FightState = JSON.parse(row.state);
  s.status = "decision";
  s.winner = "cpu";
  save(ctx, row, s);
});

// ---------- Coach ----------

function ownFight(ctx: Ctx, fightId: bigint) {
  const row = findFight(ctx, fightId);
  if (!row) throw new SenderError("no such fight");
  if (!row.owner.isEqual(ctx.sender)) throw new SenderError("not your fight");
  return row;
}

/** The player's client posts each coach line it speaks, so spectators see the same captions. */
export const postCoachCue = spacetimedb.reducer(
  {
    fightId: t.u64(), cueId: t.string(), atMs: t.u32(), persona: t.string(), trigger: t.string(),
    text: t.string(), priority: t.string(), source: t.string(), evidence: t.string(), tactic: t.string(),
  },
  (ctx, a) => {
    ownFight(ctx, a.fightId);
    if (!a.text || a.text.length > 240) throw new SenderError("bad text");
    if (a.evidence.length > 600) throw new SenderError("evidence too long");
    if (!["rules", "claude", "offline"].includes(a.source)) throw new SenderError("bad source");
    ctx.db.coachCue.insert({ id: 0n, ...a, cueId: a.cueId.slice(0, 120) });
  }
);

export const postCoachEffect = spacetimedb.reducer(
  {
    fightId: t.u64(), cueId: t.string(), appliedAtMs: t.u32(), evaluatedAtMs: t.u32(), outcome: t.string(),
    nextDecision: t.string(), beforeHitRate: t.f32(), afterHitRate: t.f32(), confidence: t.f32(), notes: t.string(),
  },
  (ctx, a) => {
    ownFight(ctx, a.fightId);
    if (!["improved", "worsened", "inconclusive"].includes(a.outcome)) throw new SenderError("bad outcome");
    ctx.db.coachEffect.insert({ id: 0n, ...a, cueId: a.cueId.slice(0, 120), notes: a.notes.slice(0, 300) });
  }
);
