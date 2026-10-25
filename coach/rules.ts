// Instant coach: fast local rules, no network. Runs on every new event.
// Capability-gated: never talks about punch types or guard if the input can't see them.

import type { Capability, CombatEvent, VoiceCue } from "../shared/contracts";
import type { ContractEvent } from "./adapter";

type Attack = Extract<CombatEvent, { kind: "attack_resolved" }>;

export interface RuleContext {
  fightId: string;
  nowMs: number; // fight clock
  events: ContractEvent[]; // full log so far
  caps: Capability[];
  playerHealth: number;
  playerStamina01: number;
  voiceId: string;
}

interface Rule {
  id: string;
  cooldownMs: number;
  once?: boolean;
  priority: VoiceCue["priority"];
  delivery: VoiceCue["delivery"];
  check: (c: RuleContext, recent: (ms: number) => Attack[]) => string | null;
}

const has = (c: RuleContext, cap: Capability) => c.caps.includes(cap);

// Every line a rule can say, so the audio layer can pre-generate them for zero-latency playback.
export const RULE_LINES = {
  low_hp: "Protect yourself! Stay moving and pick your shots.",
  guard_drop: "Hands back up after you punch!",
  countered_types: "He's countering your big windups. Lead with the jab.",
  countered_coarse: "He's countering you. Throw quicker, shorter shots.",
  guard_wall_types: "He's covering up. An uppercut breaks his guard!",
  guard_wall_coarse: "He's blocking everything. Wait for him to punch, then fire back.",
  read_hooks: "He's reading your hooks. Mix them up.",
  slipped_coarse: "He keeps slipping you. Change your rhythm.",
  gassed: "You're gassed. Breathe, then go again.",
  praise_counter: "Beautiful counter!",
  praise_slip: "Nice slip!",
} as const;

const RULES: Rule[] = [
  {
    id: "low_hp", cooldownMs: Infinity, once: true, priority: "urgent", delivery: "interrupt",
    check: (c) => (c.playerHealth > 0 && c.playerHealth < 25 ? RULE_LINES.low_hp : null),
  },
  {
    id: "guard_drop", cooldownMs: 15_000, priority: "normal", delivery: "queue",
    check: (c, recent) => {
      if (!has(c, "guard")) return null;
      const checks = c.events.filter(
        (e): e is Extract<CombatEvent, { kind: "guard_check" }> => e.kind === "guard_check" && e.fighter === "player",
      ).slice(-3);
      const tookHit = recent(6000).some((a) => a.attacker === "opponent" && a.result === "hit");
      return checks.length === 3 && checks.every((x) => !x.guardUp) && tookHit ? RULE_LINES.guard_drop : null;
    },
  },
  {
    id: "countered", cooldownMs: 15_000, priority: "normal", delivery: "queue",
    check: (c, recent) => {
      const n = recent(8000).filter((a) => a.attacker === "opponent" && a.detail === "counter").length;
      if (n < 2) return null;
      return has(c, "punch_types") ? RULE_LINES.countered_types : RULE_LINES.countered_coarse;
    },
  },
  {
    id: "guard_wall", cooldownMs: 15_000, priority: "normal", delivery: "queue",
    check: (c, recent) => {
      const mine = recent(8000).filter((a) => a.attacker === "player").slice(-4);
      if (mine.length < 3 || mine.filter((a) => a.result === "blocked").length < 3) return null;
      return has(c, "punch_types") ? RULE_LINES.guard_wall_types : RULE_LINES.guard_wall_coarse;
    },
  },
  {
    id: "slipped", cooldownMs: 15_000, priority: "normal", delivery: "queue",
    check: (c, recent) => {
      const dodged = recent(8000).filter((a) => a.attacker === "player" && a.result === "dodged");
      if (has(c, "punch_types") && dodged.filter((a) => a.punchType === "hook").length >= 2) return RULE_LINES.read_hooks;
      return dodged.length >= 3 ? RULE_LINES.slipped_coarse : null;
    },
  },
  {
    id: "gassed", cooldownMs: 20_000, priority: "low", delivery: "drop_if_busy",
    check: (c) => (c.playerStamina01 < 0.15 ? RULE_LINES.gassed : null),
  },
  {
    id: "praise_counter", cooldownMs: 15_000, priority: "low", delivery: "drop_if_busy",
    check: (_c, recent) => (recent(800).some((a) => a.attacker === "player" && a.detail === "counter") ? RULE_LINES.praise_counter : null),
  },
  {
    id: "praise_slip", cooldownMs: 20_000, priority: "low", delivery: "drop_if_busy",
    check: (c, recent) =>
      (has(c, "dodge") || has(c, "lean")) &&
      recent(800).some((a) => a.attacker === "opponent" && a.result === "dodged")
        ? RULE_LINES.praise_slip : null,
  },
];

/** Which tactic each rule is pushing, so its effect can be measured like a Claude tip. */
export const RULE_TACTIC: Record<string, "defend" | "change_rhythm" | "mix_punches" | undefined> = {
  guard_drop: "defend", low_hp: "defend", countered: "change_rhythm", guard_wall: "change_rhythm", slipped: "mix_punches",
};

export class InstantCoach {
  private lastFired = new Map<string, number>();
  private fired = new Set<string>();

  /** Returns at most one cue: the highest-priority rule that fires now. */
  evaluate(c: RuleContext): VoiceCue | null {
    const attacks = c.events.filter(
      (e): e is Attack => e.kind === "attack_resolved" && e.result !== "unscorable",
    );
    const recent = (ms: number) => attacks.filter((a) => a.atMs >= c.nowMs - ms && a.atMs <= c.nowMs);
    for (const r of RULES) {
      if (r.once && this.fired.has(r.id)) continue;
      const last = this.lastFired.get(r.id);
      if (last !== undefined && c.nowMs - last < r.cooldownMs) continue;
      const text = r.check(c, recent);
      if (!text) continue;
      this.lastFired.set(r.id, c.nowMs);
      this.fired.add(r.id);
      return {
        cueId: `${c.fightId}:rule:${r.id}:${c.nowMs}`, fightId: c.fightId, atMs: c.nowMs,
        persona: "coach", trigger: "proactive", text, priority: r.priority, delivery: r.delivery,
        voiceId: c.voiceId, cooldownMs: r.cooldownMs === Infinity ? 0 : r.cooldownMs,
      };
    }
    return null;
  }
}
