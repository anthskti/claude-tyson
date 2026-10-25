// "Did the advice help?" Compare the player before vs after a coach line, as an
// AdaptationResult (contract §8) with strategyId = cueId. Correlation, not causation.

import type { AdaptationResult, CoachResponse } from "../shared/contracts";
import type { ContractEvent } from "./adapter";
import { buildFighterStats, attempts, hitRate, guardRecoveryRate } from "./stats";

export interface EffectInput {
  fightId: string;
  cueId: string;
  tactic?: CoachResponse["suggestedTactic"];
  appliedAtMs: number;
  evaluatedAtMs: number;
  windowMs?: number;
  events: ContractEvent[];
}

export function evaluateCoachEffect(i: EffectInput): AdaptationResult {
  const w = i.windowMs ?? 10_000;
  const bFrom = Math.max(0, i.appliedAtMs - w), bTo = i.appliedAtMs;
  const aFrom = i.appliedAtMs, aTo = Math.min(i.evaluatedAtMs, i.appliedAtMs + w);
  const before = buildFighterStats(i.events, "player", bFrom, bTo);
  const after = buildFighterStats(i.events, "player", aFrom, aTo);
  const side = (s: typeof before, from: number, to: number) => ({
    durationMs: to - from,
    playerAttempts: attempts(s),
    playerHitRate01: round2(hitRate(s)),
    damageToOpponent: s.damageDealt,
  });
  const gB = guardRecoveryRate(i.events, bFrom, bTo);
  const gA = guardRecoveryRate(i.events, aFrom, aTo);
  // compare damage as a RATE: the after-window can be shorter (e.g. the fight ended)
  const perSec = (x: number, ms: number) => (ms > 0 ? (x * 1000) / ms : 0);
  const takenB = perSec(before.damageTaken, bTo - bFrom), takenA = perSec(after.damageTaken, aTo - aFrom);

  // Which metric matters depends on the advice: defense advice -> guard recovery / damage taken.
  let delta: number | null;
  let notes: string;
  if (i.tactic === "defend" && gB !== null && gA !== null) {
    delta = gA - gB;
    notes = `Guard recovery after punches ${pct(gB)} -> ${pct(gA)}.`;
  } else if (i.tactic === "defend") {
    delta = takenB + takenA > 0 ? (takenB - takenA) / Math.max(takenB, takenA) : null;
    notes = `Damage taken per second ${takenB.toFixed(1)} -> ${takenA.toFixed(1)}.`;
  } else {
    const hb = hitRate(before), ha = hitRate(after);
    delta = hb !== null && ha !== null ? ha - hb : null;
    notes = `Hit rate ${pct(hb)} -> ${pct(ha)}.`;
  }
  const sample = attempts(before) + attempts(after);
  const confidence = Math.min(1, sample / 16);
  const tooShort = aTo - aFrom < w * 0.4; // not enough time after the tip to judge
  if (tooShort) notes += " (too little time after the tip to judge)";
  const outcome: AdaptationResult["outcome"] =
    delta === null || confidence < 0.25 || tooShort ? "inconclusive" : delta >= 0.1 ? "improved" : delta <= -0.1 ? "worsened" : "inconclusive";
  return {
    schemaVersion: 1, fightId: i.fightId, strategyId: i.cueId,
    appliedAtMs: i.appliedAtMs, evaluatedAtMs: i.evaluatedAtMs,
    before: side(before, bFrom, bTo),
    after: side(after, aFrom, aTo),
    outcome,
    confidence01: round2(confidence) ?? 0,
    nextDecision: outcome === "improved" ? "keep" : outcome === "worsened" ? "revert" : "adjust",
    notes,
  };
}

const pct = (x: number | null) => (x === null ? "n/a" : `${Math.round(x * 100)}%`);
function round2(x: number | null): number | null {
  return x === null ? null : Math.round(x * 100) / 100;
}
