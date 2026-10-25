import './style.css';
import * as THREE from 'three';
import { buildArena, loadRing } from './scene/ring';
import { Boxer, PlayerGloves, cornerOf, type AnyPunch } from './scene/boxer';
import { SimulatedCvProvider } from './cv/simulatedProvider';
import { CvBridge } from './cv/bridge';
import { BrowserCv } from './cv/browserCv';
import type { CvHooks, CvInput } from './cv/input';
import { CameraFeed } from './cv/cameraFeed';
import { GuardCalibration, GuardClassifier, type GuardCalibrationData } from './cv/guard';
import { poseOf, type Body, type CvProvider, type Guard, type Observation, type PoseState } from './cv/contract';
import { ANSWER, DEFENSE_TEXT, OFFENSE_TEXT, PUNCH_NAME } from './combatText';
import { GameServer, type MatchView } from './net/server';
import { Hud, type HudState, type InputMode } from './hud';

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
camera.position.copy(EYE);
camera.lookAt(0, 1.5, -1);
const BASE_PITCH = camera.rotation.x;
scene.add(camera);

const gloves = new PlayerGloves();
camera.add(gloves.root);

const opponent = new Boxer();
scene.add(opponent.root);

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

const server = new GameServer({
  onStatus(status, detail) {
    hudState.server = status;
    hudState.serverDetail = detail;
    refresh();
  },
  onChange: refresh,
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
      if (atk.result === 'landed') opponent.takeHit();
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
    } else {
      hud.toast(atk.result === 'dodged' ? `${text} · counter ready` : text, 'good');
    }
  },
});

const hud = new Hud({
  fightBot: () => beforeFight(() => server.startBotMatch()),
  findPvp: () => beforeFight(() => server.joinPvp()),
  cancelPvp: () => server.leavePvp(),
  forfeit: () => view && server.forfeit(view.match.id),
  useKeyboard: () => setInput('keyboard'),
  useCamera: () => setInput('camera'),
  reconnectCamera: () => {
    void feed.show();
    cameraInput.reconnect();
  },
  cancelCalibration: () => endCalibration(false),
  skipCalibration: () => guardClassifier && endCalibration(true),
});

function refresh() {
  view = server.currentMatch();
  hudState.view = view;
  hudState.result = view ? server.result(view.match.id) : undefined;
  hudState.profile = server.profile();
  hudState.queued = server.inQueue();
  // The Claude-themed bot is PvE only; a PvP opponent is a fighter in their corner colour.
  opponent.setLook(view?.match.mode === 'pvp' ? cornerOf(view.opponent.slot) : 'claude');
  gloves.setCorner(cornerOf(view?.me.slot ?? 0));
  hud.render(hudState);
}

// ─── CV input ──────────────────────────────────────────────────────────────

// The keyboard and the webcam share one provider: camera input presses the same control
// keys the keyboard does. In camera mode the keyboard's punch/dodge/block keys are ignored
// so everything comes from CV; blocks are classified from the wrist and head markers
// against a per-player calibration (cv/guard.ts). X still recalibrates.
const sim = new SimulatedCvProvider();
const cv: CvProvider = sim;
const CV_DRIVEN_KEYS = ['j', 'c', 'q', 'e', 'a', 'd', 'b'];
const KEY_LABEL: Record<string, string> = {
  j: 'J', c: 'C', q: 'Q', e: 'E', a: 'hold A', d: 'hold D', b: 'hold B',
  cv_guard_left: 'left block', cv_guard_right: 'right block',
};
const GUARD_KEY = { left: 'cv_guard_left', right: 'cv_guard_right' } as const;
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
  hud.renderCalibration(calibration?.view(), {
    canSkip: !!guardClassifier, camera: hudState.camera, source: hudState.cameraSource, detail: hudState.cameraDetail,
  });
}

/** In camera mode, calibrate stance and block before the match or queue starts. */
function beforeFight(action: () => void) {
  if (hudState.input !== 'camera') return action();
  afterCalibration = action;
  calibration = new GuardCalibration({
    onStance: () => cameraInput.resetCalibration(),
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
// Camera classification runs in the browser by default (cv/browserCv.ts). The Python CV
// bridge is the dev and tuning source: NEXT_PUBLIC_CV_SOURCE=bridge, `?cvSource=bridge`, or
// `?cvBridge=ws://127.0.0.1:8799` (a different bridge, e.g. a synthetic one) picks it.
const params = new URLSearchParams(location.search);
const bridgeUrl = params.get('cvBridge') ?? undefined;
const sourceKind = params.get('cvSource') ?? (bridgeUrl ? 'bridge' : process.env.NEXT_PUBLIC_CV_SOURCE ?? 'browser');
const cameraHooks: CvHooks = {
  onStatus(status, detail) {
    if (status === 'connected' && hudState.camera !== 'connected') hud.toast('camera tracking on', 'good');
    else if (status === 'disconnected' && hudState.camera === 'connected') hud.toast(detail ?? 'camera tracking lost', 'bad');
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
  onStats(stats) {
    hudState.cameraStats = stats;
    refresh();
  },
};
const cameraInput: CvInput = sourceKind === 'bridge' ? new CvBridge(sim, cameraHooks, bridgeUrl) : new BrowserCv(sim, cameraHooks, feed);
hudState.cameraSource = cameraInput.kind;

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
  cameraInput.stop();
  setCvGuards({ left: 'neutral', right: 'neutral' });
  hudState.camera = 'off';
  hudState.lastCv = undefined;
  if (mode === 'camera') {
    void feed.show();
    cameraInput.start();
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
refresh();

// ─── Frame loop ────────────────────────────────────────────────────────────

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = performance.now();

  // Player dodge: slide + slight roll from the CV lateral displacement.
  const lateral = latest?.features.lateralDisplacementBodyWidths ?? 0;
  const targetX = EYE.x + lateral * BODY_WIDTH_M;
  const leanBack = 0;
  camera.position.x += (targetX - camera.position.x) * Math.min(1, dt * 18);
  camera.position.z += (EYE.z + leanBack * 0.32 - camera.position.z) * Math.min(1, dt * 18);
  camera.rotation.z = -lateral * 0.12;
  camera.rotation.x += (BASE_PITCH + leanBack * 0.12 - camera.rotation.x) * Math.min(1, dt * 18);
  if (t < shakeUntil) {
    camera.position.y = EYE.y + (Math.random() - 0.5) * 0.04;
  } else {
    camera.position.y = EYE.y;
  }

  // PvP opponent mirrors the other player's lateral; their left is my right.
  const pvpOpponent = view?.match.mode === 'pvp' && view.match.status === 'active' ? view.opponent : undefined;
  opponent.targetLateral = pvpOpponent ? -pvpOpponent.lateral * BODY_WIDTH_M * 0.5 : 0;
  if (pvpOpponent) {
    opponent.setPose(pvpOpponent.bodyState as Body, pvpOpponent.leftGuard as Guard, pvpOpponent.rightGuard as Guard);
  }

  if (view && view.opponent.health <= 0) opponent.knockout();
  else opponent.standUp();

  opponent.update(dt, Date.now());
  gloves.update(dt);
  hud.tick(view);
  renderer.render(scene, camera);
});

return () => {
  alive = false;
  renderer.setAnimationLoop(null);
  window.removeEventListener('resize', resize);
  cameraInput.stop();
  feed.hide();
  cv.stop();
  server.close();
  hud.dispose();
  renderer.dispose();
};
}
