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

test('a fighter cannot overlap punches or punch while blocking', () => {
  const clock = new TestClock(new Timestamp(1_800_000_000_000_000n));
  const h = createModuleTestHarness(spacetimedb, mod as any, { clock });
  const player = auth();
  h.withReducerTx(player, ctx => (mod.startBotMatch as any)(ctx));
  const match = [...h.db.fightMatch.iter()][0];
  h.withReducerTx(player, ctx => (mod.updatePose as any)(ctx, { ...pose(), matchId: match.id }));
  const punch = (eventId: string, eventType: string, punchType: string) => h.withReducerTx(player, ctx =>
    (mod.submitMotionEvent as any)(ctx, {
      matchId: match.id, cvSessionId: 'session-1', eventId, eventType, punchType,
    }),
  );

  punch('left-1', 'punch_left', 'left_straight');
  punch('right-too-soon', 'punch_right', 'right_straight');
  expect([...h.db.attack.matchId.filter(match.id)]).toHaveLength(1);

  clock.advance(ms(220));
  punch('right-after-recovery', 'punch_right', 'right_straight');
  expect([...h.db.attack.matchId.filter(match.id)]).toHaveLength(2);

  clock.advance(ms(320));
  h.withReducerTx(player, ctx => (mod.updatePose as any)(ctx, {
    ...pose('neutral', 'block', 'block'), matchId: match.id,
  }));
  punch('while-blocking', 'punch_left', 'left_straight');
  expect([...h.db.attack.matchId.filter(match.id)]).toHaveLength(2);
});

test('block and dodge lock out other actions until released and cooled down', () => {
  const clock = new TestClock(new Timestamp(1_800_000_000_000_000n));
  const h = createModuleTestHarness(spacetimedb, mod as any, { clock });
  const player = auth();
  h.withReducerTx(player, ctx => (mod.startBotMatch as any)(ctx));
  const match = [...h.db.fightMatch.iter()][0];
  const updatePose = (value: ReturnType<typeof pose>) => h.withReducerTx(player, ctx =>
    (mod.updatePose as any)(ctx, { ...value, matchId: match.id }),
  );
  const punch = (eventId: string) => h.withReducerTx(player, ctx => (mod.submitMotionEvent as any)(ctx, {
    matchId: match.id, cvSessionId: 'session-1', eventId,
    eventType: 'punch_left', punchType: 'left_straight',
  }));
  const me = () => [...h.db.fighter.matchId.filter(match.id)].find(f => f.identity)!;

  updatePose(pose('lean_left'));
  updatePose(pose('lean_right'));
  expect(me().bodyState).toBe('lean_left'); // cannot switch dodge direction mid-action
  punch('during-dodge');
  expect([...h.db.attack.matchId.filter(match.id)]).toHaveLength(0);
  updatePose(pose());
  punch('during-dodge-recovery');
  expect([...h.db.attack.matchId.filter(match.id)]).toHaveLength(0);
  clock.advance(ms(260));
  updatePose(pose());
  punch('after-dodge-recovery');
  expect([...h.db.attack.matchId.filter(match.id)]).toHaveLength(1);

  clock.advance(ms(220));
  updatePose(pose('neutral', 'block', 'block'));
  updatePose(pose('lean_left'));
  expect(me().bodyState).toBe('neutral'); // block cannot turn into a dodge in-place
  expect(me().leftGuard).toBe('block');
  punch('during-block');
  expect([...h.db.attack.matchId.filter(match.id)]).toHaveLength(1);
  updatePose(pose());
  punch('during-block-recovery');
  expect([...h.db.attack.matchId.filter(match.id)]).toHaveLength(1);
  clock.advance(ms(300));
  updatePose(pose());
  punch('after-block-recovery');
  expect([...h.db.attack.matchId.filter(match.id)]).toHaveLength(2);
});

test('a continuously held defense is forcibly released after two seconds', () => {
  const clock = new TestClock(new Timestamp(1_800_000_000_000_000n));
  const h = createModuleTestHarness(spacetimedb, mod as any, { clock });
  const player = auth();
  h.withReducerTx(player, ctx => (mod.startBotMatch as any)(ctx));
  const match = [...h.db.fightMatch.iter()][0];
  const update = () => h.withReducerTx(player, ctx => (mod.updatePose as any)(ctx, {
    ...pose('lean_left'), matchId: match.id,
  }));
  const me = () => [...h.db.fighter.matchId.filter(match.id)].find(f => f.identity)!;

  update();
  expect(me().bodyState).toBe('lean_left');
  clock.advance(ms(2_000));
  update();
  expect(me().bodyState).toBe('neutral');
  clock.advance(ms(260));
  update();
  expect(me().bodyState).toBe('lean_left');
});

test('an expired held block stays locked until release, then observes its cooldown', () => {
  const clock = new TestClock(new Timestamp(1_800_000_000_000_000n));
  const h = createModuleTestHarness(spacetimedb, mod as any, { clock });
  const player = auth();
  h.withReducerTx(player, ctx => (mod.startBotMatch as any)(ctx));
  const match = [...h.db.fightMatch.iter()][0];
  const update = (leftGuard: string, rightGuard: string) => h.withReducerTx(player, ctx =>
    (mod.updatePose as any)(ctx, {
      ...pose('neutral', leftGuard, rightGuard), matchId: match.id,
    }),
  );
  const me = () => [...h.db.fighter.matchId.filter(match.id)].find(f => f.identity)!;

  update('block', 'block');
  clock.advance(ms(2_000));
  update('block', 'block');
  expect(me().leftGuard).toBe('neutral');
  expect(me().blockLockedUntilRelease).toBe(true);
  update('neutral', 'neutral');
  expect(me().blockLockedUntilRelease).toBe(false);
  clock.advance(ms(300));
  update('block', 'block');
  expect(me().leftGuard).toBe('block');
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
  h.withReducerTx(player, ctx => (mod.updatePose as any)(ctx, { ...pose(), matchId: match.id }));
  punch('neutral-punch');
  expect([...h.db.attack.matchId.filter(match.id)]).toHaveLength(1);
  h.withReducerTx(player, ctx => (mod.updatePose as any)(ctx, { ...pose('lean_right'), matchId: match.id }));
  expect(me().bodyState).toBe('neutral');
});

test('one glove up is not a guard: only both gloves block and drain stamina', () => {
  const clock = new TestClock(new Timestamp(1_800_000_000_000_000n));
  const h = createModuleTestHarness(spacetimedb, mod as any, { clock });
  const player = auth();
  h.withReducerTx(player, ctx => (mod.startBotMatch as any)(ctx));
  const match = [...h.db.fightMatch.iter()][0];
  const guard = (left: string, right: string) => h.withReducerTx(player, ctx => (mod.updatePose as any)(ctx, {
    ...pose('neutral', left, right), matchId: match.id,
  }));
  const me = () => [...h.db.fighter.matchId.filter(match.id)].find(f => f.identity)!;

  guard('block', 'neutral');
  clock.advance(ms(500));
  guard('block', 'neutral');
  expect(me().stamina).toBe(100); // no drain: a single glove isn't blocking

  guard('neutral', 'block');
  clock.advance(ms(500));
  guard('neutral', 'block');
  expect(me().stamina).toBe(100);

  guard('block', 'block');
  clock.advance(ms(500));
  guard('block', 'block');
  expect(me().stamina).toBeCloseTo(98);
});
