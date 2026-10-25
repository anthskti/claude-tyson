import * as THREE from 'three';
import type { PunchType } from '../cv/contract';

type Hand = 'left' | 'right';
type Key = { position: [number, number, number]; rotation: [number, number, number] };

const REST_KEY: Key = { position: [0, 0, 0], rotation: [0, 0, 0] };
const BLOCK_TIMES = [0, 0.08, 0.2];
const PUNCH_TIMES = [0, 0.045, 0.14, 0.235, 0.32];

function clip(name: string, times: number[], keys: Key[]) {
  const position = new THREE.VectorKeyframeTrack(
    '.position', times, keys.flatMap(key => key.position), THREE.InterpolateSmooth,
  );
  const rotations = keys.map(key => new THREE.Quaternion().setFromEuler(new THREE.Euler(...key.rotation)));
  const quaternion = new THREE.QuaternionKeyframeTrack(
    '.quaternion', times, rotations.flatMap(rotation => rotation.toArray()), THREE.InterpolateLinear,
  );
  return new THREE.AnimationClip(name, times[times.length - 1], [position, quaternion]);
}

function punchKeys(hand: Hand, type: PunchType): Key[] {
  const side = hand === 'left' ? -1 : 1;
  if (type.endsWith('_hook')) {
    // Roll through a wide, rising arc, then turn the knuckles through the target.
    return [
      REST_KEY,
      { position: [side * 0.025, -0.015, 0.035], rotation: [-0.08, side * 0.12, side * 0.08] },
      { position: [-side * 0.09, 0.065, -0.2], rotation: [-0.18, -side * 0.55, -side * 0.22] },
      { position: [-side * 0.22, 0.045, -0.43], rotation: [-0.08, -side * 1.05, -side * 0.38] },
      REST_KEY,
    ];
  }

  // Both straights share the existing direct extension and recovery. The right cross
  // keeps that path but rolls and turns the wrist through impact for a rounder finish.
  const isCross = type === 'right_straight';
  return [
    REST_KEY,
    { position: [0, -0.015, 0.02], rotation: [-0.04, 0, 0] },
    {
      position: [-side * 0.17, 0.04, -0.55],
      rotation: isCross ? [-0.12, -side * 0.28, -side * 0.38] : [-0.12, 0, -side * 0.08],
    },
    {
      position: [-side * 0.05, 0.02, -0.18],
      rotation: isCross ? [-0.06, -side * 0.16, -side * 0.2] : [-0.04, 0, -side * 0.04],
    },
    REST_KEY,
  ];
}

/** Keyframed camera-space transforms for the first-person gloves. */
export class GloveAnimation {
  private readonly mixer: THREE.AnimationMixer;
  private readonly rest: THREE.AnimationAction;
  private readonly punches = new Map<PunchType, THREE.AnimationAction>();
  private readonly block: THREE.AnimationAction;
  private current: THREE.AnimationAction;
  private blockHeld = false;

  private onFinished = (event: { action: THREE.AnimationAction }) => {
    if (event.action !== this.current) return;
    if (this.blockHeld && event.action === this.block) {
      event.action.paused = true;
      return;
    }
    this.returnToRest();
  };

  constructor(private readonly motion: THREE.Group, hand: Hand) {
    this.mixer = new THREE.AnimationMixer(motion);
    const restClip = clip('glove-rest', [0, 0.2], [REST_KEY, REST_KEY]);
    this.rest = this.mixer.clipAction(restClip);
    this.rest.setLoop(THREE.LoopRepeat, Infinity).play();
    this.current = this.rest;

    for (const type of ['left_straight', 'right_straight', 'left_hook', 'right_hook'] as const) {
      const action = this.mixer.clipAction(clip(`glove-${type}`, PUNCH_TIMES, punchKeys(hand, type)));
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
      this.punches.set(type, action);
    }

    const side = hand === 'left' ? -1 : 1;
    const faceBlock: Key = { position: [0, 0, 0], rotation: [-0.24, side * 0.06, -side * 0.14] };
    this.block = this.mixer.clipAction(clip('glove-high-block', BLOCK_TIMES, [REST_KEY, faceBlock, faceBlock]));
    this.block.setLoop(THREE.LoopOnce, 1);
    this.block.clampWhenFinished = true;
    this.mixer.addEventListener('finished', this.onFinished as never);
  }

  punch(type: PunchType) {
    this.blockHeld = false;
    const action = this.punches.get(type);
    if (action) this.play(action, 0.045);
  }

  setBlock(held: boolean) {
    if (held === this.blockHeld) return;
    this.blockHeld = held;
    if (held) this.play(this.block, 0.09);
    else if (this.current === this.block) this.returnToRest();
  }

  update(dt: number) {
    this.mixer.update(dt);
  }

  private play(action: THREE.AnimationAction, fade: number) {
    const previous = this.current;
    action.reset();
    action.paused = false;
    action.enabled = true;
    action.play();
    previous.crossFadeTo(action, fade, false);
    this.current = action;
  }

  private returnToRest() {
    if (this.current === this.rest) return;
    this.current.crossFadeTo(this.rest, 0.1, false);
    this.rest.reset().play();
    this.current = this.rest;
  }
}
