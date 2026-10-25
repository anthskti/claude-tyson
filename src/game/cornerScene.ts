// Post-fight corner scene.
// After the match ends, the camera lerps to the player's corner showing:
//   - A crowd of silhouette figures behind the ring
//   - A glowing Claude placeholder model (box with "CLAUDE" label), or a loaded GLB crab
//   - A self-managed analysis bubble DOM element

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { DbConnection } from "./module_bindings";
import type { AnalysisRequest, FightWindowSummary } from "../../coach/analysis";

// ── Camera target: inside ring looking toward corner coach ──────────────
const CORNER_CAM_POS  = new THREE.Vector3(1.6, 1.55, 1.6);   // inside ring, near player corner
const CORNER_CAM_LOOK = new THREE.Vector3(3.6,  1.1,  3.6);  // looking at crab/placeholder head

// ── Claude placeholder: outside the near-right (blue) ring corner ────────
const CLAUDE_PLACEHOLDER_POS = new THREE.Vector3(3.6, 0.0, 3.6);

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface CornerSceneOptions {
  scene: THREE.Scene;
  camera: THREE.Camera;
  renderer: THREE.WebGLRenderer;
  analysisUrl?: string; // default "/api/analysis"
  fetchImpl?: typeof fetch;
}

export class CornerScene {
  private scene: THREE.Scene;
  private camera: THREE.Camera;
  private renderer: THREE.WebGLRenderer;
  private opts: CornerSceneOptions;

  // Three.js objects (added to scene, hidden by default)
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
  private bobT = 0;
  private pendingAnalysis: { text: string; source: "claude" | "offline" } | null = null;
  private analysisFired = false;

  // Crab model state
  private crabLoaded = false;
  private crabMesh: THREE.Object3D | null = null;

  // Analysis bubble DOM element
  private bubbleEl: HTMLDivElement;
  private typewriterTimer = 0;

  constructor(opts: CornerSceneOptions) {
    this.scene = opts.scene;
    this.camera = opts.camera;
    this.renderer = opts.renderer;
    this.opts = opts;

    this.claudeGroup = this.buildClaudePlaceholder();
    this.claudeGroup.visible = false;
    // Light starts at 0 so it doesn't leak into the main scene when inactive
    const light = this.claudeGroup.getObjectByName("claudeLight") as THREE.PointLight | undefined;
    if (light) light.intensity = 0;

    this.scene.add(this.claudeGroup);

    // Pre-compute camera end quaternion
    this.camDummy.position.copy(CORNER_CAM_POS);
    this.camDummy.lookAt(CORNER_CAM_LOOK);
    this.camEndQuat.copy(this.camDummy.quaternion);

    // Create analysis bubble DOM element
    this.bubbleEl = document.createElement("div");
    this.bubbleEl.className = "wii-crab-bubble";
    document.body.appendChild(this.bubbleEl);

    // Async load the crab GLB
    void this.loadCrab();
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /** Trigger the corner scene after a fight ends. Fetches analysis and shows bubble. */
  enter(conn: DbConnection | undefined, matchId: bigint, won: boolean, reason: string, adaptationCount: number) {
    this.active = true;
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
    void this.fetchAnalysis(conn, matchId, won, reason, adaptationCount);
  }

  /** Hide everything and return camera control to the main loop. */
  exit() {
    this.active = false;
    this.animating = false;
    this.claudeGroup.visible = false;
    // Kill the light so it doesn't leak into the main scene
    const light = this.claudeGroup.getObjectByName("claudeLight") as THREE.PointLight | undefined;
    if (light) light.intensity = 0;
    this.pendingAnalysis = null;
    this.analysisFired = false;
    this.bubbleEl.classList.remove("visible");
    clearTimeout(this.typewriterTimer);
  }

  /** Called every frame from main.ts animation loop. Returns true while cinematic camera is active. */
  update(dt: number): boolean {
    if (!this.active) return false;

    // Camera lerp to corner position
    if (this.animating) {
      this.animT = Math.min(1, this.animT + dt * 0.4); // ~2.5s cinematic transition
      const t = easeInOut(this.animT);
      this.camera.position.lerpVectors(this.camStartPos, this.camEndPos, t);
      this.camera.quaternion.slerpQuaternions(this.camStartQuat, this.camEndQuat, t);
      if (this.animT >= 1) {
        this.animating = false;
        // Camera settled — show analysis bubble after dramatic pause
        if (this.pendingAnalysis && !this.analysisFired) {
          this.analysisFired = true;
          const pending = this.pendingAnalysis;
          window.setTimeout(() => this.showAnalysisBubble(pending.text, pending.source), 300);
        }
      }
    }

    // Animate Claude logo / crab
    this.pulseT += dt;

    if (this.crabLoaded && this.crabMesh) {
      // Bob the crab up and down
      this.bobT += dt;
      this.crabMesh.position.y = Math.sin(this.bobT * 1.5) * 0.06;
    } else {
      // Placeholder fallback: slow coin-spin of the whole group
      this.claudeGroup.rotation.y += dt * 0.55;
    }

    // Pulse the orange glow light
    const claudeLight = this.claudeGroup.getObjectByName("claudeLight") as THREE.PointLight | undefined;
    if (claudeLight) {
      claudeLight.intensity = 3.5 + Math.sin(this.pulseT * 2.1) * 1.5;
    }

    // Pulse glow disc opacity (only relevant when crab not loaded)
    if (!this.crabLoaded) {
      const glowDisc = this.claudeGroup.getObjectByName("claudeGlowDisc") as THREE.Mesh | undefined;
      if (glowDisc) {
        (glowDisc.material as THREE.MeshStandardMaterial).opacity = 0.18 + Math.sin(this.pulseT * 2.1) * 0.1;
      }
    }

    // Keep bubble positioned over crab head while visible
    if (!this.animating && this.bubbleEl.classList.contains("visible")) {
      this.updateBubblePosition();
    }

    return true; // we own the camera
  }

  // ── Private: crab loader ────────────────────────────────────────────────

  private async loadCrab(): Promise<void> {
    const loader = new GLTFLoader();
    try {
      const gltf = await loader.loadAsync("/claude_crab.glb");
      const crab = gltf.scene;

      // Face toward new camera position (inside ring)
      crab.rotation.y = -Math.PI * 0.875;

      // Scale 1.5x
      crab.scale.setScalar(1.5);

      // Position at base of claudeGroup
      crab.position.set(0, 0, 0);

      this.claudeGroup.add(crab);
      this.crabMesh = crab;
      this.crabLoaded = true;

      // Hide the placeholder logo plane and glow disc
      const logoPlane = this.claudeGroup.getObjectByName("claudeLogoPlane");
      if (logoPlane) logoPlane.visible = false;
      const glowDisc = this.claudeGroup.getObjectByName("claudeGlowDisc");
      if (glowDisc) glowDisc.visible = false;
    } catch {
      // GLB not available — keep existing placeholder behavior
      this.crabLoaded = false;
      this.crabMesh = null;
    }
  }

  // ── Private: bubble management ──────────────────────────────────────────

  /** Project the crab/placeholder head world position to screen pixels. */
  private getCrabHeadScreen(): { x: number; y: number } {
    const worldPos = new THREE.Vector3(
      CLAUDE_PLACEHOLDER_POS.x,
      1.5,
      CLAUDE_PLACEHOLDER_POS.z
    );
    const ndc = worldPos.clone().project(this.camera);
    const size = this.renderer.getSize(new THREE.Vector2());
    const x = (ndc.x * 0.5 + 0.5) * size.x;
    const y = (-(ndc.y * 0.5) + 0.5) * size.y;
    return { x, y };
  }

  /** Position the bubble DOM element above the crab head. */
  private updateBubblePosition(): void {
    const { x, y } = this.getCrabHeadScreen();
    this.bubbleEl.style.left = x + "px";
    this.bubbleEl.style.top = y + "px";
  }

  /** Show the analysis speech bubble with typewriter text. */
  showAnalysisBubble(text: string, source: "claude" | "offline"): void {
    const headerLabel = source === "claude" ? "CLAUDE ANALYSIS" : "CORNER NOTES";

    this.bubbleEl.innerHTML = `
      <div class="wii-bubble-header">
        <span class="wii-bubble-icon">C</span>
        <span class="wii-bubble-source">${escapeHtml(headerLabel)}</span>
      </div>
      <p id="wii-text"></p>
      <button class="wii-bubble-ok">GOT IT</button>
    `;

    this.updateBubblePosition();
    this.bubbleEl.classList.add("visible");

    // Wire up the GOT IT button
    const btn = this.bubbleEl.querySelector(".wii-bubble-ok") as HTMLButtonElement | null;
    if (btn) {
      btn.addEventListener("click", () => {
        this.bubbleEl.classList.remove("visible");
        clearTimeout(this.typewriterTimer);
        this.exit();
      });
    }

    // Typewriter effect
    const p = this.bubbleEl.querySelector("#wii-text") as HTMLParagraphElement | null;
    if (!p) return;

    const safeText = escapeHtml(text);
    let i = 0;
    const type = () => {
      if (i <= safeText.length) {
        p.innerHTML = safeText.slice(0, i);
        i++;
        this.typewriterTimer = window.setTimeout(type, 18);
      } else {
        // Append blinking cursor after text finishes
        p.innerHTML = safeText + '<span class="wii-cursor"></span>';
      }
    };
    clearTimeout(this.typewriterTimer);
    type();
  }

  // ── Private: scene building ─────────────────────────────────────────────

  private buildClaudePlaceholder(): THREE.Group {
    const group = new THREE.Group();
    group.name = "claudePlaceholder";
    group.position.copy(CLAUDE_PLACEHOLDER_POS);

    // ── Claude logo — actual C-mark rendered on a canvas ────────────────────
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
    const gapAngle = 0.72;
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
    light.position.set(0, 1.2, 0);
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
        // Camera already settled, show after dramatic pause
        this.analysisFired = true;
        window.setTimeout(() => this.showAnalysisBubble(text, source), 300);
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
      // Persist analysis into SpacetimeDB so profile.lastAnalysis is populated
      if (conn) {
        conn.reducers.submitFightAnalysis({ matchId, analysis: data.text }).catch(() => { /* not fatal */ });
      }
      deliver(data.text, data.source);
    } catch {
      const total = windows.reduce((s, w) => s + w.playerAttempts, 0);
      const landed = windows.reduce((s, w) => s + w.playerLanded, 0);
      const wonResult = req.result.won;
      let fallback: string;
      if (total < 5) {
        fallback = wonResult
          ? "You got the win but barely threw anything. Next time stay active — use straights to find range, then follow with the hook."
          : "You didn't throw enough for me to work with. Get your hands up, stay active, mix straights and hooks.";
      } else {
        const rate = Math.round((landed / total) * 100);
        fallback = wonResult
          ? `You landed ${landed} of ${total} shots and got the job done. Work on consistency — don't reset to the same spot after a combo.`
          : `You threw ${total} punches but only ${rate}% landed. Mix up your timing — when the same combo stops working, change it up immediately.`;
      }
      if (conn) {
        conn.reducers.submitFightAnalysis({ matchId, analysis: fallback }).catch(() => { /* not fatal */ });
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
