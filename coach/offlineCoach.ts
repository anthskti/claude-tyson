// Offline strategic coach: same CoachRequest -> CoachResponse contract as the Claude route,
// built from the stats alone. Used when there's no API key, Claude errors, or it times out
// (INTEGRATION_CONTRACT §6: "Disable Claude/backend -> local match continues").

import type { CoachRequest, CoachResponse } from "../shared/contracts";
import { attempts, landed, hitRate } from "./stats";

export function offlineCoachResponse(req: CoachRequest): CoachResponse {
  const caps = req.capabilities ?? [];
  const p = req.player, o = req.opponent;
  const n = attempts(p);
  const hr = hitRate(p);
  const style = req.playerStyle;
  const said = new Set(req.previousCoachLines);
  const cands: { advice: string; evidence: string[]; tactic: CoachResponse["suggestedTactic"] }[] = [];

  if (req.trigger === "fight_end") {
    const won = (req.fightState?.playerHealth ?? 0) > (req.fightState?.opponentHealth ?? 0);
    cands.push({
      advice: `${won ? "Great fight!" : "Tough fight."} You landed ${landed(p)} of ${n} punches. ${p.longestCombo >= 3 ? "Your combos worked." : "Next time, chain two or three together."}`,
      evidence: [`${landed(p)}/${n} landed`, `longest combo ${p.longestCombo}`],
      tactic: "mix_punches",
    });
  }
  if (style?.tags.includes("guard_drops") && caps.includes("guard"))
    cands.push({ advice: "Your hands drop after every punch. Snap them back to your face.", evidence: [`guard drop rate ${Math.round((style.guardDropAfterPunchRate01 ?? 0) * 100)}%`], tactic: "defend" });
  if (style?.tags.includes("left_biased"))
    cands.push({ advice: "You're all left hand. He's waiting for it. Throw the right.", evidence: [`${p.leftAttempts} left vs ${p.rightAttempts} right`], tactic: "mix_punches" });
  if (style?.tags.includes("right_biased"))
    cands.push({ advice: "Too many rights. Set them up with your left first.", evidence: [`${p.rightAttempts} right vs ${p.leftAttempts} left`], tactic: "mix_punches" });
  if (o.successfulBlocks >= 3 && hr !== null && hr < 0.35)
    cands.push({ advice: caps.includes("punch_types") ? "He's blocking high. Go uppercut to break the guard." : "He's blocking. Let him punch first, then counter.", evidence: [`${o.successfulBlocks} blocked`], tactic: "change_rhythm" });
  if (p.damageTaken > p.damageDealt * 1.5 && p.damageTaken >= 10)
    cands.push({ advice: caps.includes("lean") || caps.includes("dodge") ? "You're eating shots. Slip left or right when he winds up." : "You're eating shots. Punch less, pick your moments.", evidence: [`taken ${p.damageTaken} vs dealt ${p.damageDealt}`], tactic: "defend" });
  if (n >= 4 && hr !== null && hr >= 0.6)
    cands.push({ advice: "That's working. Keep the pressure on!", evidence: [`${Math.round(hr * 100)}% landed`], tactic: "attack_head" });
  if (n < 3 && req.trigger === "proactive")
    cands.push({ advice: "Let your hands go! Throw first and keep him busy.", evidence: [`${n} punches in window`], tactic: "attack_head" });

  const pick = cands.find((c) => !said.has(c.advice));
  return {
    schemaVersion: 1, requestId: req.requestId, source: "offline",
    advice: pick?.advice ?? "", referencedEvidence: pick?.evidence ?? [],
    ...(pick?.tactic ? { suggestedTactic: pick.tactic } : {}),
  };
}
