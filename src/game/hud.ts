import type { PoseState, TrackingState } from './cv/contract';
import type { CvSourceKind, CvStats, CvStatus } from './cv/input';
import type { CalibrationView } from './cv/guard';
import type { MatchView, ProfileRow, ResultRow } from './net/server';

const MAX_STAMINA = 200;

// Plain-DOM HUD. Re-rendered on server changes; the timer and health bars are also
// refreshed every frame via tick().

export interface HudActions {
  fightBot(): void;
  findPvp(): void;
  cancelPvp(): void;
  forfeit(): void;
  useKeyboard(): void;
  useCamera(): void;
  useAirPods(): void;
  reconnectCamera(): void;
  cancelCalibration(): void;
  skipCalibration(): void;
  spectate(): void;
  leaveSpectate(): void;
  watchPrev(): void;
  watchNext(): void;
  /** Buttons with data-ring call this instead of their data-action. */
  watch(ring: number): void;
  changeName(): void;
}

/** One line per ring for the menu and the spectator bar. */
export interface RingSummary {
  ring: number;
  /** Free for a new fight: empty, or only bots filling time. */
  free: boolean;
  label: string; // 'PvP', 'vs bot', 'Exhibition', 'Empty'
  fighters?: string; // 'ALICE 72 · 55 BOB'
}

export type InputMode = 'keyboard' | 'camera' | 'airpods';

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
  motionSummary?: string;
  rings: RingSummary[];
  queueLength: number;
  /** Watching the arena instead of the menu; `watch` is the ring in view. */
  spectating: boolean;
  watch: number;
  /** Names over the health bars: mine and my opponent's, or red and blue when watching. */
  names: [string, string];
  playerName?: string;
  /** True while CornerScene owns the camera; hides the menu overlay. */
  cinematic?: boolean;
  /** True during the result-card window before corner scene; hides the menu. */
  debriefing?: boolean;
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
      <div id="pause" class="pause"></div>
      <div id="calibration" class="calibration"></div>
      <div id="toasts" class="toasts"></div>
      <div id="vignette" class="vignette"></div>
      <div id="pose" class="pose"></div>
      <div id="telegraph" class="telegraph"></div>
      <div id="dialogue" class="dialogue"></div>
      <div id="adapted-tag" class="adapted-tag"></div>
      <div id="adapt-vignette" class="adapt-vignette"></div>
      <div id="debrief" class="debrief" style="display:none"></div>
      <div id="result-card" class="result-card" style="display:none"></div>
      <div id="name-entry-screen" class="name-entry-screen" style="display:none"></div>
      <div id="wii-safety-screen" class="wii-safety-screen" style="display:none"></div>
      <div id="vs-screen" class="vs-screen" style="display:none"></div>
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

  render(s: HudState) {
    const active = s.view?.match.status === 'active';
    const keys = this.root.querySelector<HTMLElement>('.keys');
    if (keys) keys.style.display = (s.input === 'keyboard' && active) ? 'block' : 'none';

    // Status chips only visible during a fight
    const status = el('status');
    status.style.display = active ? 'flex' : 'none';
    if (active) {
      this.setHtml('status', `
        <span class="chip ${s.server}">server: ${s.server}</span>
        <span class="chip ${s.tracking === 'good' ? 'online' : 'warn'}">cv: ${s.tracking}</span>
        ${this.inputChips(s)}`);
    }

    el('me-name').textContent = s.names[0];
    el('opp-name').textContent = s.names[1];

    const menu = el('menu');
    const showMenu = !active && !s.spectating && !s.cinematic && !s.debriefing;
    menu.style.display = showMenu ? 'flex' : 'none';
    if (showMenu) this.setHtml('menu', this.menuHtml(s));

    const spectate = el('spectate');
    spectate.style.display = s.spectating && !active ? 'flex' : 'none';
    if (s.spectating && !active) this.setHtml('spectate', this.spectateHtml(s));

    const adapt = el('adapt');
    const strat = s.view?.strategy;
    adapt.style.display = active && strat ? 'block' : 'none';
    if (strat) {
      adapt.innerHTML = `
        <div class="label">Bot strategy · rev ${strat.revision}</div>
        <div class="explain">${escapeHtml(strat.explanation)}</div>
        <div class="nums">aggr ${strat.aggression.toFixed(2)} · interval ${strat.punchIntervalMs}ms ·
          mix L/R/H ${[strat.jabWeight, strat.straightWeight, strat.hookWeight].map(w => w.toFixed(2)).join('/')} ·
          left ${(strat.leftBias * 100).toFixed(0)}% · defends ${(strat.defenseRate * 100).toFixed(0)}% ·
          telegraph ${strat.telegraphMs}ms</div>`;
    }

    const paused = active && (s.tracking === 'lost' || s.tracking === 'calibrating');
    el('pause').style.display = paused ? 'flex' : 'none';
    if (paused) {
      el('pause').innerHTML = `<div><h2>${s.tracking === 'calibrating' ? 'Calibrating…' : 'Tracking lost'}</h2>
        <p>${s.trackingReason ?? 'Step back into frame so tracking can recover.'}</p>
        <p class="dim">The bot holds fire and incoming hits are unscorable until tracking recovers.</p></div>`;
    }
  }

  private inputChips(s: HudState): string {
    if (s.input === 'airpods') {
      return `<button class="chip" data-action="useKeyboard">input: airpods ⇄</button>
        <button class="chip ${s.camera === 'connected' ? 'online' : 'warn'}" data-action="reconnectCamera" title="Reconnect to the local harness">${escapeHtml(s.cameraDetail ?? 'Start motion companion')}</button>
        <span class="chip">${escapeHtml(s.lastCv ?? 'AirPods: punches · Pose: dodges · no blocks')}</span>
        <span class="chip" title="Approximate software timing only; excludes physical motion/Bluetooth. Full stage logs in browser console.">${escapeHtml(s.motionSummary ?? '')}</span>`;
    }
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
        : `<button class="chip warn" data-action="reconnectCamera" title="${bridge ? 'Use Camera for browser CV or AirPods for the motion companion' : 'Allow camera access, then retry'}">camera: ${label}${detail} · retry</button>`;
    const last = `<span class="chip synthetic">last cv: ${s.lastCv ? escapeHtml(s.lastCv) : '—'}</span>`;
    return toggle + camera + last;
  }

  private inputPicker(s: HudState): string {
    const opt = (mode: InputMode, action: keyof HudActions, label: string) =>
      `<button data-action="${action}" class="${s.input === mode ? '' : 'secondary'}">${label}</button>`;
    return `<div class="input-picker"><span class="dim">Input</span>
      ${opt('keyboard', 'useKeyboard', 'Keyboard')}${opt('camera', 'useCamera', 'Camera')}${opt('airpods', 'useAirPods', 'AirPods + camera')}<a href="/downloads/motion-companion.zip" download>Download Mac companion</a></div>`;
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
        </div>`
      : '';
    const name = s.playerName ?? 'FIGHTER';
    const nameHtml = `<div class="menu-player-name">${escapeHtml(name)} <button class="profile-change-name" data-action="changeName">change name</button></div>`;
    return `
      <div class="menu-title"><span class="t-claude">CLAUDE</span><span class="t-tyson">TYSON</span></div>
      ${resultHtml}
      ${this.inputPicker(s)}
      <div class="buttons">
        <button data-action="fightBot" ${offline || full ? 'disabled' : ''} ${full ? 'title="Every ring is taken. Spectate, or queue for PvP."' : ''}>Fight Claude Tyson</button>
        ${s.queued
          ? `<button data-action="cancelPvp" class="secondary">${full ? 'Waiting for a free ring' : 'Waiting for opponent'}… cancel</button>`
          : `<button data-action="findPvp" class="secondary" ${offline ? 'disabled' : ''}>Find PvP</button>`}
        <button data-action="spectate" class="secondary" ${offline ? 'disabled' : ''}>Spectate</button>
      </div>
      ${offline ? `<div class="dim">Server ${s.server}${s.serverDetail ? ` (${escapeHtml(s.serverDetail)})` : ''}. Run <code>spacetime start</code> and publish the module.</div>` : ''}
      ${profileHtml}
      ${nameHtml}`;
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
    const rows = s.rings.map(ring => `<button class="ring-row ${ring.free ? 'free' : ''} ${ring.ring === s.watch ? 'active' : ''}" data-ring="${ring.ring}">
        <b>Ring ${ring.ring + 1}</b> ${ring.label}${ring.fighters ? ` · ${escapeHtml(ring.fighters)}` : ''}</button>`).join('');
    const used = s.rings.filter(r => !r.free).length;
    const queue = s.queueLength > 0 ? ` · ${s.queueLength} in PvP queue` : '';
    return `<div class="spectate-rings">
      <div class="dim">${used} of ${s.rings.length} rings in use${queue}</div>
      <div class="ring-list">${rows}</div>
      ${queued}
    </div>
    <button data-action="leaveSpectate" class="secondary">Back to Menu</button>`;
  }

  /** Pass the watched ring as a MatchView (red as `me`) while spectating. */
  tick(view: MatchView | undefined) {
    const active = view?.match.status === 'active';
    const bars = document.querySelector<HTMLElement>('.bars');
    if (bars) bars.style.display = active ? 'flex' : 'none';
    if (active) {
      el('hp-me').style.width = `${Math.max(0, view!.me.health)}%`;
      el('hp-opp').style.width = `${Math.max(0, view!.opponent.health)}%`;
      el('stamina-me').style.width = `${Math.max(0, Math.min(100, view!.me.stamina / MAX_STAMINA * 100))}%`;
      el('stamina-opp').style.width = `${Math.max(0, Math.min(100, view!.opponent.stamina / MAX_STAMINA * 100))}%`;
    }
    let remaining = 60;
    if (active) {
      const endsMs = Number(view.match.endsAt.microsSinceUnixEpoch / 1000n);
      remaining = Math.max(0, Math.ceil((endsMs - Date.now()) / 1000));
    }
    el('timer').textContent = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
  }

  renderPose(pose: PoseState, active = false) {
    const p = el('pose');
    if (!active) { p.style.display = 'none'; return; }
    p.style.display = '';
    const body = { neutral: 'NEUTRAL', lean_left: '◀ DODGE LEFT', lean_right: 'DODGE RIGHT ▶' }[pose.body];
    const g = (on: boolean) => (on ? 'BLOCK' : '—');
    p.innerHTML = `<span>${body}</span><span class="dim">guard L ${g(pose.guards.left === 'block')} · R ${g(pose.guards.right === 'block')}${pose.guards.left !== pose.guards.right ? ' · both gloves to block' : ''}</span>`;
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
        ? `<p class="warn">Select Camera for browser CV or AirPods for the motion companion.</p>`
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
  private dialogueTimer = 0;
  private adaptedTagTimer = 0;
  private typewriterTimer = 0;
  private resultCardTimer = 0;

  showDialogue(line: string) {
    const d = el('dialogue');
    d.textContent = `"${line}"`;
    d.classList.remove('visible');
    void d.offsetWidth;
    d.classList.add('visible');
    clearTimeout(this.dialogueTimer);
    this.dialogueTimer = window.setTimeout(() => d.classList.remove('visible'), 4200);
  }

  showAdaptedTag(explanation: string) {
    const tag = el('adapted-tag');
    tag.innerHTML = `<span class="adapted-label">ADAPTED</span><span class="adapted-explain">${escapeHtml(explanation)}</span>`;
    tag.classList.remove('visible');
    void tag.offsetWidth;
    tag.classList.add('visible');
    clearTimeout(this.adaptedTagTimer);
    this.adaptedTagTimer = window.setTimeout(() => tag.classList.remove('visible'), 3500);
    const v = el('adapt-vignette');
    v.classList.remove('flash');
    void v.offsetWidth;
    v.classList.add('flash');
  }

  showAdaptation(outcome: string, explanation: string) {
    this.toast(outcome === 'improved' ? 'STRATEGY TUNED ✓' : 'STRATEGY REVISED', outcome === 'improved' ? 'good' : 'info');
  }

  showCornerAnalysis(text: string, source: 'claude' | 'offline', onDismiss?: () => void) {
    const d = el('debrief');
    const tag = source === 'claude'
      ? `<span class="debrief-source">CLAUDE CRAB</span>`
      : `<span class="debrief-source offline">CORNER NOTES</span>`;
    d.innerHTML = `
      <div class="debrief-box">
        <div class="debrief-header">
          <div class="debrief-claude-icon">CC</div>
          ${tag}
        </div>
        <p id="debrief-text"></p>
        <button class="debrief-close">GOT IT</button>
      </div>`;
    d.style.display = 'block';
    d.querySelector('.debrief-close')!.addEventListener('click', () => {
      d.style.display = 'none';
      clearTimeout(this.typewriterTimer);
      onDismiss?.();
    });
    const textEl = document.getElementById('debrief-text')!;
    let i = 0;
    const type = () => {
      textEl.textContent = text.slice(0, i);
      if (i < text.length) { i++; this.typewriterTimer = window.setTimeout(type, 20); }
    };
    clearTimeout(this.typewriterTimer);
    window.setTimeout(type, 300);
  }

  showResultCard(won: boolean, reason: string, stars: number) {
    const card = el('result-card');
    const banner = won ? 'VICTORY!' : 'DEFEAT';
    const starsHtml = won ? [1, 2, 3].map(i => `<span style="${i <= stars ? '' : 'filter:grayscale(1) opacity(0.3)'}">⭐</span>`).join('') : '';
    card.innerHTML = `<div class="result-card-inner">
      <div class="result-card-banner ${won ? 'win' : 'lose'}">${banner}</div>
      <div class="result-card-by">by ${escapeHtml(reason)}</div>
      ${won ? `<div class="result-stars">${starsHtml}</div>` : ''}
    </div>`;
    card.style.display = 'flex';
    clearTimeout(this.resultCardTimer);
    this.resultCardTimer = window.setTimeout(() => {
      card.classList.add('fade-out');
      window.setTimeout(() => { card.style.display = 'none'; card.classList.remove('fade-out'); }, 400);
    }, 2000);
  }

  showNameEntry(onSubmit: (name: string) => void) {
    const screen = el('name-entry-screen');
    screen.innerHTML = `
      <div class="ne-logo">🥊 CLAUDE TYSON</div>
      <div class="ne-prompt">WHAT'S YOUR<br>FIGHTER NAME?</div>
      <input class="ne-input" type="text" placeholder="YOUR NAME" maxlength="16"
             autocomplete="off" spellcheck="false">
      <button class="ne-btn" disabled>STEP INTO THE RING</button>`;
    screen.style.display = 'flex';
    screen.classList.remove('ne-fade-out');
    const input = screen.querySelector<HTMLInputElement>('.ne-input')!;
    const btn   = screen.querySelector<HTMLButtonElement>('.ne-btn')!;
    const submit = () => {
      const name = input.value.trim().toUpperCase().slice(0, 16);
      if (!name) return;
      screen.classList.add('ne-fade-out');
      window.setTimeout(() => { screen.style.display = 'none'; screen.classList.remove('ne-fade-out'); onSubmit(name); }, 380);
    };
    input.addEventListener('input', () => { btn.disabled = input.value.trim().length === 0; });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    btn.addEventListener('click', submit);
    window.setTimeout(() => input.focus(), 120);
  }

  showWiiSafety(onContinue: () => void) {
    const screen = el('wii-safety-screen');
    screen.innerHTML = `
      <div class="wss-bg">
        <div class="wss-watermark">CT</div>
        <div class="wss-rope wss-rope-1"></div><div class="wss-rope wss-rope-2"></div><div class="wss-rope wss-rope-3"></div>
        <div class="wss-post wss-post-l"></div><div class="wss-post wss-post-r"></div>
        <div class="wss-glove wss-glove-1">🥊</div><div class="wss-glove wss-glove-2">🥊</div>
        <div class="wss-glove wss-glove-3">🥊</div><div class="wss-glove wss-glove-4">🥊</div>
        <div class="wss-glove wss-glove-5">🥊</div>
        <div class="wss-star wss-star-1">⭐</div><div class="wss-star wss-star-2">⭐</div>
        <div class="wss-star wss-star-3">⭐</div><div class="wss-star wss-star-4">⭐</div>
        <div class="wss-star wss-star-5">⭐</div><div class="wss-star wss-star-6">⭐</div>
        <div class="wss-vignette"></div>
      </div>
      <div class="wss-dialog">
        <div class="wss-dialog-header">
          <div class="wss-dialog-icon">!</div>
          <span class="wss-dialog-header-title">Health &amp; Safety</span>
        </div>
        <div class="wss-dialog-body">
          <svg class="wss-diagram-svg" viewBox="0 0 88 88" xmlns="http://www.w3.org/2000/svg">
            <rect x="3" y="3" width="82" height="82" rx="4" fill="rgba(255,255,255,0.05)" stroke="rgba(255,255,255,0.18)" stroke-width="1.5"/>
            <circle cx="44" cy="44" r="32" fill="none" stroke="#ff8c42" stroke-width="1.5" stroke-dasharray="4 3"/>
            <circle cx="44" cy="41" r="7" fill="#ff8c42"/><circle cx="44" cy="31" r="5" fill="#ff8c42"/>
            <line x1="37" y1="40" x2="23" y2="34" stroke="#ff8c42" stroke-width="3.5" stroke-linecap="round"/>
            <line x1="51" y1="40" x2="65" y2="34" stroke="#ff8c42" stroke-width="3.5" stroke-linecap="round"/>
            <text x="44" y="11" font-size="9" fill="rgba(255,140,66,0.7)" text-anchor="middle" font-weight="900" font-family="Arial">↑</text>
            <text x="44" y="84" font-size="9" fill="rgba(255,140,66,0.7)" text-anchor="middle" font-weight="900" font-family="Arial">↓</text>
            <text x="9"  y="47" font-size="9" fill="rgba(255,140,66,0.7)" text-anchor="middle" font-weight="900" font-family="Arial">←</text>
            <text x="81" y="47" font-size="9" fill="rgba(255,140,66,0.7)" text-anchor="middle" font-weight="900" font-family="Arial">→</text>
          </svg>
          <div class="wss-dialog-textcol">
            <p class="wss-dialog-title">Before You Play</p>
            <p class="wss-dialog-text">Make sure there are <b>no people or objects</b> nearby that could be hit during gameplay.<br><br>Clear at least <b>3 feet</b> of open space in all directions.</p>
          </div>
        </div>
        <div class="wss-dialog-footer">
          <span class="wss-dialog-hint">Click anywhere to continue</span>
          <button class="wss-btn"><span class="wss-btn-a">A</span> OK</button>
        </div>
      </div>`;
    screen.style.display = 'flex';
    screen.classList.remove('wss-fade-out');
    const done = () => {
      screen.classList.add('wss-fade-out');
      window.setTimeout(() => { screen.style.display = 'none'; screen.classList.remove('wss-fade-out'); onContinue(); }, 400);
    };
    screen.querySelector('.wss-btn')!.addEventListener('click', (e) => { e.stopPropagation(); done(); });
    screen.addEventListener('click', done, { once: true });
  }

  /** SF6-style VS screen shown before each fight. Auto-starts after 3.6s or click to skip. */
  showVsScreen(playerName: string, botPortrait: string | null, onStart: () => void) {
    const screen = el('vs-screen');
    const playerInitials = (playerName.slice(0, 2) || 'YO').toUpperCase();
    const botSide = botPortrait
      ? `<img class="vss-portrait vss-portrait-bot" src="${botPortrait}" alt="Claude Tyson">`
      : `<div class="vss-portrait vss-portrait-bot vss-portrait-initials">CT</div>`;
    screen.innerHTML = `
      <div class="vss-scanlines"></div>
      <div class="vss-fighters">
        <div class="vss-side vss-side-player">
          <div class="vss-portrait vss-portrait-initials vss-portrait-player">${escapeHtml(playerInitials)}</div>
          <div class="vss-name">${escapeHtml(playerName.toUpperCase())}</div>
        </div>
        <div class="vss-center">
          <div class="vss-clash-line"></div>
          <div class="vss-vs">VS</div>
        </div>
        <div class="vss-side vss-side-bot">
          ${botSide}
          <div class="vss-name">CLAUDE TYSON</div>
        </div>
      </div>
      <div class="vss-skip">TAP TO SKIP</div>`;
    screen.style.display = 'flex';
    screen.classList.remove('vss-out');
    const start = () => {
      clearTimeout(timer);
      screen.classList.add('vss-out');
      window.setTimeout(() => { screen.style.display = 'none'; screen.classList.remove('vss-out'); onStart(); }, 350);
    };
    const timer = window.setTimeout(start, 3600);
    screen.addEventListener('click', start, { once: true });
  }

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
