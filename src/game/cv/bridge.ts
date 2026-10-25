// Client for the Python CV bridge (cv-mvp, `python -m cv_mvp --camera 0`), the dev and
// tuning source for camera input. Key mapping lives in CvInput (input.ts).

import { CvInput, type ControlKeys, type CvEvent, type CvHooks, type CvObservation } from './input';

const DEFAULT_URL = 'ws://127.0.0.1:8765';
const RETRY_MS = 3000;

export class CvBridge extends CvInput {
  readonly kind = 'bridge';
  private socket: WebSocket | null = null;
  private retryTimer = 0;
  private closed = false;
  private serial = 0;

  constructor(
    keys: ControlKeys,
    hooks: CvHooks = {},
    private url = process.env.NEXT_PUBLIC_CV_BRIDGE_URL ?? DEFAULT_URL,
  ) {
    super(keys, hooks);
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
    this.watchStale();
  }

  stop() {
    this.closed = true;
    window.removeEventListener('focus', this.reconnect);
    document.removeEventListener('visibilitychange', this.reconnect);
    clearTimeout(this.retryTimer);
    super.stop();
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
      // e.g. "One game client at a time" when another tab already holds the bridge.
      this.onStatus('disconnected', e.reason || undefined);
      if (!this.closed) this.retryTimer = window.setTimeout(() => this.connect(), RETRY_MS);
    };
  }

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
        this.sample(msg as unknown as { events: CvEvent[]; observation: CvObservation });
        return;
    }
  }
}
