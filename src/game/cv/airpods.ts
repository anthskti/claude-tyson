import type { CvProvider, CvSample, MotionEvent, Observation } from './contract';
import type { CvStatus } from './input';

type SideStatus = { fresh: boolean; ready: boolean; prompt?: string };
export type MotionStatus = { modelMode?: 'outward' | 'fast'; ready: boolean; sides: { left: SideStatus; right: SideStatus } };
export interface MotionSample extends CvSample { sentUnixMs: number; status: MotionStatus }
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const object = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x);
const states = ['good', 'degraded', 'lost', 'calibrating'];
const kinds = ['punch_left', 'punch_right', 'dodge_left', 'dodge_right', 'return_neutral'];

/** Validate the native/browser boundary before it can reach reducers or animation. */
export function parseMotionSample(value: unknown): MotionSample | undefined {
  if (!object(value) || value.kind !== 'cv_sample' || value.contractVersion !== 1 || value.source !== 'live'
    || !Number.isSafeInteger(value.seq) || value.seq < 1 || !finite(value.sentUnixMs)) return;
  const o = value.observation;
  if (!object(o) || o.schemaVersion !== 1 || o.kind !== 'observation' || typeof o.sessionId !== 'string' || !o.sessionId
    || !finite(o.timestampMs) || !finite(o.availableMs) || !states.includes(o.trackingState)
    || !object(o.validity) || !['dodge', 'punch_left', 'punch_right'].every(k => typeof o.validity[k] === 'boolean')
    || !(o.calibrationId === null || typeof o.calibrationId === 'string') || !object(o.features) || !object(o.markers)
    || !object(o.pose) || !['neutral', 'lean_left', 'lean_right'].includes(o.pose.body)
    || o.pose.guards?.left !== 'neutral' || o.pose.guards?.right !== 'neutral'
    || !(o.qualityScore === null || finite(o.qualityScore))) return;
  const lateral = o.features.lateralDisplacementBodyWidths;
  if (lateral !== undefined && !finite(lateral)) return;
  if (Object.keys(o.markers).some(k => k !== 'head')) return; // No CV hand input in this mode.
  if (o.markers.head && (!finite(o.markers.head.x) || !finite(o.markers.head.y))) return;
  const status = value.status;
  if (!object(status) || typeof status.ready !== 'boolean' || !object(status.sides)) return;
  if (status.modelMode !== undefined && !['outward', 'fast'].includes(status.modelMode)) return;
  for (const side of ['left', 'right']) {
    const s = status.sides[side];
    if (!object(s) || typeof s.ready !== 'boolean' || typeof s.fresh !== 'boolean'
      || (s.prompt !== undefined && typeof s.prompt !== 'string')) return;
    if (o.validity[`punch_${side}`] !== s.ready || (s.ready && !s.fresh)) return;
  }
  if (status.ready !== (o.validity.dodge && status.sides.left.ready && status.sides.right.ready)) return;
  if (!Array.isArray(value.events) || value.events.length > 128) return;
  for (const e of value.events) {
    if (!object(e) || e.schemaVersion !== 1 || e.sessionId !== o.sessionId || typeof e.eventId !== 'string' || !e.eventId
      || !kinds.includes(e.type) || e.sideConvention !== 'player_anatomical' || !states.includes(e.trackingState)
      || !finite(e.sampleMs) || !finite(e.detectedMs) || !(e.onsetMs === null || finite(e.onsetMs))
      || !(e.qualityScore === null || finite(e.qualityScore)) || typeof e.qualityKind !== 'string'
      || !object(e.features) || !finite(e.features.detectedUnixMs)) return;
    if (e.type.startsWith('punch_')) {
      const hand = e.type.slice(6);
      if (![`${hand}_straight`, `${hand}_hook`].includes(e.punchType) || !o.validity[e.type]) return;
    } else if (e.punchType !== undefined || !o.validity.dodge) return;
  }
  return value as MotionSample;
}

export function lostMotionObservation(sessionId = 'motion-disconnected'): Observation {
  return { schemaVersion: 1, kind: 'observation', sessionId, timestampMs: 0, availableMs: 0,
    trackingState: 'lost', validity: { dodge: false, punch_left: false, punch_right: false }, calibrationId: null,
    markers: {}, features: {}, qualityScore: null, reason: 'AirPod demo disconnected or stale. Check the local harness.',
    pose: { body: 'neutral', guards: { left: 'neutral', right: 'neutral' } } };
}

/** Sequence/event isolation survives reconnects; old events never become fresh input. */
export class MotionInbox {
  session = '';
  seq = 0;
  private seen = new Set<string>();
  accept(sample: MotionSample): MotionEvent[] | undefined {
    const session = sample.observation.sessionId;
    if (session !== this.session) { this.session = session; this.seq = 0; this.seen.clear(); }
    if (sample.seq <= this.seq) return;
    this.seq = sample.seq;
    return sample.events.filter(e => {
      if (this.seen.has(e.eventId)) return false;
      this.seen.add(e.eventId);
      if (this.seen.size > 2048) this.seen.delete(this.seen.values().next().value!);
      return true;
    });
  }
}

export class AirPodProvider implements CvProvider {
  readonly source = 'live' as const;
  status?: MotionStatus;
  private socket?: WebSocket;
  private callback?: (o: Observation, e: MotionEvent[]) => void;
  private inbox = new MotionInbox();
  private timer?: ReturnType<typeof setInterval>;
  private retry?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private hello = false;
  private lastReceipt = 0;
  private serial = 0;
  private pings = new Map<number, { perf: number; unix: number }>();
  private sync?: { offset: number; uncertainty: number; at: number };
  private traces = new Map<string, Record<string, any>>();
  private framePending = new Set<string>();
  private addedLatency: number[] = [];
  readonly counts = { detected: 0, submitted: 0, accepted: 0, resolved: 0 };

  constructor(private hooks: { status(s: CvStatus, detail?: string): void; changed(): void },
    private url = 'ws://127.0.0.1:8765') {
    const u = new URL(url);
    if (u.protocol !== 'ws:' || !['127.0.0.1', 'localhost'].includes(u.hostname) || u.username || u.password) {
      throw new Error('The demo motion bridge must use a local ws:// address');
    }
  }

  get ready() { return !!this.status?.ready && performance.now() - this.lastReceipt < 200; }
  get summary() {
    const c = this.counts;
    const latest = [...this.traces.values()].at(-1);
    const timings = latest ? [
      finite(latest.receiptToEventMs) ? `receipt→decision ${latest.receiptToEventMs.toFixed(0)}ms` : '',
      finite(latest.decisionToFrameMs) ? `decision→frame ~${latest.decisionToFrameMs.toFixed(0)}ms` : '',
      finite(latest.submitToAcceptMs) ? `submit→accepted ${latest.submitToAcceptMs.toFixed(0)}ms` : '',
    ].filter(Boolean).join(' · ') : '';
    const p95 = this.addedLatency.length ? [...this.addedLatency].sort((a,b) => a-b)[Math.ceil(this.addedLatency.length*.95)-1] : undefined;
    return `detected ${c.detected} · submitted ${c.submitted} · accepted ${c.accepted} · resolved ${c.resolved}`
      + (timings ? ` | ${timings}` : '') + (p95 === undefined ? '' : ` | added p95 ~${p95.toFixed(0)}ms`);
  }

  start(callback: (o: Observation, e: MotionEvent[]) => void) {
    this.stop();
    this.stopped = false;
    this.callback = callback;
    this.connect();
    this.timer = setInterval(() => {
      if (this.lastReceipt && performance.now() - this.lastReceipt > 200) {
        this.invalidate('Motion stream stale; releasing pose');
        this.socket?.close();
      }
      if (this.socket?.readyState === WebSocket.OPEN) this.ping();
    }, 100);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer); clearTimeout(this.retry);
    this.invalidate('Local motion stopped');
    const socket = this.socket; this.socket = undefined;
    socket?.close();
    this.callback = undefined;
    this.framePending.clear();
  }

  private invalidate(detail: string) {
    this.status = undefined; this.lastReceipt = 0;
    this.callback?.(lostMotionObservation(this.inbox.session || undefined), []);
    this.hooks.status('disconnected', detail);
  }

  private connect() {
    if (this.stopped) return;
    this.hello = false; this.sync = undefined; this.pings.clear();
    this.hooks.status('connecting', 'Start the local demo harness');
    const ws = this.socket = new WebSocket(this.url);
    ws.onopen = () => { if (this.socket === ws) this.ping(); };
    ws.onerror = () => { if (this.socket === ws) this.hooks.status('disconnected', 'Local motion bridge unavailable'); };
    ws.onmessage = event => {
      if (this.socket !== ws || this.stopped) return;
      try {
        if (typeof event.data !== 'string' || event.data.length > 65536) throw new Error('Oversize motion packet');
        this.receive(JSON.parse(event.data));
      } catch (e) {
        this.invalidate(`Invalid motion packet: ${e instanceof Error ? e.message : e}`);
        ws.close(1008, 'Invalid motion packet');
      }
    };
    ws.onclose = event => {
      if (this.socket !== ws || this.stopped) return;
      this.socket = undefined;
      this.invalidate(event.reason || 'Local motion disconnected');
      this.retry = setTimeout(() => this.connect(), 1000);
    };
  }

  private ping() {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const id = ++this.serial;
    this.pings.set(id, { perf: performance.now(), unix: Date.now() });
    if (this.pings.size > 32) this.pings.delete(this.pings.keys().next().value!);
    this.socket.send(JSON.stringify({ kind: 'ping', id }));
  }

  private receive(msg: Record<string, any>) {
    const perf = performance.now();
    if (msg.kind === 'motion_hello') {
      if (msg.contractVersion !== 1 || typeof msg.sessionId !== 'string') throw new Error('Unsupported motion version');
      this.hello = true; return;
    }
    if (msg.kind === 'pong') {
      const sent = this.pings.get(msg.id);
      if (!sent || !finite(msg.hostUnixMs)) return;
      this.pings.delete(msg.id);
      const rtt = perf - sent.perf;
      if (rtt <= 100 && (!this.sync || perf - this.sync.at > 3000 || rtt / 2 <= this.sync.uncertainty)) {
        this.sync = { offset: msg.hostUnixMs - (sent.unix + rtt / 2), uncertainty: rtt / 2, at: perf };
      }
      return;
    }
    const sample = parseMotionSample(msg);
    if (!this.hello || !sample) throw new Error('Malformed motion sample');
    // Wait for clock alignment before admitting actions; no buffering/replay.
    if (!this.sync || perf - this.sync.at > 4000) return;
    const hostNow = Date.now() + this.sync.offset;
    const age = hostNow - sample.sentUnixMs;
    if (age < -this.sync.uncertainty - 5 || age + this.sync.uncertainty > 150) return;
    const events = this.inbox.accept(sample);
    if (!events) return;
    this.lastReceipt = perf;
    this.status = sample.status;
    const fresh = events.filter(e => {
      const age = hostNow - Number(e.features!.detectedUnixMs);
      return age >= -this.sync!.uncertainty - 5 && age + this.sync!.uncertainty <= 150;
    });
    for (const e of fresh) {
      if (!e.type.startsWith('punch_')) continue;
      const trace = { eventId: e.eventId, punchType: e.punchType, stage: 'detected', receivedPerf: perf,
        bridgeEstimateMs: hostNow - Number(e.features!.detectedUnixMs), clockUncertaintyMs: this.sync.uncertainty,
        receiptToEventMs: e.features!.receiptToEventMs, confirmationToEventMs: e.features!.confirmationToEventMs };
      this.traces.set(e.eventId, trace); this.counts.detected++; this.framePending.add(e.eventId);
      if (this.traces.size > 512) this.traces.delete(this.traces.keys().next().value!);
      console.debug('[motion]', trace);
    }
    this.hooks.status('connected', `${sample.status.modelMode === 'fast' ? 'FAST DEMO' : 'OUTWARD'} · L: ${sample.status.sides.left.ready ? 'ready' : 'calibrate/check stream'} · R: ${sample.status.sides.right.ready ? 'ready' : 'calibrate/check stream'} · pose: ${sample.observation.validity.dodge ? 'ready' : 'waiting'}`);
    this.callback?.(sample.observation, fresh);
    this.hooks.changed();
  }

  submitted(events: MotionEvent[]) {
    for (const event of events) {
      const trace = this.traces.get(event.eventId);
      if (!trace || trace.submittedPerf !== undefined) continue;
      trace.submittedPerf = performance.now(); this.counts.submitted++;
      console.debug('[motion]', { ...trace, stage: 'submitted' });
    }
  }

  accepted(id: string) {
    const trace = this.traces.get(id);
    if (!trace || trace.acceptedPerf !== undefined) return;
    trace.acceptedPerf = performance.now(); this.counts.accepted++;
    trace.submitToAcceptMs = trace.submittedPerf === undefined ? null : trace.acceptedPerf - trace.submittedPerf;
    console.debug('[motion]', { ...trace, stage: 'accepted' }); this.hooks.changed();
  }

  resolved(id: string, result: string) {
    const trace = this.traces.get(id);
    if (!trace || trace.resolvedPerf !== undefined) return;
    trace.resolvedPerf = performance.now(); this.counts.resolved++;
    console.debug('[motion]', { ...trace, stage: 'resolved', result }); this.hooks.changed();
  }

  frameRendered(visible = true) {
    if (!visible) { this.framePending.clear(); return; }
    const now = performance.now();
    for (const id of this.framePending) {
      const trace = this.traces.get(id);
      if (!trace) continue;
      trace.receiptToFrameMs = now - trace.receivedPerf;
      trace.decisionToFrameMs = trace.bridgeEstimateMs + trace.receiptToFrameMs;
      this.addedLatency.push(trace.decisionToFrameMs);
      if (this.addedLatency.length > 512) this.addedLatency.shift();
      console.debug('[motion]', { ...trace, stage: 'local_frame' });
    }
    if (this.framePending.size) this.hooks.changed();
    this.framePending.clear();
  }
}
