// Aggregation: contract events -> FighterStats / StyleEvidence / FightWindow / CoachRequest.
// Counts are per unique attackId (never per frame). Unscorable attacks are excluded from
// every denominator and reported separately (INTEGRATION_CONTRACT §5).

import type {
  Capability, CoachRequest, CombatEvent, Fighter, FighterStats, FightSnapshot, FightWindow,
  PunchCounts, PunchType, StyleEvidence,
} from "../shared/contracts";
import type { ContractEvent } from "./adapter";

type Attack = Extract<CombatEvent, { kind: "attack_resolved" }>;
const PUNCH_TYPES: PunchType[] = ["jab", "cross", "hook", "uppercut"];
const COMBO_GAP_MS = 700;

const inWin = (e: { atMs: number }, from: number, to: number) => e.atMs >= from && e.atMs <= to;
const attacksOf = (ev: ContractEvent[]) =>
  ev.filter((e): e is Attack => e.kind === "attack_resolved" && e.result !== "unscorable");

function emptyCounts(): PunchCounts {
  return { attempted: 0, landed: 0, blocked: 0, dodged: 0, missed: 0, damage: 0 };
}

export function buildFighterStats(events: ContractEvent[], fighter: Fighter, fromMs = 0, toMs = Infinity): FighterStats {
  const win = events.filter((e) => inWin(e, fromMs, toMs));
  const atks = attacksOf(win);
  const mine = atks.filter((a) => a.attacker === fighter);
  const theirs = atks.filter((a) => a.attacker !== fighter);
  const punches = Object.fromEntries(PUNCH_TYPES.map((p) => [p, emptyCounts()])) as Record<PunchType, PunchCounts>;
  for (const a of mine) {
    const c = punches[a.punchType];
    c.attempted++;
    if (a.result === "hit") c.landed++;
    if (a.result === "blocked") c.blocked++;
    if (a.result === "dodged") c.dodged++;
    if (a.result === "missed") c.missed++;
    c.damage += a.damage;
  }
  // combos: my consecutive attacks <700ms apart, broken by taking a hit
  let longest = 0, run = 0, lastAt = -Infinity;
  const ordered = [...atks].sort((x, y) => x.atMs - y.atMs);
  for (const a of ordered) {
    if (a.attacker === fighter) {
      run = a.atMs - lastAt <= COMBO_GAP_MS ? run + 1 : 1;
      lastAt = a.atMs;
      longest = Math.max(longest, run);
    } else if (a.result === "hit") {
      run = 0;
      lastAt = -Infinity;
    }
  }
  const times = mine.map((a) => a.atMs).sort((x, y) => x - y);
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  const motion = win.filter((e) => fighter === "player" && "source" in e);
  const dodgeMotions = motion.filter((e) => e.kind === "dodge").length;
  const guardUps = motion.filter((e) => e.kind === "guard_change" && e.guard === "up").length;
  const successfulDodges = theirs.filter((a) => a.result === "dodged").length;
  const successfulBlocks = theirs.filter((a) => a.result === "blocked").length;
  return {
    punches,
    leftAttempts: mine.filter((a) => a.hand === "left").length,
    rightAttempts: mine.filter((a) => a.hand === "right").length,
    headHits: mine.filter((a) => a.result === "hit" && a.target === "head").length,
    bodyHits: mine.filter((a) => a.result === "hit" && a.target === "body").length,
    blocksAttempted: fighter === "player" ? guardUps : successfulBlocks,
    successfulBlocks,
    dodgesAttempted: fighter === "player" ? Math.max(dodgeMotions, successfulDodges) : successfulDodges,
    successfulDodges,
    damageDealt: round1(mine.reduce((s, a) => s + a.damage, 0)),
    damageTaken: round1(theirs.reduce((s, a) => s + a.damage, 0)),
    longestCombo: longest,
    ...(gaps.length ? { averageInterPunchMs: Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length) } : {}),
  };
}

const round1 = (x: number) => Math.round(x * 10) / 10;
const total = (s: FighterStats, k: keyof PunchCounts) => PUNCH_TYPES.reduce((n, p) => n + s.punches[p][k], 0);
export const attempts = (s: FighterStats) => total(s, "attempted");
export const landed = (s: FighterStats) => total(s, "landed");
export const hitRate = (s: FighterStats) => (attempts(s) ? landed(s) / attempts(s) : null);

/** Fraction of guard checks where the player's hands came back up (null if not measurable). */
export function guardRecoveryRate(events: ContractEvent[], fromMs = 0, toMs = Infinity): number | null {
  const checks = events.filter(
    (e): e is Extract<CombatEvent, { kind: "guard_check" }> =>
      e.kind === "guard_check" && e.fighter === "player" && inWin(e, fromMs, toMs),
  );
  return checks.length ? checks.filter((c) => c.guardUp).length / checks.length : null;
}

export function buildStyleEvidence(events: ContractEvent[], caps: Capability[], fromMs = 0, toMs = Infinity): StyleEvidence {
  const s = buildFighterStats(events, "player", fromMs, toMs);
  const n = attempts(s);
  const tags: StyleEvidence["tags"] = [];
  const leftShare = n ? s.leftAttempts / n : undefined;
  if (n >= 6 && leftShare !== undefined && leftShare >= 0.7) tags.push("left_biased");
  if (n >= 6 && leftShare !== undefined && leftShare <= 0.3) tags.push("right_biased");
  let jabShare: number | undefined;
  if (caps.includes("punch_types") && n >= 6) {
    jabShare = s.punches.jab.attempted / n;
    if (jabShare >= 0.5) tags.push("jab_heavy");
    if (s.punches.hook.attempted / n >= 0.35) tags.push("hook_heavy");
  }
  let dropRate: number | undefined;
  if (caps.includes("guard")) {
    const r = guardRecoveryRate(events, fromMs, toMs);
    const checks = events.filter((e) => e.kind === "guard_check" && e.fighter === "player" && inWin(e, fromMs, toMs)).length;
    if (r !== null && checks >= 3) {
      dropRate = 1 - r;
      if (dropRate >= 0.5) tags.push("guard_drops");
    }
  }
  if (n >= 10 && !tags.some((t) => t.endsWith("_biased") || t.endsWith("_heavy"))) tags.push("unpredictable");
  return {
    tags,
    ...(leftShare !== undefined ? { leftAttackShare01: round2(leftShare) } : {}),
    ...(jabShare !== undefined ? { jabShare01: round2(jabShare) } : {}),
    ...(dropRate !== undefined ? { guardDropAfterPunchRate01: round2(dropRate) } : {}),
    confidence01: round2(Math.min(1, n / 12)),
  };
}
const round2 = (x: number) => Math.round(x * 100) / 100;

/** Wall time with tracking lost inside [from, to] (fight clock is frozen while paused). */
function pausedCount(events: ContractEvent[], fromMs: number, toMs: number) {
  return events.filter((e) => e.kind === "tracking_pause" && e.phase === "paused" && inWin(e, fromMs, toMs)).length;
}

export function buildWindow(events: ContractEvent[], fromMs: number, toMs: number, caps: Capability[]): FightWindow {
  const win = events.filter((e) => inWin(e, fromMs, toMs));
  const resolved = win.filter((e) => e.kind === "attack_resolved");
  const unscorable = resolved.filter((e) => e.kind === "attack_resolved" && e.result === "unscorable").length;
  const pauses = pausedCount(events, fromMs, toMs);
  return {
    windowStartMs: fromMs,
    windowEndMs: toMs,
    player: buildFighterStats(events, "player", fromMs, toMs),
    opponent: buildFighterStats(events, "opponent", fromMs, toMs),
    playerStyle: buildStyleEvidence(events, caps, fromMs, toMs),
    motionEventsCount: win.filter((e) => "source" in e).length,
    resolvedAttacksCount: resolved.length - unscorable,
    trackingQuality01: pauses ? 0.5 : 1,
    supportedActions: caps,
    unscorableCount: unscorable,
  };
}

export interface CoachRequestInput {
  requestId: string;
  fightId: string;
  nowMs: number;
  trigger: CoachRequest["trigger"];
  events: ContractEvent[];
  snapshot: FightSnapshot;
  playerStamina01: number;
  caps: Capability[];
  previousLines: string[];
  windowMs?: number; // default 15s; fight_end uses the whole fight
}

export function buildCoachRequest(i: CoachRequestInput): CoachRequest {
  const from = i.trigger === "fight_end" ? 0 : Math.max(0, i.nowMs - (i.windowMs ?? 15_000));
  const oppAttacks = attacksOf(i.events.filter((e) => inWin(e, from, i.nowMs))).filter((a) => a.attacker === "opponent");
  const opp = i.snapshot.opponent;
  return {
    schemaVersion: 1,
    requestId: i.requestId,
    fightId: i.fightId,
    atMs: i.nowMs,
    trigger: i.trigger,
    player: buildFighterStats(i.events, "player", from, i.nowMs),
    opponent: buildFighterStats(i.events, "opponent", from, i.nowMs),
    observableOpponent: {
      guardHeight01: opp.state === "blocking" ? 1 : 0.4,
      recentPunches: oppAttacks.slice(-5).map((a) => a.punchType),
      perceivedOpenings: opp.state === "blocking" ? [] : ["head"],
    },
    previousCoachLines: i.previousLines.slice(-4),
    capabilities: i.caps,
    playerStyle: buildStyleEvidence(i.events, i.caps, from, i.nowMs),
    window: { startMs: from, endMs: i.nowMs },
    fightState: {
      playerHealth: i.snapshot.player.health,
      opponentHealth: opp.health,
      playerStamina01: round2(Math.max(0, Math.min(1, i.playerStamina01))),
      roundTimeRemainingMs: i.snapshot.roundTimeRemainingMs,
    },
  };
}
