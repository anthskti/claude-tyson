import { expect, test } from 'vitest';
import { PUNCHES, resolvePunch, type PunchType } from './rules';

const types: PunchType[] = ['left_straight', 'right_straight', 'left_hook', 'right_hook'];

test('server damage starts at the agreed straight and hook values', () => {
  expect(types.map(type => PUNCHES[type].damage / 10)).toEqual([0.5, 1.3, 1, 1]);
});

test('block stops both straights and hooks beat block for base damage', () => {
  for (const type of types.slice(0, 2)) {
    expect(resolvePunch(type, { body: 'neutral', blocking: true })).toMatchObject({ result: 'blocked', damageScale: 0 });
  }
  for (const type of types.slice(2)) {
    expect(resolvePunch(type, { body: 'neutral', blocking: true })).toMatchObject({ result: 'landed', detail: 'hook_beats_block', damageScale: 1 });
  }
});

test('either dodge avoids straights; matching-side dodge avoids its hook', () => {
  for (const type of types.slice(0, 2)) {
    expect(resolvePunch(type, { body: 'lean_left', blocking: false }).result).toBe('dodged');
    expect(resolvePunch(type, { body: 'lean_right', blocking: false }).result).toBe('dodged');
  }
  expect(resolvePunch('left_hook', { body: 'lean_left', blocking: false }).result).toBe('dodged');
  expect(resolvePunch('right_hook', { body: 'lean_right', blocking: false }).result).toBe('dodged');
});

test('opposite-side hook catches dodge for 1.5x base damage', () => {
  expect(resolvePunch('left_hook', { body: 'lean_right', blocking: false })).toMatchObject({
    result: 'landed', detail: 'hook_beat_slip', damageScale: 1.5,
  });
  expect(resolvePunch('right_hook', { body: 'lean_left', blocking: false })).toMatchObject({
    result: 'landed', detail: 'hook_beat_slip', damageScale: 1.5,
  });
});
