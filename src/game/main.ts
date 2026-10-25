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
import { MahoragasWheel } from './scene/mahoragasWheel';
import { CornerScene } from './cornerScene';
import { AdaptationManager } from './adaptationManager';
import { DebugLog } from './debugLog';
import { FriendsPanel } from './friendsPanel';
import { pickLine } from './dialogue';
import { renderBotPortrait } from './vsPortrait';

const PLAYER_NAME_KEY = 'claude-tyson.player-name';
function loadPlayerName(): string | null {
  try { return localStorage.getItem(PLAYER_NAME_KEY); } catch { return null; }
}
function savePlayerName(name: string) {
  try { localStorage.setItem(PLAYER_NAME_KEY, name); } catch {}
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
// The player's own ring, drawn first-person at the origin. Every other ring, and this
// one while spectating, belongs to the arena.
const firstPerson = new THREE.Group();
scene.add(firstPerson);
loadRing().then(ring => {
  if (alive) firstPerson.add(ring);
});
const arena = new Arena();
scene.add(arena.root);
const wheel = new MahoragasWheel();
scene.add(wheel.group);

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

// ─── Cinematic home-screen camera ──────────────────────────────────────────
// Multi-shot sequence: each shot slowly drifts between two positions,
// then cross-fades to the next. Rings sit in a 2×2 grid; when focus=ring0
// they occupy (0,0,0), (16,0,0), (0,0,16), (16,0,16).
interface CinematicShot {
  startPos: THREE.Vector3;
  endPos:   THREE.Vector3;
  lookAt:   THREE.Vector3;
  fov:      number;
  duration: number; // seconds
}
const CINEMATIC_SHOTS: CinematicShot[] = [
  // 1 – Epic overhead: all four rings visible
  { startPos: new THREE.Vector3(8, 28, 20), endPos: new THREE.Vector3(8, 22, 12),
    lookAt: new THREE.Vector3(8, 0, 8), fov: 52, duration: 10 },
  // 2 – Ringside low: looking up into ring 0
  { startPos: new THREE.Vector3(-3, 2.2, -8), endPos: new THREE.Vector3(0, 1.8, -4),
    lookAt: new THREE.Vector3(0, 1.6, 0), fov: 68, duration: 8 },
  // 3 – Far corner diagonal: ring 3 (16,0,16) and beyond
  { startPos: new THREE.Vector3(26, 7, 26), endPos: new THREE.Vector3(22, 5.5, 22),
    lookAt: new THREE.Vector3(8, 0, 8), fov: 60, duration: 9 },
  // 4 – Side tracking past ring 1 (16,0,0)
  { startPos: new THREE.Vector3(24, 4, -10), endPos: new THREE.Vector3(24, 3.5, 6),
    lookAt: new THREE.Vector3(16, 1.2, 0), fov: 62, duration: 8 },
  // 5 – Inside-the-action: low angle between rings 0 and 2
  { startPos: new THREE.Vector3(-4, 1.6, 4), endPos: new THREE.Vector3(-2, 2.4, 10),
    lookAt: new THREE.Vector3(4, 1.4, 8), fov: 72, duration: 9 },
];
const CINEMATIC_BLEND_S = 1.2; // cross-fade duration
let cinShotIdx = 0;
let cinShotT = 0;   // progress within current shot [0..1]
let cinBlendT = -1; // ≥0 while blending out (-1 = not blending)
const cinCamA = new THREE.PerspectiveCamera(60, 1, 0.03, 150);
const cinCamB = new THREE.PerspectiveCamera(60, 1, 0.03, 150);
const cinTarget = document.createElement('canvas'); // off-screen target for blend
cinTarget.style.display = 'none';

function cinStep(dt: number) {
  const shot = CINEMATIC_SHOTS[cinShotIdx];
  cinShotT = Math.min(1, cinShotT + dt / shot.duration);

  // Ease: slow in + slow out (smoothstep)
  const ease = cinShotT * cinShotT * (3 - 2 * cinShotT);
  const pos = new THREE.Vector3().lerpVectors(shot.startPos, shot.endPos, ease);
  camera.position.copy(pos);
  camera.lookAt(shot.lookAt);
  camera.fov = shot.fov;
  camera.updateProjectionMatrix();

  if (cinShotT >= 1) {
    cinShotIdx = (cinShotIdx + 1) % CINEMATIC_SHOTS.length;
    cinShotT = 0;
  }
}

function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  const aspect = window.innerWidth / window.innerHeight;
  camera.aspect = aspect;
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
  playerName: loadPlayerName() ?? undefined,
};
let view: MatchView | undefined;
let rings: RingView[] = [];
let cinematicMode = false;
let debriefShown = false;
let debriefTimer = 0;
let prevMatchId: string | undefined;
let prevMatchStatus: string | undefined;
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

const server = new GameServer({
  onStatus(status, detail) {
    hudState.server = status;
    hudState.serverDetail = detail;
    refresh();
  },
  onChange: markDirty,
  onError: message => hud.toast(message, 'bad'),
  onFightWindow(fw, strategy) {
    adaptationManager.onWindow(fw, strategy);
    const att = fw.playerJabs + fw.playerStraights + fw.playerHooks +
      fw.playerUppercuts + ((fw as any).playerUnclassified || 0);
    debugLog.add('window', `W#${fw.id} +${fw.playerLanded}/${att} bot${fw.botHealth}hp trk=${(fw.trackingCoverage * 100).toFixed(0)}%`);
  },
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
      if (atk.result === 'landed') {
        opponent.takeHit();
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
    beforeFight(async () => {
      const portrait = await renderBotPortrait(renderer);
      hud.showVsScreen(hudState.playerName ?? 'YOU', portrait, () => server.startBotMatch());
    });
  },
  findPvp: () => {
    if (hudState.server !== 'online') { hud.toast(`Server ${hudState.server} — run: spacetime start`, 'bad'); return; }
    beforeFight(async () => {
      const portrait = await renderBotPortrait(renderer);
      hud.showVsScreen(hudState.playerName ?? 'YOU', portrait, () => server.joinPvp());
    });
  },
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
  changeName: () => {
    hud.showNameEntry((name) => {
      savePlayerName(name);
      hudState.playerName = name;
      refresh();
      hud.showWiiSafety(() => refresh());
    });
  },
});

const debugLog = new DebugLog();
new FriendsPanel((msg, kind) => hud.toast(msg, kind));

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
    debugLog.add('outcome', `${outcome === 'improved' ? 'KEPT' : 'REVERSED'}: ${explanation}`);
  },
  log: (msg) => { console.log('[adaptation]', msg); debugLog.add('strategy', msg); },
});

const cornerScene = new CornerScene({
  scene, camera, renderer,
  onAnalysis: (text, source) => debugLog.add('analysis', `[${source}] ${text}`),
  onExit: () => {
    cinematicMode = false;
    hudState.cinematic = false;
    hudState.debriefing = false;
    wheel.show();
    refresh();
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
  const hp = (f: typeof red) => (f ? Math.max(0, Math.round(f.health)) : 0);
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
  hudState.profile = server.profile();
  hudState.queued = server.inQueue();
  hudState.queueLength = server.queueLength();
  hudState.rings = rings.map(summarize);
  hudState.watch = watchedRing();
  const watched = rings[hudState.watch];
  hudState.names = isFirstPerson()
    ? [hudState.playerName ?? 'YOU', view?.match.mode === 'bot' ? 'BOT' : server.nameOf(view?.opponent)]
    : [server.nameOf(watched?.fighters[0]), server.nameOf(watched?.fighters[1])];
  // The Claude-themed bot is PvE only; a PvP opponent is a fighter in their corner colour.
  opponent.setLook(view?.match.mode === 'pvp' ? cornerOf(view.opponent.slot) : 'claude');
  gloves.setCorner(cornerOf(view?.me.slot ?? 0));
  arena.sync(rings);

  const matchId = view ? String(view.match.id) : undefined;
  const status = view?.match.status;

  if (status === 'active' && matchId !== prevMatchId) {
    debriefShown = false;
    window.clearTimeout(debriefTimer);
    hudState.debriefing = false;
    cinematicMode = false;
    hudState.cinematic = false;
    cornerScene.exit();
    wheel.show();
    adaptationManager.reset(BigInt(view!.match.id));
    hud.showDialogue(pickLine('fight_start'));
  }

  if (!debriefShown && status !== 'active' && prevMatchStatus === 'active') {
    debriefShown = true;
    const won = hudState.result?.winnerSlot === view?.me.slot;
    const reason = hudState.result?.reason ?? 'time';
    hud.showDialogue(pickLine(won ? 'fight_end_win' : 'fight_end_lose'));
    if (view && !cinematicMode) {
      const stars = won ? (view.me.health >= 70 ? 3 : view.me.health >= 35 ? 2 : 1) : 0;
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
  hud.renderPose(myPose, view?.match.status === 'active');

  if (view?.match.status === 'active') server.forwardCv(view.match.id, obs, events);
  if (trackingChanged) refresh();
});

setInput(hudState.input);
server.connect();
refresh();

// Show name entry on first visit, then Wii safety once per session.
if (!hudState.playerName) {
  hud.showNameEntry((name) => {
    savePlayerName(name);
    hudState.playerName = name;
    refresh();
    if (!sessionStorage.getItem('claude-tyson.safety-shown')) {
      sessionStorage.setItem('claude-tyson.safety-shown', '1');
      hud.showWiiSafety(() => refresh());
    }
  });
} else if (!sessionStorage.getItem('claude-tyson.safety-shown')) {
  sessionStorage.setItem('claude-tyson.safety-shown', '1');
  hud.showWiiSafety(() => refresh());
}

// ─── Frame loop ────────────────────────────────────────────────────────────

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = performance.now();
  if (dirty) refresh();

  const fp = isFirstPerson();
  firstPerson.visible = fp;
  gloves.root.visible = fp;
  arena.setFocus(fp ? view!.match.ring : hudState.watch, fp, fp && view!.me.slot === 1);
  arena.update(dt, Date.now());
  if (!fp) {
    cinStep(dt);
    hud.tick(watchedView());
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

  // Hide opponent during corner scene cinematic.
  opponent.root.visible = !cinematicMode;

  opponent.update(dt, Date.now());
  gloves.update(dt);
  wheel.update(dt);

  if (cinematicMode) {
    cornerScene.update(dt);
  }

  hud.tick(view);
  renderer.render(scene, camera);
});

// Backtick toggles AI transparency log
window.addEventListener('keydown', (e) => { if (e.key === '`') debugLog.toggle(); });

return () => {
  alive = false;
  renderer.setAnimationLoop(null);
  window.removeEventListener('resize', resize);
  cameraInput.stop();
  feed.hide();
  cornerScene.exit();
  cv.stop();
  server.close();
  hud.dispose();
  renderer.dispose();
};
}
