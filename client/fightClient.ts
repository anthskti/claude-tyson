// Browser side of the real game: SpacetimeDB owns the fight; this file connects, starts a fight,
// sends inputs, feeds the renderer/HUD, and runs the live AI coach for the player.
// Spectators call connectFight({ spectateFightId }) and get the same fight + coach captions.
//
// Generate bindings first (from repo root):
//   spacetime generate --lang typescript --out-dir client/module_bindings --module-path spacetimedb
import { DbConnection } from "./module_bindings";
import type { Input } from "../engine/engine";
import type { AdaptationResult, Capability, CoachRequest, CoachResponse, FightSnapshot, VoiceCue } from "../shared/contracts";
import { toFightSnapshot, toContractEvent, type RawEvent, type ContractEvent } from "../coach/adapter";
import { LiveCoach, type CueInfo, type CoachStatus } from "../coach/liveCoach";
import { createCoachAudio } from "../coach/browserAudio";
import { RULE_LINES } from "../coach/rules";

const HOST = process.env.NEXT_PUBLIC_STDB_HOST ?? "ws://localhost:3000";
const DB_NAME = process.env.NEXT_PUBLIC_STDB_DB ?? "claude-tyson";

export interface FightListener {
  onSnapshot?: (s: FightSnapshot, row: any) => void; // contract snapshot + raw row (for phases/moves)
  onEvent?: (e: ContractEvent, row: any) => void; // contract CombatEvent / MotionEvent
  onCoachLine?: (cue: VoiceCue, info: CueInfo) => void; // captions (player and spectators)
  onCoachStatus?: (s: CoachStatus) => void;
  onCoachEffect?: (r: AdaptationResult) => void;
}

export interface ConnectOptions {
  spectateFightId?: bigint;
  capabilities?: Capability[]; // keyboard: punch_types,guard,dodge ; CV kit: punch_coarse,dodge,lean
  coach?: false | { coachUrl?: string; ttsUrl?: string; voiceId?: string };
}

/** Map an engine Input to the `act` reducer's action string. */
export function toAction(i: Input): string {
  switch (i.kind) {
    case "punch": return i.punch;
    case "guard": return i.on ? "guard_on" : "guard_off";
    case "dodge": return `dodge_${i.dir}`;
    case "lean": return i.dir ? `lean_${i.dir}` : "lean_off";
    case "tracking": return i.ok ? "tracking_ok" : "tracking_lost";
  }
}

export function connectFight(listener: FightListener, opts: ConnectOptions = {}) {
  const caps = opts.capabilities ?? ["punch_types", "guard", "dodge"];
  const spectating = opts.spectateFightId !== undefined;
  let myFightId: bigint | null = opts.spectateFightId ?? null;
  let myIdentity: any = null;
  let coach: LiveCoach | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  const audio = createCoachAudio({ ttsUrl: opts.coach ? opts.coach.ttsUrl : undefined });

  const conn = DbConnection.builder()
    .withUri(HOST)
    .withDatabaseName(DB_NAME)
    .withToken(localStorage.getItem("stdb_token") ?? undefined)
    .onConnect((c: any, identity: any, token: string) => {
      myIdentity = identity;
      localStorage.setItem("stdb_token", token);
      c.subscriptionBuilder().subscribeToAllTables();
    })
    .build();

  function startCoach(fightId: bigint) {
    if (spectating || opts.coach === false) return;
    const cfg = opts.coach || {};
    coach = new LiveCoach({
      fightId: String(fightId), capabilities: caps, voiceId: cfg.voiceId ?? "coach",
      source: caps.includes("punch_coarse") ? "pose" : "keyboard",
      wallNow: () => performance.now(),
      requestCoach: async (req: CoachRequest) => {
        const r = await fetch(cfg.coachUrl ?? "/api/coach", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) });
        if (!r.ok) throw new Error(`coach ${r.status}`);
        return (await r.json()) as CoachResponse;
      },
      play: audio.play,
      stop: audio.stop,
      onCaption: (cue, info) => listener.onCoachLine?.(cue, info),
      onStatus: (s) => listener.onCoachStatus?.(s),
      onEffect: (r) => listener.onCoachEffect?.(r),
      publishCue: (cue, info) => conn.reducers.postCoachCue({
        fightId, cueId: cue.cueId, atMs: cue.atMs, persona: cue.persona, trigger: cue.trigger, text: cue.text,
        priority: cue.priority, source: info.source, evidence: JSON.stringify(info.evidence), tactic: info.tactic ?? "",
      }),
      publishEffect: (r) => conn.reducers.postCoachEffect({
        fightId, cueId: r.strategyId, appliedAtMs: r.appliedAtMs, evaluatedAtMs: r.evaluatedAtMs, outcome: r.outcome,
        nextDecision: r.nextDecision, beforeHitRate: r.before.playerHitRate01 ?? -1, afterHitRate: r.after.playerHitRate01 ?? -1,
        confidence: r.confidence01, notes: r.notes ?? "",
      }),
    });
    audio.preload(Object.values(RULE_LINES).map((text) => ({ text }))); // instant-coach lines play with no TTS wait
    tickTimer ??= setInterval(() => coach?.tick(), 100);
  }

  const onFightRow = (row: any) => {
    if (row.id !== myFightId) return;
    coach?.update(row);
    listener.onSnapshot?.(toFightSnapshot(row, { fightId: String(row.id) }), row);
  };

  // The game screen picks up the fight it just created; a spectator passes spectateFightId.
  conn.db.fight.onInsert((_ctx: any, row: any) => {
    if (myFightId === null && myIdentity && row.owner.isEqual(myIdentity)) {
      myFightId = row.id;
      startCoach(row.id);
    }
    onFightRow(row);
  });
  conn.db.fight.onUpdate((_ctx: any, _old: any, row: any) => onFightRow(row));
  conn.db.combatEvent.onInsert((_ctx: any, row: RawEvent & { fightId: bigint }) => {
    if (row.fightId !== myFightId) return;
    coach?.ingest([row]);
    const c = toContractEvent(row, { fightId: String(row.fightId) });
    if (c) listener.onEvent?.(c, row);
  });
  // Spectators get captions from the table; the player already hears them live.
  conn.db.coachCue.onInsert((_ctx: any, row: any) => {
    if (!spectating || row.fightId !== myFightId) return;
    const cue: VoiceCue = { cueId: row.cueId, fightId: String(row.fightId), atMs: row.atMs, persona: row.persona, trigger: row.trigger,
      text: row.text, priority: row.priority, delivery: "queue", voiceId: "", cooldownMs: 0 };
    listener.onCoachLine?.(cue, { source: row.source, evidence: JSON.parse(row.evidence || "[]"), tactic: row.tactic || undefined });
  });

  return {
    conn,
    get fightId() { return myFightId; },
    get coach() { return coach; },
    startFight() {
      myFightId = null;
      coach = null;
      conn.reducers.startFight({ capabilities: caps.join(",") });
    },
    /** eventId: CV event key (sessionId:eventId) so duplicate deliveries count once. */
    send(i: Input) {
      if (myFightId !== null && !spectating) conn.reducers.act({ fightId: myFightId, action: toAction(i), eventId: i.eventId ?? "" });
    },
    close() {
      if (tickTimer) clearInterval(tickTimer);
      audio.stop();
      conn.disconnect();
    },
  };
}

// Example wiring for the game page (Next.js client component):
//
//   const fight = connectFight({
//     onSnapshot: (s, row) => { hud.set(s); renderer.setPoses(row.playerPhase, row.playerMove, row.cpuPhase, row.cpuMove) },
//     onEvent: (e) => { if (e.kind === "attack_resolved") sfx.play(e.result) },
//     onCoachLine: (cue, info) => captions.show(cue.text, info.source),
//     onCoachStatus: (s) => coachChip.set(s),            // watching | thinking | offline | paused | done
//     onCoachEffect: (r) => results.addCoachEffect(r),   // "Guard recovery 25% -> 75%"
//   }, { capabilities: CV_KIT_CAPABILITIES });            // or keyboard caps
//   fight.startFight();
//   attachKeyboard((i) => { renderer.predict(i); fight.send(i) });
//   // CV kit bridge: for each cv_sample message -> for (const i of cv.push(msg, performance.now())) fight.send(i)
//   //                every frame -> for (const i of cv.checkStale(performance.now())) fight.send(i)
