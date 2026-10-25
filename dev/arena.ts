// Standalone combat arena with keyboard and webcam input.
import { createFight, applyInput, advance, drainEvents, CONFIG, type FightState, type Fighter, type Input } from "../engine/engine";
import { attachKeyboard } from "../input/keyboard";
import { MotionEngine } from "../input/motion";

let s: FightState;
let t0 = 0;
let started = false;
const log: string[] = [];
const now = () => performance.now() - t0;
const leanKeys = new Set<string>();

// ---- Webcam / MediaPipe ----
let webcamEnabled = false;
let motionEng: MotionEngine | null = null;
let camStatus: "idle" | "loading" | "calibrating" | "active" = "idle";
let calibProg = 0;
let poseWasLost = false;
const vid = document.getElementById("vid") as HTMLVideoElement | null;
const camBtn = document.getElementById("camBtn") as HTMLButtonElement | null;

function drawCalibration() {
  const cx = cv.width / 2;
  g.fillStyle = css("--panel"); g.globalAlpha = 0.94;
  g.fillRect(cx - 245, 50, 490, 305); g.globalAlpha = 1;
  g.strokeStyle = css("--accent"); g.lineWidth = 2;
  g.strokeRect(cx - 245, 50, 490, 305);
  g.textAlign = "center";
  g.fillStyle = css("--accent"); g.font = "bold 11px ui-monospace, monospace";
  g.fillText(camStatus === "loading" ? "LOADING POSE MODEL" : "WEBCAM CALIBRATION", cx, 80);
  g.fillStyle = css("--ink"); g.font = "bold 17px ui-sans-serif, system-ui, sans-serif";
  g.fillText(camStatus === "loading" ? "Downloading MediaPipe pose model…" : "Stand back — head + both arms in frame", cx, 108);
  g.font = "13px ui-sans-serif, system-ui, sans-serif"; g.fillStyle = css("--muted");
  g.fillText(
    camStatus === "loading" ? "First run may take a few seconds" : "Hold a relaxed guard stance until the bar fills",
    cx, 130,
  );
  if (camStatus === "calibrating") {
    g.fillStyle = css("--track"); g.fillRect(cx - 165, 146, 330, 10);
    g.fillStyle = css("--accent"); g.fillRect(cx - 165, 146, 330 * calibProg, 10);
  }
  if (vid && vid.readyState >= 2) {
    const pw = 210, ph = 158, vy = 164;
    // mirror preview for natural selfie feel (raw stream is unmirrored for pose detection)
    g.save(); g.translate(cx + pw / 2, vy); g.scale(-1, 1);
    g.drawImage(vid, -pw, 0, pw, ph); g.restore();
    g.strokeStyle = css("--accent"); g.lineWidth = 1.5;
    g.strokeRect(cx - pw / 2, vy, pw, ph);
    g.fillStyle = css("--muted"); g.font = "10px ui-monospace, monospace";
    g.fillText("preview (mirrored)", cx, vy + ph + 14);
  }
}

async function enableWebcam() {
  if (camStatus !== "idle" || !vid) return;
  if (camBtn) { camBtn.disabled = true; camBtn.textContent = "⏳ Starting…"; }
  camStatus = "loading";

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
    });
    vid.srcObject = stream;
    await new Promise<void>((res) => { vid.onloadedmetadata = () => res(); });
    vid.play();
  } catch (e) {
    alert(`Webcam: ${(e as Error).message}`);
    camStatus = "idle";
    if (camBtn) { camBtn.disabled = false; camBtn.textContent = "📷 Enable Webcam"; }
    return;
  }

  motionEng = new MotionEngine(); // default: mirrored:false (raw unmirrored camera stream)

  // MediaPipe Pose is loaded via CDN <script async> in the HTML shell.
  const PoseCtor = (window as any).Pose as (new (cfg: object) => any) | undefined;
  if (!PoseCtor) {
    alert("MediaPipe still loading — wait a moment and try again.");
    camStatus = "idle";
    if (camBtn) { camBtn.disabled = false; camBtn.textContent = "📷 Enable Webcam"; }
    return;
  }

  if (camBtn) camBtn.textContent = "⏳ Calibrating…";
  const pose = new PoseCtor({
    locateFile: (f: string) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5.1675469404/${f}`,
  });
  pose.setOptions({
    modelComplexity: 1, smoothLandmarks: true,
    enableSegmentation: false, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5,
  });
  pose.onResults((res: { poseLandmarks?: { x: number; y: number; visibility?: number }[] }) => {
    if (camStatus === "loading") camStatus = "calibrating";
    if (!res.poseLandmarks) {
      // person left frame: pause the fight
      if (webcamEnabled && started && !poseWasLost) {
        poseWasLost = true;
        send({ who: "player", kind: "tracking", ok: false });
      }
      return;
    }
    // person back in frame: resume
    if (poseWasLost) {
      poseWasLost = false;
      if (started) send({ who: "player", kind: "tracking", ok: true });
    }
    const lm = res.poseLandmarks;
    const t = performance.now();
    if (!motionEng!.calibrated) {
      calibProg = motionEng!.calibrate(lm);
      if (motionEng!.calibrated) {
        camStatus = "active";
        webcamEnabled = true;
        if (camBtn) camBtn.textContent = "✅ Webcam Active";
        if (!started) { started = true; newFight(); }
      }
      return;
    }
    if (started) {
      const inputs = motionEng!.update(lm, t);
      for (const inp of inputs) send(inp);
    }
  });

  const runPose = async () => {
    if (camStatus === "idle") return;
    try { await pose.send({ image: vid! }); } catch { /* skip bad frame */ }
    requestAnimationFrame(runPose);
  };
  runPose();
}

camBtn?.addEventListener("click", enableWebcam);

function newFight() {
  s = createFight(Date.now() % 100000);
  t0 = performance.now();
  log.length = 0;
}

function send(i: Input) {
  if (!started) return;
  applyInput(s, i, now());
}

attachKeyboard(send);
window.addEventListener("keydown", (e) => {
  if (!started) {
    started = true;
    newFight();
    return;
  }
  if (e.repeat) return;
  if (e.code === "KeyR") newFight();
  if (e.code === "KeyQ" || e.code === "KeyE") {
    leanKeys.add(e.code);
    send({ who: "player", kind: "lean", dir: e.code === "KeyQ" ? "L" : "R" });
  }
  if (e.code === "KeyT") send({ who: "player", kind: "tracking", ok: s.paused }); // toggle simulated tracking loss
});
window.addEventListener("keyup", (e) => {
  if (e.code === "KeyQ" || e.code === "KeyE") {
    leanKeys.delete(e.code);
    send({ who: "player", kind: "lean", dir: leanKeys.has("KeyQ") ? "L" : leanKeys.has("KeyE") ? "R" : null });
  }
});

const cv = document.getElementById("c") as HTMLCanvasElement;
const g = cv.getContext("2d")!;
const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

function bar(x: number, y: number, w: number, frac: number, color: string) {
  g.fillStyle = css("--track"); g.fillRect(x, y, w, 12);
  g.fillStyle = color; g.fillRect(x, y, w * Math.max(0, frac), 12);
}

function fighter(f: Fighter, cx: number, label: string, facing: 1 | -1) {
  const y = 250;
  const dodge = f.phase === "dodge" ? (f.dodgeDir === "L" ? -40 : 40) * facing : 0;
  const ink = css("--ink");
  g.strokeStyle = ink; g.fillStyle = ink; g.lineWidth = 3;
  g.beginPath(); g.arc(cx + dodge, y - 70, 22, 0, Math.PI * 2); g.stroke();
  g.beginPath(); g.moveTo(cx + dodge, y - 48); g.lineTo(cx, y + 40); g.stroke();
  const guard = f.guardHeld && f.phase === "idle";
  const reach = f.phase === "active" ? 70 : f.phase === "windup" ? -10 : 25;
  const glove = (side: -1 | 1, out: number) => {
    const isLead = (f.punch?.endsWith("_l") || f.punch === "jab") ? side === -1 : (f.punch ? side === 1 : false);
    const ext = isLead ? out : 25;
    const gy = guard ? y - 75 : f.punch?.startsWith("upper") && isLead && f.phase === "active" ? y - 95 : y - 40;
    g.beginPath(); g.arc(cx + dodge + facing * ext + side * 18, gy, 13, 0, Math.PI * 2);
    g.fillStyle = isLead && f.phase === "active" ? css("--hit") : css("--glove"); g.fill();
  };
  glove(-1, reach); glove(1, reach);
  g.fillStyle = ink; g.font = "13px ui-monospace, monospace"; g.textAlign = "center";
  const held = f.phase === "dodge" && f.lean ? " (lean)" : "";
  g.fillText(`${label}  ${f.phase}${held}${f.punch ? " " + f.punch : ""}${f.weak ? " (low on tokens)" : ""}`, cx, y + 70);
}

function frame() {
  g.clearRect(0, 0, cv.width, cv.height);
  if (!started) {
    if (camStatus === "loading" || camStatus === "calibrating") {
      drawCalibration();
    } else {
      g.fillStyle = css("--ink"); g.textAlign = "center"; g.font = "bold 20px ui-sans-serif, system-ui, sans-serif";
      g.fillText("Press any key  (keyboard mode)", cv.width / 2, cv.height / 2 - 18);
      g.font = "14px ui-sans-serif, system-ui, sans-serif"; g.fillStyle = css("--muted");
      g.fillText("— or click 📷 Enable Webcam above to fight with your body —", cv.width / 2, cv.height / 2 + 14);
    }
    requestAnimationFrame(frame);
    return;
  }
  advance(s, now());
  const ev = drainEvents(s);
  for (const e of ev) {
    if (e.type === "punch") log.unshift(`${(e.t / 1000).toFixed(1)}s  ${e.attacker} ${e.punch} -> ${e.outcome} (${e.damage})`);
    else if (e.type === "ko" || e.type === "time_up") log.unshift(`${(e.t / 1000).toFixed(1)}s  ${e.type.toUpperCase()} winner: ${e.winner}`);
    else if (e.type === "pause" || e.type === "resume") log.unshift(`${(e.t / 1000).toFixed(1)}s  tracking ${e.type === "pause" ? "LOST (paused)" : "back"}`);
  }
  log.length = Math.min(log.length, 7);

  bar(20, 20, 300, s.player.hp / CONFIG.maxHp, css("--hp"));
  bar(20, 36, 300, s.player.stamina / CONFIG.maxStamina, css("--stam"));
  bar(cv.width - 320, 20, 300, s.cpu.hp / CONFIG.maxHp, css("--hp"));
  bar(cv.width - 320, 36, 300, s.cpu.stamina / CONFIG.maxStamina, css("--stam"));
  g.fillStyle = css("--ink"); g.textAlign = "center"; g.font = "bold 18px ui-monospace, monospace";
  const status = s.status === "countdown" ? `${Math.ceil((s.fightStartsAt - s.t) / 1000)}`
    : s.status === "fighting" ? (s.paused ? "PAUSED: tracking lost (T)" : `${Math.max(0, Math.ceil((s.roundEndsAt - s.t) / 1000))}s`)
    : `${s.status.toUpperCase()}  winner: ${s.winner}   (R to restart)`;
  const over = s.status === "ko" || s.status === "decision";
  if (over) { g.font = "bold 16px ui-monospace, monospace"; g.fillText(status, cv.width / 2, 86); }
  else g.fillText(status, cv.width / 2, 34);
  g.font = "12px ui-monospace, monospace"; g.fillStyle = css("--muted");
  fighter(s.player, cv.width / 2 - 110, "YOU", 1);
  fighter(s.cpu, cv.width / 2 + 110, "CPU", -1);

  g.textAlign = "left"; g.font = "12px ui-monospace, monospace"; g.fillStyle = css("--ink");
  log.forEach((l, i) => { g.globalAlpha = 1 - i * 0.11; g.fillText(l.slice(0, 110), 20, 500 + i * 16); });
  g.globalAlpha = 1;
  if (webcamEnabled) {
    g.fillStyle = css("--accent"); g.font = "bold 10px ui-monospace, monospace"; g.textAlign = "right";
    g.globalAlpha = 0.7;
    g.fillText("● WEBCAM", cv.width - 16, cv.height - 8);
    g.globalAlpha = 1;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
