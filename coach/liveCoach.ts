// LiveCoach: the in-game coach. Feed it combat events + fight rows (from SpacetimeDB or the
// local engine); it speaks through the scheduler and reports captions/effects.
//
//   events  -> InstantCoach rules (instant, local)          ┐
//   every 10s -> CoachRequest -> /api/coach (Claude)       ├-> CoachScheduler -> play() + caption
//   Claude down/slow -> offline coach (same contract)      ┘
//   ~10s after a tip -> AdaptationResult ("did it help?")

import type { AdaptationResult, Capability, CoachRequest, CoachResponse, FightSnapshot, InputSource, VoiceCue } from "../shared/contracts";
import { toContractEvent, toFightSnapshot, type ContractEvent, type FightRowLike, type RawEvent } from "./adapter";
import { buildCoachRequest } from "./stats";
import { InstantCoach, RULE_TACTIC } from "./rules";
import { CoachScheduler } from "./scheduler";
import { evaluateCoachEffect } from "./effect";
import { offlineCoachResponse } from "./offlineCoach";

export type CoachSource = "rules" | "claude" | "offline";
export type CoachStatus = "watching" | "thinking" | "offline" | "paused" | "done";
export interface CueInfo { source: CoachSource; evidence: string[]; tactic?: CoachResponse["suggestedTactic"] }

export interface LiveCoachOptions {
  fightId: string;
  capabilities: Capability[];
  voiceId?: string;
  source?: InputSource;
  wallNow: () => number; // performance.now() in the browser
  requestCoach: (req: CoachRequest) => Promise<CoachResponse>; // POST /api/coach
  play: (cue: VoiceCue) => Promise<void>;
  stop?: () => void;
  onCaption?: (cue: VoiceCue, info: CueInfo) => void;
  onStatus?: (s: CoachStatus) => void;
  onEffect?: (r: AdaptationResult, cue: VoiceCue) => void;
  publishCue?: (cue: VoiceCue, info: CueInfo) => void; // -> SpacetimeDB coach_cue (spectators)
  publishEffect?: (r: AdaptationResult) => void; // -> SpacetimeDB coach_effect
  claudeEveryMs?: number;
  effectWindowMs?: number;
  staleResponseMs?: number;
  log?: (m: string) => void;
}

export class LiveCoach {
  readonly events: ContractEvent[] = [];
  private seen = new Set<number>();
  private rules = new InstantCoach();
  private scheduler: CoachScheduler;
  private row: FightRowLike | null = null;
  private snapshot: FightSnapshot | null = null;
  private lastClaudeAt = -Infinity;
  private inflight = false;
  private reqSeq = 0;
  private lines: string[] = [];
  private info = new Map<string, CueInfo>();
  private pendingEffects: { cue: VoiceCue; tactic: CoachResponse["suggestedTactic"]; appliedAt: number }[] = [];
  private offlineUntil = -Infinity;
  private ended = false;
  private status: CoachStatus = "watching";
  readonly effects: AdaptationResult[] = [];

  constructor(private o: LiveCoachOptions) {
    this.scheduler = new CoachScheduler({
      now: o.wallNow,
      play: o.play,
      stop: o.stop,
      onCaption: (cue) => this.onCaption(cue),
      onDrop: (cue, why) => o.log?.(`dropped "${cue.text}" (${why})`),
    });
  }

  private get t() { return this.row?.t ?? 0; }

  private setStatus(s: CoachStatus) {
    if (s !== this.status) { this.status = s; this.o.onStatus?.(s); }
  }

  /** New combat_event rows / engine events. Safe to call with duplicates. */
  ingest(raw: RawEvent[]) {
    let fresh = false;
    for (const r of raw) {
      if (this.seen.has(r.seq)) continue;
      this.seen.add(r.seq);
      const c = toContractEvent(r, { fightId: this.o.fightId, source: this.o.source });
      if (!c) continue;
      this.events.push(c);
      fresh = true;
      if (c.kind === "tracking_pause") {
        this.scheduler.setSuspended(c.phase === "paused");
        this.setStatus(c.phase === "paused" ? "paused" : "watching");
      }
      if (c.kind === "round_transition" && c.phase === "ended") this.endFight();
    }
    if (fresh && !this.ended) this.runRules();
  }

  /** Latest fight row (SpacetimeDB `fight` row, or engineRow(state) locally). */
  update(row: FightRowLike) {
    this.row = row;
    this.snapshot = toFightSnapshot(row, { fightId: this.o.fightId });
  }

  /** Call every frame or ~10x/sec. */
  tick() {
    this.scheduler.pump();
    if (!this.row || !this.snapshot) return;
    // measure effects of earlier tips
    const w = this.o.effectWindowMs ?? 10_000;
    for (const p of [...this.pendingEffects]) {
      if (this.t - p.appliedAt < w && !this.ended) continue;
      this.pendingEffects.splice(this.pendingEffects.indexOf(p), 1);
      const r = evaluateCoachEffect({
        fightId: this.o.fightId, cueId: p.cue.cueId, tactic: p.tactic,
        appliedAtMs: p.appliedAt, evaluatedAtMs: this.t, windowMs: w, events: this.events,
      });
      this.effects.push(r);
      this.o.onEffect?.(r, p.cue);
      this.o.publishEffect?.(r);
    }
    if (this.ended || this.snapshot.status !== "active") return;
    const every = this.o.claudeEveryMs ?? 10_000;
    const resolved = this.events.filter((e) => e.kind === "attack_resolved" && e.atMs > this.t - 15_000).length;
    if (!this.inflight && this.t - this.lastClaudeAt >= every && resolved >= 3) void this.ask("proactive");
  }

  private runRules() {
    if (!this.row || this.snapshot?.status !== "active") return;
    const cue = this.rules.evaluate({
      fightId: this.o.fightId, nowMs: this.t, events: this.events, caps: this.o.capabilities,
      playerHealth: this.row.playerHp, playerStamina01: this.row.playerStamina / 100,
      voiceId: this.o.voiceId ?? "coach",
    });
    if (!cue) return;
    const ruleId = cue.cueId.split(":rule:")[1]?.split(":")[0] ?? "";
    this.info.set(cue.cueId, { source: "rules", evidence: [ruleId], tactic: RULE_TACTIC[ruleId] });
    this.scheduler.submit(cue);
  }

  private endFight() {
    if (this.ended) return;
    this.ended = true;
    void this.ask("fight_end");
  }

  private async ask(trigger: CoachRequest["trigger"]) {
    if (!this.row || !this.snapshot) return;
    this.inflight = true;
    this.lastClaudeAt = this.t;
    const req = buildCoachRequest({
      requestId: `${this.o.fightId}:coach:${++this.reqSeq}`, fightId: this.o.fightId, nowMs: this.t,
      trigger, events: this.events, snapshot: this.snapshot, playerStamina01: this.row.playerStamina / 100,
      caps: this.o.capabilities, previousLines: this.lines,
    });
    const offline = this.o.wallNow() < this.offlineUntil;
    this.setStatus(offline ? "offline" : "thinking");
    let res: CoachResponse;
    try {
      res = offline ? offlineCoachResponse(req) : await this.o.requestCoach(req);
    } catch {
      this.offlineUntil = this.o.wallNow() + 20_000; // back off, keep coaching locally
      res = offlineCoachResponse(req);
    }
    this.inflight = false;
    const source: CoachSource = res.source === "offline" ? "offline" : "claude";
    this.setStatus(trigger === "fight_end" ? "done" : source === "offline" ? "offline" : this.snapshot?.status === "break" ? "paused" : "watching");
    if (!res.advice) return;
    if (trigger !== "fight_end" && (this.t - req.atMs > (this.o.staleResponseMs ?? 6000) || this.snapshot?.status !== "active")) {
      this.o.log?.(`stale coach response dropped: ${res.advice}`);
      return;
    }
    const cue: VoiceCue = {
      cueId: `${req.requestId}`, fightId: this.o.fightId, atMs: this.t, persona: "coach",
      trigger, text: res.advice, priority: "normal", delivery: trigger === "fight_end" ? "interrupt" : "queue",
      voiceId: this.o.voiceId ?? "coach", cooldownMs: 10_000,
    };
    this.info.set(cue.cueId, { source, evidence: res.referencedEvidence, tactic: res.suggestedTactic });
    this.scheduler.submit(cue);
  }

  private onCaption(cue: VoiceCue) {
    const info = this.info.get(cue.cueId) ?? { source: "rules" as const, evidence: [] };
    this.lines.push(cue.text);
    if (this.lines.length > 8) this.lines.shift();
    this.o.onCaption?.(cue, info);
    this.o.publishCue?.(cue, info);
    if (info.tactic && cue.trigger === "proactive") this.pendingEffects.push({ cue, tactic: info.tactic, appliedAt: this.t });
  }
}
