import type { PoseState, TrackingState } from './cv/contract';
import type { BridgeStatus } from './cv/bridge';
import type { CalibrationView } from './cv/guard';
import type { MatchView, ProfileRow, ResultRow } from './net/server';
import type * as THREE from 'three';

export { type ProfileRow };

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
  changeName(): void;
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
  camera: BridgeStatus;
  cameraDetail?: string;
  /** Last CV event and the key it mapped to, e.g. "punch_left hook → U". */
  lastCv?: string;
  /** True while CornerScene owns the camera; hides the menu overlay. */
  cinematic?: boolean;
  /** True during the 2.4s result-card window before corner scene; hides the menu. */
  debriefing?: boolean;
  /** Player's chosen name (from name entry screen). */
  playerName?: string;
}

const el = (id: string) => document.getElementById(id)!;

export class Hud {
  private root = document.getElementById('hud')!;
  private actions: HudActions;

  constructor(actions: HudActions) {
    this.actions = actions;
    this.root.innerHTML = `
      <div class="bars">
        <div class="bar me"><span id="player-name" class="name">YOU</span><div class="track"><div id="hp-me" class="fill"></div></div><div class="track stamina"><div id="stamina-me" class="fill"></div></div></div>
        <div class="timer-wrap"><div class="round-label">ROUND 1</div><div id="timer" class="timer">3:00</div></div>
        <div class="bar opp"><span id="opp-name" class="name">OPPONENT</span><div class="track"><div id="hp-opp" class="fill"></div></div></div>
      </div>
      <div id="server-dot" class="server-dot"></div>
      <div id="status" class="status"></div>
      <div id="menu" class="menu"></div>
      <div id="adapt" class="adapt"></div>
      <div id="adapted-tag" class="adapted-tag"></div>
      <div id="pause" class="pause"></div>
      <div id="calibration" class="calibration"></div>
      <div id="toasts" class="toasts"></div>
      <div id="vignette" class="vignette"></div>
      <div id="adapt-vignette" class="adapt-vignette"></div>
      <div id="dialogue" class="dialogue"></div>
      <div id="telegraph" class="telegraph"></div>
      <div id="pose" class="pose"></div>
      <div id="debrief" class="debrief"></div>
      <div id="result-card" class="result-card"></div>
      <div id="name-entry-screen"></div>
      <div id="wii-safety-screen"></div>
      <div id="vs-screen"></div>`;
    this.root.addEventListener('click', this.onClick);
  }

  private onClick = (e: MouseEvent) => {
    const action = (e.target as HTMLElement).dataset.action as keyof HudActions | undefined;
    if (action) this.actions[action]();
  };


  dispose() {
    this.root.removeEventListener('click', this.onClick);
    this.root.replaceChildren();
  }

  render(s: HudState) {
    const active = s.view?.match.status === 'active';

    const statusEl = el('status');
    statusEl.style.display = active ? 'flex' : 'none';
    if (active) {
      statusEl.innerHTML = `
        <span class="chip ${s.server}">server: ${s.server}</span>
        <span class="chip ${s.tracking === 'good' ? 'online' : 'warn'}">cv: ${s.tracking}</span>
        ${this.inputChips(s)}`;
    }

    el('opp-name').textContent = s.view?.match.mode === 'bot' ? 'CLAUDE TYSON' : 'OPPONENT';
    el('player-name').textContent = s.playerName ?? 'YOU';

    const menu = el('menu');
    const showMenu = !active && !s.cinematic && !s.debriefing;
    menu.style.display = showMenu ? 'flex' : 'none';
    if (showMenu) menu.innerHTML = this.menuHtml(s);

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
    const detail = !ok && s.cameraDetail ? ` (${escapeHtml(s.cameraDetail)})` : '';
    const camera = ok
      ? `<span class="chip online">camera: connected</span>`
      : `<button class="chip warn" data-action="reconnectCamera" title="Start the bridge in cv-mvp/: python -m cv_mvp --camera 0">camera: ${s.camera}${detail} · retry</button>`;
    const last = `<span class="chip synthetic">last cv: ${s.lastCv ? escapeHtml(s.lastCv) : '—'}</span>`;
    return toggle + camera + last;
  }

  private inputPicker(s: HudState): string {
    const opt = (mode: InputMode, action: keyof HudActions, label: string) =>
      `<button data-action="${action}" class="${s.input === mode ? '' : 'secondary'}">${label}</button>`;
    return `<div class="input-picker"><span class="dim">Input</span>
      ${opt('keyboard', 'useKeyboard', 'Keyboard')}${opt('camera', 'useCamera', 'Camera (CV bridge)')}</div>`;
  }

  private menuHtml(s: HudState): string {
    const offline = s.server !== 'online';
    const p = s.profile;
    const name = s.playerName ?? 'FIGHTER';
    const profileHtml = p
      ? `<div class="profile">
          <div><span class="profile-name">${escapeHtml(name)}</span> &nbsp;<b>${p.wins}</b>W – <b>${p.losses}</b>L in ${p.matchesPlayed} fights</div>
          <button class="profile-change-name" data-action="changeName">change name</button>
        </div>`
      : `<button class="profile-change-name" data-action="changeName">change name</button>`;
    return `
      <div class="game-title">
        <div class="title-claude-badge">CLAUDE</div>
        <div class="title-tyson-boxing">TYSON</div>
      </div>
      ${this.inputPicker(s)}
      <div class="buttons">
        <button data-action="fightBot">Fight Claude Tyson</button>
        ${s.queued
          ? `<button data-action="cancelPvp" class="secondary">Waiting for opponent… cancel</button>`
          : `<button data-action="findPvp" class="secondary">Find PvP Match</button>`}
      </div>
      ${offline ? `<div class="dim small">Server ${s.server}${s.serverDetail ? ` · ${escapeHtml(s.serverDetail)}` : ''} — run spacetime start to play</div>` : ''}
      ${profileHtml}`;
  }

  tick(view: MatchView | undefined) {
    const active = view?.match.status === 'active';
    el('hp-me').style.width = `${view ? Math.max(0, view.me.health) : 100}%`;
    el('hp-opp').style.width = `${view ? Math.max(0, view.opponent.health) : 100}%`;
    el('stamina-me').style.width = `${view ? Math.max(0, Math.min(100, view.me.stamina)) : 100}%`;
    let remaining = 180;
    if (active) {
      const endsMs = Number(view.match.endsAt.microsSinceUnixEpoch / 1000n);
      remaining = Math.max(0, Math.ceil((endsMs - Date.now()) / 1000));
    }
    el('timer').textContent = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
  }

  renderPose(pose: PoseState) {
    const poseEl = el('pose');
    const inFight = el('status').style.display !== 'none';
    if (!inFight) { poseEl.innerHTML = ''; return; }
    const body = { neutral: 'NEUTRAL', lean_left: '◀ DODGE LEFT', lean_right: 'DODGE RIGHT ▶', lean_back: '▼ LEAN BACK' }[pose.body];
    const g = (on: boolean) => (on ? 'BLOCK' : '—');
    poseEl.innerHTML = `<span>${body ?? 'NEUTRAL'}</span><span class="dim">guard L ${g(pose.guards.left === 'block')} · R ${g(pose.guards.right === 'block')}</span>`;
  }

  /** Pre-match camera calibration overlay; pass undefined to hide it. */
  renderCalibration(v: CalibrationView | undefined, opts: { canSkip: boolean; camera: BridgeStatus }) {
    const box = el('calibration');
    box.style.display = v ? 'flex' : 'none';
    if (!v) {
      this.calibrationKey = '';
      return;
    }
    const steps: CalibrationView['step'][] = ['frame', 'stance', 'block'];
    const idx = steps.indexOf(v.step);
    const tick = (on: boolean, label: string) => `<span class="${on ? 'ok' : 'miss'}">${on ? '✓' : '·'} ${label}</span>`;
    const waiting = opts.camera !== 'connected'
      ? `<p class="warn">Waiting for the camera bridge. Start it in <code>cv-mvp/</code>: <code>python -m cv_mvp --camera 0</code></p>`
      : '';
    const key = [v.step, v.error, opts.canSkip, opts.camera, v.seen.head, v.seen.left, v.seen.right].join('|');
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

  telegraph(name: string, answer: string, msUntilImpact: number) {
    const t = el('telegraph');
    t.innerHTML = `<div class="incoming">${name}</div><div class="answer">${answer}</div>`;
    t.style.display = 'block';
    clearTimeout(this.telegraphTimer);
    this.telegraphTimer = window.setTimeout(() => this.clearTelegraph(), Math.max(0, msUntilImpact) + 300);
  }

  clearTelegraph() { el('telegraph').style.display = 'none'; }

  /** Called every frame with Tyson's projected head screen position so the bubble tracks him. */
  setDialogueAnchor(x: number, y: number) {
    const d = el('dialogue');
    d.style.setProperty('--dlg-x', `${x}px`);
    d.style.setProperty('--dlg-y', `${y}px`);
  }

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
    const adapt = el('adapt');
    adapt.classList.remove('adapt-flash');
    void adapt.offsetWidth;
    adapt.classList.add('adapt-flash');
    let flash = adapt.querySelector('.adapt-outcome') as HTMLElement | null;
    if (!flash) { flash = document.createElement('div'); flash.className = 'adapt-outcome'; adapt.appendChild(flash); }
    flash.textContent = `${outcome === 'improved' ? '✓' : '✗'} ${explanation}`;
  }

  /** Post-fight analysis speech bubble from the Claude corner. onDismiss is called when the player clicks GOT IT. */
  showCornerAnalysis(text: string, source: 'claude' | 'offline', onDismiss?: () => void) {
    const d = el('debrief');
    const tag = source === 'claude'
      ? `<span class="debrief-source">CLAUDE ANALYSIS</span>`
      : `<span class="debrief-source offline">CORNER NOTES</span>`;
    d.innerHTML = `
      <div class="debrief-box">
        <div class="debrief-header">
          <div class="debrief-claude-icon">C</div>
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
    // Typewriter effect
    const textEl = document.getElementById('debrief-text')!;
    let i = 0;
    const type = () => {
      textEl.textContent = text.slice(0, i);
      if (i < text.length) {
        i++;
        this.typewriterTimer = window.setTimeout(type, 20);
      }
    };
    clearTimeout(this.typewriterTimer);
    window.setTimeout(type, 300); // slight delay before typing starts
  }

  /** Result card shown at fight end before corner scene. stars: 0=loss, 1-3=win quality. */
  showResultCard(won: boolean, reason: string, stars: number) {
    const card = el('result-card');
    const banner = won ? 'VICTORY!' : 'DEFEAT';
    const starsHtml = won
      ? [1, 2, 3].map(i =>
          `<span style="${i <= stars ? '' : 'filter:grayscale(1) opacity(0.3)'}">⭐</span>`
        ).join('')
      : '';
    card.innerHTML = `<div class="result-card-inner">
      <div class="result-card-banner ${won ? 'win' : 'lose'}">${banner}</div>
      <div class="result-card-by">by ${escapeHtml(reason)}</div>
      ${won ? `<div class="result-stars">${starsHtml}</div>` : ''}
    </div>`;
    card.style.display = 'flex';
    clearTimeout(this.resultCardTimer);
    // Fade out at 2000ms, hide at 2400ms
    this.resultCardTimer = window.setTimeout(() => {
      card.classList.add('fade-out');
      window.setTimeout(() => { card.style.display = 'none'; card.classList.remove('fade-out'); }, 400);
    }, 2000);
  }

  toast(text: string, kind: 'good' | 'bad' | 'info' = 'info') {
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    t.textContent = text;
    el('toasts').appendChild(t);
    setTimeout(() => t.remove(), 1050);
  }

  flashDamage() {
    const v = el('vignette');
    v.classList.remove('hit');
    void v.offsetWidth;
    v.classList.add('hit');
  }

  // ── Name entry screen ────────────────────────────────────────────────────

  showNameEntry(onSubmit: (name: string) => void) {
    const screen = el('name-entry-screen');
    screen.innerHTML = `
      <div class="ne-logo">CLAUDE TYSON</div>
      <div class="ne-prompt">WHAT'S YOUR NAME,<br>FIGHTER?</div>
      <input class="ne-input" type="text" placeholder="ENTER NAME" maxlength="16"
             autocomplete="off" spellcheck="false">
      <button class="ne-btn" disabled>LET'S GO</button>`;
    screen.style.display = 'flex';
    screen.classList.remove('ne-fade-out');

    const input = screen.querySelector<HTMLInputElement>('.ne-input')!;
    const btn   = screen.querySelector<HTMLButtonElement>('.ne-btn')!;

    const submit = () => {
      const name = input.value.trim().toUpperCase().slice(0, 16);
      if (!name) return;
      screen.classList.add('ne-fade-out');
      window.setTimeout(() => {
        screen.style.display = 'none';
        screen.classList.remove('ne-fade-out');
        onSubmit(name);
      }, 380);
    };

    input.addEventListener('input', () => { btn.disabled = input.value.trim().length === 0; });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    btn.addEventListener('click', submit);
    window.setTimeout(() => input.focus(), 120);
  }

  // ── Wii safety screen ────────────────────────────────────────────────────

  showWiiSafety(onContinue: () => void) {
    const screen = el('wii-safety-screen');
    screen.innerHTML = `
      <div class="wss-bg">
        <div class="wss-watermark">CT</div>
        <div class="wss-rope wss-rope-1"></div>
        <div class="wss-rope wss-rope-2"></div>
        <div class="wss-rope wss-rope-3"></div>
        <div class="wss-post wss-post-l"></div>
        <div class="wss-post wss-post-r"></div>
        <div class="wss-glove wss-glove-1">🥊</div>
        <div class="wss-glove wss-glove-2">🥊</div>
        <div class="wss-glove wss-glove-3">🥊</div>
        <div class="wss-glove wss-glove-4">🥊</div>
        <div class="wss-glove wss-glove-5">🥊</div>
        <div class="wss-star wss-star-1">⭐</div>
        <div class="wss-star wss-star-2">⭐</div>
        <div class="wss-star wss-star-3">⭐</div>
        <div class="wss-star wss-star-4">⭐</div>
        <div class="wss-star wss-star-5">⭐</div>
        <div class="wss-star wss-star-6">⭐</div>
        <div class="wss-vignette"></div>
      </div>
      <div class="wss-dialog">
        <div class="wss-dialog-header">
          <div class="wss-dialog-icon">!</div>
          <span class="wss-dialog-header-title">Health &amp; Safety</span>
        </div>
        <div class="wss-dialog-body">
          <svg class="wss-diagram-svg" viewBox="0 0 88 88" xmlns="http://www.w3.org/2000/svg">
            <rect x="3" y="3" width="82" height="82" rx="4" fill="#d8d8d8" stroke="#aaa" stroke-width="1.5"/>
            <circle cx="44" cy="44" r="32" fill="none" stroke="#e06820" stroke-width="1.5" stroke-dasharray="4 3"/>
            <circle cx="44" cy="41" r="7"  fill="#e06820"/>
            <circle cx="44" cy="31" r="5"  fill="#e06820"/>
            <line x1="37" y1="40" x2="23" y2="34" stroke="#e06820" stroke-width="3.5" stroke-linecap="round"/>
            <line x1="51" y1="40" x2="65" y2="34" stroke="#e06820" stroke-width="3.5" stroke-linecap="round"/>
            <text x="44" y="11" font-size="9" fill="#c05010" text-anchor="middle" font-weight="900" font-family="Arial">↑</text>
            <text x="44" y="84" font-size="9" fill="#c05010" text-anchor="middle" font-weight="900" font-family="Arial">↓</text>
            <text x="9"  y="47" font-size="9" fill="#c05010" text-anchor="middle" font-weight="900" font-family="Arial">←</text>
            <text x="81" y="47" font-size="9" fill="#c05010" text-anchor="middle" font-weight="900" font-family="Arial">→</text>
          </svg>
          <div class="wss-dialog-textcol">
            <p class="wss-dialog-title">Before You Play</p>
            <p class="wss-dialog-text">
              Make sure there are <b>no people or objects</b> nearby that could be hit during gameplay.<br><br>
              Clear at least <b>3 feet</b> of open space in all directions.
            </p>
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
      window.setTimeout(() => {
        screen.style.display = 'none';
        screen.classList.remove('wss-fade-out');
        onContinue();
      }, 400);
    };

    screen.querySelector('.wss-btn')!.addEventListener('click', (e) => { e.stopPropagation(); done(); });
    screen.addEventListener('click', done, { once: true });
  }

  // ── VS screen ────────────────────────────────────────────────────────────

  showVsScreen(playerName: string, profile: ProfileRow | undefined, onDone: () => void, renderer?: THREE.WebGLRenderer) {
    const screen = el('vs-screen');
    const wins   = profile?.wins ?? 0;
    const losses = profile?.losses ?? 0;
    const initials = playerName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase() || playerName.slice(0, 2).toUpperCase();

    screen.innerHTML = `
      <div class="vs-flash"></div>
      <div class="vs-spotlight"></div>
      <div class="vs-bg-layer"></div>
      <div class="vs-fighter player-side">
        <div class="vs-portrait-wrap">
          <div class="vs-portrait-bg player-bg"></div>
          <div class="vs-avatar player-initials">${initials}</div>
        </div>
        <div class="vs-name-plate">
          <div class="vs-name">${escapeHtml(playerName)}</div>
          <div class="vs-record">${wins}W &nbsp;–&nbsp; ${losses}L</div>
        </div>
        <div class="vs-corner-label"></div>
      </div>
      <div class="vs-center">
        <div class="vs-text">VS</div>
        <div class="vs-clash-line"></div>
      </div>
      <div class="vs-fighter cpu-side">
        <div class="vs-portrait-wrap">
          <div class="vs-portrait-bg cpu-bg"></div>
          <div class="vs-avatar cpu-initials" id="vs-cpu-avatar">CT</div>
        </div>
        <div class="vs-name-plate">
          <div class="vs-name">CLAUDE TYSON</div>
          <div class="vs-record">AI BOXER</div>
        </div>
        <div class="vs-corner-label"></div>
      </div>
      <div class="vs-skip-hint">Click anywhere to skip</div>`;

    screen.style.display = 'flex';
    screen.classList.remove('vs-exit');

    const done = () => {
      clearTimeout(this.vsTimer);
      screen.classList.add('vs-exit');
      window.setTimeout(() => {
        screen.style.display = 'none';
        screen.classList.remove('vs-exit');
        onDone();
      }, 450);
    };

    this.vsTimer = window.setTimeout(done, 3600);
    screen.addEventListener('click', () => done(), { once: true });

    // Rumble effect when VS text appears (~400ms mark)
    window.setTimeout(() => this.triggerVsRumble(screen), 420);

    // Async portrait render — swap in when ready
    if (renderer) {
      import('./vsPortrait').then(({ renderBotPortrait }) =>
        renderBotPortrait(renderer)
      ).then(dataUrl => {
        if (!dataUrl || screen.style.display === 'none') return;
        const avatarEl = document.getElementById('vs-cpu-avatar');
        if (!avatarEl) return;
        avatarEl.innerHTML = `<img class="vs-portrait-img" src="${dataUrl}" alt="Claude Tyson">`;
        avatarEl.classList.add('has-portrait');
      }).catch(() => { /* keep initials fallback */ });
    }
  }

  private triggerVsRumble(screen: HTMLElement) {
    screen.style.transform = 'translateX(-8px)';
    window.setTimeout(() => { screen.style.transform = 'translateX(8px)'; }, 55);
    window.setTimeout(() => { screen.style.transform = 'translateX(-4px)'; }, 110);
    window.setTimeout(() => { screen.style.transform = 'translateX(4px)'; }, 155);
    window.setTimeout(() => { screen.style.transform = 'none'; }, 200);
  }

  private telegraphTimer = 0;
  private dialogueTimer = 0;
  private adaptedTagTimer = 0;
  private resultCardTimer = 0;
  private typewriterTimer = 0;
  private vsTimer = 0;
  private calibrationKey = '';
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]!);
}
