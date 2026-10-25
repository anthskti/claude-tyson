// FriendsPanel — Fortnite-style slide-in friends list.
// All data is hardcoded for the Cal Hacks demo ("performative").
// Slides in from the right; organised into ONLINE / IN THE RING / OFFLINE.

type FriendStatus = 'online' | 'in-game' | 'offline';

interface Friend {
  id:       string;
  name:     string;
  status:   FriendStatus;
  activity: string;
  detail?:  string;          // short badge shown inside the row
  wins:     number;
  losses:   number;
  avatar:   string;          // single emoji used as avatar glyph
}

const DEMO_FRIENDS: Friend[] = [
  // ── ONLINE ─────────────────────────────────────────────────────────────
  { id:'pk',  name:'PUNCHKING99',   status:'online',  activity:'In Lobby',          wins:23, losses:8,  avatar:'👊' },
  { id:'sj',  name:'SWIFT_JAB',     status:'online',  activity:'Ready to Fight',     wins:15, losses:12, avatar:'⚡' },
  // ── IN THE RING ─────────────────────────────────────────────────────────
  { id:'if',  name:'IRON_FIST99',   status:'in-game', activity:'Fighting · Ring 2',  detail:'45s left',   wins:41, losses:9,  avatar:'🥊' },
  { id:'bb',  name:'BROOKLYN_BOMB', status:'in-game', activity:'In Fight · Ring 1',  detail:'KO ROUND!',  wins:18, losses:22, avatar:'💥' },
  { id:'cm',  name:'CHAMP_MODE',    status:'in-game', activity:'Spectating · Ring 3',                     wins:67, losses:14, avatar:'🏆' },
  // ── OFFLINE ─────────────────────────────────────────────────────────────
  { id:'ku',  name:'KNUCKLE_UP',    status:'offline', activity:'Last seen 2h ago',   wins:9,  losses:5,  avatar:'🤜' },
  { id:'hh',  name:'HEADHUNTER',    status:'offline', activity:'Last seen yesterday', wins:34, losses:19, avatar:'🎯' },
  { id:'rd',  name:'ROPE_A_DOPE',   status:'offline', activity:'Last seen 3 days ago',wins:2, losses:11, avatar:'💤' },
];

const ACTION_MSG: Record<string, (n: string) => string> = {
  invite:             (n) => `🥊 Invite sent to ${n}!`,
  watch:              (n) => `👁 Now spectating ${n}'s fight...`,
  'challenge-winner': (n) => `⚡ You'll fight the winner of ${n}'s match!`,
  view:               (n) => `📋 ${n}: ${recordFor(n)} — nice stats!`,
  add:                (n) => `✅ Friend request sent to ${n}!`,
};

function recordFor(name: string): string {
  const f = DEMO_FRIENDS.find(x => x.name === name);
  if (!f) return '—';
  const pct = f.wins + f.losses > 0 ? Math.round(f.wins / (f.wins + f.losses) * 100) : 0;
  return `${f.wins}W-${f.losses}L (${pct}% win rate)`;
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]!);
}

export class FriendsPanel {
  private panel:   HTMLElement;
  private visible  = false;
  private toast:   (msg: string, kind: 'good' | 'bad' | 'info') => void;

  constructor(toast: (msg: string, kind: 'good' | 'bad' | 'info') => void) {
    this.toast = toast;

    // Build the panel DOM
    this.panel = document.createElement('div');
    this.panel.id = 'friends-panel';
    this.panel.setAttribute('aria-label', 'Fight Crew');
    document.body.appendChild(this.panel);

    // Build the toggle button
    const btn = document.createElement('button');
    btn.id = 'friends-toggle-btn';
    btn.title = 'Fight Crew';
    const activeCount = DEMO_FRIENDS.filter(f => f.status !== 'offline').length;
    btn.innerHTML = `
      <svg class="fp-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
        <circle cx="9" cy="7" r="4"/>
        <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
        <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
      </svg>
      <span class="fp-btn-label">CREW</span>
      <span class="fp-btn-count">${activeCount}</span>
    `;
    btn.addEventListener('click', (e) => { e.stopPropagation(); this.toggle(); });
    document.body.appendChild(btn);

    // Close panel when clicking outside
    document.addEventListener('click', (e) => {
      if (this.visible && !this.panel.contains(e.target as Node) && e.target !== btn && !btn.contains(e.target as Node)) {
        this.hide();
      }
    });

    this.render();
  }

  toggle() { this.visible ? this.hide() : this.show(); }

  show() {
    this.visible = true;
    this.panel.classList.add('fp-open');
  }

  hide() {
    this.visible = false;
    this.panel.classList.remove('fp-open');
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private render() {
    const online  = DEMO_FRIENDS.filter(f => f.status === 'online');
    const inGame  = DEMO_FRIENDS.filter(f => f.status === 'in-game');
    const offline = DEMO_FRIENDS.filter(f => f.status === 'offline');
    const totalActive = online.length + inGame.length;

    this.panel.innerHTML = `
      <div class="fp-header">
        <div class="fp-header-left">
          <span class="fp-header-glyph">🥊</span>
          <span class="fp-header-title">FIGHT CREW</span>
          <span class="fp-header-badge">${totalActive} ONLINE</span>
        </div>
        <button class="fp-close-btn" title="Close">✕</button>
      </div>

      <div class="fp-search-row">
        <input class="fp-search" type="text" placeholder="Find a fighter…" spellcheck="false" autocomplete="off">
      </div>

      <div class="fp-body">
        ${online.length ? `
          <div class="fp-section-header fp-sec-online">
            <span class="fp-sec-dot fp-dot-online"></span>ONLINE &nbsp;·&nbsp; ${online.length}
          </div>
          ${online.map(f => this.rowHtml(f)).join('')}
        ` : ''}

        ${inGame.length ? `
          <div class="fp-section-header fp-sec-ingame">
            <span class="fp-sec-dot fp-dot-ingame"></span>IN THE RING &nbsp;·&nbsp; ${inGame.length}
          </div>
          ${inGame.map(f => this.rowHtml(f)).join('')}
        ` : ''}

        ${offline.length ? `
          <div class="fp-section-header fp-sec-offline">
            <span class="fp-sec-dot fp-dot-offline"></span>OFFLINE &nbsp;·&nbsp; ${offline.length}
          </div>
          ${offline.map(f => this.rowHtml(f)).join('')}
        ` : ''}
      </div>

      <div class="fp-footer">
        <div class="fp-footer-note">✦ Powered by SpacetimeDB real-time sync</div>
      </div>
    `;

    this.panel.querySelector('.fp-close-btn')!.addEventListener('click', () => this.hide());

    // Wire search filter
    const search = this.panel.querySelector<HTMLInputElement>('.fp-search')!;
    search.addEventListener('input', () => {
      const q = search.value.toLowerCase();
      this.panel.querySelectorAll<HTMLElement>('.fp-row').forEach(row => {
        const name = row.dataset.name ?? '';
        row.style.display = name.toLowerCase().includes(q) ? '' : 'none';
      });
    });

    // Wire action buttons
    this.panel.querySelectorAll<HTMLButtonElement>('.fp-action-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = btn.dataset.action!;
        const name   = btn.dataset.name!;
        this.doAction(action, name);
      });
    });
  }

  private rowHtml(f: Friend): string {
    const cls = f.status === 'in-game' ? 'ingame' : f.status;
    const initials = f.name.slice(0, 2);
    const winPct = f.wins + f.losses > 0 ? Math.round(f.wins / (f.wins + f.losses) * 100) : 0;

    let actionsHtml = '';
    if (f.status === 'online') {
      actionsHtml = `
        <button class="fp-action-btn fp-action-primary"   data-action="invite"  data-name="${esc(f.name)}">INVITE</button>
        <button class="fp-action-btn fp-action-secondary" data-action="view"    data-name="${esc(f.name)}">RECORD</button>
      `;
    } else if (f.status === 'in-game') {
      actionsHtml = `
        <button class="fp-action-btn fp-action-watch"   data-action="watch"            data-name="${esc(f.name)}">WATCH</button>
        <button class="fp-action-btn fp-action-challenge" data-action="challenge-winner" data-name="${esc(f.name)}">CHALLENGE</button>
      `;
    } else {
      actionsHtml = `
        <button class="fp-action-btn fp-action-muted" data-action="view" data-name="${esc(f.name)}">RECORD</button>
        <button class="fp-action-btn fp-action-muted" data-action="add"  data-name="${esc(f.name)}">ADD</button>
      `;
    }

    return `
      <div class="fp-row fp-row-${cls}" data-name="${esc(f.name)}">
        <div class="fp-avatar fp-avatar-${cls}">
          <span class="fp-avatar-emoji">${f.avatar}</span>
          <span class="fp-status-indicator fp-ind-${cls}"></span>
        </div>
        <div class="fp-info">
          <div class="fp-name">${esc(f.name)}</div>
          <div class="fp-activity">
            ${esc(f.activity)}
            ${f.detail ? `<span class="fp-detail-badge">${esc(f.detail)}</span>` : ''}
          </div>
          <div class="fp-record">${f.wins}W–${f.losses}L &nbsp;·&nbsp; ${winPct}%</div>
        </div>
        <div class="fp-actions">
          ${actionsHtml}
        </div>
      </div>
    `;
  }

  private doAction(action: string, name: string) {
    const fn = ACTION_MSG[action];
    this.toast(fn ? fn(name) : 'Done!', 'good');
  }
}
