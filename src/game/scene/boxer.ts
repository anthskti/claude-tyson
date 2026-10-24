import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Body, Guard, PunchType } from '../cv/contract';
import { BoxingAnimationController, type ClipSlot, type HeldSlot } from './animation-controller';

// The opponent is claude_bot.glb. Gameplay still calls the same methods; the
// controller maps them onto contract clip names and no-ops until the file loads.
// First-person gloves stay primitive: there is no player body model.

export type Hand = 'left' | 'right';
export type AnyPunch = PunchType | 'unclassified';
const HANDS = ['left', 'right'] as const;

const BOT_URL = '/claude_bot.glb';
// Across the ring from the camera at z = 0.55, facing +Z (toward the camera).
const BOT_POSITION = new THREE.Vector3(0, 0, -2.6);

/**
 * Glove offset from guard for a punch at progress `s` (0 = guard, 1 = full extension),
 * in a frame where +forward is toward the target, +up is up, and `out` points away
 * from the body's centre line on this glove's side.
 */
function punchOffset(type: AnyPunch, s: number, reach: number) {
  switch (type) {
    case 'hook':
      return { forward: reach * 0.8 * s, up: 0.04 * s, out: 0.35 * Math.sin(s * Math.PI) - 0.9 * s };
    case 'uppercut':
      return { forward: reach * 0.7 * s, up: -0.25 * Math.sin((1 - s) * Math.PI / 2) + 0.1 * s, out: -0.8 * s };
    case 'straight':
      return { forward: reach * s, up: 0.05 * s, out: -0.85 * s };
    default:
      return { forward: reach * 0.8 * s, up: 0.04 * s, out: -0.6 * s };
  }
}

/** `jab` (left straight) uses the jab slot; `straight` (right straight) uses the cross slot. Uppercut has no clip. */
function punchSlot(hand: Hand, type: AnyPunch): ClipSlot {
  if (type === 'hook') return hand === 'left' ? 'left_hook' : 'right_hook';
  if (type === 'straight' || (type === 'uppercut' && hand === 'right')) return 'cross';
  return 'jab';
}

/** Anatomical defence. Lean-back is not a contract action, so it stays on idle. */
function heldSlot(body: Body, left: Guard, right: Guard): HeldSlot | null {
  if (body === 'lean_left') return 'dodge_left';
  if (body === 'lean_right') return 'dodge_right';
  if (left === 'block' || right === 'block') return 'block';
  return null;
}

export class Boxer {
  readonly root = new THREE.Group();
  lateral = 0; // metres, smoothed toward targetLateral. Visual only.
  targetLateral = 0;

  private anim: BoxingAnimationController | null = null;
  private pose: { body: Body; left: Guard; right: Guard } = { body: 'neutral', left: 'neutral', right: 'neutral' };
  private flash: { body: Body; left: Guard; right: Guard; until: number } | null = null;
  private held: HeldSlot | null = null;
  private down = false;

  constructor() {
    this.root.position.copy(BOT_POSITION);
    void new GLTFLoader().loadAsync(BOT_URL).then(gltf => {
      gltf.scene.traverse(o => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      });
      this.anim = new BoxingAnimationController(gltf.scene, gltf.animations);
      this.anim.playIdle();
      this.root.add(gltf.scene);
      if (this.down) this.anim.playKo();
    }).catch(err => {
      console.error('claude_bot.glb failed to load', err);
    });
  }

  /** Server telegraph. Does not decide whether the punch lands. */
  throwPunch(hand: Hand, type: AnyPunch, _cueMs: number, _impactMs: number) {
    if (this.down) return;
    this.anim?.playPunch(punchSlot(hand, type));
  }

  /** Resolved landed hit. Visual only. */
  takeHit() {
    if (this.down) return;
    this.anim?.playHit();
  }

  setPose(body: Body, left: Guard, right: Guard) {
    this.pose = { body, left, right };
  }

  /** Briefly show a defence (the bot decides its defence at impact). */
  showDefense(body: Body, guard: string) {
    const left: Guard = guard === 'both' || guard === 'left' ? 'block' : 'neutral';
    const right: Guard = guard === 'both' || guard === 'right' ? 'block' : 'neutral';
    this.flash = { body, left, right, until: performance.now() + 450 };
  }

  /** Authoritative health reached zero. Plays KO once; no get-up until the next fight. */
  knockout() {
    if (this.down) return;
    this.down = true;
    this.flash = null;
    this.held = null;
    this.anim?.playKo();
  }

  /** A new fight started. Not a get-up during the knockout. */
  standUp() {
    if (!this.down) return;
    this.down = false;
    this.held = null;
    this.anim?.reset();
  }

  update(dt: number, _nowMs: number) {
    const t = performance.now();
    if (this.flash && t > this.flash.until) this.flash = null;

    this.lateral += (this.targetLateral - this.lateral) * Math.min(1, dt * 10);
    this.root.position.x = BOT_POSITION.x + this.lateral;

    if (!this.down) {
      const pose = this.flash ?? this.pose;
      const slot = heldSlot(pose.body, pose.left, pose.right);
      if (slot !== this.held) {
        this.held = slot;
        if (slot) this.anim?.playHeld(slot);
        else this.anim?.releaseHeld();
      }
    }
    this.anim?.update(dt);
  }
}

/** First-person gloves attached to the camera, driven by CV wrist markers. */
export class PlayerGloves {
  readonly root = new THREE.Group();
  private gloves: Record<Hand, THREE.Mesh>;
  private punchAt: Record<Hand, { t: number; type: AnyPunch }> = {
    left: { t: -Infinity, type: 'jab' },
    right: { t: -Infinity, type: 'jab' },
  };
  private guard: Record<Hand, Guard> = { left: 'neutral', right: 'neutral' };
  private target: Record<Hand, THREE.Vector3> = {
    left: new THREE.Vector3(-0.22, -0.2, -0.45),
    right: new THREE.Vector3(0.22, -0.2, -0.45),
  };
  visible: Record<Hand, boolean> = { left: true, right: true };

  constructor() {
    const mat = new THREE.MeshStandardMaterial({ color: 0xd63031, roughness: 0.35 });
    this.gloves = {
      left: new THREE.Mesh(new THREE.SphereGeometry(0.09, 20, 14), mat),
      right: new THREE.Mesh(new THREE.SphereGeometry(0.09, 20, 14), mat),
    };
    for (const hand of HANDS) {
      this.gloves[hand].scale.set(1, 1, 1.3);
      this.gloves[hand].position.copy(this.target[hand]);
      this.root.add(this.gloves[hand]);
    }
  }

  /** Map a mirrored-screen wrist marker into camera-local guard space. */
  setMarker(hand: Hand, marker: { x: number; y: number } | undefined) {
    this.visible[hand] = !!marker;
    if (!marker) return;
    const screenX = 1 - marker.x; // mirror for a selfie-style view, keep the hand label
    this.target[hand].set((screenX - 0.5) * 1.6, -0.2 + (0.5 - marker.y) * 0.5, -0.45);
  }

  setGuard(hand: Hand, guard: Guard) {
    this.guard[hand] = guard;
  }

  punch(hand: Hand, type: AnyPunch) {
    this.punchAt[hand] = { t: performance.now(), type };
  }

  update(dt: number) {
    const t = performance.now();
    for (const hand of HANDS) {
      const glove = this.gloves[hand];
      glove.visible = this.visible[hand];
      const outSign = hand === 'left' ? -1 : 1; // camera space: my left glove is -X
      const target =
        this.guard[hand] === 'block'
          ? new THREE.Vector3(outSign * 0.085, -0.04, -0.27)
          : this.target[hand].clone();

      const { t: at, type } = this.punchAt[hand];
      const p = (t - at) / 280;
      if (p >= 0 && p < 1) {
        const s = Math.sin(p * Math.PI);
        const o = punchOffset(type, s, 0.55);
        target.z -= o.forward;
        target.y += o.up * 0.8;
        target.x += outSign * o.out * Math.abs(this.target[hand].x);
      }
      glove.position.lerp(target, Math.min(1, dt * 30));
    }
  }
}
