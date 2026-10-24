import { expect, test } from "bun:test";
import { createFight, applyInput, advance, drainEvents, CONFIG, ALL_PUNCHES, type Input } from "../engine/engine";
import type { CoachRequest, CoachResponse, VoiceCue } from "../shared/contracts";
import { toContractEvents, toFightSnapshot, engineRow, type RawEvent } from "./adapter";
import { buildFighterStats, buildWindow, buildCoachRequest, guardRecoveryRate } from "./stats";
import { InstantCoach, RULE_LINES } from "./rules";
import { CoachScheduler } from "./scheduler";
import { evaluateCoachEffect } from "./effect";
import { coachWithClaude, handleCoachHttp, rejectReason, allowedTactics } from "./claudeCoach";
import { handleTtsHttp } from "./tts";
import { LiveCoach } from "./liveCoach";

const ctx = { fightId: "f1" };
const ev = (seq: number, t: number, e: Partial<RawEvent>): RawEvent => ({ seq, t, type: "punch", ...e });

// ---------- adapter ----------

test("adapter maps engine names to contract vocabulary", () => {
  const out = toContractEvents([
    ev(1, 100, { attacker: "cpu", punch: "hook_r", outcome: "counter", damage: 16.5, defenderHp: 83.5 }),
    ev(2, 200, { attacker: "player", punch: "upper_l", outcome: "unscorable", damage: 0 }),
    ev(3, 300, { type: "guard_check", who: "player", on: false }),
    ev(4, 400, { type: "pause" }),
    ev(5, 500, { type: "lean", who: "player", dir: "L" }),
    ev(6, 600, { type: "lean", who: "player", dir: "" }), // release: no event
    ev(7, 700, { type: "mystery_future_type" }), // unknown: ignored
    ev(8, 800, { type: "ko", winner: "player" }),
  ], ctx);
  expect(out.map((e) => e.kind)).toEqual(["attack_resolved", "attack_resolved", "guard_check", "tracking_pause", "dodge", "round_transition"]);
  const a = out[0] as any;
  expect([a.attacker, a.punchType, a.hand, a.result, a.detail, a.attackId]).toEqual(["opponent", "hook", "right", "hit", "counter", "f1:1"]);
  expect((out[1] as any).result).toBe("unscorable");
  expect((out[5] as any).reason).toBe("knockout");
});

test("snapshot from a fight row", () => {
  const s = toFightSnapshot({ status: "fighting", paused: true, t: 10_000, roundEndsAt: 93_000, playerHp: 80, playerStamina: 50,
    cpuHp: 60, cpuStamina: 25, cpuPhase: "idle", cpuMove: "", cpuGuard: true }, ctx);
  expect(s.status).toBe("break");
  expect(s.player.tracking).toBe("lost");
  expect(s.opponent.state).toBe("blocking");
  expect(s.roundTimeRemainingMs).toBe(83_000);
  expect(s.opponent.stamina01).toBe(0.25);
});

// ---------- stats ----------

test("stats exclude unscorable, count hands, combos, and guard recovery", () => {
  const events = toContractEvents([
    ev(1, 1000, { attacker: "player", punch: "jab", outcome: "hit", damage: 4 }),
    ev(2, 1500, { attacker: "player", punch: "cross", outcome: "hit", damage: 8 }),
    ev(3, 2000, { attacker: "player", punch: "jab", outcome: "blocked", damage: 0.6 }),
    ev(4, 2300, { attacker: "player", punch: "jab", outcome: "unscorable", damage: 0 }),
    ev(5, 5000, { attacker: "cpu", punch: "jab", outcome: "dodged", damage: 0 }),
    ev(6, 5400, { type: "guard_check", who: "player", on: true }),
    ev(7, 6400, { type: "guard_check", who: "player", on: false }),
  ], ctx);
  const p = buildFighterStats(events, "player");
  expect(p.punches.jab.attempted).toBe(2);
  expect(p.punches.jab.landed).toBe(1);
  expect(p.punches.jab.blocked).toBe(1);
  expect([p.leftAttempts, p.rightAttempts]).toEqual([2, 1]);
  expect(p.longestCombo).toBe(3);
  expect(p.successfulDodges).toBe(1);
  expect(p.damageDealt).toBe(12.6);
  expect(guardRecoveryRate(events)).toBe(0.5);
  const w = buildWindow(events, 0, 10_000, ["punch_coarse", "lean"]);
  expect(w.unscorableCount).toBe(1);
  expect(w.resolvedAttacksCount).toBe(4);
  expect(w.supportedActions).toEqual(["punch_coarse", "lean"]);
});

// ---------- rules ----------

function rulesFor(raw: RawEvent[], caps: any[], extra: Partial<{ hp: number; stamina: number }> = {}) {
  const coach = new InstantCoach();
  const events = toContractEvents(raw, ctx);
  return coach.evaluate({ fightId: "f1", nowMs: raw[raw.length - 1].t, events, caps,
    playerHealth: extra.hp ?? 80, playerStamina01: extra.stamina ?? 0.8, voiceId: "v" });
}
const blockedThree = [1, 2, 3].map((i) => ev(i, i * 900, { attacker: "player", punch: "jab", outcome: "blocked" }));

test("rules speak in the language the input supports", () => {
  expect(rulesFor(blockedThree, ["punch_types", "guard"])!.text).toBe(RULE_LINES.guard_wall_types); // "uppercut"
  expect(rulesFor(blockedThree, ["punch_coarse", "lean"])!.text).toBe(RULE_LINES.guard_wall_coarse); // no punch names
});

test("guard advice only fires when guard is detectable", () => {
  const raw = [
    ev(1, 1000, { type: "guard_check", who: "player", on: false }),
    ev(2, 2000, { type: "guard_check", who: "player", on: false }),
    ev(3, 3000, { type: "guard_check", who: "player", on: false }),
    ev(4, 3500, { attacker: "cpu", punch: "cross", outcome: "hit", damage: 8 }),
  ];
  expect(rulesFor(raw, ["punch_types", "guard"])!.text).toBe(RULE_LINES.guard_drop);
  expect(rulesFor(raw, ["punch_coarse", "lean"])).toBeNull();
});

test("low HP is urgent and interrupts; fires once", () => {
  const coach = new InstantCoach();
  const c = { fightId: "f1", nowMs: 1000, events: [], caps: [] as any[], playerHealth: 20, playerStamina01: 1, voiceId: "v" };
  const cue = coach.evaluate(c)!;
  expect([cue.priority, cue.delivery]).toEqual(["urgent", "interrupt"]);
  expect(coach.evaluate({ ...c, nowMs: 90_000 })).toBeNull();
});

// ---------- scheduler ----------

function fakeScheduler() {
  let now = 0;
  const played: string[] = [];
  const dropped: string[] = [];
  const finish: (() => void)[] = [];
  const s = new CoachScheduler({
    now: () => now,
    play: (c) => { played.push(c.text); return new Promise<void>((r) => finish.push(r)); },
    stop: () => played.push("<stop>"),
    onDrop: (c, why) => dropped.push(`${c.text}:${why}`),
  });
  const cue = (text: string, p: VoiceCue["priority"] = "normal", d: VoiceCue["delivery"] = "queue", trigger: VoiceCue["trigger"] = "proactive"): VoiceCue =>
    ({ cueId: text, fightId: "f1", atMs: 0, persona: "coach", trigger, text, priority: p, delivery: d, voiceId: "v", cooldownMs: 0 });
  const done = async () => { finish.pop()!(); await new Promise((r) => setTimeout(r, 0)); }; // resolve the line playing now
  return { s, cue, played, dropped, done, at: (t: number) => (now = t) };
}

test("scheduler: one voice at a time, queue, interrupt, no repeats, stale drop", async () => {
  const f = fakeScheduler();
  f.s.submit(f.cue("A"));
  f.s.submit(f.cue("B")); // queued behind A
  f.s.submit(f.cue("C", "low", "drop_if_busy")); // dropped
  f.s.submit(f.cue("URGENT", "urgent", "interrupt")); // cuts A off
  expect(f.played).toEqual(["A", "<stop>", "URGENT"]);
  f.at(1000);
  await f.done(); // URGENT ends; B is fresh but min gap 4s not reached
  expect(f.played.at(-1)).toBe("URGENT");
  f.at(5100); // B queued at t=0, now 5.1s old -> stale
  f.s.pump();
  expect(f.dropped).toContain("C:busy");
  expect(f.dropped).toContain("B:stale");
  f.s.submit(f.cue("URGENT", "urgent", "interrupt"));
  expect(f.dropped).toContain("URGENT:repeat"); // same line within 20s
  f.at(9000);
  f.s.setSuspended(true);
  f.s.submit(f.cue("D"));
  expect(f.dropped).toContain("D:suspended");
  f.s.submit(f.cue("WRAP", "normal", "interrupt", "fight_end"));
  expect(f.played.at(-1)).toBe("WRAP"); // fight_end still allowed
});

// ---------- effect ----------

test("coach effect compares guard recovery before vs after a defend tip", () => {
  const raw: RawEvent[] = [];
  let seq = 0;
  for (let i = 0; i < 4; i++) raw.push(ev(++seq, 1000 + i * 2000, { type: "guard_check", who: "player", on: i === 0 }));
  for (let i = 0; i < 8; i++) raw.push(ev(++seq, 2000 + i * 1000, { attacker: "player", punch: "jab", outcome: i % 2 ? "hit" : "blocked", damage: 4 }));
  for (let i = 0; i < 4; i++) raw.push(ev(++seq, 11_000 + i * 2000, { type: "guard_check", who: "player", on: i !== 3 }));
  for (let i = 0; i < 8; i++) raw.push(ev(++seq, 11_500 + i * 1000, { attacker: "player", punch: "jab", outcome: "hit", damage: 4 }));
  const r = evaluateCoachEffect({ fightId: "f1", cueId: "c1", tactic: "defend", appliedAtMs: 10_000, evaluatedAtMs: 20_000, events: toContractEvents(raw, ctx) });
  expect(r.outcome).toBe("improved");
  expect(r.nextDecision).toBe("keep");
  expect(r.notes).toBe("Guard recovery after punches 25% -> 75%.");
  expect(r.strategyId).toBe("c1");
});

// ---------- Claude coach (mocked API) ----------

function req(over: Partial<CoachRequest> = {}): CoachRequest {
  const events = toContractEvents(blockedThree, ctx);
  const snap = toFightSnapshot({ status: "fighting", paused: false, t: 3000, roundEndsAt: 93_000, playerHp: 70, playerStamina: 60,
    cpuHp: 90, cpuStamina: 80, cpuPhase: "idle", cpuMove: "", cpuGuard: true }, ctx);
  return { ...buildCoachRequest({ requestId: "r1", fightId: "f1", nowMs: 3000, trigger: "proactive", events, snapshot: snap,
    playerStamina01: 0.6, caps: ["punch_coarse", "lean"], previousLines: [] }), ...over };
}

function mockClaude(input: object, status = 200) {
  const calls: any[] = [];
  const f = (async (url: string, init: any) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return new Response(JSON.stringify({ content: [{ type: "tool_use", name: "give_coaching", input }] }), { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

test("Claude request: forced tool, capability-limited tactics, no ids or hidden strategy sent", async () => {
  const m = mockClaude({ skip: false, advice: "He's blocking everything. Let him punch first, then fire back.", evidence: ["3 of 3 blocked"], tactic: "change_rhythm", priority: "normal" });
  const r = await coachWithClaude(req(), { apiKey: "k", fetchImpl: m.f });
  expect(r.source).toBe("claude");
  expect(r.suggestedTactic).toBe("change_rhythm");
  const body = m.calls[0].body;
  expect(m.calls[0].url).toBe("https://api.anthropic.com/v1/messages");
  expect(m.calls[0].headers["anthropic-version"]).toBe("2023-06-01");
  expect(body.model).toBe("claude-haiku-5-5");
  expect(body.tool_choice).toEqual({ type: "tool", name: "give_coaching" });
  expect(body.tools[0].input_schema.properties.tactic.enum).not.toContain("attack_body");
  expect(body.system).toContain("never name punch types");
  expect(body.messages[0].content).not.toContain("requestId");
});

test("Claude advice about undetectable signals is rejected -> offline fallback", async () => {
  for (const advice of ["Throw a hook to the ribs!", "Keep your guard up!", "Punch harder, use your legs."]) {
    const m = mockClaude({ skip: false, advice, evidence: [], tactic: "attack_head", priority: "normal" });
    const r = await coachWithClaude(req(), { apiKey: "k", fetchImpl: m.f });
    expect(`${advice} -> ${r.source}`).toBe(`${advice} -> offline`);
  }
  expect(rejectReason("Throw the uppercut!", req({ capabilities: ["punch_types"] }))).toBeNull();
  expect(allowedTactics(["punch_coarse"])).not.toContain("defend");
});

test("Claude down / slow / no key -> offline coach keeps talking", async () => {
  const down = (async () => new Response("overloaded", { status: 529 })) as unknown as typeof fetch;
  expect((await coachWithClaude(req(), { apiKey: "k", fetchImpl: down })).source).toBe("offline");
  const slow = ((_u: string, init: any) => new Promise((_r, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))))) as unknown as typeof fetch;
  const r = await coachWithClaude(req(), { apiKey: "k", fetchImpl: slow, timeoutMs: 50 });
  expect(r.source).toBe("offline");
  expect(r.advice.length).toBeGreaterThan(0);
  expect((await coachWithClaude(req(), {})).source).toBe("offline");
});

test("HTTP handler validates input", async () => {
  const bad = await handleCoachHttp(new Request("http://x/api/coach", { method: "POST", body: '{"schemaVersion":2}' }));
  expect(bad.status).toBe(400);
  const ok = await handleCoachHttp(new Request("http://x/api/coach", { method: "POST", body: JSON.stringify(req()) }));
  expect(ok.status).toBe(200);
  expect(((await ok.json()) as CoachResponse).requestId).toBe("r1");
});

test("TTS: 501 without key; with key calls Cartesia bytes endpoint", async () => {
  const none = await handleTtsHttp(new Request("http://x", { method: "POST", body: '{"text":"hi"}' }));
  expect(none.status).toBe(501);
  let call: any;
  const f = (async (url: string, init: any) => { call = { url, init }; return new Response(new Uint8Array([1, 2, 3]), { status: 200 }); }) as unknown as typeof fetch;
  const res = await handleTtsHttp(new Request("http://x", { method: "POST", body: '{"text":"Hands up!","persona":"coach"}' }),
    { apiKey: "sk", coachVoiceId: "voice-1", fetchImpl: f });
  expect(res.headers.get("content-type")).toBe("audio/mpeg");
  expect(call.url).toBe("https://api.cartesia.ai/tts/bytes");
  expect(call.init.headers.Authorization).toBe("Bearer sk");
  const b = JSON.parse(call.init.body);
  expect([b.transcript, b.voice.id, b.output_format.container]).toEqual(["Hands up!", "voice-1", "mp3"]);
});

// ---------- full fight with the live coach attached ----------

test("live coach in a real engine fight: rules + Claude cadence, one voice, effects measured, wrap-up at the end", async () => {
  const s = createFight(11);
  let wall = 0;
  const captions: { t: number; text: string; source: string }[] = [];
  const requests: CoachRequest[] = [];
  let playingUntil = 0;
  let overlaps = 0;
  const audio: { until: number; done: () => void }[] = []; // fake audio that ends on the fake clock
  const coach = new LiveCoach({
    fightId: "f-sim", capabilities: ["punch_types", "guard", "dodge"],
    wallNow: () => wall,
    requestCoach: async (r) => {
      requests.push(r);
      const lines: Record<string, string> = { proactive: `Tip number ${requests.length}: change it up.`, fight_end: "Good fight. Chain more combos next time." };
      return { schemaVersion: 1, requestId: r.requestId, advice: lines[r.trigger] ?? "", referencedEvidence: ["mock"], suggestedTactic: "mix_punches", source: "claude" };
    },
    play: () => {
      if (wall < playingUntil) overlaps++;
      playingUntil = wall + 1500;
      return new Promise<void>((done) => audio.push({ until: playingUntil, done }));
    },
    stop: () => { playingUntil = wall; },
    onCaption: (cue, info) => captions.push({ t: wall, text: cue.text, source: info.source }),
    log: (m) => console.log("  log:", m),
  });
  // player mashes like the balance sim, never guards after punching
  let r = 99;
  const rnd = () => ((r = (r * 1103515245 + 12345) % 2147483648) / 2147483648);
  let nextInput = CONFIG.countdownMs;
  while (s.status === "countdown" || s.status === "fighting") {
    wall += 50;
    if (wall >= nextInput) {
      const x = rnd();
      const inp: Input = x < 0.75 ? { who: "player", kind: "punch", punch: ALL_PUNCHES[Math.floor(rnd() * 6)] }
        : { who: "player", kind: "dodge", dir: rnd() < 0.5 ? "L" : "R" };
      applyInput(s, inp, wall);
      nextInput = wall + 450 + rnd() * 500;
    }
    advance(s, wall);
    coach.update(engineRow(s));
    coach.ingest(drainEvents(s));
    for (const a of audio.splice(0)) if (wall >= a.until) a.done(); else audio.push(a);
    coach.tick();
    await new Promise((r) => setTimeout(r, 0));
  }
  for (let i = 0; i < 60; i++) {
    wall += 50;
    for (const a of audio.splice(0)) if (wall >= a.until) a.done(); else audio.push(a);
    coach.tick();
    await new Promise((r) => setTimeout(r, 0));
  }
  console.log(`fight ${s.status} in ${(s.t / 1000).toFixed(1)}s | ${captions.length} lines | claude requests: ${requests.map((q) => q.trigger).join(",")} | effects: ${coach.effects.map((e) => e.outcome).join(",")}`);
  for (const c of captions) console.log(`  ${(c.t / 1000).toFixed(1)}s [${c.source}] ${c.text}`);
  expect(requests.some((q) => q.trigger === "proactive")).toBe(true);
  expect(requests.at(-1)!.trigger).toBe("fight_end");
  expect(captions.at(-1)!.text).toBe("Good fight. Chain more combos next time.");
  expect(captions.some((c) => c.source === "rules")).toBe(true);
  expect(overlaps).toBe(0);
  expect(coach.effects.length).toBeGreaterThan(0);
  // requests only carry observable stats
  const q = requests[0];
  expect(q.capabilities).toEqual(["punch_types", "guard", "dodge"]);
  expect(JSON.stringify(q)).not.toContain("tuning");
});
