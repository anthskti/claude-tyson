// Coach message scheduler: one voice at a time, no spam, defense warnings first.
// Honors VoiceCue.priority and VoiceCue.delivery (queue | interrupt | drop_if_busy).

import type { VoiceCue } from "../shared/contracts";

export interface SchedulerOptions {
  play: (cue: VoiceCue) => Promise<void>; // resolves when audio finished (or failed)
  stop?: () => void; // stop current audio (used by interrupt)
  onCaption?: (cue: VoiceCue) => void; // show caption the moment playback starts
  onDrop?: (cue: VoiceCue, reason: string) => void;
  now: () => number; // wall ms (performance.now in browser)
  minGapMs?: number; // silence between normal lines
  repeatWindowMs?: number; // same text not repeated inside this window
  staleMs?: number; // queued normal/low lines expire after this
  maxQueue?: number;
}

const RANK: Record<VoiceCue["priority"], number> = { urgent: 3, normal: 2, low: 1 };

export class CoachScheduler {
  private o: Required<Omit<SchedulerOptions, "stop" | "onCaption" | "onDrop">> & SchedulerOptions;
  private playing: VoiceCue | null = null;
  private playToken = 0;
  private queue: { cue: VoiceCue; at: number }[] = [];
  private lastEnd = -Infinity;
  private said = new Map<string, number>();
  private suspended = false;

  constructor(o: SchedulerOptions) {
    this.o = { minGapMs: 4000, repeatWindowMs: 20_000, staleMs: 4000, maxQueue: 2, ...o };
  }

  get busy() { return this.playing !== null; }
  get current() { return this.playing; }

  /** Tracking lost / menus: hold everything except fight_end lines. */
  setSuspended(v: boolean) {
    this.suspended = v;
    if (v) {
      this.queue = [];
      if (this.playing && this.playing.trigger !== "fight_end") this.interrupt();
    }
  }

  submit(cue: VoiceCue) {
    const now = this.o.now();
    if (this.suspended && cue.trigger !== "fight_end") return this.drop(cue, "suspended");
    const lastSaid = this.said.get(cue.text);
    if (lastSaid !== undefined && now - lastSaid < this.o.repeatWindowMs) return this.drop(cue, "repeat");

    if (cue.trigger === "fight_end") {
      // the wrap-up is the last word: it always plays, cutting off whatever is on
      this.queue = [];
      if (this.playing) this.interrupt();
      return this.start(cue);
    }
    if (this.playing) {
      if (cue.delivery === "interrupt" && RANK[cue.priority] > RANK[this.playing.priority]) {
        this.interrupt();
        return this.start(cue);
      }
      if (cue.delivery === "drop_if_busy") return this.drop(cue, "busy");
      return this.enqueue(cue, now);
    }
    const gapOk = now - this.lastEnd >= this.o.minGapMs || cue.priority === "urgent";
    if (gapOk) return this.start(cue);
    if (cue.delivery === "drop_if_busy") return this.drop(cue, "too_soon");
    this.enqueue(cue, now);
  }

  /** Call every frame / tick: starts the next queued line when allowed. */
  pump() {
    if (this.playing || !this.queue.length) return;
    const now = this.o.now();
    this.queue = this.queue.filter((q) => {
      const stale = q.cue.priority !== "urgent" && q.cue.trigger !== "fight_end" && now - q.at > this.o.staleMs;
      if (stale) this.drop(q.cue, "stale");
      return !stale;
    });
    const next = this.queue[0];
    if (!next) return;
    const gapOk = now - this.lastEnd >= this.o.minGapMs || next.cue.priority === "urgent" || next.cue.trigger === "fight_end";
    if (gapOk) {
      this.queue.shift();
      this.start(next.cue);
    }
  }

  private enqueue(cue: VoiceCue, now: number) {
    this.queue.push({ cue, at: now });
    this.queue.sort((a, b) => RANK[b.cue.priority] - RANK[a.cue.priority] || a.at - b.at);
    while (this.queue.length > this.o.maxQueue) this.drop(this.queue.pop()!.cue, "queue_full");
  }

  private start(cue: VoiceCue) {
    const token = ++this.playToken;
    this.playing = cue;
    this.said.set(cue.text, this.o.now());
    this.o.onCaption?.(cue);
    this.o.play(cue).catch(() => {}).finally(() => {
      if (token !== this.playToken) return; // was interrupted
      this.playing = null;
      this.lastEnd = this.o.now();
      this.pump();
    });
  }

  private interrupt() {
    this.playToken++;
    this.o.stop?.();
    this.playing = null;
    this.lastEnd = this.o.now();
  }

  private drop(cue: VoiceCue, reason: string) {
    this.o.onDrop?.(cue, reason);
  }
}
