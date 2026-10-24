import './style.css';
import * as THREE from 'three';
import { buildArena, loadRing } from './scene/ring';
import { Boxer, PlayerGloves, type AnyPunch } from './scene/boxer';
import { SimulatedCvProvider } from './cv/simulatedProvider';
import { poseOf, type Body, type CvProvider, type Guard, type Observation, type PoseState } from './cv/contract';
import { ANSWER, DEFENSE_TEXT, OFFENSE_TEXT, PUNCH_NAME } from './combatText';
import { GameServer, type MatchView } from './net/server';
import { Hud, type HudState } from './hud';

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

const hudState: HudState = { server: 'connecting', tracking: 'calibrating', queued: false };
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
    const counter = atk.counter && atk.result !== 'dodged' ? ' · COUNTER' : '';
    if (atk.attackerSlot === v.me.slot) {
      if (v.match.mode === 'bot') opponent.showDefense(atk.defenderBody as Body, atk.defenderGuard);
      if (atk.result === 'landed') opponent.takeHit();
      const text = OFFENSE_TEXT[atk.detail] ?? atk.result;
      hud.toast(atk.damage > 0 ? `${text} −${atk.damage}${counter}` : text, atk.damage > 0 ? 'good' : 'info');
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
      hud.toast(`${text} −${atk.damage}${counter}`, 'bad');
    } else {
      hud.toast(atk.result === 'dodged' ? `${text} · counter ready` : text, 'good');
    }
  },
});

const hud = new Hud({
  fightBot: () => server.startBotMatch(),
  findPvp: () => server.joinPvp(),
  cancelPvp: () => server.leavePvp(),
  forfeit: () => view && server.forfeit(view.match.id),
});

function refresh() {
  view = server.currentMatch();
  hudState.view = view;
  hudState.result = view ? server.result(view.match.id) : undefined;
  hudState.profile = server.profile();
  hudState.queued = server.inQueue();
  hud.render(hudState);
}

// ─── CV input ──────────────────────────────────────────────────────────────

// Swap this for Hani's provider (Python WebSocket bridge or browser worker) once ready.
const cv: CvProvider = new SimulatedCvProvider();
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
    const type = ev.punchType ?? 'unclassified';
    if (ev.type === 'punch_left') gloves.punch('left', type);
    if (ev.type === 'punch_right') gloves.punch('right', type);
  }
  hud.renderPose(myPose);

  if (view?.match.status === 'active') server.forwardCv(view.match.id, obs, events);
  if (trackingChanged) refresh();
});

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
  const leanBack = myPose.body === 'lean_back' ? 1 : 0;
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
  cv.stop();
  server.close();
  hud.dispose();
  renderer.dispose();
};
}
