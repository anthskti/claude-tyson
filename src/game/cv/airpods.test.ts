import { expect, test } from 'bun:test';
import { AirPodProvider, MotionInbox, parseMotionSample, lostMotionObservation } from './airpods';
import { GameServer } from '../net/server';

function sample(seq = 1, session = 'root'): any {
  const o = lostMotionObservation(session);
  o.validity = { dodge: true, punch_left: true, punch_right: true };
  o.trackingState = 'good';
  return { contractVersion: 1, kind: 'cv_sample', source: 'live', fightId: 'local', roundId: 'local', seq,
    sentUnixMs: Date.now(), observation: o,
    status: { ready: true, sides: { left: { fresh: true, ready: true }, right: { fresh: true, ready: true } } },
    events: [{ schemaVersion: 1, eventId: 'left-1', sessionId: session, type: 'punch_left', punchType: 'left_hook',
      onsetMs: null, sampleMs: 100, detectedMs: 102, sideConvention: 'player_anatomical', trackingState: 'good',
      qualityScore: null, qualityKind: 'model_softmax_not_calibrated_accuracy', calibrationId: 'left-cal', experimental: true,
      features: { detectedUnixMs: Date.now(), nativeSessionId: 'root-left', receiptToEventMs: 2 } }] };
}

test('valid native events keep full classes, identities, nullable physical onset and neutral guards', () => {
  const p = parseMotionSample(sample())!;
  expect(p.events[0].punchType).toBe('left_hook');
  expect(p.events[0].onsetMs).toBeNull();
  expect(p.observation.pose!.guards).toEqual({ left: 'neutral', right: 'neutral' });
});

test('reject mixed sessions, wrong-hand classes, nonfinite timing, guards and CV wrist inputs', () => {
  for (const mutate of [
    (s: any) => s.events[0].sessionId = 'root-left',
    (s: any) => s.events[0].punchType = 'right_hook',
    (s: any) => s.events[0].detectedMs = NaN,
    (s: any) => s.observation.pose.guards.left = 'block',
    (s: any) => s.observation.markers.left = { x: .3, y: .5 },
    (s: any) => s.observation.validity.punch_left = false,
    (s: any) => s.status.ready = false,
  ]) {
    const s = sample(); mutate(s); expect(parseMotionSample(s)).toBeUndefined();
  }
});

test('deduplicate native event IDs and sequences, reset only for a new sensor session', () => {
  const inbox = new MotionInbox();
  expect(inbox.accept(sample())).toHaveLength(1);
  expect(inbox.accept(sample())).toBeUndefined();
  expect(inbox.accept(sample(2))).toEqual([]);
  expect(inbox.accept(sample(1, 'new'))).toHaveLength(1);
});

test('direct provider calls the game immediately, without simulator keys or 30Hz batching', () => {
  let delivered = 0;
  const provider = new AirPodProvider({ status() {}, changed() {} });
  const internal = provider as any;
  internal.hello = true;
  internal.sync = { offset: 0, uncertainty: 0, at: performance.now() };
  internal.callback = (_: any, events: any[]) => { delivered += events.length; };
  internal.receive(sample());
  expect(delivered).toBe(1);
  expect(provider.ready).toBeTrue();
  internal.receive(sample(2));
  expect(delivered).toBe(1);
  const stale = sample(3); stale.sentUnixMs -= 1000;
  internal.receive(stale);
  expect(delivered).toBe(1);
  provider.stop();
  expect(provider.ready).toBeFalse();
});

test('only loopback endpoints are allowed in demo', () => {
  expect(() => new AirPodProvider({ status() {}, changed() {} }, 'ws://example.com')).toThrow();
});

test('send exact reducer shapes: current pose first, same canonical session, full punch class once', () => {
  const calls: any[] = [];
  const server = new GameServer({ onError() {} } as any);
  server.conn = { reducers: {
    updatePose: (p: any) => { calls.push(['pose', p]); return Promise.resolve(); },
    submitMotionEvent: (p: any) => { calls.push(['event', p]); return Promise.resolve(); },
  }} as any;
  const s = sample();
  const sent = server.forwardCv(1n, s.observation, s.events);
  expect(sent).toHaveLength(1);
  expect(calls.map(c => c[0])).toEqual(['pose', 'event']);
  expect(calls[1][1]).toEqual({ matchId: 1n, cvSessionId: 'root', eventId: 'left-1', eventType: 'punch_left', punchType: 'left_hook' });
  expect(calls[0][1].leftGuard).toBe('neutral');
  expect(calls[0][1].punchLeftValid).toBeTrue();
  server.forwardCv(1n, s.observation, s.events);
  expect(calls.filter(c => c[0] === 'event')).toHaveLength(1);
  const before = calls.length;
  s.observation.validity.punch_right = false;
  server.forwardCv(1n, s.observation, []);
  expect(calls.length).toBe(before + 1);
  expect(calls.at(-1)[1].punchRightValid).toBeFalse();
  server.forwardCv(2n, s.observation, []);
  expect(calls.at(-1)[1].matchId).toBe(2n);
});


test('controller gloves remain visible without CV wrist markers and reset camera offsets', async () => {
  const { PlayerGloves } = await import('../scene/boxer');
  const gloves = new PlayerGloves();
  gloves.setMarker('left', undefined);
  expect(gloves.visible.left).toBeFalse();
  gloves.setControllerHand('left', true);
  gloves.setControllerHand('right', false);
  gloves.update(1);
  expect(gloves.root.children[0].visible).toBeTrue();
  expect(gloves.root.children[1].visible).toBeFalse();
  expect(gloves.root.children[0].position.x).toBeCloseTo(-.22);
  gloves.punch('left', 'left_hook');
  expect(gloves.visible.left).toBeTrue();
});


test('fast status comes from the native models, is visible and validated', () => {
  let detail = '';
  const provider = new AirPodProvider({ status(_s, message) { detail = message ?? ''; }, changed() {} });
  const internal = provider as any;
  internal.hello = true;
  internal.sync = { offset: 0, uncertainty: 0, at: performance.now() };
  const s = sample();
  s.status.modelMode = 'fast';
  expect(parseMotionSample(s)?.status.modelMode).toBe('fast');
  internal.receive(s);
  expect(detail).toContain('FAST DEMO');
  s.status.modelMode = 'unknown';
  expect(parseMotionSample(s)).toBeUndefined();
  provider.stop();
});
