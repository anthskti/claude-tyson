// Motion Engine: MediaPipe Pose landmarks -> game Inputs.
// Feed it one frame at a time from PoseLandmarker.detectForVideo(); it returns 0..n Inputs.
// Everything is measured in "shoulder widths" so it works at any distance from the webcam.

import type { Input, Punch, DodgeDir } from "../engine/engine";
import { enginePunchForStraight } from "./straights";

export interface Landmark { x: number; y: number; z?: number; visibility?: number }

// MediaPipe Pose indices (person's own left/right)
const NOSE = 0, L_SH = 11, R_SH = 12, L_WR = 15, R_WR = 16;

export interface MotionConfig {
  mirrored: boolean; // true if the landmarks come from a selfie-flipped video
  punchSpeed: number; // shoulder widths per second to count as a punch
  uppercutRatio: number; // |up| must beat |sideways| by this factor
  hookInwardRatio: number; // inward motion must beat up motion by this factor
  handCooldownMs: number;
  guardRadius: number; // both wrists within this many shoulder widths of the nose
  dodgeOffset: number; // nose offset from calibrated center to trigger a dodge
  dodgeResetOffset: number; // must come back inside this before the next dodge
  minVisibility: number;
}

export const DEFAULT_MOTION: MotionConfig = {
  mirrored: false,
  punchSpeed: 4.0,
  uppercutRatio: 1.3,
  hookInwardRatio: 1.2,
  handCooldownMs: 300,
  guardRadius: 0.95,
  dodgeOffset: 0.45,
  dodgeResetOffset: 0.2,
  minVisibility: 0.5,
};

interface Sample { t: number; x: number; y: number }

export class MotionEngine {
  cfg: MotionConfig;
  private hist: Record<"L" | "R", Sample[]> = { L: [], R: [] };
  private lastPunch: Record<"L" | "R", number> = { L: -1e9, R: -1e9 };
  private guard = false;
  private dodgeLatched = false;
  private calib: { noseX: number; shoulderW: number } | null = null;
  private calibSamples: { noseX: number; shoulderW: number }[] = [];

  constructor(cfg: Partial<MotionConfig> = {}) {
    this.cfg = { ...DEFAULT_MOTION, ...cfg };
  }

  get calibrated() { return this.calib !== null; }

  /** Call every frame during the "line up your head and arms" screen. Returns progress 0..1. */
  calibrate(lm: Landmark[], samplesNeeded = 30): number {
    if (!this.visible(lm, [NOSE, L_SH, R_SH])) return this.calibSamples.length / samplesNeeded;
    this.calibSamples.push({ noseX: lm[NOSE].x, shoulderW: Math.abs(lm[L_SH].x - lm[R_SH].x) });
    if (this.calibSamples.length >= samplesNeeded) {
      const avg = (k: "noseX" | "shoulderW") =>
        this.calibSamples.reduce((a, s) => a + s[k], 0) / this.calibSamples.length;
      this.calib = { noseX: avg("noseX"), shoulderW: Math.max(0.05, avg("shoulderW")) };
    }
    return Math.min(1, this.calibSamples.length / samplesNeeded);
  }

  /** Process one frame. `t` in ms (performance.now()). */
  update(lm: Landmark[], t: number): Input[] {
    const out: Input[] = [];
    if (!this.calib || !this.visible(lm, [NOSE, L_SH, R_SH])) return out;
    const sw = this.calib.shoulderW;
    const flip = this.cfg.mirrored ? -1 : 1;
    // person-space x: positive = toward the person's LEFT
    // (unmirrored webcam: the person's left side appears on the right of the image)
    const px = (x: number) => (flip * x) / sw;
    const py = (y: number) => y / sw;
    const midX = px((lm[L_SH].x + lm[R_SH].x) / 2);

    // ---- guard (with hysteresis) ----
    const nose = { x: px(lm[NOSE].x), y: py(lm[NOSE].y) };
    const near = (i: number, r: number) =>
      this.visible(lm, [i]) && Math.hypot(px(lm[i].x) - nose.x, py(lm[i].y) - nose.y) < r;
    const r = this.cfg.guardRadius;
    // on: both wrists close to face. off: either wrist clearly away (1.3x radius) -> no flicker
    const guardNow = this.guard
      ? near(L_WR, r * 1.3) && near(R_WR, r * 1.3)
      : near(L_WR, r) && near(R_WR, r);
    if (guardNow !== this.guard) {
      this.guard = guardNow;
      out.push({ who: "player", kind: "guard", on: guardNow });
    }

    // ---- dodge (head slip left/right) ----
    const offset = nose.x - px(this.calib.noseX);
    if (!this.dodgeLatched && Math.abs(offset) > this.cfg.dodgeOffset) {
      const dir: DodgeDir = offset > 0 ? "L" : "R";
      this.dodgeLatched = true;
      out.push({ who: "player", kind: "dodge", dir });
    } else if (this.dodgeLatched && Math.abs(offset) < this.cfg.dodgeResetOffset) {
      this.dodgeLatched = false;
    }

    // ---- punches (per hand, from wrist velocity) ----
    for (const hand of ["L", "R"] as const) {
      const idx = hand === "L" ? L_WR : R_WR;
      const h = this.hist[hand];
      if (!this.visible(lm, [idx])) { h.length = 0; continue; }
      h.push({ t, x: px(lm[idx].x), y: py(lm[idx].y) });
      while (h.length > 2 && t - h[0].t > 100) h.shift(); // ~100ms window
      if (h.length < 2 || t - this.lastPunch[hand] < this.cfg.handCooldownMs) continue;

      const a = h[0], b = h[h.length - 1];
      const dt = (b.t - a.t) / 1000;
      if (dt <= 0.02) continue;
      const vx = (b.x - a.x) / dt, vy = (b.y - a.y) / dt;
      const speed = Math.hypot(vx, vy);
      if (speed < this.cfg.punchSpeed) continue;

      const up = -vy; // image y grows downward
      // inward = toward the body midline (left hand moves toward -x, right hand toward +x)
      const sideSign = hand === "L" ? 1 : -1;
      const inward = (b.x - midX) * sideSign < (a.x - midX) * sideSign ? Math.abs(vx) : 0;

      let punch: Punch;
      if (up > 0 && up > Math.abs(vx) * this.cfg.uppercutRatio) {
        punch = hand === "L" ? "upper_l" : "upper_r";
      } else if (inward > Math.max(0, up) * this.cfg.hookInwardRatio && inward > speed * 0.7) {
        punch = hand === "L" ? "hook_l" : "hook_r";
      } else {
        punch = enginePunchForStraight(hand === "L" ? "left_straight" : "right_straight");
      }
      this.lastPunch[hand] = t;
      h.length = 0;
      out.push({ who: "player", kind: "punch", punch });
    }
    return out;
  }

  private visible(lm: Landmark[], ids: number[]) {
    return ids.every((i) => lm[i] && (lm[i].visibility ?? 1) >= this.cfg.minVisibility);
  }
}
