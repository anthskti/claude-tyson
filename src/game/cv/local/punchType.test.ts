// Ported from cv-mvp tests/test_mvp.py: punch-type rules the fixtures do not pin down.

import { describe, expect, test } from 'bun:test';
import { CvAdapter } from './adapter';
import { GAME_CONFIG, PUNCH_TYPE_CONFIG, validatePunchType, type PunchTypeConfig } from './config';
import type { Landmark, LandmarkFrame } from './features';
import { PunchTyper } from './punchType';

/** cv-mvp synthetic.py: a straight per hand, a dodge and a flat left hook every 6 s. */
function frame(t: number): LandmarkFrame {
  const phase = (t % 6000) / 1000;
  const pt = (x: number, y: number): Landmark => ({ x, y, z: 0, visibility: 0.99, presence: 0.99 });
  const pose = Array.from({ length: 33 }, () => pt(0.5, 0.5));
  pose[0] = pt(phase > 3.4 && phase < 4.1 ? 0.62 : 0.5, 0.25);
  pose[11] = pt(0.65, 0.5);
  pose[12] = pt(0.35, 0.5);
  const hook = phase - 4.8;
  pose[13] = hook >= 0 && hook < 0.5 ? pt(0.86, 0.45) : pt(0.66, 0.75);
  pose[14] = pt(0.34, 0.75);
  const hands = ([['Left', 0.65, 1.2, -1], ['Right', 0.35, 2.3, 1]] as const).map(([side, center, start, direction]) => {
    const u = phase - start;
    const amount = u < 0.45 ? Math.max(0, Math.min(u, 0.25)) : Math.max(0, 0.25 - (u - 0.45));
    const size = 0.04 * Math.exp(4 * amount);
    let x = center + direction * amount * 0.6;
    if (side === 'Left' && hook >= 0 && hook < 0.9) {
      x = hook < 0.3 ? 0.75 - 1.25 * Math.min(hook, 0.2) : 0.5 + ((hook - 0.3) / 0.6) * 0.15;
    }
    const points = Array.from({ length: 21 }, () => pt(x, 0.4));
    for (const [i, dx, dy] of [[0, 0, 0.8], [5, -0.6, 0], [9, 0, -0.6], [13, 0.3, -0.3], [17, 0.6, 0]]) {
      points[i] = pt(x + dx * size, 0.4 + dy * size);
    }
    return { landmarks: points, model_handedness: side, handedness_score: 0.99 };
  });
  return { kind: 'frame', timestamp_ms: t, width: 640, height: 480, pose, hands };
}

function typedEvents(adapter: CvAdapter, end: number) {
  const out: [string, string, unknown][] = [];
  for (let t = 0; t < end; t += 33) {
    for (const e of adapter.process(frame(t), t + 25).events) {
      if (e.type.startsWith('punch_')) out.push([e.type, e.punchType, e.features.rule]);
    }
  }
  return out;
}

const arm = (raised: boolean | null, wristOut: number) => ({
  forearmLength: null, forearmDx: null, forearmAngleDeg: null, elbowOutward: null,
  elbowRaised: raised, elbowHeight: raised === null ? null : raised ? 0 : -0.8,
  elbowAngleDeg: raised === null ? null : raised ? 80 : 20,
  upperArmLength: raised === null ? null : 0.7, wristX: null,
  knuckleRatio: null, knuckleDepth: null, wristOutward: wristOut, wristHeight: null, forearmMissing: null,
});

function typerWith(xs: number[], sizes: number[], armState: ReturnType<typeof arm>, config = PUNCH_TYPE_CONFIG) {
  const typer = new PunchTyper(config, GAME_CONFIG);
  typer.scale = 0.3;
  xs.forEach((x, i) => typer.history.left.push([i * 33, x, sizes[i], armState]));
  return { typer, m: typer.measure('left', 33 * (xs.length - 1), 200) };
}

const sweep = Array.from({ length: 7 }, (_, i) => 0.75 - 0.02 * i); // left wrist moving inward
const flat = Array(7).fill(0.04);

describe('punch types', () => {
  test('straights and one hook per loop, each punch once', () => {
    const loop: [string, string, unknown][] = [['punch_left', 'straight', 'recent_hand_motion'], ['punch_right', 'straight', 'recent_hand_motion'], ['punch_left', 'hook', 'hook_lateral']];
    expect(typedEvents(new CvAdapter(GAME_CONFIG, 'game'), 12000)).toEqual([...loop, ...loop]);
  });

  test('a stricter elbow angle or a disabled trigger leaves only straights', () => {
    const strict = new CvAdapter(GAME_CONFIG, 's', { ...PUNCH_TYPE_CONFIG, hook_elbow_angle: 120 });
    expect(typedEvents(strict, 6000).map(e => e[1])).toEqual(['straight', 'straight']);
    const off = new CvAdapter(GAME_CONFIG, 'o', { ...PUNCH_TYPE_CONFIG, hook_trigger: false });
    expect(typedEvents(off, 6000).map(e => e[1])).toEqual(['straight', 'straight']);
  });

  test('reset clears punch history', () => {
    const a = new CvAdapter(GAME_CONFIG);
    for (let t = 4800; t < 4900; t += 33) a.process(frame(t), t);
    a.reset();
    expect(a.punchTyper.history).toEqual({ left: [], right: [] });
  });

  test('a hook needs a raised elbow and an outside-in wrist', () => {
    let { typer, m } = typerWith(sweep, flat, arm(true, 0.3));
    expect(typer.decide(m)).toBe('hook');
    ({ typer, m } = typerWith(sweep, flat, arm(false, 0.3)));
    expect(typer.decide(m)).toBe('straight');
    ({ typer, m } = typerWith(sweep, flat, arm(true, -0.2)));
    expect(typer.decide(m)).toBeNull();
    expect(typer.final(m)).toBe('straight');
    ({ typer, m } = typerWith(Array(7).fill(0.75), flat, arm(true, 0.3)));
    expect(typer.decide(m)).toBeNull();
    expect(typer.final(m)).toBe('straight');
    ({ typer, m } = typerWith(sweep, flat, arm(null, 0.3)));
    expect(typer.decide(m)).toBe('hook');
  });

  test('a fitted model replaces the rule', () => {
    const cfg: PunchTypeConfig = { ...PUNCH_TYPE_CONFIG, model: { features: ['wristOutward'], mean: [0.5], std: [0.2], weights: [4], bias: 0 } };
    const xs = Array.from({ length: 7 }, (_, i) => 0.7 - 0.02 * i);
    let { typer, m } = typerWith(xs, flat, arm(true, 0.9), cfg);
    expect(typer.decide(m)).toBe('hook');
    expect(m.hookProbability).toBeGreaterThan(0.9);
    ({ typer, m } = typerWith(xs, flat, arm(true, 0.1), cfg));
    expect(typer.decide(m)).toBe('straight');
    ({ typer, m } = typerWith(xs, flat, arm(true, 0.52), cfg));
    expect(typer.decide(m)).toBeNull();
    expect(() => validatePunchType({ ...PUNCH_TYPE_CONFIG, model: { features: ['nope'], mean: [0], std: [1], weights: [1], bias: 0 } })).toThrow();
  });

  test('invalid config is rejected', () => {
    for (const bad of [{ hook_elbow_angle: 0 }, { trigger_speed: 0 }, { hook_trigger: 'yes' }]) {
      expect(() => validatePunchType({ ...PUNCH_TYPE_CONFIG, ...bad } as PunchTypeConfig)).toThrow();
    }
  });

  test('a blurred fist is followed by the pose wrist, then dropped past the gap limit', () => {
    const typer = new PunchTyper(PUNCH_TYPE_CONFIG, GAME_CONFIG);
    const observe = (r: LandmarkFrame) => typer.process(r, [], new CvAdapter(GAME_CONFIG).detector);
    for (let t = 1200; t < 1300; t += 33) observe(frame(t));
    const before = typer.history.left.length;
    const blurred = frame(1300);
    const wrist = blurred.hands[0].landmarks[0];
    blurred.hands = [];
    blurred.pose[15] = { ...wrist, visibility: 0.9, presence: 0.9 };
    observe(blurred);
    const entry = typer.history.left[typer.history.left.length - 1];
    expect(typer.history.left.length).toBe(before + 1);
    expect(entry[2]).toBeNull();
    expect(entry[1]).toBe(wrist.x);
    const lost = frame(1600);
    lost.hands = [];
    for (const i of [15, 16]) lost.pose[i] = { ...lost.pose[i], visibility: 0.1 };
    observe(lost);
    expect(typer.history.left).toEqual([]);
  });
});
