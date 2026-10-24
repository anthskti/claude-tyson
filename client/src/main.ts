import './style.css';
import * as THREE from 'three';
import { buildArena, loadRing } from './scene/ring';
import { Boxer, PlayerGloves, type AnyPunch } from './scene/boxer';
import { SimulatedCvProvider } from './cv/simulatedProvider';
import { RealCvProvider } from './cv/realProvider';
import { poseOf, type Body, type CvProvider, type Guard, type Observation, type PoseState } from './cv/contract';
import { ANSWER, DEFENSE_TEXT, OFFENSE_TEXT, PUNCH_NAME } from './combatText';
import { GameServer, type MatchView } from './net/server';
import { Hud, type HudState } from './hud';
import { DebugLog } from './debugLog';
import { AdaptationManager } from './adaptationManager';
import { MahoragasWheel } from './scene/mahoragasWheel';
import { CornerScene } from './cornerScene';
import { pickLine } from './dialogue';
import { CalibrationScreen } from './calibration';
import { CvFeed } from './cvFeed';

// ─── Scene ─────────────────────────────────────────────────────────────────

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();
buildArena(scene);
loadRing().then(ring => scene.add(ring));

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
// Let Boxer use its own BOT_POSITION (0, 0, -2.6); 3 m across the ring from the camera.
scene.add(opponent.root);

// ── Maharagas Wheel ─────────────────────────────────────────────────────
const wheel = new MahoragasWheel();
scene.add(wheel.group);

function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// ─── Debug + adaptation + corner scene (declared early; initialized after server/hud) ─

let debugLog: DebugLog | undefined;
let adaptationManager: AdaptationManager | undefined;
let cornerScene: CornerScene | undefined;
let cinematicMode = false;

// ─── Game state ────────────────────────────────────────────────────────────

const hudState: HudState = { server: 'connecting', tracking: 'calibrating', queued: false };
let view: MatchView | undefined;
let debriefShown = false;
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
  onFightWindow(window, strategy) {
    const attempts = window.playerJabs + window.playerStraights + window.playerHooks +
      window.playerUppercuts + window.playerUnclassified;
    debugLog?.add('window', `W#${window.id} player+${window.playerLanded}/${attempts} bot-${window.botHealth}hp trk=${(window.trackingCoverage * 100).toFixed(0)}%`);
    adaptationManager?.onWindow(window, strategy);
  },
  onAttackResolved(atk, v) {
    if (atk.result === 'cancelled') return;
    const counter = atk.counter && atk.result !== 'dodged' ? ' · COUNTER' : '';
    if (atk.attackerSlot === v.me.slot) {
      if (v.match.mode === 'bot') opponent.showDefense(atk.defenderBody as Body, atk.defenderGuard);
      if (atk.result === 'landed') {
        opponent.takeHit();
        // Claude Tyson reacts to taking damage (occasional, not every hit)
        if (Math.random() < 0.35) {
          hud.showDialogue(pickLine(atk.damage >= 9 ? 'hit_taken_heavy' : 'hit_taken_light'));
        }
      }
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
      // Claude Tyson taunts when he lands
      if (Math.random() < 0.28) {
        hud.showDialogue(pickLine('hit_landed'));
      }
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

// Initialize debug log and adaptation manager now that server + hud exist.
debugLog = new DebugLog();
adaptationManager = new AdaptationManager({
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
    // Maharagas wheel clanks + JJK dialogue + purple flash
    wheel.clank();
    hud.showAdaptedTag(explanation);
    hud.showDialogue(pickLine('adaptation'));
    debugLog?.add('strategy', `ADAPTED: ${explanation}`);
  },
  onAdaptation: (outcome, explanation) => {
    hud.showAdaptation(outcome, explanation);
    debugLog?.add('outcome', `${outcome === 'improved' ? 'KEPT ✓' : 'NOTED ✗'} — ${explanation}`);
  },
  log: (msg) => debugLog?.add('strategy', msg),
});

cornerScene = new CornerScene({
  scene,
  camera,
  onAnalysis: (text, source) => {
    hud.showCornerAnalysis(text, source, () => {
      // "GOT IT" pressed: exit corner scene, show menu again
      cinematicMode = false;
      cornerScene?.exit();
      refresh();
    });
    debugLog?.add('analysis', `[${source.toUpperCase()}] ${text}`);
  },
});

window.addEventListener('keydown', (e) => {
  if (e.key === '`') debugLog?.toggle();
});

let prevMatchId: string | undefined;
let prevMatchStatus: string | undefined;

function refresh() {
  view = server.currentMatch();
  hudState.view = view;
  hudState.result = view ? server.result(view.match.id) : undefined;
  hudState.profile = server.profile();
  hudState.queued = server.inQueue();
  hudState.cinematic = cinematicMode;
  hud.render(hudState);

  const matchId = view ? String(view.match.id) : undefined;
  const status = view?.match.status;

  // New active match started
  if (status === 'active' && view?.match.mode === 'bot') {
    if (matchId !== prevMatchId) {
      // New fight: reset state, show wheel, opening taunt
      debriefShown = false;
      adaptationManager?.reset();
      cinematicMode = false;
      hud.hideCornerAnalysis();
      cornerScene?.exit();
      wheel.show();
      hud.showDialogue(pickLine('fight_start'));
    }
  }

  // Fight just finished — show result briefly, then enter corner scene after 2s
  if (!debriefShown && status !== 'active' && prevMatchStatus === 'active') {
    debriefShown = true;
    const won = hudState.result?.winnerSlot === view?.me.slot;
    hud.showDialogue(pickLine(won ? 'fight_end_win' : 'fight_end_lose'));
    wheel.hide();

    if (view && !cinematicMode) {
      const capturedView = view;
      const capturedWon = won ?? false;
      // Let the result screen show for 2s, then transition to corner scene
      setTimeout(() => {
        cinematicMode = true;
        hudState.cinematic = true;
        hud.render(hudState); // hide menu
        cornerScene?.enter(
          server.conn,
          capturedView.match.id,
          capturedWon,
          hudState.result?.reason ?? 'time',
          wheel.totalClanks,
        );
      }, 2000);
    }
  }

  prevMatchId = matchId;
  prevMatchStatus = status;
}

// ─── CV input ──────────────────────────────────────────────────────────────

// Real provider by default; ?sim forces keyboard simulation.
const useSim = new URLSearchParams(location.search).has('sim');
const cv: CvProvider = useSim ? new SimulatedCvProvider() : new RealCvProvider();
hudState.cvSource = cv.source === 'live' ? 'live' : 'synthetic';
const calibration = new CalibrationScreen(useSim);
// Only show the camera feed PiP when using real CV (not sim)
const cvFeed = useSim ? null : new CvFeed();
let simFallbackSignalled = false;

cv.start((obs, events) => {
  const trackingChanged = obs.trackingState !== hudState.tracking;
  latest = obs;
  hudState.tracking = obs.trackingState;
  hudState.trackingReason = obs.reason;

  // Detect when RealCvProvider has fallen back to sim (sessionId begins with 'sim-')
  const isSim = (obs as any).sessionId?.startsWith('sim-') ?? false;
  if (isSim && !simFallbackSignalled) {
    simFallbackSignalled = true;
    hudState.cvSource = 'synthetic';
    calibration.onSimFallback();
  } else if (!isSim) {
    calibration.onTrackingState(obs.trackingState);
  }

  myPose = poseOf(obs);
  hudState.pose = myPose;
  cvFeed?.update(obs);
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
let lowHpDialogueShown = false;

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = performance.now();

  // ── Corner scene owns camera during cinematic mode ──────────────────────
  const cinematic = cornerScene?.update(dt) ?? false;

  if (!cinematic) {
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
  }

  // PvP opponent mirrors the other player's lateral; their left is my right.
  const pvpOpponent = view?.match.mode === 'pvp' && view.match.status === 'active' ? view.opponent : undefined;
  opponent.targetLateral = pvpOpponent ? -pvpOpponent.lateral * BODY_WIDTH_M * 0.5 : 0;
  if (pvpOpponent) {
    opponent.setPose(pvpOpponent.bodyState as Body, pvpOpponent.leftGuard as Guard, pvpOpponent.rightGuard as Guard);
  }

  opponent.update(dt, Date.now());
  gloves.update(dt);
  wheel.update(dt);
  hud.tick(view);

  // Low-HP dialogue (bot below 30) — once per match
  if (view?.match.status === 'active' && !lowHpDialogueShown) {
    if (view.opponent.health < 30) {
      lowHpDialogueShown = true;
      hud.showDialogue(pickLine('low_hp'));
    }
  }
  if (view?.match.status !== 'active') lowHpDialogueShown = false;

  renderer.render(scene, camera);
});
