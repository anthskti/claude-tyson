// Client for the Python CV bridge (cv-mvp, `python -m cv_mvp --camera 0`). Maps its
// classified movements onto the same control keys the keyboard uses, so the webcam and
// the keyboard drive one input path and either works when the other is absent.
//
//   punch_left  straight → J   hook → U
//   punch_right straight → K   hook → I
//   dodge_left → hold A · dodge_right → hold D · return_neutral → release
//
// Blocks come from the wrist/head markers in each observation (cv/guard.ts); main.ts
// turns those into Q/E holds.

import type { CameraMarkers } from './guard';

export interface ControlKeys {
  press(key: string): void;
  release(key: string): void;
}

export type BridgeStatus = 'off' | 'connecting' | 'connected' | 'disconnected';

export interface BridgeObservation {
  trackingState: string;
  markers: CameraMarkers;
}

export interface BridgeHooks {
  /** Every camera observation, for the preview and block detection. */
  onObservation?(obs: BridgeObservation): void;
  onStatus?(status: BridgeStatus, detail?: string): void;
  /** Each accepted CV event and the key it pressed (null for a release), for on-screen verification. */
  onTranslate?(event: string, key: string | null): void;
}

const DEFAULT_URL = 'ws://127.0.0.1:8765';
const RETRY_MS = 3000;
const STALE_MS = 500;

const PUNCH_KEY: Record<string, { straight: string; hook: string }> = {
  punch_left: { straight: 'j', hook: 'u' },
  punch_right: { straight: 'k', hook: 'i' },
};
const DODGE_KEY: Record<string, string> = { dodge_left: 'a', dodge_right: 'd' };

interface BridgeEvent {
  eventId: string;
  type: string;
  punchType?: 'straight' | 'hook';
}

export class CvBridge {
  private socket: WebSocket | null = null;
  private retryTimer = 0;
  private staleTimer = 0;
  private lastSampleAt = 0;
  private heldDodge: string | null = null;
  private seen = new Set<string>();
  private closed = false;
  private serial = 0;

  constructor(
    private keys: ControlKeys,
    private hooks: BridgeHooks = {},
    private url = process.env.NEXT_PUBLIC_CV_BRIDGE_URL ?? DEFAULT_URL,
  ) {}

  private onStatus(status: BridgeStatus, detail?: string) {
    this.hooks.onStatus?.(status, detail);
  }

  start() {
    if (this.url === 'off') {
      this.onStatus('off');
      return;
    }
    this.closed = false;
    this.connect();
    // Background tabs can stall the retry timer; try again as soon as the player looks.
    window.addEventListener('focus', this.reconnect);
    document.addEventListener('visibilitychange', this.reconnect);
    this.staleTimer = window.setInterval(() => {
      if (this.heldDodge && performance.now() - this.lastSampleAt > STALE_MS) this.releaseDodge();
    }, 100);
  }

  stop() {
    this.closed = true;
    window.removeEventListener('focus', this.reconnect);
    document.removeEventListener('visibilitychange', this.reconnect);
    clearTimeout(this.retryTimer);
    clearInterval(this.staleTimer);
    this.releaseDodge();
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.close();
      this.socket = null;
    }
  }

  /** Retry now instead of waiting for the backoff timer. No-op while a socket is open or opening. */
  reconnect = () => {
    if (this.closed || this.socket || document.visibilityState === 'hidden') return;
    clearTimeout(this.retryTimer);
    this.connect();
  };

  private connect() {
    this.onStatus('connecting');
    const socket = (this.socket = new WebSocket(this.url));
    socket.onmessage = e => {
      try {
        this.receive(JSON.parse(e.data));
      } catch {
        // Malformed packet: ignore it rather than act on a guess.
      }
    };
    socket.onclose = e => {
      this.socket = null;
      this.releaseDodge();
      // e.g. "One game client at a time" when another tab already holds the bridge.
      this.onStatus('disconnected', e.reason || undefined);
      if (!this.closed) this.retryTimer = window.setTimeout(() => this.connect(), RETRY_MS);
    };
  }

  /** Ask the bridge to re-learn the neutral head position (dodge reference). */
  resetCalibration() {
    if (this.socket?.readyState === WebSocket.OPEN) this.send('reset_calibration');
  }

  private send(kind: string, fields: Record<string, unknown> = {}) {
    this.socket?.send(JSON.stringify({ contractVersion: 1, kind, requestId: String(++this.serial), ...fields }));
  }

  private receive(msg: { kind?: string; [k: string]: unknown }) {
    switch (msg.kind) {
      case 'cv_hello':
        if (msg.contractVersion !== 1 || msg.motionSchemaVersion !== 1) {
          this.onStatus('disconnected', 'unsupported CV contract version');
          this.socket?.close();
          return;
        }
        // The bridge only streams after a context. Fight/round stamping is CV-side
        // bookkeeping; the server stamps the authoritative match itself.
        this.send('set_context', { fightId: 'local', roundId: 'local' });
        return;
      case 'cv_ack':
        if (msg.operation === 'set_context') this.onStatus('connected');
        return;
      case 'cv_status':
      case 'cv_error':
        this.releaseDodge();
        return;
      case 'cv_sample':
        this.sample(msg as unknown as { events: BridgeEvent[]; observation: BridgeObservation });
        return;
    }
  }

  private sample(s: { events: BridgeEvent[]; observation: BridgeObservation }) {
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

  private apply(ev: BridgeEvent) {
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

  private releaseDodge() {
    if (!this.heldDodge) return;
    this.keys.release(this.heldDodge);
    this.heldDodge = null;
  }
}
