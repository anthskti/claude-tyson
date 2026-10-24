import { expect, test } from 'vitest';
import { createModuleTestHarness, TestAuth, TestClock } from 'spacetimedb/server/test-utils';
import { ConnectionId, TimeDuration, Timestamp } from 'spacetimedb';
import spacetimedb, * as mod from './index';

const ms = (n: number) => new TimeDuration(BigInt(n) * 1000n);
const auth = () => TestAuth.fromJwtPayload(
  JSON.stringify({ iss: 'localhost', sub: 'fighter', iat: 0, exp: 9999999999 }),
  ConnectionId.random(),
);
const pose = (bodyState = 'neutral', leftGuard = 'neutral', rightGuard = 'neutral') => ({
  matchId: 1n,
  cvSessionId: 'session-1',
  calibrationId: 'cal-1',
  trackingState: 'good',
  dodgeValid: true,
  punchLeftValid: true,
  punchRightValid: true,
  bodyState,
  leftGuard,
  rightGuard,
  lateral: 0,
});

test('authoritative input spends stamina once per deduplicated punch', () => {
  const clock = new TestClock(new Timestamp(1_800_000_000_000_000n));
  const h = createModuleTestHarness(spacetimedb, mod as any, { clock });
  const player = auth();
  h.withReducerTx(player, ctx => (mod.startBotMatch as any)(ctx));
  const match = [...h.db.fightMatch.iter()][0];
  h.withReducerTx(player, ctx => (mod.updatePose as any)(ctx, { ...pose(), matchId: match.id }));

  const action = {
    matchId: match.id,
    cvSessionId: 'session-1',
    eventId: 'event-1',
    eventType: 'punch_left',
    punchType: 'left_straight',
  };
  h.withReducerTx(player, ctx => (mod.submitMotionEvent as any)(ctx, action));
  h.withReducerTx(player, ctx => (mod.submitMotionEvent as any)(ctx, action));

  const me = [...h.db.fighter.matchId.filter(match.id)].find(f => f.identity);
  expect(me?.stamina).toBe(95);
  expect([...h.db.attack.matchId.filter(match.id)]).toHaveLength(1);
});

test('dodge has a fixed cost and active block drains stamina over server time', () => {
  const clock = new TestClock(new Timestamp(1_800_000_000_000_000n));
  const h = createModuleTestHarness(spacetimedb, mod as any, { clock });
  const player = auth();
  h.withReducerTx(player, ctx => (mod.startBotMatch as any)(ctx));
  const match = [...h.db.fightMatch.iter()][0];

  h.withReducerTx(player, ctx => (mod.updatePose as any)(ctx, { ...pose('lean_left'), matchId: match.id }));
  let me = [...h.db.fighter.matchId.filter(match.id)].find(f => f.identity)!;
  expect(me.stamina).toBe(80);

  h.withReducerTx(player, ctx => (mod.updatePose as any)(ctx, { ...pose(), matchId: match.id }));
  h.withReducerTx(player, ctx => (mod.updatePose as any)(ctx, {
    ...pose('lean_right'), matchId: match.id,
  }));
  me = [...h.db.fighter.matchId.filter(match.id)].find(f => f.identity)!;
  expect(me.bodyState).toBe('neutral'); // Dodge recovery rejects a rapid re-trigger.
  expect(me.stamina).toBe(80);

  clock.advance(ms(260));
  h.withReducerTx(player, ctx => (mod.updatePose as any)(ctx, {
    ...pose('lean_right'), matchId: match.id,
  }));
  me = [...h.db.fighter.matchId.filter(match.id)].find(f => f.identity)!;
  expect(me.bodyState).toBe('lean_right');
  expect(me.stamina).toBeCloseTo(63.12);

  h.withReducerTx(player, ctx => (mod.updatePose as any)(ctx, { ...pose(), matchId: match.id }));

  h.withReducerTx(player, ctx => (mod.updatePose as any)(ctx, {
    ...pose('neutral', 'block', 'block'), matchId: match.id,
  }));
  clock.advance(ms(500));
  h.withReducerTx(player, ctx => (mod.updatePose as any)(ctx, {
    ...pose('neutral', 'block', 'block'), matchId: match.id,
  }));
  me = [...h.db.fighter.matchId.filter(match.id)].find(f => f.identity)!;
  expect(me.stamina).toBeCloseTo(61.12);
});

test('a fighter cannot punch while leaning or lean while a punch is out', () => {
  const clock = new TestClock(new Timestamp(1_800_000_000_000_000n));
  const h = createModuleTestHarness(spacetimedb, mod as any, { clock });
  const player = auth();
  h.withReducerTx(player, ctx => (mod.startBotMatch as any)(ctx));
  const match = [...h.db.fightMatch.iter()][0];
  const punch = (eventId: string) => h.withReducerTx(player, ctx => (mod.submitMotionEvent as any)(ctx, {
    matchId: match.id, cvSessionId: 'session-1', eventId, eventType: 'punch_left', punchType: 'left_straight',
  }));
  const me = () => [...h.db.fighter.matchId.filter(match.id)].find(f => f.identity)!;

  h.withReducerTx(player, ctx => (mod.updatePose as any)(ctx, { ...pose('lean_left'), matchId: match.id }));
  expect(me().bodyState).toBe('lean_left');
  punch('lean-punch');
  expect([...h.db.attack.matchId.filter(match.id)]).toHaveLength(0);

  h.withReducerTx(player, ctx => (mod.updatePose as any)(ctx, { ...pose(), matchId: match.id }));
  clock.advance(ms(260));
  punch('neutral-punch');
  expect([...h.db.attack.matchId.filter(match.id)]).toHaveLength(1);
  h.withReducerTx(player, ctx => (mod.updatePose as any)(ctx, { ...pose('lean_right'), matchId: match.id }));
  expect(me().bodyState).toBe('neutral');
});
