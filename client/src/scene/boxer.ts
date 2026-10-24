import * as THREE from 'three';
import type { Body, Guard, PunchType } from '../cv/contract';

// Low-poly stand-in fighters. Animation is driven by plain state (punch timing, body
// state, guards) so a rigged Blender model can replace the meshes later without
// touching game logic.

export type Hand = 'left' | 'right';
export type AnyPunch = PunchType | 'unclassified';
const HANDS = ['left', 'right'] as const;

/**
 * Glove offset from guard for a punch at progress `s` (0 = guard, 1 = full extension),
 * in a frame where +forward is toward the target, +up is up, and `out` points away
 * from the body's centre line on this glove's side.
 */
function punchOffset(type: AnyPunch, s: number, reach: number) {
  switch (type) {
    case 'hook': // swings in from the side on a flat arc
      return { forward: reach * 0.8 * s, up: 0.04 * s, out: 0.35 * Math.sin(s * Math.PI) - 0.9 * s };
    case 'uppercut': // drops, then drives up the middle
      return { forward: reach * 0.7 * s, up: -0.25 * Math.sin((1 - s) * Math.PI / 2) + 0.1 * s, out: -0.8 * s };
    case 'straight':
      return { forward: reach * s, up: 0.05 * s, out: -0.85 * s };
    default: // jab
      return { forward: reach * 0.8 * s, up: 0.04 * s, out: -0.6 * s };
  }
}

/** Wind-up pose: where the glove loads before the strike. This is the telegraph. */
function windupOffset(type: AnyPunch, p: number) {
  switch (type) {
    case 'hook':
      return { forward: -0.1 * p, up: 0, out: 0.35 * p };
    case 'uppercut':
      return { forward: -0.05 * p, up: -0.3 * p, out: 0 };
    case 'straight':
      return { forward: -0.15 * p, up: -0.02 * p, out: 0.05 * p };
    default:
      return { forward: -0.06 * p, up: 0, out: 0 };
  }
}

const WINDUP_FRACTION = 0.6; // share of cue→impact spent loading; the rest is the strike
const RETRACT_MS = 220;

export class Boxer {
  readonly root = new THREE.Group();
  private body = new THREE.Group(); // leans/slips
  private torso: THREE.Mesh;
  private head: THREE.Mesh;
  private gloves: Record<Hand, THREE.Mesh>;
  private guardPos: Record<Hand, THREE.Vector3>;
  private blockPos: Record<Hand, THREE.Vector3>;
  private skin: THREE.MeshStandardMaterial;

  private swing: { hand: Hand; type: AnyPunch; cueMs: number; impactMs: number } | null = null;
  private hitAt = -Infinity;
  // Persistent pose (PvP opponent) and a short-lived override (bot defence reveal).
  private pose: { body: Body; left: Guard; right: Guard } = { body: 'neutral', left: 'neutral', right: 'neutral' };
  private flash: { body: Body; left: Guard; right: Guard; until: number } | null = null;
  lateral = 0; // metres, smoothed toward targetLateral
  targetLateral = 0;

  constructor(trunkColor: number) {
    this.skin = new THREE.MeshStandardMaterial({ color: 0xc68e6a, roughness: 0.7 });
    const trunks = new THREE.MeshStandardMaterial({ color: trunkColor, roughness: 0.6 });
    const gloveMat = new THREE.MeshStandardMaterial({ color: trunkColor, roughness: 0.35 });

    const legs = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.16, 0.9, 12), trunks);
    legs.position.y = 0.45;
    this.torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.24, 0.45, 6, 16), this.skin);
    this.torso.position.y = 0.3;
    this.head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 24, 16), this.skin);
    this.head.position.y = 0.78;
    // Upper body pivots at the hips so leans look like leans.
    this.body.position.y = 0.9;

    // Facing +Z (toward the camera). Their left glove is on our right (+X).
    this.guardPos = { left: new THREE.Vector3(0.2, 0.55, 0.28), right: new THREE.Vector3(-0.2, 0.55, 0.28) };
    this.blockPos = { left: new THREE.Vector3(0.1, 0.76, 0.22), right: new THREE.Vector3(-0.1, 0.76, 0.22) };
    this.gloves = {
      left: new THREE.Mesh(new THREE.SphereGeometry(0.11, 20, 14), gloveMat),
      right: new THREE.Mesh(new THREE.SphereGeometry(0.11, 20, 14), gloveMat),
    };
    for (const hand of HANDS) this.gloves[hand].position.copy(this.guardPos[hand]);

    this.body.add(this.torso, this.head, this.gloves.left, this.gloves.right);
    this.root.add(legs, this.body);
    for (const m of [legs, this.torso, this.head, this.gloves.left, this.gloves.right]) m.castShadow = true;
  }

  /** Telegraphed punch whose glove arrives exactly at impactMs (wall-clock ms). */
  throwPunch(hand: Hand, type: AnyPunch, cueMs: number, impactMs: number) {
    this.swing = { hand, type, cueMs, impactMs };
  }

  takeHit() {
    this.hitAt = performance.now();
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

  update(dt: number, nowMs: number) {
    const t = performance.now();
    if (this.flash && t > this.flash.until) this.flash = null;
    const pose = this.flash ?? this.pose;
    const k = Math.min(1, dt * 14);

    this.lateral += (this.targetLateral - this.lateral) * Math.min(1, dt * 10);
    this.root.position.x = this.lateral;
    this.root.position.y = Math.sin(t / 260) * 0.02;

    // Body lean. Their left is our +X.
    const slip = pose.body === 'lean_left' ? 1 : pose.body === 'lean_right' ? -1 : 0;
    const back = pose.body === 'lean_back' ? 1 : 0;
    this.body.rotation.z += (-slip * 0.35 - this.body.rotation.z) * k;
    this.body.rotation.x += (-back * 0.4 - this.body.rotation.x) * k;
    this.body.position.x += (slip * 0.12 - this.body.position.x) * k;

    // Hit reaction: head snaps back, skin flashes red.
    const hit = Math.max(0, 1 - (t - this.hitAt) / 300);
    this.head.position.z = -hit * 0.12;
    this.torso.rotation.x = -hit * 0.15;
    this.skin.emissive.setRGB(hit * 0.6, 0, 0);

    for (const hand of HANDS) {
      const outSign = hand === 'left' ? 1 : -1; // their left glove's "out" is +X
      const base = (hand === 'left' ? pose.left : pose.right) === 'block' ? this.blockPos[hand] : this.guardPos[hand];
      const target = base.clone();
      if (this.swing?.hand === hand) {
        const { type, cueMs, impactMs } = this.swing;
        const total = Math.max(1, impactMs - cueMs);
        const p = (nowMs - cueMs) / total;
        let o = { forward: 0, up: 0, out: 0 };
        if (p < WINDUP_FRACTION) {
          o = windupOffset(type, Math.max(0, p) / WINDUP_FRACTION);
        } else if (nowMs <= impactMs) {
          const s = (p - WINDUP_FRACTION) / (1 - WINDUP_FRACTION);
          const w = windupOffset(type, 1 - s);
          const strike = punchOffset(type, s, 0.8);
          o = { forward: w.forward + strike.forward, up: w.up + strike.up, out: w.out + strike.out };
        } else if (nowMs - impactMs < RETRACT_MS) {
          o = punchOffset(type, 1 - (nowMs - impactMs) / RETRACT_MS, 0.8);
        } else {
          this.swing = null;
        }
        target.z += o.forward;
        target.y += o.up;
        target.x += outSign * o.out * Math.abs(base.x) * 1.0;
      }
      this.gloves[hand].position.lerp(target, Math.min(1, dt * 25));
    }
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
          ? new THREE.Vector3(outSign * 0.085, -0.04, -0.27) // gloves up in front of the face
          : this.target[hand].clone();

      const { t: at, type } = this.punchAt[hand];
      const p = (t - at) / 280;
      if (p >= 0 && p < 1) {
        const s = Math.sin(p * Math.PI); // out and back
        const o = punchOffset(type, s, 0.55);
        target.z -= o.forward;
        target.y += o.up * 0.8;
        target.x += outSign * o.out * Math.abs(this.target[hand].x);
      }
      glove.position.lerp(target, Math.min(1, dt * 30));
    }
  }
}
