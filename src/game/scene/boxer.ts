import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { Body, Guard, PunchType } from '../cv/contract';
import { BoxingAnimationController, type ClipSlot, type HeldSlot } from './animation-controller';

// The opponent is claude_bot.glb. Gameplay still calls the same methods; the
// controller maps them onto contract clip names and no-ops until the file loads.
// First-person gloves stay primitive: there is no player body model.
//
// PvE shows the Claude-themed bot as authored. PvP reuses the same rig and clips as a
// human-sized fighter in their corner colour: the orange in its textures is recoloured,
// the Claude logo is hidden, and it's scaled so both players are eye to eye.
//
// Every boxer in the arena clones one load of the file, and boxers in the same corner
// share recoloured materials, so twelve fighters cost one download and two recolours.

export type Hand = 'left' | 'right';
export type AnyPunch = PunchType;
export type Corner = 'red' | 'blue';
export type BoxerLook = 'claude' | Corner;
const HANDS = ['left', 'right'] as const;

/** Slot 0 is the red corner, slot 1 the blue corner. */
export const cornerOf = (slot: number): Corner => (slot === 0 ? 'red' : 'blue');
export const CORNER_COLOR: Record<Corner, number> = { red: 0xd63031, blue: 0x2563eb };

const BOT_URL = '/claude_bot.glb';
const LOGO_MESH = 'path147.001';
// Across the ring from the camera at z = 0.55, facing +Z (toward the camera).
const BOT_POSITION = new THREE.Vector3(0, 0, -2.6);
// Camera eye is at 1.62 m; the top of the head sits a little above the eyes.
const PLAYER_HEAD_TOP_M = 1.73;
// The PvE bot stands a little taller than the player, but not a giant.
const BOT_HEAD_TOP_M = 1.95;

let botAsset: Promise<GLTF> | undefined;
const loadBot = () => (botAsset ??= new GLTFLoader().loadAsync(BOT_URL));
const VARIANTS: Partial<Record<Corner, Map<THREE.Material, THREE.Material>>> = {};

/** Copy of `tex` with its saturated orange pixels moved to `color`'s hue, keeping shading. */
function recolorOrange(tex: THREE.Texture, color: number): THREE.Texture {
  const img = tex.image as CanvasImageSource & { width: number; height: number };
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const target = { h: 0, s: 0, l: 0 };
  new THREE.Color(color).getHSL(target);
  const c = new THREE.Color();
  const hsl = { h: 0, s: 0, l: 0 };
  const rgb = { r: 0, g: 0, b: 0 };
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    const max = Math.max(px[i], px[i + 1], px[i + 2]);
    const min = Math.min(px[i], px[i + 1], px[i + 2]);
    // Red/orange paint (trunks, hair, shoes, gloves). Skin shares the hue but its
    // HSV saturation is ~0.25 against ≥0.65 for paint.
    if (max < 40 || (max - min) / max < 0.5) continue;
    c.setRGB(px[i] / 255, px[i + 1] / 255, px[i + 2] / 255, THREE.SRGBColorSpace);
    c.getHSL(hsl, THREE.SRGBColorSpace);
    if (hsl.h > 0.13 && hsl.h < 0.95) continue;
    c.setHSL(target.h, Math.max(hsl.s * 0.85, target.s * 0.8), hsl.l * 0.9, THREE.SRGBColorSpace);
    c.getRGB(rgb, THREE.SRGBColorSpace);
    px[i] = Math.round(rgb.r * 255);
    px[i + 1] = Math.round(rgb.g * 255);
    px[i + 2] = Math.round(rgb.b * 255);
  }
  ctx.putImageData(data, 0, 0);
  const out = new THREE.CanvasTexture(canvas);
  out.flipY = tex.flipY;
  out.colorSpace = tex.colorSpace;
  out.wrapS = tex.wrapS;
  out.wrapT = tex.wrapT;
  out.magFilter = tex.magFilter;
  out.minFilter = tex.minFilter;
  return out;
}

/** Same material with every texture slot that holds paint recoloured. */
function recolorMaterial(mat: THREE.Material, color: number): THREE.Material {
  const m = mat.clone() as THREE.MeshStandardMaterial;
  if (m.map) m.map = recolorOrange(m.map, color);
  if (m.emissiveMap) m.emissiveMap = recolorOrange(m.emissiveMap, color);
  return m;
}

/**
 * Glove offset from guard for a punch at progress `s` (0 = guard, 1 = full extension),
 * in a frame where +forward is toward the target, +up is up, and `out` points away
 * from the body's centre line on this glove's side.
 */
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

  private look: BoxerLook = 'claude';
  private model: THREE.Object3D | null = null;
  private headTop = 0; // model units, in the idle stance
  private meshes: { mesh: THREE.Mesh; original: THREE.Material | THREE.Material[] }[] = [];
  private base: THREE.Vector3;

  /** Defaults to the first-person opponent: across the ring, facing the camera (+Z). */
  constructor(opts: { position?: THREE.Vector3; facing?: number } = {}) {
    this.base = (opts.position ?? BOT_POSITION).clone();
    this.root.position.copy(this.base);
    this.root.rotation.y = opts.facing ?? 0;
    void loadBot().then(gltf => {
      const model = cloneSkinned(gltf.scene);
      model.traverse(o => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.meshes.push({ mesh, original: mesh.material });
      });
      this.anim = new BoxingAnimationController(model, gltf.animations);
      this.anim.playIdle();
      // Measure in the settled idle stance, not the bind pose, so eye level matches in play.
      this.anim.update(1);
      model.updateMatrixWorld(true);
      this.headTop = new THREE.Box3().setFromObject(model, true).max.y;
      this.model = model;
      this.root.add(model);
      this.applyLook();
      if (this.down) this.anim.playKo();
    }).catch(err => {
      console.error('claude_bot.glb failed to load', err);
    });
  }

  /** 'claude' for PvE; a corner colour for a human opponent in PvP. */
  setLook(look: BoxerLook) {
    if (look === this.look) return;
    this.look = look;
    this.applyLook();
  }

  private applyLook() {
    if (!this.model) return;
    const corner = this.look === 'claude' ? null : this.look;
    const variants = corner ? (VARIANTS[corner] ??= new Map()) : null;
    for (const { mesh, original } of this.meshes) {
      mesh.visible = !corner || mesh.name !== LOGO_MESH;
      if (!variants) {
        mesh.material = original;
        continue;
      }
      const swap = (m: THREE.Material) => {
        let v = variants.get(m);
        if (!v) variants.set(m, (v = recolorMaterial(m, CORNER_COLOR[corner!])));
        return v;
      };
      mesh.material = Array.isArray(original) ? original.map(swap) : swap(original);
    }
    const scale = this.headTop > 0 ? (corner ? PLAYER_HEAD_TOP_M : BOT_HEAD_TOP_M) / this.headTop : 1;
    this.model.scale.setScalar(scale);
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
    const mat = this.material;
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
