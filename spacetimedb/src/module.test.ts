import { expect, test } from "vitest";
import { createModuleTestHarness, TestAuth, TestClock } from "spacetimedb/server/test-utils";
import { Timestamp, TimeDuration, ConnectionId } from "spacetimedb";
import spacetimedb, * as mod from "./index";

const ms = (n: number) => new TimeDuration(BigInt(n) * 1000n);

test("fight runs end to end through the reducers", () => {
  const clock = new TestClock(new Timestamp(1_800_000_000_000_000n));
  const h = createModuleTestHarness(spacetimedb, mod as any, { clock });
  const auth = TestAuth.fromJwtPayload(
    JSON.stringify({ iss: "localhost", sub: "abdullah", iat: 0, exp: 9999999999 }),
    ConnectionId.random(),
  );

  h.withReducerTx(auth, (ctx) => (mod.startFight as any)(ctx, { capabilities: "punch_types,guard,dodge,bogus" }));
  const fight = [...h.db.fight.iter()][0];
  expect(fight.status).toBe("countdown");
  expect(fight.capabilities).toBe("punch_types,guard,dodge"); // unknown capability dropped
  expect(h.db.fightTick.count()).toBe(1n);

  // Simulate the 50ms scheduler + the player throwing a punch every ~400ms
  const tickRow = [...h.db.fightTick.iter()][0];
  const actions = ["jab", "cross", "hook_l", "guard_on", "jab", "upper_r", "guard_off", "dodge_L"];
  for (let i = 0; i < 2400; i++) {
    clock.advance(ms(50));
    h.withReducerTx(TestAuth.internal(), (ctx) => (mod.tick as any)(ctx, { arg: tickRow }));
    if (i > 60 && i % 8 === 0) {
      const f = h.db.fight.id.find(fight.id)!;
      if (f.status !== "fighting") break;
      h.withReducerTx(auth, (ctx) => (mod.act as any)(ctx, { fightId: fight.id, action: actions[(i / 8) % actions.length], eventId: `cv:${i}` }));
    }
  }

  const end = h.db.fight.id.find(fight.id)!;
  const events = [...h.db.combatEvent.iter()];
  console.log(`status=${end.status} winner=${end.winner} t=${end.t}ms playerHp=${end.playerHp} cpuHp=${end.cpuHp} events=${events.length}`);
  expect(["ko", "decision"]).toContain(end.status);
  expect(events.some((e) => e.attacker === "cpu")).toBe(true); // bot fought back on its own via ticks
  expect(events.some((e) => e.attacker === "player")).toBe(true);
  expect(end.tickId).toBe(0n);
  expect(h.db.fightTick.count()).toBe(0n); // ticking stopped after the fight ended

  // someone else can't punch in your fight
  const intruder = TestAuth.fromJwtPayload(
    JSON.stringify({ iss: "localhost", sub: "intruder", iat: 0, exp: 9999999999 }),
    ConnectionId.random(),
  );
  expect(() => h.withReducerTx(intruder, (ctx) => (mod.act as any)(ctx, { fightId: fight.id, action: "jab", eventId: "" }))).toThrow();
});

test("pause, lean and duplicate CV events through the reducers", () => {
  const clock = new TestClock(new Timestamp(1_800_000_000_000_000n));
  const h = createModuleTestHarness(spacetimedb, mod as any, { clock });
  const auth = TestAuth.fromJwtPayload(
    JSON.stringify({ iss: "localhost", sub: "abdullah", iat: 0, exp: 9999999999 }),
    ConnectionId.random(),
  );
  h.withReducerTx(auth, (ctx) => (mod.startFight as any)(ctx, { capabilities: "punch_coarse,lean" }));
  const id = [...h.db.fight.iter()][0].id;
  const tickRow = [...h.db.fightTick.iter()][0];
  const tick = (n: number) => { for (let i = 0; i < n; i++) { clock.advance(ms(50)); h.withReducerTx(TestAuth.internal(), (ctx) => (mod.tick as any)(ctx, { arg: tickRow })); } };
  const act = (action: string, eventId = "") => h.withReducerTx(auth, (ctx) => (mod.act as any)(ctx, { fightId: id, action, eventId }));
  tick(62); // past the countdown

  act("jab", "s1:7");
  act("jab", "s1:7"); // same CV event delivered twice
  tick(20);
  const state = JSON.parse(h.db.fight.id.find(id)!.state);
  expect(state.player.stats.attempted).toBe(1);

  act("lean_L");
  act("tracking_lost");
  tick(40); // 2s with no tracking
  const paused = h.db.fight.id.find(id)!;
  expect(paused.paused).toBe(true);
  const tFrozen = paused.t;
  tick(20);
  expect(h.db.fight.id.find(id)!.t).toBe(tFrozen);
  act("tracking_ok");
  tick(10);
  expect(h.db.fight.id.find(id)!.paused).toBe(false);
  const types = [...h.db.combatEvent.iter()].map((e) => e.type);
  expect(types).toContain("lean");
  expect(types).toContain("pause");
  expect(types).toContain("resume");

});
