import { expect, test } from "bun:test";
import {
  advance, applyInput, createFight, drainEvents, applyTuningPatch, CONFIG,
  DEFAULT_TUNING, type FightState, type Input, type Punch, ALL_PUNCHES,
} from "./engine";

// Bot that never acts, so we can test rules in isolation.
const PASSIVE = { ...DEFAULT_TUNING, aggression: 0, blockChance: 0, dodgeChance: 0, decisionMs: 99999 };
const START = CONFIG.countdownMs;

function fight(): FightState {
  const s = createFight(42, PASSIVE);
  s.botNextDecision = Infinity; // fully frozen bot
  advance(s, START + 10);
  return s;
}
const P = (punch: Punch): Input => ({ who: "player", kind: "punch", punch });

test("countdown then fighting", () => {
  const s = createFight(1, PASSIVE);
  applyInput(s, P("jab"), 1000);
  expect(s.status).toBe("countdown");
  expect(s.player.stats.attempted).toBe(0); // inputs ignored during countdown
  advance(s, START + 10);
  expect(s.status).toBe("fighting");
});

test("clean jab lands for 4", () => {
  const s = fight();
  applyInput(s, P("jab"), s.t);
  advance(s, s.t + 200);
  expect(s.cpu.hp).toBe(96);
  const e = drainEvents(s).find((e) => e.type === "punch")!;
  expect(e.outcome).toBe("hit");
});

test("block reduces damage, uppercut breaks guard", () => {
  const s = fight();
  s.cpu.guardHeld = true;
  applyInput(s, P("cross"), s.t);
  advance(s, s.t + 1000);
  expect(s.cpu.hp).toBe(100 - 8 * CONFIG.blockMult);
  applyInput(s, P("upper_l"), s.t);
  advance(s, s.t + 400);
  const ev = drainEvents(s).filter((e) => e.type === "punch").map((e) => e.outcome);
  expect(ev).toEqual(["blocked", "guard_break"]);
  expect(s.cpu.phase).toBe("stunned");
});

test("hooks need the right dodge direction, straights don't", () => {
  for (const [punch, dir, expected] of [
    ["hook_l", "L", "dodged"], ["hook_l", "R", "hit"], ["jab", "R", "dodged"],
  ] as const) {
    const s = fight();
    applyInput(s, P(punch), s.t);
    applyInput(s, { who: "cpu", kind: "dodge", dir }, s.t + 60);
    advance(s, s.t + 600);
    const e = drainEvents(s).find((e) => e.type === "punch")!;
    expect(`${punch}/${dir}:${e.outcome}`).toBe(`${punch}/${dir}:${expected}`);
  }
});

test("hitting someone mid-windup is a counter (x1.5, cancels their punch)", () => {
  const s = fight();
  applyInput(s, { who: "cpu", kind: "punch", punch: "upper_r" }, s.t); // 320ms windup
  applyInput(s, P("jab"), s.t + 50); // lands at +170, inside their windup
  advance(s, s.t + 1000);
  const ev = drainEvents(s).filter((e) => e.type === "punch");
  expect(ev.length).toBe(1);
  expect(ev[0].outcome).toBe("counter");
  expect(s.cpu.hp).toBe(100 - 4 * 1.5);
});

test("input during recovery is buffered, not dropped", () => {
  const s = fight();
  applyInput(s, P("jab"), s.t);
  applyInput(s, P("cross"), s.t + 250); // still in recovery
  advance(s, s.t + 2000);
  expect(s.player.stats.attempted).toBe(2);
});

test("out of stamina punches are slower and weaker", () => {
  const s = fight();
  s.player.stamina = 0;
  applyInput(s, P("jab"), s.t);
  advance(s, s.t + 150);
  expect(s.cpu.hp).toBe(100); // normal jab would have landed at 120ms
  advance(s, s.t + 100);
  expect(s.cpu.hp).toBe(100 - 4 * CONFIG.weakDamageMult);
});

test("KO ends the fight", () => {
  const s = fight();
  s.cpu.hp = 3;
  applyInput(s, P("jab"), s.t);
  advance(s, s.t + 300);
  expect(s.status).toBe("ko");
  expect(s.winner).toBe("player");
});

test("time up decides on HP", () => {
  const s = fight();
  s.cpu.hp = 50;
  advance(s, START + CONFIG.roundMs + 20);
  expect(s.status).toBe("decision");
  expect(s.winner).toBe("player");
});

test("deterministic: same seed + inputs = same result (server and client agree)", () => {
  const run = () => {
    const s = createFight(7);
    for (let i = 0; i < 200; i++)
      applyInput(s, P(ALL_PUNCHES[i % 6]), START + i * 450);
    advance(s, START + CONFIG.roundMs + 50);
    return JSON.stringify([s.player.hp, s.cpu.hp, s.winner, s.player.stats, s.cpu.stats]);
  };
  expect(run()).toBe(run());
});

test("tuning patches are clamped to small nudges", () => {
  const s = createFight(1);
  applyTuningPatch(s, { aggression: 1, reactionMs: 50, punchWeights: { jab: 99 } });
  expect(s.tuning.aggression).toBeCloseTo(DEFAULT_TUNING.aggression + 0.15);
  expect(s.tuning.reactionMs).toBe(DEFAULT_TUNING.reactionMs - 40);
  expect(s.tuning.punchWeights.jab).toBe(DEFAULT_TUNING.punchWeights.jab + 1);
});

test("balance sim: default bot vs a random-mashing player over 200 fights", () => {
  let ko = 0, playerWins = 0, totalLen = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const s = createFight(seed);
    let r = seed * 99991;
    const rnd = () => ((r = (r * 1103515245 + 12345) % 2147483648) / 2147483648);
    let t = START;
    while (s.status === "countdown" || s.status === "fighting") {
      t += 250 + rnd() * 500;
      const x = rnd();
      const inp: Input = x < 0.65 ? P(ALL_PUNCHES[Math.floor(rnd() * 6)])
        : x < 0.85 ? { who: "player", kind: "guard", on: rnd() < 0.5 }
        : { who: "player", kind: "dodge", dir: rnd() < 0.5 ? "L" : "R" };
      applyInput(s, inp, t);
    }
    if (s.status === "ko") ko++;
    if (s.winner === "player") playerWins++;
    totalLen += s.t - START;
  }
  console.log(`KO rate ${ko / 2}%, masher win rate ${playerWins / 2}%, avg fight ${(totalLen / 200 / 1000).toFixed(1)}s`);
  expect(ko).toBeGreaterThan(100); // most fights should end in a KO well inside 90s
});

// ---------- integration-contract features ----------

test("held lean protects for as long as it's held (no second dodge event needed)", () => {
  const s = fight();
  applyInput(s, { who: "player", kind: "lean", dir: "L" }, s.t);
  advance(s, s.t + 1500); // lean held a long time before the attack
  applyInput(s, { who: "cpu", kind: "punch", punch: "cross" }, s.t);
  advance(s, s.t + 400);
  const e = drainEvents(s).find((e) => e.type === "punch")!;
  expect(e.outcome).toBe("dodged");
  applyInput(s, { who: "player", kind: "lean", dir: null }, s.t);
  expect(s.player.phase).toBe("idle");
});

test("lean drains stamina; an exhausted lean stops protecting", () => {
  const s = fight();
  s.player.stamina = 3;
  applyInput(s, { who: "player", kind: "lean", dir: "L" }, s.t);
  advance(s, s.t + 600);
  applyInput(s, { who: "cpu", kind: "punch", punch: "cross" }, s.t);
  advance(s, s.t + 400);
  expect(drainEvents(s).find((e) => e.type === "punch")!.outcome).toBe("hit");
});

test("tracking lost pauses the clock and voids attacks in flight as unscorable", () => {
  const s = fight();
  applyInput(s, { who: "cpu", kind: "punch", punch: "upper_l" }, s.t);
  const t0 = s.t;
  applyInput(s, { who: "player", kind: "tracking", ok: false }, t0 + 100);
  advance(s, t0 + 5000); // 5s of lost tracking
  expect(s.t).toBe(t0 + 100); // fight clock frozen
  expect(s.player.hp).toBe(100); // no hit on an unobserved player
  applyInput(s, P("jab"), t0 + 5000); // inputs ignored while paused
  expect(s.player.stats.attempted).toBe(0);
  applyInput(s, { who: "player", kind: "tracking", ok: true }, t0 + 5000);
  advance(s, t0 + 5300);
  expect(s.t).toBe(t0 + 400); // resumes from where it stopped
  const ev = drainEvents(s);
  expect(ev.find((e) => e.type === "punch")!.outcome).toBe("unscorable");
  expect(s.cpu.stats.attempted).toBe(0); // excluded from stats
  expect(ev.map((e) => e.type)).toEqual(["punch", "pause", "resume"]);
});

test("same eventId delivered twice = one attack", () => {
  const s = fight();
  applyInput(s, { ...P("jab"), eventId: "cv-1:17" }, s.t);
  applyInput(s, { ...P("jab"), eventId: "cv-1:17" }, s.t + 400);
  advance(s, s.t + 1500);
  expect(s.player.stats.attempted).toBe(1);
});

test("guard_check records whether hands came back up after a punch", () => {
  const s = fight();
  applyInput(s, P("jab"), s.t); // no guard afterwards
  advance(s, s.t + 1200);
  applyInput(s, P("jab"), s.t);
  applyInput(s, { who: "player", kind: "guard", on: true }, s.t + 450); // hands back up
  advance(s, s.t + 1200);
  const checks = drainEvents(s).filter((e) => e.type === "guard_check" && e.who === "player").map((e) => e.on);
  expect(checks).toEqual([false, true]);
});
