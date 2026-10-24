import { describe, expect, test } from 'bun:test';
import { GuardCalibration, GuardClassifier, type CameraMarkers, type GuardCalibrationData } from './guard';

const head = { x: 0.5, y: 0.3 };
// Unmirrored image: the player's left hand shows on image-right.
const stance: CameraMarkers = { head, left: { x: 0.6, y: 0.5 }, right: { x: 0.4, y: 0.5 } };
const block: CameraMarkers = { head, left: { x: 0.54, y: 0.32 }, right: { x: 0.46, y: 0.32 } };
const calib: GuardCalibrationData = {
  stance: { left: { x: 0.1, y: 0.2 }, right: { x: -0.1, y: 0.2 } },
  block: { left: { x: 0.04, y: 0.02 }, right: { x: -0.04, y: 0.02 } },
};

describe('GuardClassifier', () => {
  test('stance is neutral, gloves at the face block', () => {
    const g = new GuardClassifier(calib);
    expect(g.update(stance, 0)).toEqual({ left: 'neutral', right: 'neutral' });
    expect(g.update(block, 33)).toEqual({ left: 'block', right: 'block' });
  });

  test('one glove up blocks that side only', () => {
    const g = new GuardClassifier(calib);
    expect(g.update({ head, left: block.left, right: stance.right }, 0)).toEqual({ left: 'block', right: 'neutral' });
  });

  test('a block survives a hidden nose and a short hand dropout, then times out', () => {
    const g = new GuardClassifier(calib);
    g.update(block, 0);
    expect(g.update({ left: block.left, right: block.right }, 100)).toEqual({ left: 'block', right: 'block' });
    expect(g.update({ head }, 300)).toEqual({ left: 'block', right: 'block' });
    expect(g.update({ head }, 600)).toEqual({ left: 'neutral', right: 'neutral' });
  });

  test('hysteresis: halfway between stance and block keeps the current state', () => {
    const g = new GuardClassifier(calib);
    const mid: CameraMarkers = { head, left: { x: 0.57, y: 0.41 }, right: { x: 0.43, y: 0.41 } };
    expect(g.update(mid, 0).left).toBe('neutral');
    g.update(block, 33);
    expect(g.update(mid, 66).left).toBe('block');
  });
});

describe('GuardCalibration', () => {
  function run(stancePose: CameraMarkers, blockPose: CameraMarkers) {
    let done: GuardCalibrationData | undefined;
    let stanceStarted = 0;
    const c = new GuardCalibration({ onStance: () => stanceStarted++, onDone: d => (done = d) });
    let t = performance.now();
    const feedFor = (pose: CameraMarkers, ms: number) => {
      for (const end = t + ms; t < end; t += 33) c.feed(pose, t);
    };
    feedFor(stancePose, 700); // in frame
    feedFor(stancePose, 2600); // prep + capture
    feedFor(blockPose, 2600);
    return { c, done, stanceStarted };
  }

  test('captures stance and block offsets relative to the head', () => {
    const { c, done, stanceStarted } = run(stance, block);
    expect(stanceStarted).toBe(1);
    expect(c.view().step).toBe('done');
    expect(done!.stance.left.x).toBeCloseTo(0.1);
    expect(done!.block.right.y).toBeCloseTo(0.02);
  });

  test('rejects a block that looks like the stance', () => {
    const { c, done } = run(stance, stance);
    expect(done).toBeUndefined();
    expect(c.view().step).toBe('block');
    expect(c.view().error).toContain('looked like your stance');
  });

  test('waits in the frame step until head and both hands are visible', () => {
    const partial = { head, left: stance.left };
    const { c } = run(partial, partial);
    expect(c.view().step).toBe('frame');
    expect(c.view().seen).toEqual({ head: true, left: true, right: false });
  });
});
