import { describe, expect, test } from 'bun:test';
import { SIM_KEYS, SimulatedCvProvider } from './simulatedProvider';
import type { MotionEvent, Observation } from './contract';

type TestProvider = SimulatedCvProvider & {
  calibrationId: string | null;
  calibratingUntil: number;
  pending: MotionEvent[];
  step(now: number, dt: number): void;
  observe(now: number): Observation;
};

function setup() {
  let now = 0;
  const provider = new SimulatedCvProvider(() => now);
  provider.setStamina(200);
  const internal = provider as TestProvider;
  internal.calibrationId = 'test-calibration';
  internal.calibratingUntil = 0;
  const tick = (time: number) => {
    internal.step(time, Math.max(0, time - now) / 1000);
    now = time;
    return internal.observe(time);
  };
  return { provider, internal, tick, setNow: (time: number) => (now = time) };
}

describe('SimulatedCvProvider action rules', () => {
  test('uses the shared keyboard punch bindings', () => {
    expect(SIM_KEYS).toEqual({
      j: { hand: 'left', type: 'left_straight' },
      c: { hand: 'right', type: 'right_straight' },
      q: { hand: 'left', type: 'left_hook' },
      e: { hand: 'right', type: 'right_hook' },
    });
  });

  test('locks both punch hands for the server recovery window and drops spam', () => {
    const { provider, internal, setNow } = setup();
    provider.press('j');
    expect(internal.pending.map(event => event.punchType)).toEqual(['left_straight']);

    setNow(269);
    provider.press('c');
    expect(internal.pending).toHaveLength(1);

    setNow(270);
    provider.press('c');
    expect(internal.pending.map(event => event.punchType)).toEqual(['left_straight', 'right_straight']);
  });

  test('rejects punches when the latest server stamina cannot cover the cost', () => {
    const { provider, internal } = setup();
    provider.setStamina(4);
    provider.press('j');
    expect(internal.pending).toHaveLength(0);

    provider.setStamina(5);
    provider.press('j');
    expect(internal.pending.map(event => event.punchType)).toEqual(['left_straight']);
  });

  test('requires 20 stamina to dodge and positive stamina to block', () => {
    const lowDodge = setup();
    lowDodge.provider.setStamina(19);
    lowDodge.provider.press('a');
    expect(lowDodge.tick(0).pose?.body).toBe('neutral');

    const enoughDodge = setup();
    enoughDodge.provider.setStamina(20);
    enoughDodge.provider.press('a');
    expect(enoughDodge.tick(0).pose?.body).toBe('lean_left');

    const noBlock = setup();
    noBlock.provider.setStamina(0);
    noBlock.provider.press('b');
    expect(noBlock.tick(0).pose?.guards).toEqual({ left: 'neutral', right: 'neutral' });
  });

  test('forces block release at two seconds and applies release cooldown', () => {
    const { provider, tick } = setup();
    provider.press('b');
    expect(tick(0).pose?.guards).toEqual({ left: 'block', right: 'block' });
    expect(tick(1999).pose?.guards.left).toBe('block');
    expect(tick(2000).pose?.guards).toEqual({ left: 'neutral', right: 'neutral' });

    provider.press('b'); // Still physically held: timeout requires keyup before another block.
    expect(tick(2299).pose?.guards.left).toBe('neutral');
    provider.release('b');
    provider.press('b');
    expect(tick(2300).pose?.guards.left).toBe('block');
  });

  test.each([
    ['a', 'lean_left', 'dodge_left'],
    ['d', 'lean_right', 'dodge_right'],
  ] as const)('forces %s dodge release and applies cooldown', (key, body, _action) => {
    const { provider, tick } = setup();
    provider.press(key);
    expect(tick(0).pose?.body).toBe(body);
    expect(tick(2000).pose?.body).toBe('neutral');

    provider.press(key); // Still physically held: timeout requires keyup before another dodge.
    expect(tick(2259).pose?.body).toBe('neutral');
    provider.release(key);
    provider.press(key);
    expect(tick(2260).pose?.body).toBe(body);
  });
});
