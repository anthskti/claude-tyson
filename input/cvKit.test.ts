import { expect, test } from "bun:test";
import { CvKitAdapter, type CvSample, type CvEvent } from "./cvKit";

let seq = 0;
function sample(o: { x?: number; state?: string; cal?: string | null; session?: string; events?: Partial<CvEvent>[]; seq?: number; lw?: boolean } = {}): CvSample {
  const session = o.session ?? "s1";
  return {
    contractVersion: 1, kind: "cv_sample", fightId: "f1", seq: o.seq ?? seq++, source: "synthetic",
    observation: {
      schemaVersion: 1, kind: "observation", sessionId: session, timestampMs: 0,
      trackingState: (o.state ?? "good") as any,
      validity: { dodge: o.state !== "lost", punch_left: o.lw ?? true, punch_right: true },
      calibrationId: o.cal === undefined ? "cal-1" : o.cal,
      features: o.x === undefined ? {} : { lateralDisplacementBodyWidths: o.x },
    },
    events: (o.events ?? []).map((e, i) => ({ schemaVersion: 1, eventId: `e${i}`, sessionId: session, type: "punch_left", sampleMs: 0, ...e })),
  };
}

function ready() {
  seq = 0;
  const a = new CvKitAdapter();
  expect(a.push(sample({ state: "calibrating", cal: null }), 0)).toEqual([]);
  expect(a.push(sample({ x: 0 }), 33)).toEqual([{ who: "player", kind: "tracking", ok: true }]);
  return a;
}

test("coarse punches map to left/right attacks with dedupe keys", () => {
  const a = ready();
  const out = a.push(sample({ x: 0, events: [{ eventId: "7", type: "punch_left" }, { eventId: "8", type: "punch_right" }] }), 66);
  expect(out).toEqual([
    { who: "player", kind: "punch", punch: "jab", eventId: "s1:7" },
    { who: "player", kind: "punch", punch: "cross", eventId: "s1:8" },
  ]);
  // same event re-sent in the next batch: ignored
  expect(a.push(sample({ x: 0, events: [{ eventId: "7", type: "punch_left" }] }), 99)).toEqual([]);
});

test("guard_return is not a block; unsupported hand is ignored", () => {
  const a = ready();
  expect(a.push(sample({ x: 0, events: [{ eventId: "1", type: "guard_return_left" }] }), 66)).toEqual([]);
  expect(a.push(sample({ x: 0, lw: false, events: [{ eventId: "2", type: "punch_left" }] }), 99)).toEqual([]);
});

test("lean follows continuous lateral position with hysteresis", () => {
  const a = ready();
  expect(a.push(sample({ x: -0.5 }), 66)).toEqual([{ who: "player", kind: "lean", dir: "L" }]);
  expect(a.push(sample({ x: -0.3 }), 99)).toEqual([]); // still leaning (hysteresis)
  expect(a.push(sample({ x: -0.1 }), 132)).toEqual([{ who: "player", kind: "lean", dir: null }]);
});

test("stale stream pauses; resume needs fresh neutral; no backlog punch burst", () => {
  const a = ready();
  a.push(sample({ x: -0.5 }), 66);
  expect(a.checkStale(400)).toEqual([
    { who: "player", kind: "lean", dir: null },
    { who: "player", kind: "tracking", ok: false },
  ]);
  // backlog arrives still leaning with a delayed punch: stays paused, punch not replayed
  expect(a.push(sample({ x: -0.5, events: [{ eventId: "9", type: "punch_left" }] }), 500)).toEqual([]);
  // fresh neutral: resume, delayed punch still not replayed
  expect(a.push(sample({ x: 0, events: [{ eventId: "9", type: "punch_left" }] }), 533)).toEqual([{ who: "player", kind: "tracking", ok: true }]);
  expect(a.push(sample({ x: 0, events: [{ eventId: "9", type: "punch_left" }] }), 566)).toEqual([]);
});

test("lost tracking, sequence gap and recalibration all reset safely", () => {
  const a = ready();
  expect(a.push(sample({ state: "lost" }), 66)).toEqual([{ who: "player", kind: "tracking", ok: false }]);
  a.push(sample({ x: 0 }), 99); // recovers
  expect(a.push(sample({ x: 0, seq: 999 }), 132)).toContainEqual({ who: "player", kind: "tracking", ok: false }); // gap
  seq = 1000;
  a.push(sample({ x: 0 }), 165);
  expect(a.tracking).toBe(true);
  // recalibration: old-baseline event can't trigger a hit
  const out = a.push(sample({ x: 0, cal: "cal-2", events: [{ eventId: "3", type: "punch_left", calibrationId: "cal-1" }] }), 198);
  expect(out.some((i) => i.kind === "punch")).toBe(false);
});
