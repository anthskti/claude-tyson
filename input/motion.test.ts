import { expect, test } from "bun:test";
import { MotionEngine, type Landmark } from "./motion";

// Synthetic skeleton in image coords (unmirrored webcam: person's LEFT is image RIGHT).
// Shoulder width 0.2.
function pose(o: { nose?: [number, number]; lw?: [number, number]; rw?: [number, number] } = {}): Landmark[] {
  const lm: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 1 }));
  lm[0] = { x: o.nose?.[0] ?? 0.5, y: o.nose?.[1] ?? 0.3, visibility: 1 };
  lm[11] = { x: 0.6, y: 0.45, visibility: 1 }; // left shoulder (image right)
  lm[12] = { x: 0.4, y: 0.45, visibility: 1 }; // right shoulder
  lm[15] = { x: o.lw?.[0] ?? 0.65, y: o.lw?.[1] ?? 0.7, visibility: 1 }; // left wrist, hands down
  lm[16] = { x: o.rw?.[0] ?? 0.35, y: o.rw?.[1] ?? 0.7, visibility: 1 };
  return lm;
}

function ready() {
  const m = new MotionEngine();
  for (let i = 0; i < 30; i++) m.calibrate(pose());
  expect(m.calibrated).toBe(true);
  return m;
}

// Move a wrist from a to b over 60ms (3 frames at ~30fps) and collect outputs.
function swing(m: MotionEngine, hand: "lw" | "rw", a: [number, number], b: [number, number], t0: number) {
  const out = [];
  for (let k = 0; k <= 3; k++) {
    const p: [number, number] = [a[0] + ((b[0] - a[0]) * k) / 3, a[1] + ((b[1] - a[1]) * k) / 3];
    out.push(...m.update(pose({ [hand]: p }), t0 + k * 20));
  }
  return out.filter((i) => i.kind === "punch").map((i: any) => i.punch);
}

test("uppercut: right wrist shoots up", () => {
  expect(swing(ready(), "rw", [0.38, 0.7], [0.4, 0.45], 0)).toEqual(["upper_r"]);
});

test("hook: left wrist sweeps inward across the body", () => {
  expect(swing(ready(), "lw", [0.75, 0.42], [0.5, 0.4], 0)).toEqual(["hook_l"]);
});

test("straight: left wrist pushes outward/forward = jab", () => {
  expect(swing(ready(), "lw", [0.56, 0.35], [0.66, 0.33], 0)).toEqual(["jab"]);
});

test("slow movement is not a punch", () => {
  const m = ready();
  const out = [];
  for (let k = 0; k <= 10; k++) out.push(...m.update(pose({ lw: [0.65 - k * 0.002, 0.7] }), k * 33));
  expect(out.filter((i) => i.kind === "punch")).toEqual([]);
});

test("guard on when both wrists by the face, off when dropped", () => {
  const m = ready();
  expect(m.update(pose({ lw: [0.54, 0.33], rw: [0.46, 0.33] }), 0)).toContainEqual({ who: "player", kind: "guard", on: true });
  expect(m.update(pose(), 500)).toContainEqual({ who: "player", kind: "guard", on: false });
});

test("head slip to the person's left = dodge L, must recenter before next", () => {
  const m = ready();
  expect(m.update(pose({ nose: [0.6, 0.3] }), 0)).toContainEqual({ who: "player", kind: "dodge", dir: "L" });
  expect(m.update(pose({ nose: [0.61, 0.3] }), 50)).toEqual([]); // latched
  m.update(pose(), 300);
  expect(m.update(pose({ nose: [0.4, 0.3] }), 400)).toContainEqual({ who: "player", kind: "dodge", dir: "R" });
});
