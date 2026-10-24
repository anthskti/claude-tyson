// Adapter for Hani's CV kit output (INTEGRATION_CONTRACT.md §2-4) -> engine Inputs.
// Works the same for the Python localhost bridge or a browser worker port: feed it the
// `cv_sample` wrapper messages in order, call checkStale() every frame.
//
// What the kit supports today: punch_left / punch_right (coarse), lateral dodge position.
// So the player's capabilities are ["punch_coarse", "dodge", "lean"]; no guard, no punch types.

import type { Input } from "../engine/engine";


// Field names exactly as documented; unknown extra fields are tolerated.
export interface CvObservation {
  schemaVersion: number;
  kind: "observation";
  sessionId: string;
  timestampMs: number;
  availableMs?: number;
  trackingState: "calibrating" | "good" | "degraded" | "lost";
  validity: { dodge: boolean; punch_left: boolean; punch_right: boolean };
  calibrationId: string | null;
  markers?: { head?: { x: number; y: number }; left?: { x: number; y: number }; right?: { x: number; y: number } };
  features?: { lateralDisplacementBodyWidths?: number; [k: string]: unknown };
  qualityScore?: number;
}
export interface CvEvent {
  schemaVersion: number;
  eventId: string;
  sessionId: string;
  type: string; // dodge_left | dodge_right | return_neutral | punch_left | punch_right | guard_return_left | guard_return_right
  onsetMs?: number;
  sampleMs: number;
  detectedMs?: number;
  trackingState?: string;
  calibrationId?: string | null;
}
export interface CvSample {
  contractVersion: number;
  kind: "cv_sample";
  fightId: string;
  seq: number;
  source: "live" | "replay" | "synthetic";
  observation: CvObservation;
  events: CvEvent[];
}

export interface CvKitOptions {
  freshnessMs?: number; // INTEGRATION_CONTRACT §3: start at 250ms, measure on the demo laptop
  leanOnBodyWidths?: number; // |lateral| above this = leaning
  leanOffBodyWidths?: number; // below this = neutral (hysteresis)
}

export class CvKitAdapter {
  private o: Required<CvKitOptions>;
  private session: string | null = null;
  private calibration: string | null = null;
  private lastSeq = -1;
  private lastReceiptMs = -Infinity;
  private seen = new Set<string>();
  private lean: "L" | "R" | null = null;
  private trackingOk = false; // fight starts only after a fresh usable observation
  private needsNeutral = true; // after loss/reset, require a fresh neutral before resuming

  constructor(opts: CvKitOptions = {}) {
    this.o = { freshnessMs: 250, leanOnBodyWidths: 0.35, leanOffBodyWidths: 0.2, ...opts };
  }

  get tracking() { return this.trackingOk; }

  /** Feed one cv_sample message. `nowMs` = local receipt time (performance.now()). */
  push(msg: CvSample, nowMs: number): Input[] {
    const out: Input[] = [];
    if (msg.kind !== "cv_sample" || msg.contractVersion !== 1) return out; // reject unsupported major versions
    const obs = msg.observation;

    // new CV session or recalibration: drop held pose and pending associations
    if (obs.sessionId !== this.session || obs.calibrationId !== this.calibration) {
      if (this.session !== null) this.lose(out);
      this.session = obs.sessionId;
      this.calibration = obs.calibrationId;
      this.seen.clear();
      this.lastSeq = msg.seq - 1;
      this.needsNeutral = true;
    }
    // sequence gap = coverage uncertain -> recovery path
    if (msg.seq !== this.lastSeq + 1) {
      this.lose(out);
      this.needsNeutral = true;
    }
    this.lastSeq = msg.seq;
    this.lastReceiptMs = nowMs;

    const usable = obs.trackingState !== "lost" && obs.trackingState !== "calibrating" && obs.validity?.dodge && obs.calibrationId !== null;
    if (!usable) {
      this.lose(out);
      return out;
    }

    // continuous lean from lateral position (negative = player-left)
    const x = obs.features?.lateralDisplacementBodyWidths;
    let lean = this.lean;
    if (typeof x === "number") {
      if (Math.abs(x) >= this.o.leanOnBodyWidths) lean = x < 0 ? "L" : "R";
      else if (Math.abs(x) <= this.o.leanOffBodyWidths) lean = null;
    }

    // recovering: wait for a fresh neutral before resuming; never replay punches from the gap
    if (!this.trackingOk) {
      if (lean !== null || (this.needsNeutral && typeof x !== "number")) return out;
      this.trackingOk = true;
      this.needsNeutral = false;
      out.push({ who: "player", kind: "tracking", ok: true });
      for (const e of msg.events) this.seen.add(`${e.sessionId}:${e.eventId}`); // consumed, not replayed
      return out;
    }

    if (lean !== this.lean) {
      this.lean = lean;
      out.push({ who: "player", kind: "lean", dir: lean });
    }

    for (const e of msg.events) {
      const key = `${e.sessionId}:${e.eventId}`;
      if (this.seen.has(key)) continue; // dedupe (sessionId, eventId)
      this.seen.add(key);
      if (e.calibrationId !== undefined && e.calibrationId !== this.calibration) continue; // old baseline
      if (e.type === "punch_left" && obs.validity.punch_left) out.push({ who: "player", kind: "punch", punch: "jab", eventId: key });
      else if (e.type === "punch_right" && obs.validity.punch_right) out.push({ who: "player", kind: "punch", punch: "cross", eventId: key });
      // dodge_* / return_neutral are covered by the continuous lean; guard_return_* is NOT a block detector
    }
    return out;
  }

  /** Call every frame: no message within the freshness budget = tracking lost. */
  checkStale(nowMs: number): Input[] {
    const out: Input[] = [];
    if (this.trackingOk && nowMs - this.lastReceiptMs > this.o.freshnessMs) {
      this.lose(out);
      this.needsNeutral = true;
    }
    return out;
  }

  private lose(out: Input[]) {
    if (this.lean !== null) {
      this.lean = null;
      out.push({ who: "player", kind: "lean", dir: null });
    }
    if (this.trackingOk) {
      this.trackingOk = false;
      out.push({ who: "player", kind: "tracking", ok: false });
    }
  }
}
