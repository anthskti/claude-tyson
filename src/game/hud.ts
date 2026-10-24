import type { PoseState, TrackingState } from './cv/contract';
import type { CvSourceKind, CvStats, CvStatus } from './cv/input';
import type { CalibrationView } from './cv/guard';
import { RULES_HTML } from './combatText';
import type { MatchView, ProfileRow, ResultRow } from './net/server';

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
}

const el = (id: string) => document.getElementById(id)!;

export class Hud {
  private root = document.getElementById('hud')!;

  private actions: HudActions;

  constructor(actions: HudActions) {
    this.actions = actions;
    this.root.innerHTML = `
      <div class="bars">
        <div class="bar me"><span class="name">YOU</span><div class="track"><div id="hp-me" class="fill"></div></div><div class="track stamina"><div id="stamina-me" class="fill"></div></div></div>
        <div id="timer" class="timer">3:00</div>
        <div class="bar opp"><span id="opp-name" class="name">OPPONENT</span><div class="track"><div id="hp-opp" class="fill"></div></div></div>
      </div>
      <div id="status" class="status"></div>
      <div id="menu" class="menu"></div>
      <div id="adapt" class="adapt"></div>
      <div id="pause" class="pause"></div>
      <div id="calibration" class="calibration"></div>
      <div id="toasts" class="toasts"></div>
      <div id="vignette" class="vignette"></div>
      <div id="pose" class="pose"></div>
      <div id="telegraph" class="telegraph"></div>
      <div class="keys">
        body <b>A</b>/<b>D</b> slip · <b>S</b> lean back &nbsp;|&nbsp; guard <b>Q</b>/<b>E</b> one side · <b>W</b> both &nbsp;|&nbsp;
        left straight <b>J</b> · left hook <b>U</b> &nbsp;|&nbsp; right straight <b>K</b> · right hook <b>I</b>
        &nbsp;|&nbsp; <b>T</b> lose tracking · <b>C</b> recalibrate
      </div>`;
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

    el('status').innerHTML = `
      <span class="chip ${s.server}">server: ${s.server}</span>
      <span class="chip ${s.tracking === 'good' ? 'online' : 'warn'}">cv: ${s.tracking}</span>
      ${this.inputChips(s)}`;

    el('opp-name').textContent = s.view?.match.mode === 'bot' ? `BOT` : 'OPPONENT';

    const menu = el('menu');
    menu.style.display = active ? 'none' : 'flex';
    if (!active) menu.innerHTML = this.menuHtml(s);

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
        <button data-action="fightBot" ${offline ? 'disabled' : ''}>Fight adaptive bot</button>
        ${s.queued
          ? `<button data-action="cancelPvp" class="secondary">Waiting for opponent… cancel</button>`
          : `<button data-action="findPvp" class="secondary" ${offline ? 'disabled' : ''}>Find PvP match</button>`}
      </div>
      ${offline ? `<div class="dim">Server ${s.server}${s.serverDetail ? ` (${escapeHtml(s.serverDetail)})` : ''}. Run <code>spacetime start</code> and publish the module. You can still shadowbox.</div>` : ''}
      ${RULES_HTML}
      ${profileHtml}`;
  }

  tick(view: MatchView | undefined) {
    const active = view?.match.status === 'active';
    el('hp-me').style.width = `${view ? Math.max(0, view.me.health / 10) : 100}%`;
    el('hp-opp').style.width = `${view ? Math.max(0, view.opponent.health / 10) : 100}%`;
    el('stamina-me').style.width = `${view ? Math.max(0, Math.min(100, view.me.stamina)) : 100}%`;
    let remaining = 180;
    if (active) {
      const endsMs = Number(view.match.endsAt.microsSinceUnixEpoch / 1000n);
      remaining = Math.max(0, Math.ceil((endsMs - Date.now()) / 1000));
    }
    el('timer').textContent = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
  }

  renderPose(pose: PoseState) {
    const body = { neutral: 'NEUTRAL', lean_left: '◀ DODGE LEFT', lean_right: 'DODGE RIGHT ▶' }[pose.body];
    const g = (on: boolean) => (on ? 'BLOCK' : '—');
    el('pose').innerHTML = `<span>${body}</span><span class="dim">guard L ${g(pose.guards.left === 'block')} · R ${g(pose.guards.right === 'block')}</span>`;
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
