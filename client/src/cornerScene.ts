// Post-fight corner scene.
// After the match ends, the camera lerps to the player's corner showing:
//   - A crowd of silhouette figures behind the ring
//   - A glowing Claude placeholder model (box with "CLAUDE" label)
//   - A mini-Claude analysis overlay

import * as THREE from "three";
import type { DbConnection } from "./module_bindings";
import type { AnalysisRequest, FightWindowSummary } from "../../coach/analysis";

// ── Ring geometry reference (matches ring.ts) ────────────────────────────
const RING_HALF = 3; // 6 m ring

// ── Camera target: player's ringside corner, looking diagonally across ──
const CORNER_CAM_POS = new THREE.Vector3(4.5, 1.7, 4.5);
const CORNER_CAM_LOOK = new THREE.Vector3(-0.5, 1.4, -1.5);

// ── Claude placeholder: outside the near-right (blue) ring corner ────────
const CLAUDE_PLACEHOLDER_POS = new THREE.Vector3(3.6, 0.0, 3.6);

// Crowd layout: rows behind and to the sides of the ring
const CROWD_CONFIGS: { x: number; z: number; h: number; col: number }[] = [];
(function buildCrowd() {
  const colors = [0x2233aa, 0xaa2222, 0x229933, 0x886600, 0x553399, 0x116677];
  const rng = mulberry32(0xdeadbeef);
  // Far end (behind opponent corner, z < -RING_HALF-0.5)
  for (let row = 0; row < 4; row++) {
    const z = -(RING_HALF + 1.5 + row * 0.9);
    for (let col = -6; col <= 6; col++) {
      CROWD_CONFIGS.push({ x: col * 0.95 + (rng() - 0.5) * 0.4, z, h: 0.8 + rng() * 0.5, col: colors[Math.floor(rng() * colors.length)] });
    }
  }
  // Left side (x < -RING_HALF-0.5)
  for (let row = 0; row < 3; row++) {
    const x = -(RING_HALF + 1.5 + row * 0.9);
    for (let zi = -4; zi <= 4; zi++) {
      CROWD_CONFIGS.push({ x, z: zi * 0.95 + (rng() - 0.5) * 0.4, h: 0.8 + rng() * 0.5, col: colors[Math.floor(rng() * colors.length)] });
    }
  }
  // Right side
  for (let row = 0; row < 3; row++) {
    const x = (RING_HALF + 1.5 + row * 0.9);
    for (let zi = -4; zi <= 4; zi++) {
      CROWD_CONFIGS.push({ x, z: zi * 0.95 + (rng() - 0.5) * 0.4, h: 0.8 + rng() * 0.5, col: colors[Math.floor(rng() * colors.length)] });
    }
  }
})();

function mulberry32(seed: number) {
  let s = seed;
  return () => { s += 0x6D2B79F5; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export interface CornerSceneOptions {
  scene: THREE.Scene;
  camera: THREE.Camera;
  analysisUrl?: string; // default "/api/analysis"
  fetchImpl?: typeof fetch;
  onAnalysis?: (text: string, source: "claude" | "offline") => void;
}

export class CornerScene {
  private scene: THREE.Scene;
  private camera: THREE.Camera;
  private opts: CornerSceneOptions;

  // Three.js objects (added to scene, hidden by default)
  private crowdGroup: THREE.Group;
  private claudeGroup: THREE.Group;

  // Camera animation state
  private animating = false;
  private animT = 0;
  private camStartPos = new THREE.Vector3();
  private camStartQuat = new THREE.Quaternion();
  private camEndPos = CORNER_CAM_POS.clone();
  private camEndQuat = new THREE.Quaternion();
  private camDummy = new THREE.Object3D();

  active = false;
  private pulseT = 0;
  private pendingAnalysis: { text: string; source: "claude" | "offline" } | null = null;
  private analysisFired = false;

  constructor(opts: CornerSceneOptions) {
    this.scene = opts.scene;
    this.camera = opts.camera;
    this.opts = opts;

    this.crowdGroup = this.buildCrowd();
    this.claudeGroup = this.buildClaudePlaceholder();

    this.crowdGroup.visible = false;
    this.claudeGroup.visible = false;

    this.scene.add(this.crowdGroup, this.claudeGroup);

    // Pre-compute camera end quaternion
    this.camDummy.position.copy(CORNER_CAM_POS);
    this.camDummy.lookAt(CORNER_CAM_LOOK);
    this.camEndQuat.copy(this.camDummy.quaternion);
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /** Trigger the corner scene after a fight ends. Fetches analysis and calls onAnalysis. */
  enter(conn: DbConnection | undefined, matchId: bigint, won: boolean, reason: string, adaptationCount: number) {
    this.active = true;
    this.crowdGroup.visible = true;
    this.claudeGroup.visible = true;

    // Reset analysis state for this fight
    this.pendingAnalysis = null;
    this.analysisFired = false;

    // Snapshot camera state for animation
    this.animT = 0;
    this.animating = true;
    this.camStartPos.copy(this.camera.position);
    this.camStartQuat.copy(this.camera.quaternion);

    // Fetch analysis; delivered after camera settles
    this.fetchAnalysis(conn, matchId, won, reason, adaptationCount);
  }

  /** Hide everything and return camera control to the main loop. */
  exit() {
    this.active = false;
    this.animating = false;
    this.crowdGroup.visible = false;
    this.claudeGroup.visible = false;
    this.pendingAnalysis = null;
    this.analysisFired = false;
  }

  /** Called every frame from main.ts animation loop. Returns true while cinematic camera is active. */
  update(dt: number): boolean {
    if (!this.active) return false;

    // Camera lerp to corner position
    if (this.animating) {
      this.animT = Math.min(1, this.animT + dt * 0.6); // ~1.7s transition
      const t = easeInOut(this.animT);
      this.camera.position.lerpVectors(this.camStartPos, this.camEndPos, t);
      this.camera.quaternion.slerpQuaternions(this.camStartQuat, this.camEndQuat, t);
      if (this.animT >= 1) {
        this.animating = false;
        // Camera settled — show analysis bubble now
        if (this.pendingAnalysis && !this.analysisFired) {
          this.analysisFired = true;
          this.opts.onAnalysis?.(this.pendingAnalysis.text, this.pendingAnalysis.source);
        }
      }
    }

    // Animate Claude logo
    this.pulseT += dt;

    // Slow coin-spin of the whole group so the logo rotates like a prize badge
    this.claudeGroup.rotation.y += dt * 0.55;

    // Pulse the orange glow light
    const claudeLight = this.claudeGroup.getObjectByName("claudeLight") as THREE.PointLight | undefined;
    if (claudeLight) {
      claudeLight.intensity = 3.5 + Math.sin(this.pulseT * 2.1) * 1.5;
    }

    // Pulse glow disc opacity
    const glowDisc = this.claudeGroup.getObjectByName("claudeGlowDisc") as THREE.Mesh | undefined;
    if (glowDisc) {
      (glowDisc.material as THREE.MeshStandardMaterial).opacity = 0.18 + Math.sin(this.pulseT * 2.1) * 0.1;
    }

    return true; // we own the camera
  }

  // ── Private: scene building ─────────────────────────────────────────────

  private buildCrowd(): THREE.Group {
    const group = new THREE.Group();
    group.name = "crowd";
    for (const cfg of CROWD_CONFIGS) {
      // Head (sphere)
      const headGeo = new THREE.SphereGeometry(0.14, 6, 5);
      const mat = new THREE.MeshStandardMaterial({ color: cfg.col, roughness: 1, emissive: cfg.col, emissiveIntensity: 0.2 });
      const head = new THREE.Mesh(headGeo, mat);
      head.position.set(cfg.x, cfg.h + 0.14, cfg.z);
      // Body (box)
      const bodyGeo = new THREE.BoxGeometry(0.22, cfg.h, 0.12);
      const body = new THREE.Mesh(bodyGeo, mat.clone());
      body.position.set(cfg.x, cfg.h / 2, cfg.z);
      group.add(head, body);
    }
    return group;
  }

  private buildClaudePlaceholder(): THREE.Group {
    const group = new THREE.Group();
    group.name = "claudePlaceholder";
    group.position.copy(CLAUDE_PLACEHOLDER_POS);

    // ── Claude logo — actual C-mark rendered on a canvas ────────────────────
    // Canvas: 512×512. Orange disc + thick white C arc with rounded ends.
    const S = 512;
    const logoCanvas = document.createElement("canvas");
    logoCanvas.width = S;
    logoCanvas.height = S;
    const ctx = logoCanvas.getContext("2d")!;

    // Orange radial gradient disc
    const bg = ctx.createRadialGradient(S * 0.43, S * 0.40, S * 0.04, S / 2, S / 2, S * 0.49);
    bg.addColorStop(0.0, "#ff9050");
    bg.addColorStop(0.5, "#e06820");
    bg.addColorStop(1.0, "#a83000");
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, S * 0.49, 0, Math.PI * 2);
    ctx.fill();

    // Thin dark rim for definition
    ctx.strokeStyle = "rgba(0,0,0,0.4)";
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, S * 0.475, 0, Math.PI * 2);
    ctx.stroke();

    // Claude C mark: thick white arc, rounded caps, soft glow
    // canvas arc(x,y,r,start,end,false) goes CLOCKWISE in screen space (y-down).
    // From gapAngle → 2π−gapAngle clockwise traces the C opening to the right.
    const gapAngle = 0.72; // ≈41° each side → ~82° total opening (matches real C)
    ctx.shadowColor = "rgba(255,210,160,0.75)";
    ctx.shadowBlur = 28;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 82;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, S * 0.285, gapAngle, Math.PI * 2 - gapAngle, false);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Subtle inner-shadow on lower arc for depth
    ctx.globalAlpha = 0.28;
    ctx.strokeStyle = "rgba(100,30,0,1)";
    ctx.lineWidth = 82;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, S * 0.285, gapAngle + 0.1, Math.PI - 0.1, false);
    ctx.stroke();
    ctx.globalAlpha = 1;

    const logoTex = new THREE.CanvasTexture(logoCanvas);

    // Flat plane facing ring center.
    // Claude is at (3.6, 0, 3.6); ring center at (0,0,0).
    // Plane +Z normal must point toward (−1, 0, −1) → rotation.y = −3π/4.
    const logoPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(1.3, 1.3),
      new THREE.MeshBasicMaterial({ map: logoTex, transparent: true, side: THREE.DoubleSide })
    );
    logoPlane.position.set(0, 1.15, 0);
    logoPlane.rotation.y = -Math.PI * 0.75;
    logoPlane.name = "claudeLogoPlane";
    group.add(logoPlane);

    // Soft orange glow disc behind the logo
    const glowDisc = new THREE.Mesh(
      new THREE.CircleGeometry(0.72, 32),
      new THREE.MeshStandardMaterial({
        color: 0xff6020,
        emissive: 0xff3300,
        emissiveIntensity: 0.9,
        transparent: true,
        opacity: 0.22,
      })
    );
    glowDisc.position.set(0, 1.15, -0.02);
    glowDisc.rotation.y = -Math.PI * 0.75;
    glowDisc.name = "claudeGlowDisc";
    group.add(glowDisc);

    // Stool
    const stoolGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.45, 12);
    const stoolMat = new THREE.MeshStandardMaterial({ color: 0x1a1a2e, roughness: 0.8 });
    const stool = new THREE.Mesh(stoolGeo, stoolMat);
    stool.position.y = 0.225;
    group.add(stool);

    // Orange point light for the logo glow
    const light = new THREE.PointLight(0xff6820, 4.5, 5, 2);
    light.name = "claudeLight";
    light.position.set(0, 1.5, 0);
    group.add(light);

    return group;
  }

  // ── Private: analysis fetch ─────────────────────────────────────────────

  private async fetchAnalysis(
    conn: DbConnection | undefined,
    matchId: bigint,
    won: boolean,
    reason: string,
    adaptationCount: number
  ) {
    const windows = this.collectWindows(conn, matchId);
    const req: AnalysisRequest = {
      matchId: String(matchId),
      result: { won, reason },
      windows,
      adaptationCount,
    };

    const deliver = (text: string, source: "claude" | "offline") => {
      if (!this.analysisFired && !this.animating && this.active) {
        // Camera already settled, show immediately
        this.analysisFired = true;
        this.opts.onAnalysis?.(text, source);
      } else {
        // Store for when the camera animation finishes
        this.pendingAnalysis = { text, source };
      }
    };

    try {
      const f = this.opts.fetchImpl ?? fetch;
      const url = this.opts.analysisUrl ?? "/api/analysis";
      const res = await f(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = (await res.json()) as { text: string; source: "claude" | "offline" };
      deliver(data.text, data.source);
    } catch {
      const total = windows.reduce((s, w) => s + w.playerAttempts, 0);
      const landed = windows.reduce((s, w) => s + w.playerLanded, 0);
      const won = req.result.won;
      let fallback: string;
      if (total < 5) {
        fallback = won
          ? "You got the win but barely threw anything. Next time stay active — jab to find range, then follow up hard."
          : "You didn't throw enough for me to work with. Get your hands up, stay active, start with the jab.";
      } else {
        const rate = Math.round((landed / total) * 100);
        fallback = won
          ? `You landed ${landed} of ${total} shots and got the job done. Work on consistency — don't reset to the same spot after a combo.`
          : `You threw ${total} punches but only ${rate}% landed. Mix up your timing — when the same combo stops working, change it up immediately.`;
      }
      deliver(fallback, "offline");
    }
  }

  private collectWindows(conn: DbConnection | undefined, matchId: bigint): FightWindowSummary[] {
    if (!conn) return [];
    return [...conn.db.fightWindow.iter()]
      .filter((w) => w.matchId === matchId)
      .map((w) => ({
        playerLanded: w.playerLanded,
        playerAttempts: w.playerJabs + w.playerStraights + w.playerHooks + w.playerUppercuts + w.playerUnclassified,
        playerJabs: w.playerJabs,
        playerStraights: w.playerStraights,
        playerHooks: w.playerHooks,
        playerUppercuts: w.playerUppercuts,
        playerSlips: w.playerSlips,
        playerBlocks: w.playerBlocks,
        playerCaught: w.playerCaught,
        botHealth: w.botHealth,
        playerHealth: w.playerHealth,
      }));
  }
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}
