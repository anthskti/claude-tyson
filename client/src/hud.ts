import type { PoseState, TrackingState } from './cv/contract';
import type { MatchView, ProfileRow, ResultRow } from './net/server';

export interface HudActions {
  fightBot(): void;
  findPvp(): void;
  cancelPvp(): void;
  forfeit(): void;
}

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
  cvSource?: 'live' | 'synthetic';
  cinematic?: boolean; // true while corner scene owns the camera
}

const el = (id: string) => document.getElementById(id)!;

export class Hud {
  private root = document.getElementById('hud')!;
  private actions: HudActions;

  constructor(actions: HudActions) {
    this.actions = actions;
    this.root.innerHTML = `
      <div class="bars">
        <div class="bar me"><span class="name">YOU</span><div class="track"><div id="hp-me" class="fill"></div></div></div>
        <div id="timer" class="timer">3:00</div>
        <div class="bar opp"><span id="opp-name" class="name">OPPONENT</span><div class="track"><div id="hp-opp" class="fill"></div></div></div>
      </div>
      <div id="server-dot" class="server-dot"></div>
      <div id="menu" class="menu"></div>
      <div id="adapt" class="adapt"></div>
      <div id="adapted-tag" class="adapted-tag"></div>
      <div id="pause" class="pause"></div>
      <div id="toasts" class="toasts"></div>
      <div id="vignette" class="vignette"></div>
      <div id="adapt-vignette" class="adapt-vignette"></div>
      <div id="dialogue" class="dialogue"></div>
      <div id="telegraph" class="telegraph"></div>
      <div id="corner-analysis" class="corner-analysis"></div>`;

    this.root.addEventListener('click', e => {
      const action = (e.target as HTMLElement).dataset.action as keyof HudActions | undefined;
      if (action) this.actions[action]();
    });
  }

  render(s: HudState) {
    const active = s.view?.match.status === 'active';

    // Tiny server status dot
    const dot = el('server-dot');
    dot.className = `server-dot ${s.server}`;
    dot.title = `Server: ${s.server}${s.serverDetail ? ` (${s.serverDetail})` : ''}`;

    el('opp-name').textContent = s.view?.match.mode === 'bot' ? 'CLAUDE TYSON' : 'OPPONENT';

    const menu = el('menu');
    const showMenu = !active && !s.cinematic;
    menu.style.display = showMenu ? 'flex' : 'none';
    if (showMenu) menu.innerHTML = this.menuHtml(s);

    const adapt = el('adapt');
    const strat = s.view?.strategy;
    adapt.style.display = active && strat ? 'block' : 'none';
    if (strat) {
      adapt.innerHTML = `
        <div class="label">Strategy rev ${strat.revision}</div>
        <div class="explain">${escapeHtml(strat.explanation)}</div>`;
    }

    const paused = active && s.tracking !== 'good';
    el('pause').style.display = paused ? 'flex' : 'none';
    if (paused) {
      el('pause').innerHTML = `<div>
        <h2>${s.tracking === 'calibrating' ? 'Calibrating…' : 'Tracking lost'}</h2>
        <p>${s.trackingReason ?? 'Step back into frame and return to guard.'}</p>
      </div>`;
    }
  }

  private menuHtml(s: HudState): string {
    const offline = s.server !== 'online';
    let resultHtml = '';
    if (s.view && s.result) {
      const w = s.result.winnerSlot;
      const outcome = w === undefined ? 'DRAW' : w === s.view.me.slot ? 'YOU WIN' : 'YOU LOSE';
      resultHtml = `<div class="result"><h2>${outcome}</h2><div class="dim">by ${s.result.reason}</div></div>`;
    }
    const p = s.profile;
    const profileHtml = p
      ? `<div class="profile"><div><b>${p.wins}</b>W · <b>${p.losses}</b>L · ${p.matchesPlayed} fights</div></div>`
      : '';
    return `
      <h1>CLAUDE TYSON</h1>
      ${resultHtml}
      <div class="buttons">
        <button data-action="fightBot" ${offline ? 'disabled' : ''}>Fight Claude Tyson</button>
        ${s.queued
          ? `<button data-action="cancelPvp" class="secondary">Waiting for opponent… cancel</button>`
          : `<button data-action="findPvp" class="secondary" ${offline ? 'disabled' : ''}>Find PvP Match</button>`}
      </div>
      ${offline ? `<div class="dim small">Server ${s.server}${s.serverDetail ? ` · ${escapeHtml(s.serverDetail)}` : ''}</div>` : ''}
      ${profileHtml}`;
  }

  tick(view: MatchView | undefined) {
    const active = view?.match.status === 'active';
    el('hp-me').style.width = `${view ? Math.max(0, view.me.health) : 100}%`;
    el('hp-opp').style.width = `${view ? Math.max(0, view.opponent.health) : 100}%`;
    let remaining = 180;
    if (active) {
      const endsMs = Number(view.match.endsAt.microsSinceUnixEpoch / 1000n);
      remaining = Math.max(0, Math.ceil((endsMs - Date.now()) / 1000));
    }
    el('timer').textContent = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
  }

  renderPose(_pose: PoseState) { /* pose display removed for clean UI */ }

  telegraph(name: string, answer: string, msUntilImpact: number) {
    const t = el('telegraph');
    t.innerHTML = `<div class="incoming">${name}</div><div class="answer">${answer}</div>`;
    t.style.display = 'block';
    clearTimeout(this.telegraphTimer);
    this.telegraphTimer = window.setTimeout(() => this.clearTelegraph(), Math.max(0, msUntilImpact) + 300);
  }

  clearTelegraph() { el('telegraph').style.display = 'none'; }
  private telegraphTimer = 0;

  showDialogue(line: string) {
    const d = el('dialogue');
    d.textContent = `"${line}"`;
    d.classList.remove('visible');
    void d.offsetWidth;
    d.classList.add('visible');
    clearTimeout(this.dialogueTimer);
    this.dialogueTimer = window.setTimeout(() => d.classList.remove('visible'), 4200);
  }
  private dialogueTimer = 0;

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
  private adaptedTagTimer = 0;

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

  /** Corner speech bubble — overlaid on the 3D scene, visible once camera reaches corner. */
  showCornerAnalysis(analysis: string, source: 'claude' | 'offline', onDismiss?: () => void) {
    const d = el('corner-analysis');
    const badge = source === 'claude'
      ? `<span class="ca-badge ca-claude">CLAUDE</span>`
      : `<span class="ca-badge ca-offline">CORNER</span>`;
    d.innerHTML = `
      <div class="ca-bubble">
        <div class="ca-top">YOUR CORNER SAYS ${badge}</div>
        <p class="ca-text">${escapeHtml(analysis).replace(/\n/g, '<br>')}</p>
        <button class="ca-close">GOT IT →</button>
      </div>`;
    d.style.display = 'flex';
    d.querySelector('.ca-close')!.addEventListener('click', () => {
      d.style.display = 'none';
      onDismiss?.();
    });
  }

  hideCornerAnalysis() { el('corner-analysis').style.display = 'none'; }

  showDebrief(analysis: string) { this.showCornerAnalysis(analysis, 'offline'); }

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
    void v.offsetWidth;
    v.classList.add('hit');
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]!);
}
