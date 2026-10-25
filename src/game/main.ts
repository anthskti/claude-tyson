import './style.css';
import * as THREE from 'three';
import { buildArena, loadRing } from './scene/ring';
import { Boxer, PlayerGloves, cornerOf, type AnyPunch } from './scene/boxer';
import { SimulatedCvProvider } from './cv/simulatedProvider';
import { CvBridge } from './cv/bridge';
import { CameraFeed } from './cv/cameraFeed';
import { GuardCalibration, GuardClassifier, type GuardCalibrationData } from './cv/guard';
import { poseOf, type Body, type CvProvider, type Guard, type Observation, type PoseState } from './cv/contract';
import { ANSWER, DEFENSE_TEXT, OFFENSE_TEXT, PUNCH_NAME } from './combatText';
import { GameServer, type MatchView } from './net/server';
import { Hud, type HudState, type InputMode } from './hud';
import { MahoragasWheel } from './scene/mahoragasWheel';
import { CornerScene } from './cornerScene';
import { AdaptationManager } from './adaptationManager';
import { DebugLog } from './debugLog';
import { pickLine } from './dialogue';
import { GameAudio } from './audio';

// ─── Player name + session helpers ─────────────────────────────────────────

const PLAYER_NAME_KEY   = 'claude-tyson.player-name';
const SAFETY_SHOWN_KEY  = 'claude-tyson.safety-shown'; // sessionStorage key

function loadPlayerName(): string | null {
  try { return localStorage.getItem(PLAYER_NAME_KEY); } catch { return null; }
}
function savePlayerName(name: string) {
  try { localStorage.setItem(PLAYER_NAME_KEY, name); } catch {}
}
function safetyShownThisSession(): boolean {
  try { return sessionStorage.getItem(SAFETY_SHOWN_KEY) === '1'; } catch { return false; }
}
function markSafetyShown() {
  try { sessionStorage.setItem(SAFETY_SHOWN_KEY, '1'); } catch {}
}

/** Mounts the fight on `#scene` and `#hud`. Call after those elements exist. */
export function startGame(): () => void {
let alive = true;

// ─── Scene ─────────────────────────────────────────────────────────────────

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();
buildArena(scene);
loadRing().then(ring => {
  if (alive) scene.add(ring);
});

// First-person: the player stands just south of centre, facing the opponent (-Z).
const EYE = new THREE.Vector3(0, 1.62, 0.55);
const BODY_WIDTH_M = 0.55; // metres per CV "body width" of lateral displacement
const camera = new THREE.PerspectiveCamera(70, 1, 0.03, 100);
camera.rotation.order = 'YXZ'; // FPS order: yaw→pitch→roll, prevents gimbal lock
camera.position.copy(EYE);
camera.lookAt(0, 1.5, -1);
const BASE_PITCH = camera.rotation.x;
scene.add(camera);

const gloves = new PlayerGloves();
camera.add(gloves.root);

const opponent = new Boxer();
scene.add(opponent.root);

// ── Maharagas Wheel / Corner Scene / debug ──────────────────────────────
const wheel = new MahoragasWheel();
scene.add(wheel.group);

const debugLog = new DebugLog();
function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// ─── Game state ────────────────────────────────────────────────────────────

// Per tab (sessionStorage), so two local clients can use different inputs.
const INPUT_KEY = 'claude-tyson.input';
function savedInput(): InputMode {
  const param = new URLSearchParams(location.search).get('input');
  if (param === 'camera' || param === 'keyboard') return param;
  try {
    return sessionStorage.getItem(INPUT_KEY) === 'camera' ? 'camera' : 'keyboard';
  } catch {
    return 'keyboard';
  }
}
const hudState: HudState = {
  server: 'connecting', tracking: 'calibrating', queued: false, input: savedInput(), camera: 'off',
};
let view: MatchView | undefined;
let latest: Observation | undefined;
let myPose: PoseState = { body: 'neutral', guards: { left: 'neutral', right: 'neutral' } };
let shakeUntil = 0;
let prevMatchId: string | undefined;
let prevMatchStatus: string | undefined;
let debriefShown = false;
let debriefTimer = 0;
let cinematicMode = false;
let lowHpDialogueShown = false;
let winningDialogueShown = false;
let losingDialogueShown = false;
let slowmoUntil = -Infinity;
let koFlashTriggered = false;

const server = new GameServer({
  onStatus(status, detail) {
    hudState.server = status;
    hudState.serverDetail = detail;
    refresh();
  },
  onChange: refresh,
  onFightWindow(window, strategy) {
    const att = window.playerJabs + window.playerStraights + window.playerHooks +
      window.playerUppercuts + window.playerUnclassified;
    debugLog.add('window', `W#${window.id} +${window.playerLanded}/${att} bot${window.botHealth}hp trk=${(window.trackingCoverage*100).toFixed(0)}%`);
    adaptationManager?.onWindow(window, strategy);
  },
  onAttack(atk, v) {
    if (v.match.status !== 'active' || atk.attackerSlot === v.me.slot) return;
    const cueMs = Number(atk.cueAt.microsSinceUnixEpoch / 1000n);
    const impactMs = Number(atk.impactAt.microsSinceUnixEpoch / 1000n);
    opponent.throwPunch(atk.hand as 'left' | 'right', atk.punchType as AnyPunch, cueMs, impactMs);
    // Their left hand arrives on my right side.
    const side = atk.punchType === 'hook' ? (atk.hand === 'left' ? ' from your right' : ' from your left') : '';
    hud.telegraph(`${PUNCH_NAME[atk.punchType]}${side}`, ANSWER[atk.punchType], impactMs - Date.now());
  },
  onAttackResolved(atk, v) {
    if (atk.result === 'cancelled') return;
    if (atk.attackerSlot === v.me.slot) {
      if (v.match.mode === 'bot') opponent.showDefense(atk.defenderBody as Body, atk.defenderGuard);
      if (atk.result === 'landed') {
        opponent.takeHit(atk.damage >= 9);
        if (Math.random() < 0.35) hud.showDialogue(pickLine(atk.damage >= 9 ? 'hit_taken_heavy' : 'hit_taken_light'));
      }
      const text = OFFENSE_TEXT[atk.detail] ?? atk.result;
      hud.toast(atk.damage > 0 ? `${text} −${(atk.damage / 10).toFixed(1)}` : text, atk.damage > 0 ? 'good' : 'info');
      return;
    }
    hud.clearTelegraph();
    if (atk.result === 'unscorable') {
      hud.toast('unscorable (tracking)', 'info');
      return;
    }
    const text = DEFENSE_TEXT[atk.detail] ?? atk.result;
    if (atk.damage > 0) {
      hud.flashDamage();
      shakeUntil = performance.now() + 220;
      hud.toast(`${text} −${(atk.damage / 10).toFixed(1)}`, 'bad');
      if (Math.random() < 0.28) hud.showDialogue(pickLine('hit_landed'));
    } else {
      hud.toast(atk.result === 'dodged' ? `${text} · counter ready` : text, 'good');
    }
  },
});

const hud = new Hud({
  fightBot: () => {
    if (hudState.server !== 'online') { hud.toast(`Server ${hudState.server} — run: spacetime start`, 'bad'); return; }
    hud.showVsScreen(hudState.playerName ?? 'FIGHTER', hudState.profile, () => {
      beforeFight(() => server.startBotMatch());
    });
  },
  findPvp: () => {
    if (hudState.server !== 'online') { hud.toast(`Server ${hudState.server} — run: spacetime start`, 'bad'); return; }
    hud.showVsScreen(hudState.playerName ?? 'FIGHTER', hudState.profile, () => {
      beforeFight(() => server.joinPvp());
    });
  },
  cancelPvp: () => server.leavePvp(),
  forfeit: () => view && server.forfeit(view.match.id),
  useKeyboard: () => setInput('keyboard'),
  useCamera: () => setInput('camera'),
  reconnectCamera: () => bridge.reconnect(),
  cancelCalibration: () => endCalibration(false),
  skipCalibration: () => guardClassifier && endCalibration(true),
  changeName: () => {
    hud.showNameEntry((name) => {
      savePlayerName(name);
      hudState.playerName = name;
      refresh();
      hud.showWiiSafety(() => refresh());
    });
  },
});

const adaptationManager = new AdaptationManager({
  server,
  requestStrategist: async (req) => {
    const res = await fetch('/api/strategist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!res.ok) throw new Error(`strategist ${res.status}`);
    return res.json();
  },
  onStrategyApplied: (explanation) => {
    wheel.clank();
    hud.showAdaptedTag(explanation);
    hud.showDialogue(pickLine('adaptation'));
    debugLog.add('strategy', `ADAPTED: ${explanation}`);
  },
  onAdaptation: (outcome, explanation) => {
    hud.showAdaptation(outcome, explanation);
    debugLog.add('outcome', `${outcome === 'improved' ? '✓' : '✗'} ${explanation}`);
  },
  log: (msg) => debugLog.add('strategy', msg),
});

const cornerScene = new CornerScene({ scene, camera, renderer });
window.addEventListener('keydown', (e) => { if (e.key === '`') debugLog.toggle(); });

function refresh() {
  view = server.currentMatch();
  hudState.view = view;
  hudState.result = view ? server.result(view.match.id) : undefined;
  hudState.profile = server.profile();
  hudState.queued = server.inQueue();
  // The Claude-themed bot is PvE only; a PvP opponent is a fighter in their corner colour.
  opponent.setLook(view?.match.mode === 'pvp' ? cornerOf(view.opponent.slot) : 'claude');
  gloves.setCorner(cornerOf(view?.me.slot ?? 0));

  const matchId = view ? String(view.match.id) : undefined;
  const status = view?.match.status;

  if (status === 'active' && view?.match.mode === 'bot' && matchId !== prevMatchId) {
    debriefShown = false;
    window.clearTimeout(debriefTimer);
    hudState.debriefing = false;
    lowHpDialogueShown = false;
    winningDialogueShown = false;
    losingDialogueShown = false;
    koFlashTriggered = false;
    slowmoUntil = -Infinity;
    adaptationManager.reset(view.match.id);
    cinematicMode = false;
    cornerScene.exit();
    wheel.show();
    hud.showDialogue(pickLine('fight_start'));
    hud.toast('FIGHT STARTING…', 'info');
  }

  if (!debriefShown && status !== 'active' && prevMatchStatus === 'active') {
    debriefShown = true;
    const won = hudState.result?.winnerSlot === view?.me.slot;
    const reason = hudState.result?.reason ?? 'time';
    hud.showDialogue(pickLine(won ? 'fight_end_win' : 'fight_end_lose'));
    if (view && !cinematicMode) {
      const stars = won ? (view.me.health >= 700 ? 3 : view.me.health >= 350 ? 2 : 1) : 0;
      hud.showResultCard(won, reason, stars);
      hudState.debriefing = true;
      const snap = view;
      debriefTimer = window.setTimeout(() => {
        hudState.debriefing = false;
        cinematicMode = true;
        hudState.cinematic = true;
        wheel.hide();
        cornerScene.enter(server.conn, snap.match.id, won, reason, wheel.totalClanks, hudState.playerName);
      }, 2400);
    }
  }

  prevMatchId = matchId;
  prevMatchStatus = status;


  hud.render(hudState);
}

// ─── CV input ──────────────────────────────────────────────────────────────

// The keyboard and the webcam share one provider: the Python CV bridge presses the same
// control keys the keyboard does. In camera mode the keyboard's punch/slip/guard keys are
// ignored so everything comes from CV; blocks are classified from the bridge's wrist and
// head markers against a per-player calibration (cv/guard.ts). C still recalibrates.
const sim = new SimulatedCvProvider();
const cv: CvProvider = sim;
const CV_DRIVEN_KEYS = ['j', 'u', 'k', 'i', 'a', 'd', 'q', 'e', 'w'];
const KEY_LABEL: Record<string, string> = {
  j: 'J', u: 'U', k: 'K', i: 'I', a: 'hold A', d: 'hold D', q: 'hold Q', e: 'hold E',
};
const GUARD_KEY = { left: 'q', right: 'e' } as const;
const feed = new CameraFeed(document.getElementById('hud')!);

// Saved per machine so the next match can skip calibration.
const CALIBRATION_KEY = 'claude-tyson.guard-calibration';
function loadCalibration(): GuardCalibrationData | undefined {
  try {
    const raw = localStorage.getItem(CALIBRATION_KEY);
    return raw ? (JSON.parse(raw) as GuardCalibrationData) : undefined;
  } catch {
    return undefined;
  }
}
const savedCalibration = loadCalibration();
let guardClassifier = savedCalibration && new GuardClassifier(savedCalibration);
let cvGuards: Record<'left' | 'right', Guard> = { left: 'neutral', right: 'neutral' };
let calibration: GuardCalibration | undefined;
let afterCalibration: (() => void) | undefined;

function setCvGuards(next: Record<'left' | 'right', Guard>) {
  for (const hand of ['left', 'right'] as const) {
    if (next[hand] === cvGuards[hand]) continue;
    const key = GUARD_KEY[hand];
    if (next[hand] === 'block') sim.press(key);
    else sim.release(key);
    hudState.lastCv = `${next[hand] === 'block' ? 'block' : 'unblock'}_${hand} → ${next[hand] === 'block' ? KEY_LABEL[key] : 'release'}`;
  }
  cvGuards = next;
}

function renderCalibration() {
  hud.renderCalibration(calibration?.view(), { canSkip: !!guardClassifier, camera: hudState.camera });
}

/** In camera mode, calibrate stance and block before the match or queue starts. */
function beforeFight(action: () => void) {
  if (hudState.input !== 'camera') return action();
  afterCalibration = action;
  calibration = new GuardCalibration({
    onStance: () => bridge.resetCalibration(),
    onDone(data) {
      try {
        localStorage.setItem(CALIBRATION_KEY, JSON.stringify(data));
      } catch {
        // Storage blocked: calibration lasts for this page only.
      }
      guardClassifier = new GuardClassifier(data);
      hud.toast('calibrated', 'good');
      endCalibration(true);
    },
  });
  renderCalibration();
}

function endCalibration(run: boolean) {
  const action = afterCalibration;
  calibration = undefined;
  afterCalibration = undefined;
  renderCalibration();
  if (run) action?.();
}
// `?cvBridge=ws://127.0.0.1:8799` points this tab at a different bridge (e.g. a synthetic one).
const bridgeUrl = new URLSearchParams(location.search).get('cvBridge') ?? undefined;
const bridge = new CvBridge(sim, {
  onStatus(status, detail) {
    if (status === 'connected') hud.toast('camera CV connected', 'good');
    else if (status === 'disconnected' && hudState.camera === 'connected') hud.toast(detail ?? 'camera CV disconnected', 'bad');
    hudState.camera = status;
    hudState.cameraDetail = detail;
    if (status !== 'connected') setCvGuards({ left: 'neutral', right: 'neutral' });
    renderCalibration();
    refresh();
  },
  onObservation(obs) {
    const now = performance.now();
    if (calibration) {
      calibration.feed(obs.markers, now);
      renderCalibration();
    } else if (guardClassifier) {
      setCvGuards(guardClassifier.update(obs.markers, now));
    }
    feed.update(obs.markers, cvGuards);
  },
  onTranslate(event, key) {
    hudState.lastCv = `${event} → ${key ? KEY_LABEL[key] : 'release'}`;
    refresh();
  },
}, bridgeUrl);

function setInput(mode: InputMode) {
  hudState.input = mode;
  try {
    sessionStorage.setItem(INPUT_KEY, mode);
  } catch {
    // Storage blocked: the choice just won't survive a reload.
  }
  for (const k of CV_DRIVEN_KEYS) {
    sim.release(k);
    if (mode === 'camera') sim.blockedKeys.add(k);
    else sim.blockedKeys.delete(k);
  }
  bridge.stop();
  setCvGuards({ left: 'neutral', right: 'neutral' });
  hudState.camera = 'off';
  hudState.lastCv = undefined;
  if (mode === 'camera') {
    bridge.start();
    void feed.show();
  } else {
    feed.hide();
    endCalibration(false);
  }
  refresh();
}
cv.start((obs, events) => {
  const trackingChanged = obs.trackingState !== hudState.tracking;
  latest = obs;
  hudState.tracking = obs.trackingState;
  hudState.trackingReason = obs.reason;

  myPose = poseOf(obs);
  hudState.pose = myPose;
  gloves.setMarker('left', obs.validity.punch_left ? obs.markers.left : undefined);
  gloves.setMarker('right', obs.validity.punch_right ? obs.markers.right : undefined);
  gloves.setGuard('left', myPose.guards.left);
  gloves.setGuard('right', myPose.guards.right);
  // Animate locally right away; the server decides whether it lands.
  for (const ev of events) {
    const type = ev.punchType ?? (ev.type === 'punch_left' ? 'left_straight' : 'right_straight');
    if (ev.type === 'punch_left') gloves.punch('left', type);
    if (ev.type === 'punch_right') gloves.punch('right', type);
  }
  hud.renderPose(myPose);

  if (view?.match.status === 'active') server.forwardCv(view.match.id, obs, events);
  if (trackingChanged) refresh();
});

setInput(hudState.input);
server.connect();

// ─── Initial screen flow ────────────────────────────────────────────────────
// name entry (first visit) → wii safety (once per session) → menu
{
  const savedName = loadPlayerName();
  const showMenu = () => {
    hudState.playerName = loadPlayerName() ?? undefined;
    refresh();
  };
  const showSafety = () => {
    markSafetyShown();
    hud.showWiiSafety(showMenu);
  };
  if (!savedName) {
    hud.showNameEntry((name) => {
      savePlayerName(name);
      hudState.playerName = name;
      showSafety();
    });
  } else {
    hudState.playerName = savedName;
    if (!safetyShownThisSession()) {
      showSafety();
    } else {
      showMenu();
    }
  }
}

// ─── Frame loop ────────────────────────────────────────────────────────────

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const rawDt = Math.min(clock.getDelta(), 0.05);
  const t = performance.now();
  const slowT = t < slowmoUntil ? Math.max(0.1, (slowmoUntil - t) / 2200) : 1; // ramp from 0.1→1
  const dt = rawDt * (t < slowmoUntil ? 0.1 + slowT * 0.3 : 1);

  // Corner scene owns camera during cinematic mode.
  const cinematic = cornerScene.update(dt);
  if (cinematic !== cinematicMode) {
    cinematicMode = cinematic;
    hudState.cinematic = cinematic;
    hud.render(hudState); // show/hide menu immediately when cinematic state changes
    // Hide the opponent model during the corner coach scene so it doesn't
    // appear in the background of the cinematic shot.
    opponent.root.visible = !cinematic;
    if (!cinematic) {
      // Snap camera back to ring-facing position — the corner scene leaves the
      // camera at a corner position with a yaw that the main loop never
      // resets, causing the opponent to appear off-screen to one side.
      camera.position.copy(EYE);
      camera.lookAt(0, 1.5, -1);
    }
  }

  if (!cinematic) {
    // Player dodge: slide + slight roll from the CV lateral displacement.
    const lateral = latest?.features.lateralDisplacementBodyWidths ?? 0;
    const targetX = EYE.x + lateral * BODY_WIDTH_M;
    const leanBack = 0; // lean_back not in Body type; lateral-only dodge
    camera.position.x += (targetX - camera.position.x) * Math.min(1, dt * 18);
    camera.position.z += (EYE.z + leanBack * 0.32 - camera.position.z) * Math.min(1, dt * 18);
    camera.rotation.z = -lateral * 0.12;
    camera.rotation.x += (BASE_PITCH + leanBack * 0.12 - camera.rotation.x) * Math.min(1, dt * 18);
    if (t < shakeUntil) {
      camera.position.y = EYE.y + (Math.random() - 0.5) * 0.04;
    } else {
      camera.position.y = EYE.y;
    }
  }

  // PvP opponent mirrors the other player's lateral; their left is my right.
  const pvpOpponent = view?.match.mode === 'pvp' && view.match.status === 'active' ? view.opponent : undefined;
  opponent.targetLateral = pvpOpponent ? -pvpOpponent.lateral * BODY_WIDTH_M * 0.5 : 0;
  if (pvpOpponent) {
    opponent.setPose(pvpOpponent.bodyState as Body, pvpOpponent.leftGuard as Guard, pvpOpponent.rightGuard as Guard);
  }

  if (view && view.opponent.health <= 0) {
    if (!koFlashTriggered) {
      koFlashTriggered = true;
      slowmoUntil = t + 2200; // 2.2s of slow-mo on KO
      const vig = document.getElementById('vignette')!;
      vig.classList.remove('hit', 'ko-flash');
      void vig.offsetWidth;
      vig.classList.add('ko-flash');
    }
    opponent.knockout();
  } else {
    opponent.standUp();
  }

  // Dialogue triggers (once per match).
  if (view?.match.status === 'active') {
    if (!lowHpDialogueShown && view.opponent.health < 300) {
      lowHpDialogueShown = true;
      hud.showDialogue(pickLine('low_hp'));
    }
    const gap = view.opponent.health - view.me.health;
    if (!winningDialogueShown && gap > 200) { winningDialogueShown = true; hud.showDialogue(pickLine('winning')); }
    if (!losingDialogueShown && gap < -200) { losingDialogueShown = true; hud.showDialogue(pickLine('losing')); }
  }

  opponent.update(dt, Date.now());
  gloves.update(dt);
  wheel.update(dt);

  // Project Tyson's head to screen for Mii-style speech bubbles
  if (view?.match.status === 'active' && !cinematic) {
    const headW = opponent.root.position.clone();
    headW.y += 2.1; // above head
    headW.project(camera);
    const sx = (headW.x * 0.5 + 0.5) * renderer.domElement.clientWidth;
    const sy = (-(headW.y * 0.5) + 0.5) * renderer.domElement.clientHeight;
    hud.setDialogueAnchor(sx, sy);
  }

  hud.tick(view);
  renderer.render(scene, camera);
});

return () => {
  alive = false;
  renderer.setAnimationLoop(null);
  window.removeEventListener('resize', resize);
  cornerScene.exit();
  wheel.hide();
  bridge.stop();
  feed.hide();
  cv.stop();
  server.close();
  hud.dispose();
  renderer.dispose();
};
}
