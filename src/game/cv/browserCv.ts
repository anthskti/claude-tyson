// Camera input classified in the browser: frames from the preview's <video> go to two
// workers, one per MediaPipe model (local/worker.ts), so pose and hands run in parallel.
// Their landmarks merge into one frame for the ported cv-mvp detector (local/adapter.ts),
// which produces the same observations and events the Python bridge streams. Frames
// never leave the page.

import { CvAdapter } from './local/adapter';
import { CV_ASSETS } from './local/assets';
import type { HandRecord, Landmark } from './local/features';
import type { Delegate, ModelKind } from './local/inference';
import type { WorkerReply, WorkerRequest } from './local/protocol';
import { CvInput, type ControlKeys, type CvHooks } from './input';

export interface VideoSource {
  /** The playing camera video, or null while it is starting or unavailable. */
  video(): HTMLVideoElement | null;
  /** Why the camera is unavailable, if it failed. */
  error(): string | null;
}

// The detector's 120 ms punch window needs four samples (~17 FPS), so 20 is the floor.
const RATES = [30, 25, 20];
const WINDOW_MS = 2000;
// Frames never queue (one in flight), so step down only when p95 overruns the budget.
const STEP_DOWN = 1;
const STEP_UP = 0.75;
// The first GPU frames compile shaders and take seconds; keep them out of the numbers.
const WARMUP_FRAMES = 15;
const MODELS: ModelKind[] = ['pose', 'hands'];
// CPU for both measured fastest in parallel on an M3 (two GPU contexts contend with each
// other and with the Three.js scene) and leaves the GPU to rendering.
const DELEGATES: Record<string, Record<ModelKind, Delegate>> = {
  CPU: { pose: 'CPU', hands: 'CPU' },
  GPU: { pose: 'GPU', hands: 'GPU' },
  mixed: { pose: 'GPU', hands: 'CPU' },
};

const percentile = (values: number[], q: number) => {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
};

interface Pending {
  timestampMs: number;
  sentAt: number;
  width: number;
  height: number;
  pose?: Landmark[];
  hands?: HandRecord[];
  ms: Partial<Record<ModelKind, number>>;
}

export class BrowserCv extends CvInput {
  readonly kind = 'browser';
  private workers: Partial<Record<ModelKind, Worker>> = {};
  private delegates: Partial<Record<ModelKind, Delegate>> = {};
  private adapter = new CvAdapter();
  private pending: Pending | null = null;
  private raf = 0;
  private lastSent = 0;
  private lastStamp = -1;
  private rate = 0; // index into RATES
  private costs: number[] = []; // send-to-result wall time per frame, this window
  private modelMs: Record<ModelKind, number[]> = { pose: [], hands: [] };
  private frames = 0;
  private windowStart = 0;
  private started = false;
  private connected = false;
  private failed = false;
  private warmup = WARMUP_FRAMES;
  private slow = false;

  constructor(
    keys: ControlKeys,
    hooks: CvHooks,
    private camera: VideoSource,
  ) {
    super(keys, hooks);
  }

  private get ready() {
    return MODELS.every(m => this.delegates[m]);
  }

  private get delegate() {
    return [...new Set(MODELS.map(m => this.delegates[m]))].join('+');
  }

  start() {
    if (this.started) return;
    Object.assign(this, { started: true, failed: false, connected: false, warmup: WARMUP_FRAMES, slow: false, rate: 0 });
    this.onStatus('connecting', 'loading camera tracking');
    const base = `${location.origin}/${CV_ASSETS.root}`;
    // `?cvDelegate=GPU|CPU|mixed` overrides the per-model delegates, for comparing devices.
    const delegates = DELEGATES[new URLSearchParams(location.search).get('cvDelegate')] ?? DELEGATES.CPU;
    for (const model of MODELS) {
      const delegate = delegates[model];
      // Classic workers: MediaPipe loads its WASM glue with importScripts.
      const worker = new Worker(new URL('./local/worker.ts', import.meta.url));
      worker.onmessage = (e: MessageEvent<WorkerReply>) => this.receive(model, e.data);
      worker.onerror = () => this.fail('camera tracking failed to load');
      this.workers[model] = worker;
      this.post(model, { kind: 'init', model, base, delegate });
    }
    this.watchStale();
    this.raf = requestAnimationFrame(this.tick);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    for (const model of MODELS) {
      this.post(model, { kind: 'close' });
      this.workers[model]?.terminate();
    }
    this.workers = {};
    this.delegates = {};
    this.pending = null;
    this.started = this.connected = false;
    super.stop();
  }

  reconnect = () => {
    if (this.started && !this.failed) return;
    this.stop();
    this.start();
  };

  resetCalibration() {
    this.adapter.reset();
  }

  private post(model: ModelKind, msg: WorkerRequest, transfer: Transferable[] = []) {
    this.workers[model]?.postMessage(msg, transfer);
  }

  private fail(detail: string) {
    this.failed = true;
    this.connected = false;
    this.pending = null;
    this.onStatus('disconnected', detail);
  }

  private receive(model: ModelKind, msg: WorkerReply) {
    if (msg.kind === 'ready') {
      this.delegates[model] = msg.delegate;
      if (this.ready) {
        this.windowStart = performance.now();
        this.onStatus('connecting', 'starting camera');
      }
      return;
    }
    if (msg.kind === 'error') {
      this.fail(msg.message);
      return;
    }
    const p = this.pending;
    if (!p || p.timestampMs !== msg.timestampMs) return;
    if (msg.pose) p.pose = msg.pose;
    if (msg.hands) p.hands = msg.hands;
    p.ms[model] = msg.ms;
    if (!p.pose || !p.hands) return;
    this.pending = null;
    const sample = this.adapter.process({
      kind: 'frame', timestamp_ms: p.timestampMs, width: p.width, height: p.height, pose: p.pose, hands: p.hands,
    }, p.timestampMs);
    this.frames += 1;
    if (this.warmup > 0) {
      this.warmup -= 1;
    } else {
      this.costs.push(performance.now() - p.sentAt);
      for (const m of MODELS) this.modelMs[m].push(p.ms[m]);
    }
    if (!this.connected) {
      this.connected = true;
      this.onStatus('connected', this.delegate);
    }
    this.sample(sample);
  }

  /** Every display frame: send the next camera frame when the workers are free and due. */
  private tick = () => {
    this.raf = requestAnimationFrame(this.tick);
    if (!this.ready || this.failed) return;
    const now = performance.now();
    if (now - this.windowStart >= WINDOW_MS) this.adapt(now);
    if (this.pending || now - this.lastSent < 1000 / RATES[this.rate] - 4) return;
    const video = this.camera.video();
    if (!video || video.readyState < 2 || !video.videoWidth) {
      const error = this.camera.error();
      if (error) this.fail(error);
      return;
    }
    // MediaPipe and the detector both need strictly increasing integer milliseconds.
    const timestampMs = Math.max(this.lastStamp + 1, Math.round(now));
    this.lastStamp = timestampMs;
    this.lastSent = now;
    const p: Pending = (this.pending = { timestampMs, sentAt: now, width: video.videoWidth, height: video.videoHeight, ms: {} });
    void Promise.all([createImageBitmap(video), createImageBitmap(video)])
      .then(bitmaps => {
        if (this.pending !== p) return bitmaps.forEach(b => b.close());
        MODELS.forEach((model, i) => this.post(model, { kind: 'frame', bitmap: bitmaps[i], timestampMs }, [bitmaps[i]]));
      })
      .catch(() => {
        if (this.pending === p) this.pending = null;
      });
  };

  /** Step the frame rate between 30 and 20 FPS from the measured per-frame cost. */
  private adapt(now: number) {
    const cost = percentile(this.costs, 0.95);
    const fps = (this.frames * 1000) / (now - this.windowStart);
    if (this.costs.length >= 10) {
      if (cost > (1000 / RATES[this.rate]) * STEP_DOWN && this.rate < RATES.length - 1) this.rate += 1;
      else if (this.rate > 0 && cost < (1000 / RATES[this.rate - 1]) * STEP_UP) this.rate -= 1;
    }
    this.hooks.onStats?.({
      delegate: this.delegate, fps, inferenceP95Ms: cost,
      poseMs: percentile(this.modelMs.pose, 0.5), handsMs: percentile(this.modelMs.hands, 0.5),
    });
    // Below the floor punches stop registering; say so instead of failing silently.
    const slow = this.costs.length >= 10 && cost > 1000 / RATES[RATES.length - 1];
    if (this.connected && slow !== this.slow) {
      this.slow = slow;
      this.onStatus('connected', slow ? `${this.delegate} · too slow for reliable punches` : this.delegate);
    }
    this.costs = [];
    this.modelMs = { pose: [], hands: [] };
    this.frames = 0;
    this.windowStart = now;
  }
}
