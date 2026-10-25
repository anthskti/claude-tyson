// Maharagas Wheel — 3D Three.js object above Claude Tyson.
// Spins slowly face-on; clanks 45° each time the strategist applies an update.
// Named after Mahoraga (JJK) whose wheel adapts to every technique.

import * as THREE from "three";

// Sits directly above Claude Tyson at BOT_POSITION z = -2.6
const WHEEL_POS = new THREE.Vector3(0, 3.2, -2.6);

const SPOKE_COUNT = 8;
const OUTER_RADIUS = 0.52;
const TOOTH_COUNT = 16;
const CLANK_RADS = Math.PI / 4; // 45° per adaptation
const CLANK_SPEED = 14;         // lerp factor for snap rotation
const IDLE_ROT_SPEED = 0.18;    // rad/s constant slow face-on spin

// Mahoraga-accurate palette: dark ring, gold spokes, white hub
const COL_RING   = 0x1a1a1a;
const COL_SPOKE  = 0xc8960c;
const COL_TOOTH  = 0x888888;
const COL_CENTER = 0xffffff;
const EMI_RING   = 0x000000;
const EMI_SPOKE  = 0x7a5800;
const EMI_TOOTH  = 0x333333;
const EMI_CENTER = 0xddbb55;

function ringMat(color: number, emissive: number, intensity = 1.0) {
  return new THREE.MeshStandardMaterial({ color, emissive, emissiveIntensity: intensity, roughness: 0.4, metalness: 0.9 });
}

export class MahoragasWheel {
  readonly group: THREE.Group;

  private outerRing: THREE.Mesh;
  private innerDisc: THREE.Mesh;
  private spokes: THREE.Mesh[] = [];
  private teeth: THREE.Mesh[] = [];

  // targetRotZ accumulates idle + clank offsets; group.rotation.z lerps toward it
  private targetRotZ = 0;
  private clanksApplied = 0;

  private pulseT = 0;
  private pulsing = false;

  private audioCtx: AudioContext | null = null;

  constructor() {
    this.group = new THREE.Group();
    this.group.position.copy(WHEEL_POS);
    this.group.visible = false;

    // ── Outer torus ring ───────────────────────────────────────────────────
    const torusGeo = new THREE.TorusGeometry(OUTER_RADIUS, 0.04, 10, 48);
    this.outerRing = new THREE.Mesh(torusGeo, ringMat(COL_RING, EMI_RING, 0.0));
    this.group.add(this.outerRing);

    // ── Spokes ────────────────────────────────────────────────────────────
    for (let i = 0; i < SPOKE_COUNT; i++) {
      const angle = (i / SPOKE_COUNT) * Math.PI * 2;
      const geo = new THREE.BoxGeometry(0.03, OUTER_RADIUS * 1.8, 0.03);
      const spoke = new THREE.Mesh(geo, ringMat(COL_SPOKE, EMI_SPOKE, 1.2));
      spoke.rotation.z = angle;
      this.spokes.push(spoke);
      this.group.add(spoke);
    }

    // ── Center hub ────────────────────────────────────────────────────────
    this.innerDisc = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.08, 0.05, 16),
      ringMat(COL_CENTER, EMI_CENTER, 2.5)
    );
    this.innerDisc.rotation.x = Math.PI / 2;
    this.group.add(this.innerDisc);

    // ── Teeth around outer ring ───────────────────────────────────────────
    for (let i = 0; i < TOOTH_COUNT; i++) {
      const angle = (i / TOOTH_COUNT) * Math.PI * 2;
      const tooth = new THREE.Mesh(
        new THREE.BoxGeometry(0.05, 0.11, 0.05),
        ringMat(COL_TOOTH, EMI_TOOTH, 0.8)
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

    // ── Point light — warm gold glow ──────────────────────────────────────
    const glow = new THREE.PointLight(0xd4a017, 2.5, 4.0, 2);
    glow.position.set(0, 0, 0);
    this.group.add(glow);
  }

  show() { this.group.visible = true; }
  hide() { this.group.visible = false; }

  get totalClanks() { return this.clanksApplied; }

  /** Call when a strategy update is applied. Snaps the wheel 45° and plays a clank. */
  clank() {
    this.clanksApplied++;
    this.targetRotZ += CLANK_RADS;
    this.pulseT = 0;
    this.pulsing = true;
    this.playClank();
  }

  update(dt: number) {
    if (!this.group.visible) return;

    // ── Idle face-on spin (Z axis = spinning like a compass rose) ─────────
    // Keep targetRotZ in sync so clank snaps are additive on top of idle spin.
    this.targetRotZ += IDLE_ROT_SPEED * dt;

    // ── Lerp group rotation toward target (handles both idle and clank) ───
    const diff = this.targetRotZ - this.group.rotation.z;
    this.group.rotation.z += diff * Math.min(1, CLANK_SPEED * dt);

    // ── Pulse: emissive flare on clank ────────────────────────────────────
    if (this.pulsing) {
      this.pulseT += dt;
      const flash = Math.max(0, 1 - this.pulseT * 2.5);
      const intensity = 1.0 + flash * 4.0;
      (this.outerRing.material as THREE.MeshStandardMaterial).emissiveIntensity = flash * 2.0;
      (this.outerRing.material as THREE.MeshStandardMaterial).emissive.setHex(flash > 0 ? 0xd4a017 : 0x000000);
      (this.innerDisc.material as THREE.MeshStandardMaterial).emissiveIntensity = 2.5 + flash * 3.0;
      const glowLight = this.group.children.find(c => c instanceof THREE.PointLight) as THREE.PointLight | undefined;
      if (glowLight) glowLight.intensity = 2.5 + flash * 8.0;
      if (this.pulseT > 1.2) this.pulsing = false;
    } else {
      // Gentle ambient gold shimmer
      const shimmer = 0.3 + Math.sin(performance.now() / 1100) * 0.15;
      for (const spoke of this.spokes) {
        (spoke.material as THREE.MeshStandardMaterial).emissiveIntensity = shimmer + 0.9;
      }
    }
  }

  private playClank() {
    try {
      if (!this.audioCtx) this.audioCtx = new AudioContext();
      const ctx = this.audioCtx;
      // Metallic clank: short noise burst filtered to mid-high freq
      const bufLen = Math.floor(ctx.sampleRate * 0.18);
      const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < bufLen; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufLen * 0.12));
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;

      // Band-pass around 1.5kHz for metallic ring
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1500;
      bp.Q.value = 4;

      const gain = ctx.createGain();
      gain.gain.value = 0.55;

      src.connect(bp);
      bp.connect(gain);
      gain.connect(ctx.destination);
      src.start();
    } catch {
      // AudioContext blocked (no user gesture yet) — silent fail
    }
  }
}
