// Claude Tyson MVP game engine.
// Pure TypeScript, zero dependencies, deterministic (seeded RNG, no Date/Math.random).
// The same file runs in the browser (local practice / prediction) and inside the
// SpacetimeDB module (authoritative fight), so both sides always agree on the rules.

// ---------- Types ----------

export type FighterId = "player" | "cpu";
export type Punch = "jab" | "cross" | "hook_l" | "hook_r" | "upper_l" | "upper_r";
export type DodgeDir = "L" | "R";
export type Phase = "idle" | "windup" | "active" | "recovery" | "dodge" | "stunned" | "ko";
export type Status = "countdown" | "fighting" | "ko" | "decision";
// "unscorable": the attack was in flight when tracking was lost; no damage, excluded from stats.
export type Outcome = "hit" | "counter" | "blocked" | "guard_break" | "dodged" | "unscorable";

// eventId (optional): the CV/motion event id; duplicates are ignored so one punch = one attack.
type InputBase = { who: FighterId; eventId?: string };
export type Input =
  | (InputBase & { kind: "punch"; punch: Punch })
  | (InputBase & { kind: "guard"; on: boolean })
  | (InputBase & { kind: "dodge"; dir: DodgeDir }) // quick slip (timed window)
  | (InputBase & { kind: "lean"; dir: DodgeDir | null }) // held dodge from continuous lateral position
  | (InputBase & { kind: "tracking"; ok: boolean }); // false pauses the fight, true resumes

export interface PunchSpec {
  windup: number; // ms before the punch can connect (the "tell" the animation shows)
  active: number; // ms the fist is out
  recovery: number; // ms before the attacker can act again
  damage: number;
  stamina: number;
  kind: "straight" | "hook" | "upper";
  dodgeDir?: DodgeDir; // hooks must be dodged in a specific direction
}

export interface PunchCounts {
  attempted: number;
  landed: number;
  counters: number;
  blocked: number; // my punches that were blocked
  dodged: number; // my punches that were dodged
  damageDealt: number;
  byPunch: Record<Punch, number>;
}

export interface Fighter {
  hp: number;
  stamina: number;
  guardHeld: boolean; // what the input says (hands up)
  phase: Phase;
  phaseEnd: number; // ms timestamp when current phase ends
  punch: Punch | null; // punch in flight (windup/active/recovery)
  dodgeDir: DodgeDir | null;
  dodgeStart: number;
  weak: boolean; // threw this punch while out of stamina ("low on tokens")
  extraRecovery: number; // punish time added when a punch is blocked or dodged
  queued: Input | null; // one buffered input so the game feels responsive
  lean: DodgeDir | null; // held lean intent
  guardCheckAt: number; // 0 = none; when to record "hands back up after punching?"
  stats: PunchCounts;
}

// Runtime-tunable opponent behavior. MVP: fixed preset.
// Later the Claude strategist only ever sends a TuningPatch for this.
export interface OpponentTuning {
  aggression: number; // 0..1 chance to attack at each decision
  decisionMs: number; // average gap between bot decisions
  reactionMs: number; // how long the bot takes to notice your windup
  blockChance: number; // 0..1 reaction is a block
  dodgeChance: number; // 0..1 reaction is a dodge
  comboChance: number; // 0..1 follow up immediately after a punch
  punchWeights: Record<Punch, number>;
}

export interface CombatEvent {
  seq: number;
  t: number;
  // punch: an attack resolved. guard/dodge/lean: player defensive state changed.
  // guard_check: ~350ms after a punch finished, was the attacker's guard back up? (on = up)
  // pause/resume: player tracking lost/recovered.
  type: "punch" | "ko" | "time_up" | "guard" | "dodge" | "lean" | "guard_check" | "pause" | "resume";
  who?: FighterId; // subject of guard/dodge/lean/guard_check
  on?: boolean;
  dir?: DodgeDir | "";
  attacker?: FighterId;
  punch?: Punch;
  outcome?: Outcome;
  damage?: number;
  defenderHp?: number;
  winner?: FighterId | "draw";
}

export interface FightState {
  t: number; // ms since fight created
  status: Status;
  fightStartsAt: number; // end of countdown
  roundEndsAt: number;
  winner: FighterId | "draw" | null;
  player: Fighter;
  cpu: Fighter;
  tuning: OpponentTuning;
  botNextDecision: number;
  botPendingReaction: { at: number; vs: Punch | null } | null;
  rng: number;
  seq: number;
  paused: boolean;
  pauseOffset: number; // total wall ms spent paused (engine clock = wall - pauseOffset)
  lastWall: number;
  seenIds: string[]; // recent input eventIds for dedupe
  events: CombatEvent[]; // new events since the last drainEvents()
}

// ---------- Tuning constants ----------

export const CONFIG = {
  maxHp: 100,
  maxStamina: 100,
  staminaRegenPerSec: 14,
  countdownMs: 3000,
  roundMs: 90_000,
  stepMs: 10,
  hitStunMs: 260,
  counterStunMs: 480,
  counterMult: 1.5,
  blockMult: 0.15,
  guardBreakMult: 0.6,
  guardBreakStunMs: 400,
  blockedExtraRecovery: 100, // attacker punished a bit for hitting a guard
  whiffExtraRecovery: 160, // big punish window when your punch is dodged
  weakWindupMult: 1.5,
  weakDamageMult: 0.7,
  dodgeMs: 380,
  dodgeInvulnFrom: 40,
  dodgeInvulnTo: 300,
  dodgeStamina: 6,
  leanStaminaPerSec: 10, // holding a lean drains stamina; at 0 the lean stops protecting you
  guardCheckMs: 350,
};

export const PUNCHES: Record<Punch, PunchSpec> = {
  jab: { windup: 120, active: 80, recovery: 200, damage: 4, stamina: 4, kind: "straight" },
  cross: { windup: 200, active: 80, recovery: 300, damage: 8, stamina: 7, kind: "straight" },
  hook_l: { windup: 260, active: 100, recovery: 350, damage: 11, stamina: 10, kind: "hook", dodgeDir: "L" },
  hook_r: { windup: 260, active: 100, recovery: 350, damage: 11, stamina: 10, kind: "hook", dodgeDir: "R" },
  upper_l: { windup: 320, active: 100, recovery: 420, damage: 14, stamina: 13, kind: "upper" },
  upper_r: { windup: 320, active: 100, recovery: 420, damage: 14, stamina: 13, kind: "upper" },
};

export const ALL_PUNCHES = Object.keys(PUNCHES) as Punch[];

export const DEFAULT_TUNING: OpponentTuning = {
  aggression: 0.55,
  decisionMs: 900,
  reactionMs: 230, // slower than a jab windup (120), faster than a hook (260)
  blockChance: 0.35,
  dodgeChance: 0.2,
  comboChance: 0.25,
  punchWeights: { jab: 3, cross: 2, hook_l: 1.5, hook_r: 1.5, upper_l: 0.8, upper_r: 0.8 },
};

// ---------- Helpers ----------

function emptyCounts(): PunchCounts {
  return {
    attempted: 0, landed: 0, counters: 0, blocked: 0, dodged: 0, damageDealt: 0,
    byPunch: { jab: 0, cross: 0, hook_l: 0, hook_r: 0, upper_l: 0, upper_r: 0 },
  };
}

function newFighter(): Fighter {
  return {
    hp: CONFIG.maxHp, stamina: CONFIG.maxStamina, guardHeld: false,
    phase: "idle", phaseEnd: 0, punch: null, dodgeDir: null, dodgeStart: 0,
    weak: false, extraRecovery: 0, queued: null, lean: null, guardCheckAt: 0, stats: emptyCounts(),
  };
}

// mulberry32: tiny seeded RNG, state is one int so it serializes cleanly
function rand(s: FightState): number {
  let a = (s.rng = (s.rng + 0x6d2b79f5) | 0);
  a = Math.imul(a ^ (a >>> 15), a | 1);
  a ^= a + Math.imul(a ^ (a >>> 7), a | 61);
  return ((a ^ (a >>> 14)) >>> 0) / 4294967296;
}

const other = (id: FighterId): FighterId => (id === "player" ? "cpu" : "player");
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function emit(s: FightState, e: Omit<CombatEvent, "seq" | "t">) {
  s.events.push({ seq: ++s.seq, t: s.t, ...e });
}

export function guardUp(f: Fighter): boolean {
  return f.guardHeld && f.phase === "idle";
}

function invulnerable(f: Fighter, t: number): boolean {
  if (f.phase !== "dodge") return false;
  const into = t - f.dodgeStart;
  if (f.lean) return into >= CONFIG.dodgeInvulnFrom && f.stamina > 0; // held lean
  return into >= CONFIG.dodgeInvulnFrom && into <= CONFIG.dodgeInvulnTo;
}

const HELD = Number.MAX_SAFE_INTEGER; // phaseEnd for a held lean

// ---------- Public API ----------

export function createFight(seed = 1, tuning: OpponentTuning = DEFAULT_TUNING): FightState {
  return {
    t: 0,
    status: "countdown",
    fightStartsAt: CONFIG.countdownMs,
    roundEndsAt: CONFIG.countdownMs + CONFIG.roundMs,
    winner: null,
    player: newFighter(),
    cpu: newFighter(),
    tuning: structuredCloneSafe(tuning),
    botNextDecision: CONFIG.countdownMs + 600,
    botPendingReaction: null,
    rng: seed | 0,
    seq: 0,
    paused: false,
    pauseOffset: 0,
    lastWall: 0,
    seenIds: [],
    events: [],
  };
}

/**
 * Advance the simulation to wall time `wallT` (ms since fight created).
 * While paused, wall time passes but the fight clock does not.
 */
export function advance(s: FightState, wallT: number): FightState {
  if (s.paused) {
    s.pauseOffset += Math.max(0, wallT - s.lastWall);
    s.lastWall = Math.max(s.lastWall, wallT);
    return s;
  }
  s.lastWall = Math.max(s.lastWall, wallT);
  const toT = wallT - s.pauseOffset;
  while (s.t + CONFIG.stepMs <= toT && (s.status === "countdown" || s.status === "fighting")) {
    s.t += CONFIG.stepMs;
    step(s);
  }
  if (s.status !== "countdown" && s.status !== "fighting") s.t = Math.max(s.t, toT);
  return s;
}

/** Advance to `atT`, then apply one input. Call this for every player action. */
export function applyInput(s: FightState, input: Input, atT: number): FightState {
  if (input.eventId) {
    if (s.seenIds.includes(input.eventId)) return s; // duplicate delivery
    s.seenIds.push(input.eventId);
    if (s.seenIds.length > 64) s.seenIds.shift();
  }
  if (input.kind === "tracking") {
    setTracking(s, input.ok, atT);
    return s;
  }
  advance(s, atT);
  if (s.status !== "fighting" || s.paused) return s;
  const f = s[input.who];
  const isPlayer = input.who === "player";
  if (input.kind === "guard") {
    if (f.guardHeld !== input.on && isPlayer) emit(s, { type: "guard", who: input.who, on: input.on });
    f.guardHeld = input.on; // guard is "held" state, never queued
    return s;
  }
  if (input.kind === "lean") {
    if (f.lean === input.dir) return s;
    f.lean = input.dir;
    if (isPlayer) emit(s, { type: "lean", who: input.who, dir: input.dir ?? "" });
    if (input.dir && f.phase === "idle") enterLean(s, f);
    else if (!input.dir && f.phase === "dodge" && f.phaseEnd === HELD) toIdle(s, input.who);
    return s; // if busy, the lean starts as soon as the fighter is idle
  }
  if (canAct(f)) start(s, input.who, input);
  else if (f.phase === "recovery" || f.phase === "dodge") f.queued = input; // buffer 1 input
  return s;
}

/** Player tracking lost/recovered. Losing it freezes the clock and voids attacks in flight. */
function setTracking(s: FightState, ok: boolean, atT: number) {
  if (s.status !== "fighting") { s.lastWall = Math.max(s.lastWall, atT); return; }
  if (!ok && !s.paused) {
    advance(s, atT);
    if (s.status !== "fighting") return;
    for (const id of ["player", "cpu"] as FighterId[]) {
      const f = s[id];
      if (f.phase === "windup" && f.punch) {
        emit(s, { type: "punch", attacker: id, punch: f.punch, outcome: "unscorable", damage: 0, defenderHp: s[other(id)].hp });
        f.stats.attempted--; // excluded from stats
        f.stats.byPunch[f.punch]--;
        f.punch = null;
        f.phase = "idle";
        f.queued = null;
      }
    }
    s.botPendingReaction = null;
    s.paused = true;
    emit(s, { type: "pause" });
  } else if (ok && s.paused) {
    advance(s, atT); // accumulates paused time
    s.paused = false;
    s.botNextDecision = Math.max(s.botNextDecision, s.t + 800); // no instant punch on resume
    emit(s, { type: "resume" });
  }
}

/** Take the events produced since the last call (to insert as rows / play sounds). */
export function drainEvents(s: FightState): CombatEvent[] {
  const e = s.events;
  s.events = [];
  return e;
}

/** Claude strategist hook (post-MVP): small clamped nudges only. */
export type TuningPatch = Partial<Omit<OpponentTuning, "punchWeights">> & {
  punchWeights?: Partial<Record<Punch, number>>;
};
export function applyTuningPatch(s: FightState, p: TuningPatch): void {
  const t = s.tuning;
  const nudge = (cur: number, next: number | undefined, maxDelta: number, lo: number, hi: number) =>
    next === undefined ? cur : clamp(clamp(next, cur - maxDelta, cur + maxDelta), lo, hi);
  t.aggression = nudge(t.aggression, p.aggression, 0.15, 0.1, 0.95);
  t.blockChance = nudge(t.blockChance, p.blockChance, 0.15, 0, 0.85);
  t.dodgeChance = nudge(t.dodgeChance, p.dodgeChance, 0.15, 0, 0.7);
  t.comboChance = nudge(t.comboChance, p.comboChance, 0.15, 0, 0.8);
  t.decisionMs = nudge(t.decisionMs, p.decisionMs, 200, 350, 2000);
  t.reactionMs = nudge(t.reactionMs, p.reactionMs, 40, 140, 500);
  if (p.punchWeights)
    for (const k of ALL_PUNCHES)
      t.punchWeights[k] = nudge(t.punchWeights[k], p.punchWeights[k], 1, 0, 6);
}

// ---------- Internals ----------

function structuredCloneSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

function canAct(f: Fighter) {
  return f.phase === "idle";
}

function enterLean(s: FightState, f: Fighter) {
  f.phase = "dodge";
  f.dodgeDir = f.lean;
  f.dodgeStart = s.t;
  f.phaseEnd = HELD;
}

function toIdle(s: FightState, id: FighterId) {
  const f = s[id];
  const wasPunch = f.punch !== null && f.phase === "recovery";
  f.phase = "idle";
  f.punch = null;
  f.dodgeDir = null;
  f.weak = false;
  if (wasPunch) f.guardCheckAt = s.t + CONFIG.guardCheckMs;
  if (f.queued) {
    const q = f.queued;
    f.queued = null;
    start(s, id, q);
  } else if (f.lean) {
    enterLean(s, f);
  }
}

function start(s: FightState, who: FighterId, input: Input) {
  const f = s[who];
  if (input.kind === "punch" || input.kind === "dodge") f.guardCheckAt = 0; // chaining, not resting
  if (input.kind === "punch") {
    const spec = PUNCHES[input.punch];
    f.weak = f.stamina < spec.stamina;
    f.stamina = Math.max(0, f.stamina - spec.stamina);
    f.punch = input.punch;
    f.phase = "windup";
    f.phaseEnd = s.t + spec.windup * (f.weak ? CONFIG.weakWindupMult : 1);
    f.stats.attempted++;
    f.stats.byPunch[input.punch]++;
    if (who === "player") botNoticeWindup(s, input.punch);
  } else if (input.kind === "dodge") {
    f.stamina = Math.max(0, f.stamina - CONFIG.dodgeStamina);
    f.phase = "dodge";
    f.dodgeDir = input.dir;
    f.dodgeStart = s.t;
    f.phaseEnd = s.t + CONFIG.dodgeMs;
    if (who === "player") emit(s, { type: "dodge", who, dir: input.dir });
  }
}

function step(s: FightState) {
  if (s.status === "countdown") {
    if (s.t >= s.fightStartsAt) s.status = "fighting";
    return;
  }
  for (const id of ["player", "cpu"] as FighterId[]) tickFighter(s, id);
  if (s.status !== "fighting") return;
  botThink(s);
  const regen = (CONFIG.staminaRegenPerSec * CONFIG.stepMs) / 1000;
  const leanCost = (CONFIG.leanStaminaPerSec * CONFIG.stepMs) / 1000;
  for (const id of ["player", "cpu"] as FighterId[]) {
    const f = s[id];
    if (f.phase === "idle") f.stamina = Math.min(CONFIG.maxStamina, f.stamina + regen);
    else if (f.phase === "dodge" && f.phaseEnd === HELD) f.stamina = Math.max(0, f.stamina - leanCost);
    if (f.guardCheckAt && s.t >= f.guardCheckAt) {
      f.guardCheckAt = 0;
      if (f.phase === "idle" || f.phase === "dodge")
        emit(s, { type: "guard_check", who: id, on: f.guardHeld });
    }
  }
  if (s.t >= s.roundEndsAt) {
    const p = s.player.hp, c = s.cpu.hp;
    s.winner = p === c ? "draw" : p > c ? "player" : "cpu";
    s.status = "decision";
    emit(s, { type: "time_up", winner: s.winner });
  }
}

function tickFighter(s: FightState, id: FighterId) {
  const f = s[id];
  if (f.phase === "idle" || f.phase === "ko" || s.t < f.phaseEnd) return;
  switch (f.phase) {
    case "windup": {
      const spec = PUNCHES[f.punch!];
      f.phase = "active";
      f.phaseEnd = s.t + spec.active;
      resolveHit(s, id); // the punch connects (or not) the instant it goes active
      break;
    }
    case "active": {
      f.phase = "recovery";
      f.phaseEnd = s.t + PUNCHES[f.punch!].recovery + f.extraRecovery;
      f.extraRecovery = 0;
      break;
    }
    case "recovery":
    case "dodge":
    case "stunned":
      toIdle(s, id);
      break;
  }
}

function resolveHit(s: FightState, attackerId: FighterId) {
  const atk = s[attackerId];
  const defId = other(attackerId);
  const def = s[defId];
  const punch = atk.punch!;
  const spec = PUNCHES[punch];
  let dmg = spec.damage * (atk.weak ? CONFIG.weakDamageMult : 1);
  let outcome: Outcome;

  const dodgeWorks =
    invulnerable(def, s.t) && (spec.dodgeDir === undefined || spec.dodgeDir === def.dodgeDir);

  if (dodgeWorks) {
    outcome = "dodged";
    dmg = 0;
    atk.extraRecovery = CONFIG.whiffExtraRecovery;
    atk.stats.dodged++;
  } else if (guardUp(def)) {
    if (spec.kind === "upper") {
      outcome = "guard_break";
      dmg *= CONFIG.guardBreakMult;
      stun(s, def, CONFIG.guardBreakStunMs);
    } else {
      outcome = "blocked";
      dmg *= CONFIG.blockMult;
      atk.extraRecovery = CONFIG.blockedExtraRecovery;
      atk.stats.blocked++;
    }
  } else if (def.phase === "windup") {
    outcome = "counter"; // caught them mid-windup
    dmg *= CONFIG.counterMult;
    def.punch = null; // their punch is cancelled
    stun(s, def, CONFIG.counterStunMs);
    atk.stats.counters++;
  } else {
    outcome = "hit";
    if (def.phase !== "ko") stun(s, def, CONFIG.hitStunMs);
  }

  dmg = Math.round(dmg * 10) / 10;
  def.hp = Math.max(0, Math.round((def.hp - dmg) * 10) / 10);
  if (outcome === "hit" || outcome === "counter" || outcome === "guard_break") atk.stats.landed++;
  if (outcome === "hit" || outcome === "counter") def.guardCheckAt = 0;
  atk.stats.damageDealt = Math.round((atk.stats.damageDealt + dmg) * 10) / 10;

  emit(s, { type: "punch", attacker: attackerId, punch, outcome, damage: dmg, defenderHp: def.hp });

  if (def.hp <= 0) {
    def.phase = "ko";
    s.status = "ko";
    s.winner = attackerId;
    emit(s, { type: "ko", winner: attackerId });
  }
}

function stun(s: FightState, f: Fighter, ms: number) {
  f.guardCheckAt = 0;
  f.phase = "stunned";
  f.punch = null;
  f.dodgeDir = null;
  f.queued = null;
  f.phaseEnd = s.t + ms;
}

// ---------- Opponent bot ----------
// Two loops: (1) a reaction when it "sees" your windup, (2) periodic decisions to attack/guard.
// Every knob is in OpponentTuning, which is what an adaptive layer would tune later.

function botNoticeWindup(s: FightState, punch: Punch) {
  s.botPendingReaction = { at: s.t + s.tuning.reactionMs, vs: punch };
}

function weightedPunch(s: FightState): Punch {
  const w = s.tuning.punchWeights;
  const total = ALL_PUNCHES.reduce((a, k) => a + Math.max(0, w[k]), 0) || 1;
  let r = rand(s) * total;
  for (const k of ALL_PUNCHES) {
    r -= Math.max(0, w[k]);
    if (r <= 0) return k;
  }
  return "jab";
}

function botThink(s: FightState) {
  const bot = s.cpu;
  const tun = s.tuning;

  // (1) reaction to a seen windup
  const r = s.botPendingReaction;
  if (r && s.t >= r.at) {
    s.botPendingReaction = null;
    const playerStillWinding = s.player.phase === "windup" || s.player.phase === "active";
    if (playerStillWinding && bot.phase === "idle") {
      const roll = rand(s);
      if (roll < tun.dodgeChance) {
        const spec = r.vs ? PUNCHES[r.vs] : null;
        const dir: DodgeDir = spec?.dodgeDir ?? (rand(s) < 0.5 ? "L" : "R");
        start(s, "cpu", { who: "cpu", kind: "dodge", dir });
      } else if (roll < tun.dodgeChance + tun.blockChance) {
        bot.guardHeld = true;
        s.botNextDecision = s.t + 450; // hold guard a moment
      }
    }
  }

  // (2) periodic decision
  if (s.t < s.botNextDecision || bot.phase !== "idle") return;
  const jitter = 0.6 + rand(s) * 0.8;
  s.botNextDecision = s.t + tun.decisionMs * jitter;
  if (rand(s) < tun.aggression) {
    bot.guardHeld = false;
    start(s, "cpu", { who: "cpu", kind: "punch", punch: weightedPunch(s) });
    if (rand(s) < tun.comboChance) {
      bot.queued = { who: "cpu", kind: "punch", punch: weightedPunch(s) };
    }
  } else {
    bot.guardHeld = rand(s) < 0.6;
  }
}
