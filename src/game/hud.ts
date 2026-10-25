import type { PoseState, TrackingState } from './cv/contract';
import type { CvSourceKind, CvStats, CvStatus } from './cv/input';
import type { CalibrationView } from './cv/guard';
import { RULES_HTML } from './combatText';
import type { MatchView, ProfileRow, ResultRow } from './net/server';

const MAX_STAMINA = 200;
const MAX_HEALTH = 100; // SpacetimeDB stores tenths: 100 = 10 HP and a full bar.
const SHOW_CLAUDE_DEBUG = process.env.NODE_ENV === 'development'
  && process.env.NEXT_PUBLIC_CLAUDE_LOG === 'true';

// Plain-DOM HUD. Re-rendered on server changes; the timer and health bars are also
// refreshed every frame via tick().

export interface HudActions {
  fightBot(): void;
  findPvp(): void;
  cancelPvp(): void;
  forfeit(): void;
  useKeyboard(): void;
  useCamera(): void;
  reconnectCamera(): void;
  cancelCalibration(): void;
  skipCalibration(): void;
  spectate(): void;
  leaveSpectate(): void;
  watchPrev(): void;
  watchNext(): void;
  /** Buttons with data-ring call this instead of their data-action. */
  watch(ring: number): void;
}

/** One line per ring for the menu and the spectator bar. */
export interface RingSummary {
  ring: number;
  /** Free for a new fight: empty, or only bots filling time. */
  free: boolean;
  label: string; // 'PvP', 'vs bot', 'Exhibition', 'Empty'
  fighters?: string; // 'ALICE 72 · 55 BOB'
}

export type InputMode = 'keyboard' | 'camera';

export interface HudState {
  server: 'connecting' | 'online' | 'offline';
  serverDetail?: string;
  tracking: TrackingState;
  trackingReason?: string;
  view?: MatchView;
  result?: ResultRow;
  profile?: ProfileRow;
  queued: boolean;
  pose?: PoseState;
  input: InputMode;
  camera: CvStatus;
  cameraDetail?: string;
  cameraSource?: CvSourceKind;
  cameraStats?: CvStats;
  /** Last CV event and the key it mapped to, e.g. "punch_left hook → U". */
  lastCv?: string;
  rings: RingSummary[];
  queueLength: number;
  /** Watching the arena instead of the menu; `watch` is the ring in view. */
  spectating: boolean;
  watch: number;
  /** Names over the health bars: mine and my opponent's, or red and blue when watching. */
  names: [string, string];
}

const el = (id: string) => document.getElementById(id)!;

export class Hud {
  private root = document.getElementById('hud')!;

  private actions: HudActions;

  constructor(actions: HudActions) {
    this.actions = actions;
    this.root.innerHTML = `
      <div class="bars">
        <div class="bar me"><span id="me-name" class="name">YOU</span><div class="track"><div id="hp-me" class="fill"></div></div><div class="track stamina"><div id="stamina-me" class="fill"></div></div></div>
        <div id="timer" class="timer">0:30</div>
        <div class="bar opp"><span id="opp-name" class="name">OPPONENT</span><div class="track"><div id="hp-opp" class="fill"></div></div><div class="track stamina"><div id="stamina-opp" class="fill"></div></div></div>
      </div>
      <div id="status" class="status"></div>
      <div id="menu" class="menu"></div>
      <div id="spectate" class="spectate"></div>
      <div id="adapt" class="adapt"></div>
      ${SHOW_CLAUDE_DEBUG ? `<details id="claude-log" class="claude-log">
        <summary>Claude log <span id="claude-log-count">0</span></summary>
        <ol id="claude-log-entries"><li class="empty">Fight an adaptive bot to see its decisions here.</li></ol>
      </details>` : ''}
      <div id="pause" class="pause"></div>
      <div id="calibration" class="calibration"></div>
      <div id="toasts" class="toasts"></div>
      <div id="vignette" class="vignette"></div>
      <div id="pose" class="pose"></div>
      <div id="telegraph" class="telegraph"></div>
      <div class="keys">
        <div class="keys-title">KEYBOARD CONTROLS</div>
        <div><b>J</b> Left straight · <b>C</b> Right straight</div>
        <div><b>Q</b> Left hook · <b>E</b> Right hook</div>
        <div><b>A</b> Dodge left · <b>D</b> Dodge right</div>
        <div><b>B</b> Hold to block</div>
        <div class="keys-debug"><b>T</b> Test tracking loss · <b>X</b> Recalibrate</div>
      </div>`;
    this.root.addEventListener('click', this.onClick);
  }

  private onClick = (e: MouseEvent) => {
    const data = (e.target as HTMLElement).dataset;
    if (data.ring !== undefined) return this.actions.watch(Number(data.ring));
    const action = data.action as Exclude<keyof HudActions, 'watch'> | undefined;
    if (action) this.actions[action]();
  };

  // innerHTML is only replaced when it changes: server updates from every ring arrive
  // many times a second, and rebuilding buttons that often swallows clicks.
  private html = new Map<string, string>();
  private setHtml(id: string, html: string) {
    if (this.html.get(id) === html) return;
    this.html.set(id, html);
    el(id).innerHTML = html;
  }

  dispose() {
    this.root.removeEventListener('click', this.onClick);
    this.root.replaceChildren();
  }

  logClaude(kind: 'window' | 'strategy' | 'analysis' | 'error', message: string) {
    if (!SHOW_CLAUDE_DEBUG) return;
    const entries = el('claude-log-entries');
    entries.querySelector('.empty')?.remove();
    const item = document.createElement('li');
    item.className = kind;
    const time = document.createElement('time');
    time.textContent = new Date().toLocaleTimeString();
    const detail = document.createElement('span');
    detail.textContent = message;
    item.append(time, detail);
    entries.prepend(item);
    while (entries.children.length > 50) entries.lastElementChild?.remove();
    el('claude-log-count').textContent = String(entries.children.length);
  }

  render(s: HudState) {
    const active = s.view?.match.status === 'active';
    const keys = this.root.querySelector<HTMLElement>('.keys');
    if (keys) keys.style.display = s.input === 'keyboard' ? 'block' : 'none';

    this.setHtml('status', `
      <span class="chip ${s.server}">server: ${s.server}</span>
      <span class="chip ${s.tracking === 'good' ? 'online' : 'warn'}">cv: ${s.tracking}</span>
      ${this.inputChips(s)}`);

    el('me-name').textContent = s.names[0];
    el('opp-name').textContent = s.names[1];

    const menu = el('menu');
    const showMenu = !active && !s.spectating;
    menu.style.display = showMenu ? 'flex' : 'none';
    if (showMenu) this.setHtml('menu', this.menuHtml(s));

    const spectate = el('spectate');
    spectate.style.display = s.spectating && !active ? 'flex' : 'none';
    if (s.spectating && !active) this.setHtml('spectate', this.spectateHtml(s));

    const adapt = el('adapt');
    const strat = s.view?.strategy;
    adapt.style.display = SHOW_CLAUDE_DEBUG && active && strat ? 'block' : 'none';
    if (SHOW_CLAUDE_DEBUG && strat) {
      adapt.innerHTML = `
        <div class="label">Bot strategy · rev ${strat.revision}</div>
        <div class="explain">${escapeHtml(strat.explanation)}</div>
        <div class="nums">aggr ${strat.aggression.toFixed(2)} · interval ${strat.punchIntervalMs}ms ·
          mix L/R/H ${[strat.jabWeight, strat.straightWeight, strat.hookWeight].map(w => w.toFixed(2)).join('/')} ·
          left ${((strat.leftBias + 1) * 50).toFixed(0)}% · defends ${(strat.defenseRate * 100).toFixed(0)}% ·
          telegraph ${strat.telegraphMs}ms</div>`;
    }

    const paused = active && s.tracking !== 'good';
    el('pause').style.display = paused ? 'flex' : 'none';
    if (paused) {
      el('pause').innerHTML = `<div><h2>${s.tracking === 'calibrating' ? 'Calibrating…' : 'Tracking lost'}</h2>
        <p>${s.trackingReason ?? 'Step back into frame so tracking can recover.'}</p>
        <p class="dim">The bot holds fire and incoming hits are unscorable until tracking recovers.</p></div>`;
    }
  }

  private inputChips(s: HudState): string {
    const other = s.input === 'camera' ? 'useKeyboard' : 'useCamera';
    const toggle = `<button class="chip" data-action="${other}" title="Switch input">input: ${s.input} ⇄</button>`;
    if (s.input === 'keyboard') return toggle;
    const ok = s.camera === 'connected';
    const detail = s.cameraDetail ? ` (${escapeHtml(s.cameraDetail)})` : '';
    const bridge = s.cameraSource === 'bridge';
    const stats = s.cameraStats && !bridge ? ` · ${s.cameraStats.fps.toFixed(0)} fps` : '';
    const label = { off: 'off', connecting: 'starting', connected: 'tracking', disconnected: 'unavailable' }[s.camera];
    const camera = ok
      ? `<span class="chip online" title="${s.cameraStats ? `${s.cameraStats.inferenceP95Ms.toFixed(1)} ms/frame p95 · pose ${s.cameraStats.poseMs?.toFixed(1)} · hands ${s.cameraStats.handsMs?.toFixed(1)} ms median` : ''}">camera: ${label}${detail}${stats}</span>`
      : s.camera === 'connecting'
        ? `<span class="chip warn">camera: ${label}${detail}</span>`
        : `<button class="chip warn" data-action="reconnectCamera" title="${bridge ? 'Start the bridge in cv-mvp/: python -m cv_mvp --camera 0' : 'Allow camera access, then retry'}">camera: ${label}${detail} · retry</button>`;
    const last = `<span class="chip synthetic">last cv: ${s.lastCv ? escapeHtml(s.lastCv) : '—'}</span>`;
    return toggle + camera + last;
  }

  private inputPicker(s: HudState): string {
    const opt = (mode: InputMode, action: keyof HudActions, label: string) =>
      `<button data-action="${action}" class="${s.input === mode ? '' : 'secondary'}">${label}</button>`;
    return `<div class="input-picker"><span class="dim">Input</span>
      ${opt('keyboard', 'useKeyboard', 'Keyboard')}${opt('camera', 'useCamera', s.cameraSource === 'bridge' ? 'Camera (CV bridge)' : 'Camera')}</div>`;
  }

  private menuHtml(s: HudState): string {
    const offline = s.server !== 'online';
    const full = !s.rings.some(r => r.free);
    let resultHtml = '';
    if (s.view && s.result) {
      const w = s.result.winnerSlot;
      const outcome = w === undefined ? 'DRAW' : w === s.view.me.slot ? 'YOU WIN' : 'YOU LOSE';
      resultHtml = `<div class="result"><h2>${outcome}</h2><div class="dim">by ${s.result.reason}</div>
        ${s.result.analysis ? `<p>${escapeHtml(s.result.analysis)}</p>` : ''}</div>`;
    }
    const p = s.profile;
    const profileHtml = p
      ? `<div class="profile">
          <div><b>${p.wins}</b>-<b>${p.losses}</b> in ${p.matchesPlayed} fights</div>
          <div>straights ${p.straights} · hooks ${p.hooks} · landed ${p.punchesLanded} · counters ${p.counters}</div>
          <div>of ${p.defenseOpportunities} incoming: slipped ${p.slips} · leaned back ${p.leanBacks} · blocked ${p.blocks} · hit ${p.hitsTaken}</div>
        </div>`
      : '';
    return `
      <h1>CLAUDE TYSON</h1>
      ${resultHtml}
      ${this.inputPicker(s)}
      <div class="buttons">
        <button data-action="fightBot" ${offline || full ? 'disabled' : ''} ${full ? 'title="Every ring is taken. Spectate, or queue for PvP."' : ''}>Fight adaptive bot</button>
        ${s.queued
          ? `<button data-action="cancelPvp" class="secondary">${full ? 'Waiting for a free ring' : 'Waiting for opponent'}… cancel</button>`
          : `<button data-action="findPvp" class="secondary" ${offline ? 'disabled' : ''}>Find PvP match</button>`}
        <button data-action="spectate" class="secondary" ${offline ? 'disabled' : ''}>Spectate</button>
      </div>
      ${offline ? `<div class="dim">Server ${s.server}${s.serverDetail ? ` (${escapeHtml(s.serverDetail)})` : ''}. Run <code>spacetime start</code> and publish the module. You can still shadowbox.</div>` : this.ringsHtml(s, full)}
      ${RULES_HTML}
      ${profileHtml}`;
  }

  private ringsHtml(s: HudState, full: boolean): string {
    const used = s.rings.filter(r => !r.free).length;
    const queue = s.queueLength > 0 ? ` · ${s.queueLength} in the PvP queue` : '';
    const note = full ? '<div class="dim">Every ring is taken. Queue for PvP and you will be matched as soon as one frees up, or spectate meanwhile.</div>' : '';
    const rows = s.rings.map(r => `<button class="ring-row ${r.free ? 'free' : ''}" data-ring="${r.ring}">
        <b>Ring ${r.ring + 1}</b> ${r.label}${r.fighters ? ` · ${escapeHtml(r.fighters)}` : ''}</button>`).join('');
    return `<div class="rings"><div class="dim">${used} of ${s.rings.length} rings in use${queue}</div>
      <div class="ring-list">${rows}</div>${note}</div>`;
  }

  private spectateHtml(s: HudState): string {
    const r = s.rings[s.watch];
    const queued = s.queued ? `<span class="chip warn">in PvP queue · you join as soon as a ring frees</span>` : '';
    return `<button data-action="watchPrev" class="secondary" title="Previous ring">◀</button>
      <div class="what"><b>Ring ${(r?.ring ?? 0) + 1}</b> · ${r?.label ?? 'Empty'}${r?.fighters ? ` · ${escapeHtml(r.fighters)}` : ''}</div>
      <button data-action="watchNext" class="secondary" title="Next ring">▶</button>
      ${queued}
      <button data-action="leaveSpectate">Menu</button>`;
  }

  /** Pass the watched ring as a MatchView (red as `me`) while spectating. */
  tick(view: MatchView | undefined) {
    const active = view?.match.status === 'active';
    el('hp-me').style.width = `${view ? Math.max(0, Math.min(100, view.me.health / MAX_HEALTH * 100)) : 100}%`;
    el('hp-opp').style.width = `${view ? Math.max(0, Math.min(100, view.opponent.health / MAX_HEALTH * 100)) : 100}%`;
    el('stamina-me').style.width = `${view ? Math.max(0, Math.min(100, view.me.stamina / MAX_STAMINA * 100)) : 100}%`;
    el('stamina-opp').style.width = `${view ? Math.max(0, Math.min(100, view.opponent.stamina / MAX_STAMINA * 100)) : 100}%`;
    let remaining = 30;
    if (active) {
      const endsMs = Number(view.match.endsAt.microsSinceUnixEpoch / 1000n);
      remaining = Math.max(0, Math.ceil((endsMs - Date.now()) / 1000));
    }
    el('timer').textContent = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
  }

  renderPose(pose: PoseState) {
    const body = { neutral: 'NEUTRAL', lean_left: '◀ DODGE LEFT', lean_right: 'DODGE RIGHT ▶' }[pose.body];
    const g = (on: boolean) => (on ? 'BLOCK' : '—');
    el('pose').innerHTML = `<span>${body}</span><span class="dim">guard L ${g(pose.guards.left === 'block')} · R ${g(pose.guards.right === 'block')}${pose.guards.left !== pose.guards.right ? ' · both gloves to block' : ''}</span>`;
  }

  /** Pre-match camera calibration overlay; pass undefined to hide it. */
  renderCalibration(v: CalibrationView | undefined, opts: { canSkip: boolean; camera: CvStatus; source?: CvSourceKind; detail?: string }) {
    const box = el('calibration');
    box.style.display = v ? 'flex' : 'none';
    if (!v) {
      this.calibrationKey = '';
      return;
    }
    const steps: CalibrationView['step'][] = ['frame', 'stance', 'block'];
    const idx = steps.indexOf(v.step);
    const tick = (on: boolean, label: string) => `<span class="${on ? 'ok' : 'miss'}">${on ? '✓' : '·'} ${label}</span>`;
    const detail = opts.detail ? ` (${escapeHtml(opts.detail)})` : '';
    const waiting = opts.camera === 'connected' ? ''
      : opts.source === 'bridge'
        ? `<p class="warn">Waiting for the camera bridge. Start it in <code>cv-mvp/</code>: <code>python -m cv_mvp --camera 0</code></p>`
        : opts.camera === 'disconnected'
          ? `<p class="warn">Camera tracking unavailable${detail}. Allow camera access and retry.</p>`
          : `<p class="warn">Starting camera tracking${detail}. The first load downloads about 20 MB.</p>`;
    // Rebuild only when the text changes; observations arrive at ~30 Hz and replacing the
    // buttons that often would swallow clicks.
    const key = [v.step, v.error, opts.canSkip, opts.camera, opts.detail, v.seen.head, v.seen.left, v.seen.right].join('|');
    if (key === this.calibrationKey) {
      const bar = box.querySelector<HTMLElement>('.progress div');
      if (bar) bar.style.width = `${(v.progress * 100).toFixed(0)}%`;
      return;
    }
    this.calibrationKey = key;
    box.innerHTML = `<div class="panel">
      <div class="dim">Camera calibration · step ${Math.max(1, idx + 1)} of 3</div>
      <h2>${v.title}</h2>
      <p>${v.hint}</p>
      <div class="progress"><div style="width:${(v.progress * 100).toFixed(0)}%"></div></div>
      <div class="seen">${tick(v.seen.head, 'head')}${tick(v.seen.left, 'left hand')}${tick(v.seen.right, 'right hand')}</div>
      ${v.error ? `<p class="warn">${escapeHtml(v.error)}</p>` : ''}
      ${waiting}
      <div class="buttons">
        ${opts.canSkip ? `<button data-action="skipCalibration" class="secondary">Use last calibration</button>` : ''}
        <button data-action="cancelCalibration" class="secondary">Cancel</button>
      </div>
    </div>`;
  }

  /** Name the incoming punch and the answers to it, until it lands. */
  telegraph(name: string, answer: string, msUntilImpact: number) {
    const t = el('telegraph');
    t.innerHTML = `<div class="incoming">${name}</div><div class="answer">${answer}</div>`;
    t.style.display = 'block';
    clearTimeout(this.telegraphTimer);
    this.telegraphTimer = window.setTimeout(() => this.clearTelegraph(), Math.max(0, msUntilImpact) + 300);
  }

  clearTelegraph() {
    el('telegraph').style.display = 'none';
  }

  private telegraphTimer = 0;
  private calibrationKey = '';

  toast(text: string, kind: 'good' | 'bad' | 'info' = 'info') {
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    t.textContent = text;
    el('toasts').appendChild(t);
    setTimeout(() => t.remove(), 900);
  }

  flashDamage() {
    const v = el('vignette');
    v.classList.remove('hit');
    void v.offsetWidth; // restart the CSS animation
    v.classList.add('hit');
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
