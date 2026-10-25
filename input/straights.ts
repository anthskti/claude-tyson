import type { Punch } from "../engine/engine";

/** Design-contract name for a straight punch, by anatomical hand. */
export type StraightPunch = "left_straight" | "right_straight";

/** Orthodox straights keep the jab and cross engine punches, clips, and HUD labels. */
export function enginePunchForStraight(straight: StraightPunch): Extract<Punch, "jab" | "cross"> {
  return straight === "left_straight" ? "jab" : "cross";
}
