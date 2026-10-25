// Camera input, whichever source classifies it: maps classified movements onto the same
// control keys the keyboard uses, so the webcam and the keyboard drive one input path
// and either works when the other is absent.
//
//   punch_left  straight → J   hook → Q
//   punch_right straight → C   hook → E
//   dodge_left → hold A · dodge_right → hold D · return_neutral → release
//
// Blocks come from the wrist/head markers in each observation (cv/guard.ts); main.ts
// turns those into internal guard holds. Sources: the in-browser worker (browserCv.ts) and the
// Python CV bridge (bridge.ts).

import type { CameraMarkers } from './guard';

export interface ControlKeys {
  press(key: string): void;
  release(key: string): void;
}

export type CvStatus = 'off' | 'connecting' | 'connected' | 'disconnected';
export type CvSourceKind = 'browser' | 'bridge';

export interface CvObservation {
  trackingState: string;
  markers: CameraMarkers;
}

export interface CvEvent {
  eventId: string;
  type: string;
  punchType?: 'straight' | 'hook';
}

export interface CvStats {
  delegate?: string;
  fps: number;
  inferenceP95Ms: number;
  /** Median wall time per model, when the source measures it. */
  poseMs?: number;
  handsMs?: number;
}

export interface CvHooks {
  /** Every camera observation, for the preview and block detection. */
  onObservation?(obs: CvObservation): void;
  onStatus?(status: CvStatus, detail?: string): void;
  /** Each accepted CV event and the key it pressed (null for a release), for on-screen verification. */
  onTranslate?(event: string, key: string | null): void;
  /** Periodic throughput numbers from sources that measure them. */
  onStats?(stats: CvStats): void;
}

const STALE_MS = 500;

const PUNCH_KEY: Record<string, { straight: string; hook: string }> = {
  punch_left: { straight: 'j', hook: 'q' },
  punch_right: { straight: 'c', hook: 'e' },
};
const DODGE_KEY: Record<string, string> = { dodge_left: 'a', dodge_right: 'd' };

export abstract class CvInput {
  abstract readonly kind: CvSourceKind;
  private staleTimer = 0;
  private lastSampleAt = 0;
  private heldDodge: string | null = null;
  private seen = new Set<string>();

  constructor(
    private keys: ControlKeys,
    protected hooks: CvHooks = {},
  ) {}

  abstract start(): void;
  /** Retry now instead of waiting. No-op while the source is running or starting. */
  abstract reconnect(): void;
  /** Ask the classifier to re-learn the neutral head position (dodge reference). */
  abstract resetCalibration(): void;

  stop() {
    clearInterval(this.staleTimer);
    this.staleTimer = 0;
    this.releaseDodge();
  }

  protected onStatus(status: CvStatus, detail?: string) {
    if (status !== 'connected') this.releaseDodge();
    this.hooks.onStatus?.(status, detail);
  }

  /** Release a held dodge if samples stop arriving. Sources call this from start(). */
  protected watchStale() {
    clearInterval(this.staleTimer);
    this.staleTimer = window.setInterval(() => {
      if (this.heldDodge && performance.now() - this.lastSampleAt > STALE_MS) this.releaseDodge();
    }, 100);
  }

  protected sample(s: { events: CvEvent[]; observation: CvObservation }) {
    this.lastSampleAt = performance.now();
    this.hooks.onObservation?.(s.observation);
    if (s.observation.trackingState === 'lost') this.releaseDodge();
    for (const ev of s.events) {
      if (this.seen.has(ev.eventId)) continue;
      this.seen.add(ev.eventId);
      if (this.seen.size > 1024) this.seen.delete(this.seen.values().next().value!);
      this.apply(ev);
    }
  }

  private apply(ev: CvEvent) {
    const punch = PUNCH_KEY[ev.type];
    if (punch) {
      const type = ev.punchType ?? 'straight';
      const key = punch[type];
      this.keys.press(key);
      this.keys.release(key);
      this.hooks.onTranslate?.(`${ev.type} ${type}`, key);
      return;
    }
    const dodge = DODGE_KEY[ev.type];
    if (dodge) {
      if (this.heldDodge && this.heldDodge !== dodge) this.keys.release(this.heldDodge);
      this.heldDodge = dodge;
      this.keys.press(dodge);
      this.hooks.onTranslate?.(ev.type, dodge);
      return;
    }
    if (ev.type === 'return_neutral') {
      this.releaseDodge();
      this.hooks.onTranslate?.(ev.type, null);
    }
  }

  protected releaseDodge() {
    if (!this.heldDodge) return;
    this.keys.release(this.heldDodge);
    this.heldDodge = null;
  }
}
