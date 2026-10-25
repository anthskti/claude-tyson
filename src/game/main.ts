import './style.css';
import * as THREE from 'three';
import { buildArena, loadRing } from './scene/ring';
import { Boxer, PlayerGloves, cornerOf, type AnyPunch } from './scene/boxer';
import { Arena, RING_COUNT } from './scene/arena';
import { SimulatedCvProvider } from './cv/simulatedProvider';
import { CvBridge } from './cv/bridge';
import { BrowserCv } from './cv/browserCv';
import type { CvHooks, CvInput } from './cv/input';
import { CameraFeed } from './cv/cameraFeed';
import { GuardCalibration, GuardClassifier, type GuardCalibrationData } from './cv/guard';
import { poseOf, type Body, type CvProvider, type Guard, type Observation, type PoseState } from './cv/contract';
import { ANSWER, DEFENSE_TEXT, OFFENSE_TEXT, PUNCH_NAME } from './combatText';
import { GameServer, type MatchView, type RingView } from './net/server';
import { Hud, type HudState, type InputMode, type RingSummary } from './hud';
import { parsePatch, type StrategyRequest } from '../../coach/strategist';
import type { AnalysisRequest } from '../../coach/analysis';
import type { FightWindowRow } from './net/server';

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
// The player's own ring, drawn first-person at the origin. Every other ring, and this
// one while spectating, belongs to the arena.
const firstPerson = new THREE.Group();
scene.add(firstPerson);
loadRing().then(ring => {
  if (alive) firstPerson.add(ring);
});
const arena = new Arena();
scene.add(arena.root);

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
firstPerson.add(opponent.root);

// Spectator camera: a slow orbit outside the ropes of the watched ring.
const ORBIT_RADIUS_M = 9.5;
const ORBIT_HEIGHT_M = 5;
const ORBIT_RAD_PER_S = 0.12;
let orbitAngle = 0.6;
// The 2 × 2 grid leaves a gap at world origin. Orbit inside it while looking
// outward; looking back at the origin would show only empty floor.
const LOBBY_RADIUS_M = 0.9;
const LOBBY_HEIGHT_M = 3.2;
const LOBBY_LOOK_DISTANCE_M = 10;
let lobbyAngle = Math.PI / 4;

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
  rings: [], queueLength: 0, spectating: false, watch: 0, names: ['YOU', 'OPPONENT'],
};
let view: MatchView | undefined;
let rings: RingView[] = [];
// Set by a ring picked in the menu or the spectator bar; otherwise the busiest ring is shown.
let pickedRing: number | undefined;
// Server updates from every ring land many times a second; redraw the HUD once per frame.
let dirty = true;
const markDirty = () => {
  dirty = true;
};
let latest: Observation | undefined;
let myPose: PoseState = { body: 'neutral', guards: { left: 'neutral', right: 'neutral' } };
let shakeUntil = 0;
const requestedWindows = new Set<string>();
const analyzingMatches = new Set<string>();
const strategyInFlight = new Set<string>();
const loggedBotMatches = new Set<string>();

async function onFightWindow(window: FightWindowRow) {
  const matchId = String(window.matchId);
  const key = `${matchId}:${window.id}`;
  if (requestedWindows.has(key) || strategyInFlight.has(matchId)) return;
  const current = server.currentMatch();
  if (!current || current.match.id !== window.matchId || current.match.mode !== 'bot' ||
      current.match.status !== 'active' || !current.strategy) return;
  requestedWindows.add(key);
  const attempts = window.playerStraights + window.playerHooks + window.playerUnclassified;
  hud.logClaude('window', `Match ${matchId}, window ${window.id}: ${window.playerLanded}/${attempts} punches landed; tracking ${Math.round(window.trackingCoverage * 100)}%.`);
  if (window.trackingCoverage < 0.5) {
    hud.logClaude('strategy', 'Strategy unchanged: tracking was too unreliable.');
    return;
  }
  const p = server.profile();
  const s = current.strategy;
  const req: StrategyRequest = {
    windowId: String(window.id), matchId, revision: s.revision,
    attempts,
    landed: window.playerLanded, leftAttempts: window.playerLeftAttempts,
    rightAttempts: window.playerRightAttempts, straights: window.playerStraights,
    hooks: window.playerHooks, slips: window.playerSlips, blocks: window.playerBlocks,
    hitsTaken: window.playerHitsTaken, trackingCoverage: window.trackingCoverage,
    profile: { leftAttempts: p?.leftAttempts ?? 0, rightAttempts: p?.rightAttempts ?? 0,
      straights: p?.straights ?? 0, hooks: p?.hooks ?? 0, punchesLanded: p?.punchesLanded ?? 0 },
    strategy: { aggression: s.aggression, punchIntervalMs: s.punchIntervalMs,
      jabWeight: s.jabWeight, straightWeight: s.straightWeight, hookWeight: s.hookWeight,
      leftBias: s.leftBias, defenseRate: s.defenseRate, telegraphMs: s.telegraphMs,
      explanation: s.explanation },
  };
  strategyInFlight.add(matchId);
  hud.logClaude('strategy', `Checking window ${window.id} with Claude…`);
  try {
    const response = await fetch('/api/strategist', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) });
    if (!response.ok) {
      hud.logClaude('error', `Strategy request failed (${response.status}); current strategy stays active.`);
      return;
    }
    const patch = parsePatch(await response.json());
    const latest = server.currentMatch();
    if (!patch) {
      hud.logClaude('error', 'Strategy response was invalid; current strategy stays active.');
      return;
    }
    if (!('aggression' in patch)) {
      hud.logClaude('strategy', patch.reason);
      return;
    }
    if (!latest || latest.match.id !== window.matchId ||
        latest.match.status !== 'active' || latest.strategy?.revision !== s.revision) {
      hud.logClaude('strategy', 'Strategy response arrived after the fight changed; discarded.');
      return;
    }
    const { skip: _skip, ...fields } = patch;
    await server.applyStrategyUpdate(window.matchId, window.id, s.revision, fields);
    hud.logClaude('strategy', `Applied revision ${s.revision + 1}: ${fields.explanation} (aggression ${fields.aggression.toFixed(2)}, left bias ${fields.leftBias.toFixed(2)}).`);
  } catch (error) {
    console.warn('[strategist]', error);
    hud.logClaude('error', 'Strategy update failed; current strategy stays active.');
  } finally {
    strategyInFlight.delete(matchId);
  }
}

async function analyzeMatch(matchId: bigint, mySlot: number, won: boolean, reason: string, playerName: string, playerHealth: number) {
  const key = String(matchId);
  if (analyzingMatches.has(key)) return;
  analyzingMatches.add(key);
  const attacks = server.attacks(matchId).filter(a => a.result !== 'pending' &&
    a.result !== 'cancelled' && a.result !== 'unscorable');
  const mine = attacks.filter(a => a.attackerSlot === mySlot);
  const incoming = attacks.filter(a => a.attackerSlot !== mySlot);
  const req: AnalysisRequest = {
    matchId: key, playerName, playerHealth, won, reason,
    attempts: mine.length,
    landed: mine.filter(a => a.result === 'landed').length,
    straights: mine.filter(a => a.punchType.endsWith('_straight')).length,
    hooks: mine.filter(a => a.punchType.endsWith('_hook')).length,
    slips: incoming.filter(a => a.detail === 'slipped').length,
    blocks: incoming.filter(a => a.result === 'blocked').length,
    hitsTaken: incoming.filter(a => a.result === 'landed').length,
  };
  hud.logClaude('analysis', `Match ${key} ended by ${reason}. Requesting analysis from ${req.landed}/${req.attempts} landed punches.`);
  try {
    const response = await fetch('/api/analysis', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) });
    if (!response.ok) {
      hud.logClaude('error', `Analysis request failed (${response.status}).`);
      return;
    }
    const data = await response.json() as { text?: string; source?: 'claude' | 'offline' };
    if (typeof data.text === 'string' && data.text && server.result(matchId)?.analysis === '') {
      await server.submitFightAnalysis(matchId, data.text);
      hud.logClaude('analysis', `${data.source === 'claude' ? 'Claude analysis' : 'Offline analysis'} saved to the fight result: ${data.text}`);
    }
  } catch (error) {
    console.warn('[analysis]', error);
    hud.logClaude('error', 'Analysis could not be saved.');
  }
}

const server = new GameServer({
  onStatus(status, detail) {
    hudState.server = status;
    hudState.serverDetail = detail;
    refresh();
  },
  onChange: markDirty,
  onFightWindow: window => { void onFightWindow(window); },
  onError: message => hud.toast(message, 'bad'),
  onRingAttack: atk => arena.attack(atk),
  onRingAttackResolved: atk => arena.resolved(atk),
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
  spectate: () => setSpectating(true),
  leaveSpectate: () => setSpectating(false),
  watchPrev: () => watch(hudState.watch - 1),
  watchNext: () => watch(hudState.watch + 1),
  watch: ring => {
    watch(ring);
    setSpectating(true);
  },
});

function setSpectating(on: boolean) {
  hudState.spectating = on;
  refresh();
}

function watch(ring: number) {
  pickedRing = (ring + RING_COUNT) % RING_COUNT;
  refresh();
}

const MODE_LABEL: Record<string, string> = { pvp: 'PvP', bot: 'vs bot', exhibition: 'Exhibition' };

function summarize(r: RingView): RingSummary {
  const m = r.match;
  if (!m) return { ring: r.ring, free: true, label: 'Empty' };
  const [red, blue] = r.fighters;
  const hp = (f: typeof red) => (f ? Math.max(0, Math.round(f.health / 10)) : 0);
  const result = m.status === 'active' ? '' : ' · ended';
  return {
    ring: r.ring,
    free: m.mode === 'exhibition' || m.status !== 'active',
    label: MODE_LABEL[m.mode] ?? m.mode,
    fighters: `${server.nameOf(red)} ${hp(red)} · ${hp(blue)} ${server.nameOf(blue)}${result}`,
  };
}

/** The ring the spectator camera shows: the picked one, else a human fight, else any fight. */
function watchedRing(): number {
  if (pickedRing !== undefined) return pickedRing;
  const live = rings.filter(r => r.match?.status === 'active');
  return (live.find(r => r.match!.mode !== 'exhibition') ?? live[0] ?? rings[0])?.ring ?? 0;
}

/** First-person while I'm in a match or looking at its result; otherwise the arena. */
function isFirstPerson(): boolean {
  return !!view && !hudState.spectating;
}

function refresh() {
  dirty = false;
  view = server.currentMatch();
  sim.setStamina(view?.me.stamina ?? 0);
  rings = server.rings();
  // A fight of mine starting (say, from the queue) pulls me out of spectating.
  if (view?.match.status === 'active') hudState.spectating = false;
  hudState.view = view;
  hudState.result = view ? server.result(view.match.id) : undefined;
  if (view?.match.mode === 'bot' && view.match.status === 'finished' &&
      hudState.result && !hudState.result.analysis) {
    void analyzeMatch(view.match.id, view.me.slot, hudState.result.winnerSlot === view.me.slot,
      hudState.result.reason, server.nameOf(view.me), view.me.health / 10);
  }
  hudState.profile = server.profile();
  if (view?.match.mode === 'bot' && view.match.status === 'active') {
    const matchId = String(view.match.id);
    if (!loggedBotMatches.has(matchId)) {
      loggedBotMatches.add(matchId);
      hud.logClaude('strategy', `Match ${matchId} started with the baseline bot strategy. Claude checks reliable fight windows as they arrive.`);
    }
    const latestWindow = server.windows(view.match.id).at(-1);
    if (latestWindow) void onFightWindow(latestWindow);
  }
  hudState.queued = server.inQueue();
  hudState.queueLength = server.queueLength();
  hudState.rings = rings.map(summarize);
  hudState.watch = watchedRing();
  const watched = rings[hudState.watch];
  hudState.names = isFirstPerson()
    ? ['YOU', view?.match.mode === 'bot' ? 'BOT' : server.nameOf(view?.opponent)]
    : [server.nameOf(watched?.fighters[0]), server.nameOf(watched?.fighters[1])];
  // The Claude-themed bot is PvE only; a PvP opponent is a fighter in their corner colour.
  opponent.setLook(view?.match.mode === 'pvp' ? cornerOf(view.opponent.slot) : 'claude');
  arena.sync(rings);
  hud.render(hudState);
}

/** The watched ring as a MatchView, red as `me`, for the health bars and timer. */
function watchedView(): MatchView | undefined {
  const r = rings[hudState.watch];
  if (!r?.match || r.fighters.length < 2) return undefined;
  return { match: r.match, me: r.fighters[0], opponent: r.fighters[1] };
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
  if (dirty) refresh();

  const fp = isFirstPerson();
  firstPerson.visible = fp;
  gloves.root.visible = fp;
  arena.setFocus(fp ? view!.match.ring : hudState.spectating ? hudState.watch : null, fp, fp && view!.me.slot === 1);
  arena.update(dt, Date.now());
  if (!fp) {
    if (hudState.spectating) {
      orbitAngle += dt * ORBIT_RAD_PER_S;
      camera.position.set(Math.sin(orbitAngle) * ORBIT_RADIUS_M, ORBIT_HEIGHT_M, Math.cos(orbitAngle) * ORBIT_RADIUS_M);
      camera.lookAt(0, 1.1, 0);
      hud.tick(watchedView());
    } else {
      lobbyAngle += dt * ORBIT_RAD_PER_S;
      camera.position.set(Math.sin(lobbyAngle) * LOBBY_RADIUS_M, LOBBY_HEIGHT_M, Math.cos(lobbyAngle) * LOBBY_RADIUS_M);
      camera.lookAt(Math.sin(lobbyAngle) * LOBBY_LOOK_DISTANCE_M, 1.2, Math.cos(lobbyAngle) * LOBBY_LOOK_DISTANCE_M);
      hud.tick(undefined);
    }
    renderer.render(scene, camera);
    return;
  }
  camera.rotation.y = 0;

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
