import type { PoseState, TrackingState } from './cv/contract';
import { RULES_HTML } from './combatText';
import type { MatchView, ProfileRow, ResultRow } from './net/server';

// Plain-DOM HUD. Re-rendered on server changes; the timer and health bars are also
// refreshed every frame via tick().

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
      <div id="status" class="status"></div>
      <div id="menu" class="menu"></div>
      <div id="adapt" class="adapt"></div>
      <div id="pause" class="pause"></div>
      <div id="toasts" class="toasts"></div>
      <div id="vignette" class="vignette"></div>
      <div id="pose" class="pose"></div>
      <div id="telegraph" class="telegraph"></div>
      <div class="keys">
        body <b>A</b>/<b>D</b> slip · <b>S</b> lean back &nbsp;|&nbsp; guard <b>Q</b>/<b>E</b> one side · <b>W</b> both &nbsp;|&nbsp;
        left <b>J</b> jab · <b>U</b> hook · <b>M</b> upper &nbsp;|&nbsp; right <b>K</b> straight · <b>I</b> hook · <b>,</b> upper
        &nbsp;|&nbsp; <b>T</b> lose tracking · <b>C</b> recalibrate
      </div>`;
    this.root.addEventListener('click', e => {
      const action = (e.target as HTMLElement).dataset.action as keyof HudActions | undefined;
      if (action) this.actions[action]();
    });
  }

  render(s: HudState) {
    const active = s.view?.match.status === 'active';

    el('status').innerHTML = `
      <span class="chip ${s.server}">server: ${s.server}</span>
      <span class="chip ${s.tracking === 'good' ? 'online' : 'warn'}">cv: ${s.tracking}</span>
      <span class="chip synthetic">simulated input</span>`;

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
          mix J/S/H/U ${[strat.jabWeight, strat.straightWeight, strat.hookWeight, strat.uppercutWeight].map(w => w.toFixed(2)).join('/')} ·
          left ${(strat.leftBias * 100).toFixed(0)}% · defends ${(strat.defenseRate * 100).toFixed(0)}% ·
          telegraph ${strat.telegraphMs}ms</div>`;
    }

    const paused = active && s.tracking !== 'good';
    el('pause').style.display = paused ? 'flex' : 'none';
    if (paused) {
      el('pause').innerHTML = `<div><h2>${s.tracking === 'calibrating' ? 'Calibrating…' : 'Tracking lost'}</h2>
        <p>${s.trackingReason ?? 'Step back into frame and return to guard.'}</p>
        <p class="dim">The bot holds fire and incoming hits are unscorable until tracking recovers.</p></div>`;
    }
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
          <div>jab ${p.jabs} · straight ${p.straights} · hook ${p.hooks} · upper ${p.uppercuts} · landed ${p.punchesLanded} · counters ${p.counters}</div>
          <div>of ${p.defenseOpportunities} incoming: slipped ${p.slips} · leaned back ${p.leanBacks} · blocked ${p.blocks} · hit ${p.hitsTaken}</div>
        </div>`
      : '';
    return `
      <h1>CLAUDE TYSON</h1>
      ${resultHtml}
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
    el('hp-me').style.width = `${view ? Math.max(0, view.me.health) : 100}%`;
    el('hp-opp').style.width = `${view ? Math.max(0, view.opponent.health) : 100}%`;
    let remaining = 180;
    if (active) {
      const endsMs = Number(view.match.endsAt.microsSinceUnixEpoch / 1000n);
      remaining = Math.max(0, Math.ceil((endsMs - Date.now()) / 1000));
    }
    el('timer').textContent = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
  }

  renderPose(pose: PoseState) {
    const body = { neutral: 'NEUTRAL', lean_left: '◀ SLIP LEFT', lean_right: 'SLIP RIGHT ▶', lean_back: '▼ LEAN BACK' }[pose.body];
    const g = (on: boolean) => (on ? 'BLOCK' : '—');
    el('pose').innerHTML = `<span>${body}</span><span class="dim">guard L ${g(pose.guards.left === 'block')} · R ${g(pose.guards.right === 'block')}</span>`;
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
