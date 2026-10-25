// Adapter: engine events / SpacetimeDB rows  ->  team contract types (shared/contracts.ts).
// Everything downstream (coach, HUD, analysis, strategist) speaks contract types only.

import type {
  CombatEvent, MotionEvent, FightSnapshot, PunchType, Side, Fighter, FightStatus, InputSource,
} from "../shared/contracts";

/** Shape shared by engine CombatEvent and the `combat_event` table row. */
export interface RawEvent {
  seq: number;
  t: number;
  type: string;
  who?: string;
  on?: boolean;
  dir?: string;
  attacker?: string;
  punch?: string;
  outcome?: string;
  damage?: number;
  defenderHp?: number;
  winner?: string;
}

/** Shape shared by the `fight` table row and engineRow() below. */
export interface FightRowLike {
  status: string; // countdown | fighting | ko | decision
  paused: boolean;
  t: number;
  roundEndsAt: number;
  playerHp: number;
  playerStamina: number;
  cpuHp: number;
  cpuStamina: number;
  cpuPhase: string;
  cpuMove: string;
  cpuGuard: boolean;
}

export type ContractEvent = CombatEvent | MotionEvent;

export interface AdapterContext {
  fightId: string;
  roundIndex?: number;
  source?: InputSource;
  maxHealth?: number;
  maxStamina?: number;
}

export const fighterOf = (x?: string): Fighter => (x === "cpu" || x === "opponent" ? "opponent" : "player");

const PUNCH_MAP: Record<string, { punchType: PunchType; hand: Side }> = {
  jab: { punchType: "jab", hand: "left" },
  cross: { punchType: "cross", hand: "right" },
  hook_l: { punchType: "hook", hand: "left" },
  hook_r: { punchType: "hook", hand: "right" },
  upper_l: { punchType: "uppercut", hand: "left" },
  upper_r: { punchType: "uppercut", hand: "right" },
};
export const punchToContract = (p: string) => PUNCH_MAP[p] ?? { punchType: "jab" as PunchType, hand: "left" as Side };

/** Convert one raw event into 0..1 contract events. Unknown types are ignored safely. */
export function toContractEvent(e: RawEvent, ctx: AdapterContext): ContractEvent | null {
  const base = { schemaVersion: 1 as const, fightId: ctx.fightId, roundIndex: ctx.roundIndex ?? 0, atMs: e.t };
  const id = `${ctx.fightId}:${e.seq}`;
  const motion = { ...base, eventId: id, source: ctx.source ?? "pose", confidence01: 1, trackingQuality01: 1 };
  switch (e.type) {
    case "punch": {
      const { punchType, hand } = punchToContract(e.punch ?? "");
      const o = e.outcome ?? "hit";
      const result = o === "counter" || o === "guard_break" ? "hit" : (o as "hit" | "blocked" | "dodged" | "unscorable");
      return {
        ...base, kind: "attack_resolved", eventId: id, attackId: id,
        attacker: fighterOf(e.attacker), punchType, hand, target: "head", result,
        ...(o === "counter" || o === "guard_break" ? { detail: o } : {}),
        damage: e.damage ?? 0, defenderHealthAfter: e.defenderHp ?? 0,
      };
    }
    case "ko":
    case "time_up":
      return { ...base, kind: "round_transition", phase: "ended", reason: e.type === "ko" ? "knockout" : "timer" };
    case "guard_check":
      return { ...base, kind: "guard_check", eventId: id, fighter: fighterOf(e.who), guardUp: !!e.on };
    case "pause":
    case "resume":
      return { ...base, kind: "tracking_pause", phase: e.type === "pause" ? "paused" : "resumed" };
    case "guard":
      return { ...motion, kind: "guard_change", guard: e.on ? "up" : "down" };
    case "dodge":
      return { ...motion, kind: "dodge", direction: e.dir === "L" ? "left" : "right" };
    case "lean":
      return e.dir ? { ...motion, kind: "dodge", direction: e.dir === "L" ? "left" : "right" } : null;
    default:
      return null;
  }
}

export function toContractEvents(raw: RawEvent[], ctx: AdapterContext): ContractEvent[] {
  const out: ContractEvent[] = [];
  for (const e of raw) {
    const c = toContractEvent(e, ctx);
    if (c) out.push(c);
  }
  return out;
}

const OPP_STATE: Record<string, FightSnapshot["opponent"]["state"]> = {
  idle: "idle", windup: "attacking", active: "attacking", recovery: "attacking",
  dodge: "dodging", stunned: "stunned", ko: "ko",
};

export function toFightSnapshot(row: FightRowLike, ctx: AdapterContext): FightSnapshot {
  const maxHealth = ctx.maxHealth ?? 100, maxStamina = ctx.maxStamina ?? 100;
  const status: FightStatus =
    row.status === "countdown" ? "waiting"
    : row.status === "fighting" ? (row.paused ? "break" : "active")
    : "finished";
  const state = row.cpuGuard && row.cpuPhase === "idle" ? "blocking" : OPP_STATE[row.cpuPhase] ?? "idle";
  return {
    schemaVersion: 1, fightId: ctx.fightId, roundIndex: ctx.roundIndex ?? 0, atMs: row.t,
    status,
    roundTimeRemainingMs: Math.max(0, row.roundEndsAt - row.t),
    player: { health: row.playerHp, maxHealth, tracking: row.paused ? "lost" : "ok" },
    opponent: {
      health: row.cpuHp, maxHealth, worldX: 0, worldZ: 0, // positions belong to the scene mapper
      state,
      animation: row.cpuMove ? `${row.cpuPhase}_${row.cpuMove}` : row.cpuPhase,
      stamina01: Math.max(0, Math.min(1, row.cpuStamina / maxStamina)),
    },
  };
}

/** Engine FightState -> the same row shape the SpacetimeDB `fight` table has. */
export function engineRow(s: {
  status: string; paused: boolean; t: number; roundEndsAt: number;
  player: { hp: number; stamina: number };
  cpu: { hp: number; stamina: number; phase: string; punch: string | null; dodgeDir: string | null; guardHeld: boolean };
}): FightRowLike {
  return {
    status: s.status, paused: s.paused, t: s.t, roundEndsAt: s.roundEndsAt,
    playerHp: s.player.hp, playerStamina: s.player.stamina,
    cpuHp: s.cpu.hp, cpuStamina: s.cpu.stamina, cpuPhase: s.cpu.phase,
    cpuMove: s.cpu.punch ?? (s.cpu.dodgeDir ? `dodge_${s.cpu.dodgeDir}` : ""),
    cpuGuard: s.cpu.guardHeld,
  };
}
