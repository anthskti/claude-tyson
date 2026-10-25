import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { Body, Guard, PunchType } from '../cv/contract';
import { BoxingAnimationController, type ClipSlot, type HeldSlot } from './animation-controller';

// Gameplay uses the same animation controller for the bot and PvP boxer assets.
// First-person gloves stay primitive: there is no player body model.

export type Hand = 'left' | 'right';
export type AnyPunch = PunchType;
export type Corner = 'red' | 'blue';
export type BoxerLook = 'claude' | Corner;
const HANDS = ['left', 'right'] as const;

/** Slot 0 is the red corner, slot 1 the blue corner. */
export const cornerOf = (slot: number): Corner => (slot === 0 ? 'red' : 'blue');
export const CORNER_COLOR: Record<Corner, number> = { red: 0xd63031, blue: 0x2563eb };

const MODEL_URL: Record<BoxerLook, string> = {
  claude: '/claude_botv3.glb',
  red: '/red_boxer.glb',
  blue: '/blue_boxer.glb',
};
// Across the ring from the camera at z = 0.55, facing +Z (toward the camera).
const BOT_POSITION = new THREE.Vector3(0, 0, -2.6);
// Camera eye is at 1.62 m; the top of the head sits a little above the eyes.
const PLAYER_HEAD_TOP_M = 1.73;
// The PvE bot stands a little taller than the player, but not a giant.
const BOT_HEAD_TOP_M = 1.95;

const MODEL_ASSETS: Partial<Record<BoxerLook, Promise<GLTF>>> = {};
const loadModel = (look: BoxerLook) =>
  (MODEL_ASSETS[look] ??= new GLTFLoader().loadAsync(MODEL_URL[look]));
/** Glove offset from guard for a punch at progress `s` (0 = guard, 1 = full extension). */
function punchOffset(type: AnyPunch, s: number, reach: number) {
  switch (type) {
    case 'left_hook': case 'right_hook':
      return { forward: reach * 0.8 * s, up: 0.04 * s, out: 0.35 * Math.sin(s * Math.PI) - 0.9 * s };
    case 'left_straight': case 'right_straight':
      return { forward: reach * s, up: 0.05 * s, out: -0.85 * s };
  }
}
/** Straights keep the available jab/cross animation clips; action names stay anatomical. */
function punchSlot(hand: Hand, type: AnyPunch): ClipSlot {
  if (type.endsWith('_hook')) return hand === 'left' ? 'left_hook' : 'right_hook';
  return hand === 'left' ? 'jab' : 'cross';
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

  private look: BoxerLook | null = null;
  private loadVersion = 0;
  private model: THREE.Object3D | null = null;
  private headTop = 0; // model units, in the idle stance
  private base: THREE.Vector3;

  constructor(opts: { position?: THREE.Vector3; facing?: number } = {}) {
    this.base = (opts.position ?? BOT_POSITION).clone();
    this.root.position.copy(this.base);
    this.root.rotation.y = opts.facing ?? 0;
    this.setLook('claude');
  }

  setLook(look: BoxerLook) {
    if (look === this.look) return;
    this.look = look;
    const version = ++this.loadVersion;
    void loadModel(look).then(gltf => {
      if (version !== this.loadVersion) return;
      const model = cloneSkinned(gltf.scene);
      model.traverse(o => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      });
      if (this.model) this.root.remove(this.model);
      this.anim = new BoxingAnimationController(model, gltf.animations);
      this.anim.playIdle();
      // Measure in the settled idle stance, not the bind pose, so eye level matches in play.
      this.anim.update(1);
      model.updateMatrixWorld(true);
      this.headTop = new THREE.Box3().setFromObject(model, true).max.y;
      this.model = model;
      this.root.add(model);
      const scale = this.headTop > 0 ? (look === 'claude' ? BOT_HEAD_TOP_M : PLAYER_HEAD_TOP_M) / this.headTop : 1;
      model.scale.setScalar(scale);
      if (this.down) this.anim.playKo();
    }).catch(err => {
      if (version === this.loadVersion) console.error(`${MODEL_URL[look]} failed to load`, err);
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
    this.root.position.x = this.base.x + this.lateral;

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
    left: { t: -Infinity, type: 'left_straight' },
    right: { t: -Infinity, type: 'right_straight' },
  };
  private guard: Record<Hand, Guard> = { left: 'neutral', right: 'neutral' };
  private material = new THREE.MeshStandardMaterial({ color: CORNER_COLOR.red, roughness: 0.35 });
  private target: Record<Hand, THREE.Vector3> = {
    left: new THREE.Vector3(-0.22, -0.2, -0.45),
    right: new THREE.Vector3(0.22, -0.2, -0.45),
  };
  visible: Record<Hand, boolean> = { left: true, right: true };

  constructor() {
    this.gloves = {
      left: new THREE.Mesh(new THREE.SphereGeometry(0.09, 20, 14), this.material),
      right: new THREE.Mesh(new THREE.SphereGeometry(0.09, 20, 14), this.material),
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

  setCorner(corner: Corner) {
    this.material.color.setHex(CORNER_COLOR[corner]);
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
