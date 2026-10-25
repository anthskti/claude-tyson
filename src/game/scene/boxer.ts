import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { Body, Guard, PunchType } from '../cv/contract';
import { BoxingAnimationController, type ClipSlot, type HeldSlot } from './animation-controller';
import { GloveAnimation } from './glove-animation';

// Gameplay uses the same animation controller for the bot and PvP boxer assets.
// First-person gloves use separate camera-space models and transform animation.

export type Hand = 'left' | 'right';
export type AnyPunch = PunchType;
export type Corner = 'red' | 'blue';
export type BoxerLook = 'claude' | Corner;
const HANDS = ['left', 'right'] as const;

/** Slot 0 is the red corner, slot 1 the blue corner. */
export const cornerOf = (slot: number): Corner => (slot === 0 ? 'red' : 'blue');

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
  private gloves: Record<Hand, THREE.Group> = { left: new THREE.Group(), right: new THREE.Group() };
  private motions: Record<Hand, THREE.Group> = { left: new THREE.Group(), right: new THREE.Group() };
  private animations: Record<Hand, GloveAnimation>;
  private guard: Record<Hand, Guard> = { left: 'neutral', right: 'neutral' };
  private target: Record<Hand, THREE.Vector3> = {
    left: new THREE.Vector3(-0.22, -0.2, -0.45),
    right: new THREE.Vector3(0.22, -0.2, -0.45),
  };
  visible: Record<Hand, boolean> = { left: true, right: true };

  constructor() {
    this.animations = {
      left: new GloveAnimation(this.motions.left, 'left'),
      right: new GloveAnimation(this.motions.right, 'right'),
    };
    for (const hand of HANDS) {
      this.gloves[hand].position.copy(this.target[hand]);
      this.gloves[hand].add(this.motions[hand]);
      this.root.add(this.gloves[hand]);
    }
    void this.loadModels();
  }

  private async loadModels() {
    const loader = new GLTFLoader();
    const loaded = await Promise.all(HANDS.map(async hand => {
      try {
        return (await loader.loadAsync(`/${hand}_glove.glb`)).scene;
      } catch (error) {
        console.error(`/${hand}_glove.glb failed to load`, error);
        return null;
      }
    }));
    const assets: Partial<Record<Hand, THREE.Object3D>> = {};
    HANDS.forEach((hand, i) => { assets[hand] = loaded[i] ?? undefined; });
    const hasMesh = (model: THREE.Object3D | undefined): model is THREE.Object3D => {
      let found = false;
      model?.traverse(object => { if ((object as THREE.Mesh).isMesh) found = true; });
      return found;
    };

    for (const hand of HANDS) {
      let sourceHand: Hand | undefined = hasMesh(assets[hand]) ? hand : undefined;
      if (!sourceHand) sourceHand = HANDS.find(candidate => hasMesh(assets[candidate]));
      if (!sourceHand) {
        console.error('No usable first-person glove model was found');
        continue;
      }
      if (sourceHand !== hand) console.warn(`/${hand}_glove.glb has no mesh; mirroring /${sourceHand}_glove.glb instead`);

      const model = cloneSkinned(assets[sourceHand]!);
      model.rotation.x = -Math.PI / 2; // orient the glove toward the opponent (-Z)
      model.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(model);
      const center = bounds.getCenter(new THREE.Vector3());
      const size = bounds.getSize(new THREE.Vector3());
      const maxDimension = Math.max(size.x, size.y, size.z);
      if (!Number.isFinite(maxDimension) || maxDimension <= 0) continue;
      const scale = 0.34 / maxDimension;
      const mirror = sourceHand === hand ? 1 : -1;
      model.scale.set(scale * mirror, scale, scale);
      model.position.set(-center.x * scale * mirror, -center.y * scale, -center.z * scale);
      model.traverse(object => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        const copies = materials.map(material => {
          return material.clone();
        });
        mesh.material = Array.isArray(mesh.material) ? copies : copies[0]!;
      });
      this.motions[hand].add(model);
    }
  }

  /** Map a mirrored-screen wrist marker into camera-local guard space. */
  setMarker(hand: Hand, marker: { x: number; y: number } | undefined) {
    this.visible[hand] = !!marker;
    if (!marker) return;
    const screenX = 1 - marker.x; // mirrored preview, anatomical label is unchanged
    const expectedX = hand === 'left' ? 0.46 : 0.54;
    const baseX = hand === 'left' ? -0.22 : 0.22;
    this.target[hand].set(
      baseX + THREE.MathUtils.clamp((screenX - expectedX) * 0.45, -0.055, 0.055),
      -0.2 + THREE.MathUtils.clamp((0.5 - marker.y) * 0.12, -0.045, 0.045),
      -0.45,
    );
  }

  setGuard(hand: Hand, guard: Guard) {
    if (this.guard[hand] !== guard) this.animations[hand].setBlock(guard === 'block');
    this.guard[hand] = guard;
  }

  punch(hand: Hand, type: AnyPunch) {
    this.animations[hand].punch(type);
  }

  update(dt: number) {
    for (const hand of HANDS) {
      const anchor = this.gloves[hand];
      anchor.visible = this.visible[hand];
      const target =
        this.guard[hand] === 'block'
          ? new THREE.Vector3(hand === 'left' ? -0.085 : 0.085, -0.04, -0.27)
          : this.target[hand].clone();
      anchor.position.lerp(target, Math.min(1, dt * 30));
      this.animations[hand].update(dt);
    }
  }
}
