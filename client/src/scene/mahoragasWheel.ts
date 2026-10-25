// Maharagas Wheel — 3D Three.js object above Claude Tyson.
// Spins slowly at rest; clanks 45° each time the strategist applies an update.
// Named after Mahoraga (JJK) whose wheel adapts to every technique.

import * as THREE from "three";

// Sits directly above Claude Tyson at BOT_POSITION z = -2.6
const WHEEL_POS = new THREE.Vector3(0, 3.2, -2.6);

const SPOKE_COUNT = 8;
const OUTER_RADIUS = 0.52;
const TOOTH_COUNT = 16;
const CLANK_RADS = Math.PI / 4; // 45° per adaptation
const CLANK_SPEED = 14;         // lerp factor for snap rotation
const IDLE_ROT_SPEED = 0.25;    // rad/s constant slow spin

// Neon purple / indigo palette
const COL_RING   = 0x9b00ff;
const COL_SPOKE  = 0x6a00ee;
const COL_TOOTH  = 0xcc44ff;
const COL_CENTER = 0xffffff;
const EMI_RING   = 0x5500aa;
const EMI_SPOKE  = 0x3300aa;
const EMI_TOOTH  = 0x880099;
const EMI_CENTER = 0x8800ff;

function ringMat(color: number, emissive: number, intensity = 1.2) {
  return new THREE.MeshStandardMaterial({ color, emissive, emissiveIntensity: intensity, roughness: 0.3, metalness: 0.7 });
}

export class MahoragasWheel {
  readonly group: THREE.Group;

  private outerRing: THREE.Mesh;
  private innerDisc: THREE.Mesh;
  private spokes: THREE.Mesh[] = [];
  private teeth: THREE.Mesh[] = [];

  private targetRotZ = 0;
  private clanksApplied = 0;

  // Pulse state
  private pulseT = 0;
  private pulsing = false;

  constructor() {
    this.group = new THREE.Group();
    this.group.position.copy(WHEEL_POS);
    this.group.visible = false;

    // ── Outer torus ring ───────────────────────────────────────────────────
    const torusGeo = new THREE.TorusGeometry(OUTER_RADIUS, 0.04, 10, 48);
    this.outerRing = new THREE.Mesh(torusGeo, ringMat(COL_RING, EMI_RING, 1.5));
    this.group.add(this.outerRing);

    // ── Spokes ────────────────────────────────────────────────────────────
    for (let i = 0; i < SPOKE_COUNT; i++) {
      const angle = (i / SPOKE_COUNT) * Math.PI * 2;
      const geo = new THREE.BoxGeometry(0.03, OUTER_RADIUS * 1.8, 0.03);
      const spoke = new THREE.Mesh(geo, ringMat(COL_SPOKE, EMI_SPOKE, 1.0));
      spoke.rotation.z = angle;
      this.spokes.push(spoke);
      this.group.add(spoke);
    }

    // ── Center hub ────────────────────────────────────────────────────────
    this.innerDisc = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.08, 0.05, 16),
      ringMat(COL_CENTER, EMI_CENTER, 2.0)
    );
    this.innerDisc.rotation.x = Math.PI / 2;
    this.group.add(this.innerDisc);

    // ── Teeth around outer ring ───────────────────────────────────────────
    for (let i = 0; i < TOOTH_COUNT; i++) {
      const angle = (i / TOOTH_COUNT) * Math.PI * 2;
      const tooth = new THREE.Mesh(
        new THREE.BoxGeometry(0.05, 0.11, 0.05),
        ringMat(COL_TOOTH, EMI_TOOTH, 1.2)
      );
      tooth.position.set(
        Math.cos(angle) * OUTER_RADIUS,
        Math.sin(angle) * OUTER_RADIUS,
        0
      );
      tooth.rotation.z = angle;
      this.teeth.push(tooth);
      this.group.add(tooth);
    }

    // ── Point light for glow ──────────────────────────────────────────────
    const glow = new THREE.PointLight(0x8800ff, 3, 4.5, 2);
    glow.position.set(0, 0, 0);
    this.group.add(glow);
  }

  show() { this.group.visible = true; }
  hide() { this.group.visible = false; }

  get totalClanks() { return this.clanksApplied; }

  /** Call when a strategy update is applied. Returns immediately; animation runs in update(). */
  clank() {
    this.clanksApplied++;
    this.targetRotZ += CLANK_RADS;
    this.pulseT = 0;
    this.pulsing = true;
  }

  update(dt: number) {
    if (!this.group.visible) return;

    // ── Idle slow rotation (Y axis = face-on to camera-ish) ──────────────
    this.group.rotation.y += IDLE_ROT_SPEED * dt;

    // ── Clank: snap Z rotation toward target ──────────────────────────────
    const diff = this.targetRotZ - this.group.rotation.z;
    if (Math.abs(diff) > 0.001) {
      this.group.rotation.z += diff * Math.min(1, CLANK_SPEED * dt);
    }

    // ── Pulse: emissive flare on clank ────────────────────────────────────
    if (this.pulsing) {
      this.pulseT += dt;
      const intensity = 1.5 + Math.max(0, 1 - this.pulseT * 3) * 3.0;
      (this.outerRing.material as THREE.MeshStandardMaterial).emissiveIntensity = intensity;
      (this.innerDisc.material as THREE.MeshStandardMaterial).emissiveIntensity = intensity * 1.3;
      if (this.pulseT > 1.5) this.pulsing = false;
    } else {
      // Gentle ambient pulse
      const base = 1.2 + Math.sin(performance.now() / 900) * 0.3;
      (this.outerRing.material as THREE.MeshStandardMaterial).emissiveIntensity = base;
    }
  }
}
