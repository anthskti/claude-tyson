# Claude Tyson — Branch Migration Guide
> Changes from `feat/combined-polish` worth migrating into `main`.
> Written for Anthony so he can apply these on top of his multiplayer work.
> Every section is self-contained — migrate in any order.

---

## Table of Contents
1. [Adaptive AI Strategist — System Prompt & Tool Schema](#1-adaptive-ai-strategist)
2. [Post-Fight Analysis — Prompt, Persona & Model Config](#2-post-fight-analysis)
3. [Adaptation Manager — Faster Detection, Match-Scoped Windows](#3-adaptation-manager)
4. [SpacetimeDB — Punch Type Counting Fix](#4-spacetimedb-punch-type-counting-fix)
5. [VS Screen — SF6-style Layout](#5-vs-screen-layout)
6. [Corner Scene — Analysis Bubble + 3D Model Auto-fit](#6-corner-scene)
7. [Wii Safety Dialog — Dark Glass Theme](#7-wii-safety-dialog-dark-glass)
8. [Menu — Ambient Decorations](#8-menu-ambient-decorations)
9. [Mahoraga's Wheel — Realistic Colors + Clank Sound](#9-maharagas-wheel)
10. [Small Misc Fixes](#10-misc-fixes)

---

## 1. Adaptive AI Strategist

**File:** `coach/strategist.ts`

The old system prompt was vague and the tool schema exposed `uppercutWeight` and had wrong `leftBias` range. Replace entirely.

### System Prompt

```typescript
const SYSTEM_PROMPT = `You are the adaptive AI strategist for Claude Tyson, a CPU boxer that reacts to the human player's punch patterns in real-time.

Every 6 seconds you receive a fight window. Your job: mutate the bot's behavior knobs to make the fight harder and expose the player's weaknesses. Be decisive — make meaningful changes, not tiny tweaks.

=== BOT PUNCH SYSTEM (hooks + straights only, no jabs or uppercuts) ===
jabWeight    (0–1): probability weight for LEFT-HAND straights
straightWeight (0–1): probability weight for RIGHT-HAND straights (power punches)
hookWeight   (0–1): probability weight for HOOKS on BOTH hands (wide arc, punishes extended arms)
leftBias (0–1): hand selection — 0=always right-hand, 0.5=balanced, 1=always left-hand

=== OTHER KNOBS ===
aggression (0–1): how often bot initiates attacks. 0.8+ = relentless pressure.
punchIntervalMs (600–4000): ms between bot punches. 600=very fast, 1600=default.
defenseRate (0–0.8): fraction of incoming punches bot slips or blocks.
telegraphMs (350–1200): ms before impact the visual cue appears. Lower = harder to react.

=== COUNTER-TRIANGLE: how to exploit punch patterns ===
• Player throwing >55% straights → raise hookWeight (hooks beat straight-arm extension)
• Player throwing >55% hooks     → raise jabWeight + straightWeight, lower hookWeight (straights beat hook openings)
• Player landing rate > 55%      → lower telegraphMs by 100–150ms AND raise defenseRate by 0.1
• Player landing rate > 55% and playerCaught > 3 → raise aggression (punish recovery gaps)
• Player landing rate < 25%      → raise aggression 0.15, keep defenseRate low (dominant bot presses advantage)
• Player attempts low but landing high → raise telegraphMs (give them readable cues, keep fight fair)
• leftBias tip: attack the side where player's guard is weaker (default 0.5 balanced)

=== HISTORY RULE ===
• If previous strategy "worsened": change a DIFFERENT knob, or reverse direction — do NOT repeat the same move.
• If "inconclusive" two or more times in a row: make a bold change (±0.25 aggression, ±300ms interval, ±0.3 weight).
• If "improved": the current strategy is working — skip OR make only a tiny tightening move (±0.05).
• Never return the exact same knob values as current strategy (that's a skip — use skip=true instead).

=== SKIP RULES (set skip=true, still fill all other fields with CURRENT values) ===
• playerAttempts < 5 (not enough data)
• trackingCoverage < 0.5 (unreliable data)
• Strategy is currently "improved" and you have no strong counter-signal

Keep explanation ≤ 130 chars. Always cite the key stat (e.g., "hooks 63%, raising straight weights to counter").`;
```

### Tool Schema Changes

Remove `uppercutWeight`, fix `leftBias` range to `0–1` (not `-1–1`), tighten `telegraphMs` to `350–1200` (was `200–1000`). Add descriptions to every property:

```typescript
function tool() {
  return {
    name: "update_strategy",
    description: "Update the bot strategy knobs, or skip if data is insufficient or strategy is already working.",
    input_schema: {
      type: "object",
      properties: {
        skip: { type: "boolean", description: "true if no change needed or data insufficient" },
        aggression: { type: "number", minimum: 0, maximum: 1, description: "attack initiation frequency" },
        punchIntervalMs: { type: "number", minimum: 600, maximum: 4000, description: "ms between bot punches" },
        jabWeight: { type: "number", minimum: 0, maximum: 1, description: "left-hand straight probability weight" },
        straightWeight: { type: "number", minimum: 0, maximum: 1, description: "right-hand straight probability weight" },
        hookWeight: { type: "number", minimum: 0, maximum: 1, description: "hook probability weight for both hands" },
        leftBias: { type: "number", minimum: 0, maximum: 1, description: "hand bias: 0=always right, 0.5=balanced, 1=always left" },
        defenseRate: { type: "number", minimum: 0, maximum: 0.8, description: "fraction of incoming punches bot slips/blocks" },
        telegraphMs: { type: "number", minimum: 350, maximum: 1200, description: "ms before impact visual cue appears" },
        explanation: { type: "string", description: "≤130 chars: what changed and why (cite a stat)" },
      },
      required: ["skip", "aggression", "punchIntervalMs", "jabWeight", "straightWeight",
                 "hookWeight", "leftBias", "defenseRate", "telegraphMs", "explanation"],
    },
  };
}
```

### User Message Builder

Replace the old `JSON.stringify(req)` dump with a structured, human-readable message:

```typescript
function buildUserMessage(req: StrategistRequest): string {
  const { window: w, strategy: s, history } = req;
  const acc = w.playerAttempts > 0 ? Math.round((w.playerLanded / w.playerAttempts) * 100) : 0;
  const hookPct = w.playerAttempts > 0 ? Math.round((w.playerHooks / w.playerAttempts) * 100) : 0;
  const stPct   = w.playerAttempts > 0 ? Math.round((w.playerStraights / w.playerAttempts) * 100) : 0;

  const histLines = history.length > 0
    ? history.map(h => `  [${h.outcome}] ${h.explanation}`).join('\n')
    : '  (none yet)';

  return `=== WINDOW #${req.windowId} ===
Player: ${w.playerLanded}/${w.playerAttempts} landed (${acc}%) | hooks ${hookPct}% | straights ${stPct}%
Defense: ${w.playerSlips} slips, ${w.playerBlocks} blocks, took ${w.playerCaught} hits
Health: bot ${w.botHealth}/100, player ${w.playerHealth}/100 | tracking ${Math.round(w.trackingCoverage * 100)}%
Bot attacks this window: ${w.botAttacks}

Current strategy (rev ${req.strategyRevision}):
  aggression=${s.aggression.toFixed(2)}, interval=${s.punchIntervalMs}ms, telegraph=${s.telegraphMs}ms
  hooks=${s.hookWeight.toFixed(2)}, straights=${s.straightWeight.toFixed(2)}, jabs=${s.jabWeight.toFixed(2)}, leftBias=${s.leftBias.toFixed(2)}, defense=${s.defenseRate.toFixed(2)}
  last reason: "${s.explanation}"

Adaptation history (oldest→newest):
${histLines}

Call update_strategy now.`;
}
```

Then in `coachWithStrategist`:
```typescript
// Change this:
messages: [{ role: "user", content: `Fight window:\n${JSON.stringify(req)}` }],
// To this:
messages: [{ role: "user", content: buildUserMessage(req) }],
```

### Response Clamping

Force `uppercutWeight` to 0 always, and fix `leftBias` clamping to `0–1`:

```typescript
uppercutWeight: 0,
leftBias: clamp(Number(inp.leftBias ?? req.strategy.leftBias), 0, 1),
telegraphMs: Math.round(clamp(Number(inp.telegraphMs ?? req.strategy.telegraphMs), 350, 1200)),
```

### Timeout

Increase from 4000ms to 7000ms — the structured prompt takes a tiny bit longer but gets much better results:
```typescript
const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 7000);
```

### History window

Increase from 2 to 3 entries so Claude has more context for the "did it work" loop:
```typescript
history: this.history.slice(-3),
```

---

## 2. Post-Fight Analysis

**File:** `coach/analysis.ts`

### Add `playerName` to the request interface

```typescript
export interface AnalysisRequest {
  matchId: string;
  playerName?: string;   // ← ADD THIS
  result: { won: boolean; reason: string };
  windows: FightWindowSummary[];
  adaptationCount: number;
}
```

### System Prompt

Replace entirely. Key changes: warmer persona ("Claude Crab"), strict 2-3 sentences, no stats/numbers, no jab/uppercut mentions, no outside-fight references:

```typescript
const SYSTEM_PROMPT = `You are Claude Crab, an enthusiastic boxing coach and gym trainer who genuinely wants to see this fighter grow. Give a post-match analysis in 2 to 3 sentences covering what went well and the main thing to work on.

Style: warm, direct, encouraging but honest. Think Wii Fit trainer energy crossed with a real boxing corner coach. Address the fighter by name if provided.

Rules:
- Exactly 2 to 3 sentences. No more.
- No dashes, em dashes, colons, semicolons, or asterisks anywhere in the output.
- No stats, numbers, or percentages. Describe patterns and tendencies in plain language.
- This fighter only throws hooks and straights. Never mention jabs or uppercuts.
- Base everything on patterns across the whole fight, not single moments.
- If they won, still identify the main habit to sharpen. If they lost, lead with what showed genuine promise.
- Give practical actionable boxing advice the way a real gym trainer would.
- No mention of future sessions, next time, or anything outside this fight.
- No markdown, no bold, no bullet points. Plain sentences only.`;
```

### User Prompt Builder

Address by name, remove jab/uppercut stats, update health display, reinforce formatting constraint at the end:

```typescript
function buildUserPrompt(req: AnalysisRequest): string {
  const total = req.windows.reduce((s, w) => s + w.playerAttempts, 0);
  const landed = req.windows.reduce((s, w) => s + w.playerLanded, 0);
  const slips = req.windows.reduce((s, w) => s + w.playerSlips, 0);
  const blocks = req.windows.reduce((s, w) => s + w.playerBlocks, 0);
  const caught = req.windows.reduce((s, w) => s + w.playerCaught, 0);
  const hooks = req.windows.reduce((s, w) => s + w.playerHooks, 0);
  const straights = req.windows.reduce((s, w) => s + w.playerStraights, 0);
  const acc = total > 0 ? Math.round((landed / total) * 100) : 0;
  const lastHealth = req.windows.at(-1)?.playerHealth ?? 100;
  const skill = total < 10 || acc < 20 ? 'beginner' : acc > 40 && req.windows.length >= 4 ? 'advanced' : 'intermediate';

  const name = req.playerName ?? 'the fighter';
  const outcome = req.result.won ? `${name} WON` : `${name} LOST`;
  return `Player name: ${name}
Outcome: ${outcome} by ${req.result.reason}.
Skill level (inferred): ${skill}
Total punches thrown: ${total} | landed: ${landed} (${acc}%)
Punch mix: straights ${straights}, hooks ${hooks}
Defense: ${slips} slips, ${blocks} blocks, took ${caught} hits
Player health remaining: ${lastHealth}/133
Bot adapted ${req.adaptationCount} times during the fight.
Fight windows (each ~6s): ${req.windows.length}

Give them your post-match analysis now. Address them by name. No dashes, colons, semicolons, em dashes, or asterisks.`;
}
```

### Max tokens

Reduce from 350 to 250 — 2-3 sentences doesn't need more:
```typescript
max_tokens: 250,
```

### Model

Use `claude-haiku-4-5-20251001` — fast and cheap for this use case:
```typescript
export const DEFAULT_ANALYSIS_MODEL = "claude-haiku-4-5-20251001";
```

### Pass playerName when calling `enter()` on CornerScene

In `main.ts` (or wherever you call `cornerScene.enter()`):
```typescript
// Old:
cornerScene.enter(conn, matchId, won, reason, adaptationCount);
// New:
cornerScene.enter(conn, matchId, won, reason, adaptationCount, hudState.playerName);
```

And in `CornerScene.fetchAnalysis()`:
```typescript
const req: AnalysisRequest = {
  matchId: String(matchId),
  playerName,        // ← pass through
  result: { won, reason },
  windows,
  adaptationCount,
};
```

### Persist analysis to SpacetimeDB

After receiving the analysis response, call `submitFightAnalysis` so the profile stores the last analysis. Add this in `fetchAnalysis` in `cornerScene.ts`:

```typescript
// After successful analysis fetch:
if (conn) {
  conn.reducers.submitFightAnalysis({ matchId, analysis: data.text }).catch(() => {});
}
// Also in the offline fallback path — same pattern.
```

---

## 3. Adaptation Manager

**File:** `src/game/adaptationManager.ts`

### Match-scoped window filtering

SpacetimeDB replays ALL historical rows when you connect. Without this, the adaptation loop fires on stale windows from previous fights before the current fight even starts.

Add `activeMatchId` field and guard at top of `onWindow`:

```typescript
private activeMatchId: bigint | undefined;

async onWindow(window: FightWindowRow, strategy: StrategyRow | undefined) {
  // Ignore rows from previous matches (SpacetimeDB replays on connect)
  if (this.activeMatchId === undefined || window.matchId !== this.activeMatchId) return;
  // ... rest of method
}

reset(matchId?: bigint) {
  this.state = "idle";
  this.pending = null;
  this.history = [];
  this.activeMatchId = matchId;  // ← record which match we're watching
}
```

Call `reset(matchId)` when a fight starts, passing the new match ID.

### Punch type counting (hooks + straights only)

Remove jabs and uppercuts from `playerAttempts` calculation:

```typescript
// Old:
const playerAttempts =
  window.playerJabs + window.playerStraights + window.playerHooks +
  window.playerUppercuts + window.playerUnclassified;

// New:
const playerAttempts = window.playerStraights + window.playerHooks;

// Skip windows where player barely threw — Claude would skip anyway and this wastes API calls:
if (playerAttempts < 3) {
  log(`W#${window.id} skip — playerAttempts ${playerAttempts}`);
  return;
}
```

Apply the same fix in `evaluate()` and when recording `prePlayerAttempts` for the pending eval.

### Evaluation thresholds (much more reactive)

The old thresholds were too conservative — they waited 3-4 windows before detecting anything. New values trigger in 1-2 windows:

```typescript
private evaluate(nextWindow: FightWindowRow, prev: PendingEval): "improved" | "worsened" | "inconclusive" {
  const nextAttempts = nextWindow.playerStraights + nextWindow.playerHooks;
  const hasEnoughData = prev.prePlayerAttempts >= 8 && nextAttempts >= 8;

  const nextRate = nextAttempts > 0 ? nextWindow.playerLanded / nextAttempts : 0;
  const prevRate = prev.prePlayerAttempts > 0 ? prev.prePlayerLanded / prev.prePlayerAttempts : 0;
  const healthDelta = nextWindow.botHealth - prev.preBotHealth;

  // Bot barely lost health → strategy is working
  if (healthDelta >= -4) return "improved";
  // Bot took significant damage → strategy worsened
  if (healthDelta < -10) return "worsened";

  // Accuracy delta only reliable with enough samples
  if (hasEnoughData) {
    if (nextRate < prevRate - 0.05) return "improved";
    if (nextRate > prevRate + 0.05) return "worsened";
  }
  return "inconclusive";
}
```

**Old thresholds for reference:**
- `healthDelta > 5` → improved (now `>= -4`)
- `healthDelta < -10` → worsened (same)
- accuracy delta `±0.06` (now `±0.05` with sample guard)

### Force uppercutWeight to 0 in the applied patch

```typescript
uppercutWeight: 0,  // ← always zero, game doesn't use uppercuts
```

---

## 4. SpacetimeDB — Punch Type Counting Fix

**File:** `spacetimedb/src/index.ts`

The old counting used exact string equality (`=== 'jab'`). The punch type strings from the engine are things like `left_hook`, `right_straight`, etc. Fix to use `includes()`:

```typescript
// In finishMatch, profile update:
jabs: p.jabs + count(mine, a => a.punchType.includes('jab')),
straights: p.straights + count(mine, a => a.punchType.includes('straight')),
hooks: p.hooks + count(mine, a => a.punchType.includes('hook')),
uppercuts: p.uppercuts + count(mine, a => a.punchType.includes('uppercut')),
unclassified: p.unclassified + count(mine, a => a.punchType === 'unclassified'),
```

In `closeWindow` reducer, since the game only uses hooks + straights:
```typescript
playerJabs: 0,
playerStraights: count(mine, a => a.punchType.includes('straight')),
playerHooks: count(mine, a => a.punchType.includes('hook')),
playerUppercuts: 0,
playerUnclassified: 0,
```

### SpacetimeDB connection — disable compression

Prevents a common "message too large" WebSocket error during heavy fight traffic:

```typescript
// In your GameServer constructor / connect setup:
.withCompression('none')
```

---

## 5. VS Screen Layout

**File:** `src/game/style.css` + `src/game/hud.ts`

### The problem with the old layout

`justify-content: flex-end` stacked the avatar + nameplate at the very bottom. The nameplate as a flex item mixed badly with any absolute-positioned elements, causing the name to either overflow or get crushed.

### HTML structure (hud.ts `showVsScreen`)

Replace `.vs-portrait-wrap` / `.vs-portrait-bg` / `.vs-name-plate` / `.vs-corner-label` with a simpler flat structure. Remove the async 3D portrait render (too fragile for demo):

```html
<div class="vs-fighter player-side">
  <div class="vs-stage-light"></div>
  <div class="vs-watermark">${initial}</div>      <!-- single letter, giant faded bg -->
  <div class="vs-avatar">${initials}</div>        <!-- circular avatar with initials -->
  <div class="vs-nameplate">
    <div class="vs-name">${escapeHtml(playerName)}</div>
    <div class="vs-record">${wins}W &nbsp;–&nbsp; ${losses}L</div>
  </div>
</div>
<div class="vs-center">
  <div class="vs-text">VS</div>
  <div class="vs-clash-line"></div>
</div>
<div class="vs-fighter cpu-side">
  <div class="vs-stage-light"></div>
  <div class="vs-watermark">CT</div>
  <div class="vs-avatar">CT</div>
  <div class="vs-nameplate">
    <div class="vs-name">CLAUDE TYSON</div>
    <div class="vs-record">AI BOXER</div>
  </div>
</div>
```

Note: `initial` = `(playerName[0] ?? 'P').toUpperCase()` (single char watermark), `initials` = up to 2 chars for the avatar circle.

### CSS — VS screen (full replacement block)

```css
/* Fighter panels */
.vs-fighter {
  flex: 1;
  position: relative;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;   /* CENTER not flex-end */
  overflow: hidden;
  padding-bottom: clamp(70px, 14vh, 110px);       /* reserve space for nameplate */
}
.vs-fighter.player-side {
  background: radial-gradient(ellipse 85% 70% at 48% 72%, #1a3a80 0%, #0a1e50 42%, #050e28 100%);
  clip-path: polygon(0 0, calc(100% - 3vw) 0, 100% 100%, 0 100%); /* diagonal right cut */
  animation: vs-slide-left 0.38s cubic-bezier(0.16,1,0.3,1) both;
}
.vs-fighter.cpu-side {
  background: radial-gradient(ellipse 85% 70% at 52% 72%, #5a2800 0%, #2e1200 42%, #120700 100%);
  clip-path: polygon(3vw 0, 100% 0, 100% 100%, 0 100%); /* diagonal left cut */
  animation: vs-slide-right 0.38s cubic-bezier(0.16,1,0.3,1) 0.06s both;
}

/* Stage spotlight beam from top */
.vs-stage-light {
  position: absolute; top: -10%; left: 50%; transform: translateX(-50%);
  width: 70%; height: 90%;
  background: radial-gradient(ellipse 100% 100% at 50% 0%, rgba(255,255,255,0.07) 0%, transparent 68%);
  pointer-events: none; z-index: 0;
  animation: vs-spotlight-in 0.8s ease 0.3s both;
}
@keyframes vs-spotlight-in { from { opacity:0; } to { opacity:1; } }

/* Giant faded watermark letter (SF6 style) */
.vs-watermark {
  position: absolute; bottom: -8%; left: 50%; transform: translateX(-50%);
  font-family: 'Lilita One', cursive;
  font-size: clamp(18rem, 38vw, 32rem);
  line-height: 0.82; font-weight: 900; color: #fff;
  opacity: 0.045; pointer-events: none; user-select: none;
  letter-spacing: -0.04em; z-index: 0;
}

/* Avatar circle */
.vs-avatar {
  width: clamp(120px, min(28vw, 34vh), 260px);
  height: clamp(120px, min(28vw, 34vh), 260px);
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-family: 'Lilita One', cursive;
  font-size: clamp(2rem, min(6vw, 8vh), 4.5rem);
  color: #fff; letter-spacing: 0.02em;
  position: relative; z-index: 2; flex-shrink: 0;
  border: 4px solid rgba(255,255,255,0.14);
  box-shadow: 0 0 0 2px rgba(255,255,255,0.06), 0 0 60px rgba(0,0,0,0.7), 0 20px 60px rgba(0,0,0,0.6);
  overflow: hidden;
  animation: vs-avatar-in 0.5s cubic-bezier(0.22,1,0.36,1) 0.18s both;
}
@keyframes vs-avatar-in {
  from { transform: translateY(28px) scale(0.88); opacity: 0; }
  to   { transform: none; opacity: 1; }
}
.vs-avatar::before {
  content: '';
  position: absolute; inset: 0; border-radius: 50%;
  background: linear-gradient(145deg, rgba(255,255,255,0.22) 0%, transparent 50%);
  pointer-events: none; z-index: 1;
}
.player-side .vs-avatar {
  background: radial-gradient(circle at 38% 30%, #5a9aff 0%, #2056d0 40%, #0c2a80 100%);
}
.cpu-side .vs-avatar {
  background: radial-gradient(circle at 38% 30%, #ff9040 0%, #c05000 40%, #5a1800 100%);
}

/* Bottom nameplate — absolutely pinned so it doesn't interfere with avatar centering */
.vs-nameplate {
  position: absolute; bottom: 0; left: 0; right: 0;
  padding: clamp(8px, 1.5vh, 14px) 20px clamp(10px, 2.5vh, 20px);
  text-align: center; z-index: 3;
}
.player-side .vs-nameplate {
  background: linear-gradient(to top, rgba(10,24,70,0.98) 0%, rgba(10,24,70,0.6) 70%, transparent 100%);
  border-top: 3px solid #3a70ff;
  box-shadow: inset 0 1px 0 rgba(80,130,255,0.3);
}
.cpu-side .vs-nameplate {
  background: linear-gradient(to top, rgba(40,16,0,0.98) 0%, rgba(40,16,0,0.6) 70%, transparent 100%);
  border-top: 3px solid #e07020;
  box-shadow: inset 0 1px 0 rgba(255,140,40,0.3);
}
.vs-name {
  font-family: 'Lilita One', cursive;
  font-size: clamp(1rem, min(3vw, 3.5vh), 1.8rem);
  color: #fff; letter-spacing: 0.06em; text-transform: uppercase;
  text-shadow: 0 2px 12px rgba(0,0,0,0.9), 0 0 30px rgba(255,255,255,0.1);
  line-height: 1.1; margin-bottom: 4px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 90%;
}
.vs-record {
  font-family: 'Nunito', sans-serif;
  font-size: clamp(0.7rem, 1.5vw, 0.85rem);
  font-weight: 800; letter-spacing: 0.16em; text-transform: uppercase;
  color: rgba(255,255,255,0.42);
}

/* VS text + clash line */
.vs-center {
  position: absolute; left: 50%; top: 50%;
  transform: translate(-50%, -50%);
  display: flex; flex-direction: column; align-items: center;
  z-index: 10; pointer-events: none;
  animation: vs-center-in 0.48s cubic-bezier(0.34,1.56,0.64,1) 0.36s both;
}
@keyframes vs-center-in {
  from { transform: translate(-50%,-50%) scale(3); opacity: 0; }
  to   { transform: translate(-50%,-50%) scale(1); opacity: 1; }
}
.vs-text {
  font-family: 'Lilita One', cursive;
  font-size: clamp(3.5rem, min(11vw, 18vh), 7.5rem);
  line-height: 1; color: #ffc820; letter-spacing: -0.04em;
  text-shadow:
    0 0 80px rgba(255,200,32,0.7), 0 0 120px rgba(255,160,0,0.35),
    0 5px 0 #7a4200, 0 10px 4px rgba(0,0,0,0.7);
}
.vs-clash-line {
  width: 3px; height: 100vh;
  background: linear-gradient(to bottom, transparent 0%, rgba(255,200,32,0.8) 30%, #ffe060 50%, rgba(255,200,32,0.8) 70%, transparent 100%);
  box-shadow: 0 0 12px 3px rgba(255,200,32,0.7), 0 0 30px 8px rgba(255,120,0,0.35);
  animation: vs-clash-in 0.2s ease-out 0.38s both;
  border-radius: 2px; margin-top: -6px;
}
@keyframes vs-clash-in {
  from { opacity: 0; transform: scaleY(0); }
  to   { opacity: 1; transform: none; }
}
```

**Also remove `.vs-spotlight` from HTML** — it's been replaced by per-panel `.vs-stage-light` elements.

---

## 6. Corner Scene

**File:** `src/game/cornerScene.ts` + `src/game/style.css`

### Analysis bubble — fixed bottom-center (not world-projected)

The old bubble tried to follow the 3D model's head via NDC projection — unreliable and janky. Replace with a fixed CSS-positioned panel at the bottom center of the screen.

**Remove** `getCrabHeadScreen()`, `updateBubblePosition()`, and the call inside `update()`.

**Change** `showAnalysisBubble` — no more position update call:

```typescript
showAnalysisBubble(text: string, source: "claude" | "offline"): void {
  const headerLabel = source === "claude" ? "CLAUDE BOT" : "CORNER NOTES";
  this.bubbleEl.innerHTML = `
    <div class="wii-bubble-header">
      <div class="wii-bubble-icon">CC</div>
      <span class="wii-bubble-source">${headerLabel}</span>
    </div>
    <p id="wii-text"></p>
    <button class="wii-bubble-ok">GOT IT</button>
  `;
  // Don't call updateBubblePosition() — it's CSS-fixed now
  this.bubbleEl.classList.add("visible");
  // ... typewriter + GOT IT button logic unchanged
}
```

### Bubble CSS — fixed bottom-center panel

```css
.wii-crab-bubble {
  position: fixed;
  bottom: 28px;
  left: 50%;
  width: min(500px, 90vw);
  transform: translateX(-50%) translateY(20px); /* hidden: slide down + fade */
  background: #fff;
  border-radius: 20px;
  border: 3px solid #111;
  box-shadow: 0 12px 48px rgba(0,0,0,0.55), 0 0 32px rgba(255,100,20,0.2);
  padding: 0 0 14px;
  opacity: 0;
  pointer-events: none;
  z-index: 300;
  transition: opacity 0.4s ease, transform 0.45s cubic-bezier(0.34,1.56,0.64,1);
}
.wii-crab-bubble.visible {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
  pointer-events: auto;
}
/* Tail pointing UP toward the 3D scene */
.wii-crab-bubble::before {
  content: '';
  position: absolute; top: -18px; left: 38%; transform: translateX(-50%);
  border-left: 13px solid transparent; border-right: 13px solid transparent;
  border-bottom: 18px solid #111;
}
.wii-crab-bubble::after {
  content: '';
  position: absolute; top: -11px; left: 38%; transform: translateX(-50%);
  border-left: 10px solid transparent; border-right: 10px solid transparent;
  border-bottom: 12px solid #fff;
  z-index: 1;
}
```

### 3D Model auto-fit (GLB loading)

If you're loading a GLB for the CPU character, don't hardcode scale. Auto-fit to a target height:

```typescript
const gltf = await loader.loadAsync("/your_model.glb");
const model = gltf.scene;

// Auto-fit: scale so model is ~1.8 units (metres) tall
const box = new THREE.Box3().setFromObject(model);
const size = new THREE.Vector3();
box.getSize(size);
const targetHeight = 1.8;
const fitScale = size.y > 0.001 ? targetHeight / size.y : 1;
model.scale.setScalar(fitScale);

// Re-measure after scaling
box.setFromObject(model);
const center = new THREE.Vector3();
box.getCenter(center);

// Centre on group origin, sit on y=0
model.position.x = -center.x;
model.position.z = -center.z;
model.position.y = -box.min.y;
const modelBaseY = model.position.y; // save for bobbing animation

// Face toward camera — IMPORTANT for Blender exports:
// Blender's default export has -Z as forward in Three.js space.
// So: model.rotation.y = atan2(dx, dz) where (dx,dz) = direction TO camera.
// (If your model faces the wrong way, negate both: atan2(-dx, -dz))
const dx = CAMERA_POS.x - MODEL_WORLD_POS.x;
const dz = CAMERA_POS.z - MODEL_WORLD_POS.z;
model.rotation.y = Math.atan2(dx, dz);
```

For the bobbing animation, use the saved base Y:
```typescript
// In update():
this.crabMesh.position.y = this.crabBaseY + Math.sin(this.bobT * 1.5) * 0.06;
```

### Hide opponent during corner cinematic

In your main animation loop, hide the opponent model when the corner scene is active:

```typescript
opponent.root.visible = !cinematicMode;
```

---

## 7. Wii Safety Dialog — Dark Glass Theme

**File:** `src/game/style.css`

The old dialog was a flat light-grey box. Replace with dark glass (dark background shows through the canvas behind it):

```css
.wss-dialog {
  position: relative; z-index: 2;
  width: min(390px, 90vw);
  border-radius: 18px; overflow: hidden;
  background: rgba(8, 14, 30, 0.82);
  border: 1px solid rgba(255,255,255,0.1);
  backdrop-filter: blur(18px) saturate(1.4);
  -webkit-backdrop-filter: blur(18px) saturate(1.4);
  box-shadow:
    0 0 0 1px rgba(255,255,255,0.06),
    0 32px 80px rgba(0,0,0,0.85),
    0 0 60px rgba(255,140,66,0.08);
  animation: dialog-pop 0.48s cubic-bezier(0.34,1.56,0.64,1) 0.08s both;
}

.wss-dialog-header {
  background: linear-gradient(180deg, #3a7ee0 0%, #1448b8 100%);
  padding: 10px 18px 11px;
  display: flex; align-items: center; gap: 10px;
  border-bottom: 1px solid rgba(255,255,255,0.1);
}

.wss-dialog-body {
  padding: 16px 18px 14px;
  display: flex; gap: 14px; align-items: flex-start;
  border-bottom: 1px solid rgba(255,255,255,0.07);
}
.wss-dialog-title {
  font-family: 'Helvetica Neue', Arial, sans-serif;
  font-size: 0.82rem; font-weight: 800;
  color: #fff; margin: 0 0 8px; line-height: 1.3;
}
.wss-dialog-text {
  font-family: 'Helvetica Neue', Arial, sans-serif;
  font-size: 0.73rem; font-weight: 400; line-height: 1.75;
  color: rgba(255,255,255,0.55); margin: 0;
}
.wss-dialog-text b { color: rgba(255,255,255,0.9); font-weight: 700; }

.wss-dialog-footer {
  padding: 11px 18px 12px;
  background: rgba(255,255,255,0.04);
  display: flex; align-items: center; justify-content: space-between;
}
.wss-dialog-hint {
  font-size: 0.66rem; color: rgba(255,255,255,0.28); letter-spacing: 0.04em;
}

/* Button — blue to match header (was Wii green) */
.wss-btn {
  display: inline-flex; align-items: center; gap: 7px;
  font-size: 0.75rem; font-weight: 700;
  letter-spacing: 0.1em; text-transform: uppercase; color: #fff;
  background: linear-gradient(180deg, #3a7ee0 0%, #1448b8 100%);
  border: none; border-radius: 20px;
  padding: 9px 22px 10px; cursor: pointer;
  box-shadow: 0 3px 0 #0c2e80, 0 5px 16px rgba(0,0,0,0.4);
  transition: filter 0.1s, transform 0.08s, box-shadow 0.08s;
}
.wss-btn:hover { filter: brightness(1.15); transform: translateY(-2px); box-shadow: 0 5px 0 #0c2e80, 0 8px 20px rgba(0,0,0,0.45); }
.wss-btn:active { transform: translateY(2px); box-shadow: 0 1px 0 #0c2e80; }
```

Also update the SVG diagram colors in `hud.ts`:
- Background rect: `fill="rgba(255,255,255,0.05)" stroke="rgba(255,255,255,0.18)"`
- Orange elements: `#ff8c42` (was `#e06820`)
- Arrow text: `fill="rgba(255,140,66,0.7)"` (was `#c05010`)

---

## 8. Menu Ambient Decorations

**File:** `src/game/hud.ts` + `src/game/style.css`

### The animation reset problem

If you rebuild `menu.innerHTML` on every render frame (common pattern for reactive HUDs), CSS animations on child elements reset every frame — they never play. Solution: put decorations in a separate persistent DOM layer that is **never touched by render()**.

### hud.ts — constructor HTML

Add a `.menu-deco` layer inside the menu div. The dynamic content goes to `#menu-content`:

```typescript
// In constructor, where you build the base HTML:
// Replace:   <div id="menu" class="menu"></div>
// With:
`<div id="menu" class="menu">
  <div class="menu-deco" aria-hidden="true">
    <div class="md-rope md-rope-t"></div>
    <div class="md-rope md-rope-b"></div>
    <div class="md-glove md-glove-1">🥊</div>
    <div class="md-glove md-glove-2">🥊</div>
    <div class="md-glove md-glove-3">🥊</div>
    <div class="md-glove md-glove-4">🥊</div>
    <div class="md-star md-star-1">⭐</div>
    <div class="md-star md-star-2">⭐</div>
    <div class="md-star md-star-3">⭐</div>
    <div class="md-star md-star-4">⭐</div>
    <div class="md-star md-star-5">★</div>
    <div class="md-star md-star-6">★</div>
    <div class="md-star md-star-7">✦</div>
    <div class="md-star md-star-8">✦</div>
  </div>
  <div id="menu-content"></div>
</div>`
```

### hud.ts — render()

```typescript
// Replace:
el('menu').innerHTML = this.menuHtml(s);
// With:
el('menu-content').innerHTML = this.menuHtml(s);
```

### CSS — decorations

These reuse the existing `glove-rise`, `star-twinkle`, `rope-sway` keyframe animations (if you have them). If not, add them too — see the keyframes in our `style.css`.

```css
/* Persistent decoration layer — never re-rendered */
.menu-deco {
  position: absolute; inset: 0;
  pointer-events: none; overflow: hidden; z-index: 0;
}

/* Ring ropes: faint horizontal lines at 18% and 82% height */
.md-rope {
  position: absolute; left: -2%; right: -2%; height: 2px;
  background: linear-gradient(90deg, transparent 0%, rgba(212,168,23,0.18) 15%, rgba(212,168,23,0.28) 50%, rgba(212,168,23,0.18) 85%, transparent 100%);
  border-radius: 1px;
  animation: rope-sway ease-in-out infinite alternate;
}
.md-rope-t { top: 18%; animation-duration: 7s; animation-delay: 0s; }
.md-rope-b { top: 82%; animation-duration: 9s; animation-delay: 2s; }

/* Boxing gloves — rise up from bottom, fade in/out */
.md-glove {
  position: absolute; font-size: 2.6rem;
  opacity: 0; animation: glove-rise linear infinite;
}
.md-glove-1 { left: 5%;  animation-duration: 22s; animation-delay: 0s;   bottom: -5%; }
.md-glove-2 { left: 18%; animation-duration: 28s; animation-delay: 7s;   bottom: -5%; }
.md-glove-3 { left: 78%; animation-duration: 25s; animation-delay: 14s;  bottom: -5%; }
.md-glove-4 { left: 91%; animation-duration: 19s; animation-delay: 3.5s; bottom: -5%; }

/* Stars — twinkle at various screen positions */
.md-star {
  position: absolute;
  animation: star-twinkle ease-in-out infinite;
}
/* ⭐ emoji stars */
.md-star-1 { top: 12%; left:  8%; font-size: 1.6rem; animation-duration: 3.2s; animation-delay: 0s; }
.md-star-2 { top: 22%; left: 88%; font-size: 1.3rem; animation-duration: 2.8s; animation-delay: 1.1s; }
.md-star-3 { top: 72%; left:  6%; font-size: 1.4rem; animation-duration: 3.5s; animation-delay: 0.7s; }
.md-star-4 { top: 82%; left: 90%; font-size: 1.7rem; animation-duration: 2.6s; animation-delay: 1.8s; }
/* ★ gold (CSS char) */
.md-star-5 { top: 38%; left: 4%;  font-size: 1.1rem; color: var(--gold, #d4a817);        animation-duration: 4.1s; animation-delay: 0.3s; }
.md-star-6 { top: 55%; left: 94%; font-size: 0.9rem; color: var(--gold, #d4a817);        animation-duration: 3.7s; animation-delay: 2.2s; }
/* ✦ purple accent */
.md-star-7 { top: 18%; left: 50%; font-size: 0.85rem; color: var(--purple-light, #c084fc); animation-duration: 5s;   animation-delay: 1.5s; }
.md-star-8 { top: 65%; left: 50%; font-size: 0.75rem; color: var(--purple-light, #c084fc); animation-duration: 4.4s; animation-delay: 0.9s; }

/* Dynamic content sits above decorations */
#menu-content {
  display: flex; flex-direction: column;
  align-items: center; gap: 22px;
  position: relative; z-index: 1; width: 100%;
}
```

**Required keyframes** (add if not already present):
```css
@keyframes glove-rise {
  0%   { opacity: 0; transform: translateY(0) rotate(-15deg); }
  10%  { opacity: 0.55; }
  80%  { opacity: 0.4; }
  100% { opacity: 0; transform: translateY(-120vh) rotate(25deg); }
}
@keyframes star-twinkle {
  0%, 100% { opacity: 0.15; transform: scale(0.9); }
  50%       { opacity: 0.85; transform: scale(1.1); }
}
@keyframes rope-sway {
  from { transform: skewY(-0.4deg) translateY(-1px); }
  to   { transform: skewY(0.4deg)  translateY(1px); }
}
```

---

## 9. Mahoraga's Wheel

**File:** `src/game/scene/mahoragasWheel.ts`

If you use the adaptation wheel, here are the improvements:

### Color palette — Mahoraga-accurate

```typescript
// Old: neon purple
// New: dark ring, gold spokes, white hub (matches the anime)
const COL_RING   = 0x1a1a1a;  // dark grey ring
const COL_SPOKE  = 0xc8960c;  // gold spokes
const COL_TOOTH  = 0x888888;  // grey teeth
const COL_CENTER = 0xffffff;  // white hub
const EMI_RING   = 0x000000;  // no ring glow at rest
const EMI_SPOKE  = 0x7a5800;  // warm gold emission
const EMI_TOOTH  = 0x333333;
const EMI_CENTER = 0xddbb55;  // golden hub glow
```

Point light: `new THREE.PointLight(0xd4a017, 2.5, 4.0, 2)` (gold, was purple)

### Clank sound — Web Audio API

```typescript
private audioCtx: AudioContext | null = null;

private playClank() {
  try {
    if (!this.audioCtx) this.audioCtx = new AudioContext();
    const ctx = this.audioCtx;
    const bufLen = Math.floor(ctx.sampleRate * 0.18);
    const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data = buf.getChannelData(0);
    // Exponentially decaying noise burst
    for (let i = 0; i < bufLen; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufLen * 0.12));
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    // Band-pass ~1.5kHz for metallic ring
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1500; bp.Q.value = 4;
    const gain = ctx.createGain();
    gain.gain.value = 0.55;
    src.connect(bp); bp.connect(gain); gain.connect(ctx.destination);
    src.start();
  } catch { /* AudioContext blocked before user gesture — silent */ }
}
```

Call `this.playClank()` inside `clank()`.

### Face-on spin (Z axis, not Y)

```typescript
// Old: this.group.rotation.y += IDLE_ROT_SPEED * dt;
// New: spin face-on (Z axis = like a compass rose facing the camera)
this.targetRotZ += IDLE_ROT_SPEED * dt;
// Then lerp group.rotation.z toward targetRotZ (handles both idle + clank snaps)
const diff = this.targetRotZ - this.group.rotation.z;
this.group.rotation.z += diff * Math.min(1, CLANK_SPEED * dt);
```

---

## 10. Misc Fixes

### HP bar normalization

If max HP is not 100, you must divide by the actual max before using as CSS width percentage:

```typescript
const MAX_HP = 133; // or whatever your server's MAX_HEALTH is
el('hp-me').style.width  = `${view ? Math.max(0, view.me.health / MAX_HP * 100) : 100}%`;
el('hp-opp').style.width = `${view ? Math.max(0, view.opponent.health / MAX_HP * 100) : 100}%`;
```

### Keyboard sim — skip calibration wait

The `SimulatedCvProvider` used to trigger a full `recalibrate()` on start which left the game waiting for a physical calibration that never comes. Fix: mark as ready immediately:

```typescript
// Instead of: this.recalibrate();
this.calibrationId = `sim-cal-${Math.random().toString(36).slice(2, 8)}`;
this.calibratingUntil = 0;
```

### Skip async 3D portrait in VS screen

The `vsPortrait` module renders the bot as a Three.js snapshot and swaps it into the VS screen. This is fragile (timing, canvas size, async race). Remove it for reliability:

```typescript
// In main.ts, showVsScreen call:
hud.showVsScreen(playerName, profile, onDone); // no renderer arg
// In hud.ts, remove the renderer parameter and the entire import('./vsPortrait') block
```

The initials-circle fallback looks great and never fails.

---

## Environment Variables

```env
ANTHROPIC_API_KEY=sk-ant-...

# Strategist model (called every ~6s during fight)
COACH_MODEL=claude-haiku-4-5-20251001

# Analysis model (called once at fight end)
ANALYSIS_MODEL=claude-haiku-4-5-20251001

# SpacetimeDB
NEXT_PUBLIC_STDB_HOST=http://127.0.0.1:3000
NEXT_PUBLIC_STDB_DB=claude-tyson
```

---

## Summary — Priority Order for Migration

| Priority | What | Files | Why |
|----------|------|-------|-----|
| 🔴 Must | Strategist system prompt + tool schema | `coach/strategist.ts` | Garbage in without it |
| 🔴 Must | Analysis prompt + playerName | `coach/analysis.ts` | Much better output |
| 🔴 Must | HP bar normalization | `hud.ts` | Bar won't move without it |
| 🔴 Must | Punch type `includes()` fix | `spacetimedb/src/index.ts` | Counts are all 0 without it |
| 🟡 High | Adaptation match-scoping | `adaptationManager.ts` | Fires on stale rows otherwise |
| 🟡 High | VS screen layout | `style.css` + `hud.ts` | Names overflow / get crushed |
| 🟡 High | Analysis bubble — fixed position | `cornerScene.ts` + `style.css` | Old version breaks when model moves |
| 🟢 Nice | Wii dialog dark glass | `style.css` + `hud.ts` | Looks much better |
| 🟢 Nice | Menu decorations | `hud.ts` + `style.css` | Polish |
| 🟢 Nice | Mahoraga's wheel — colors + sound | `mahoragasWheel.ts` | More faithful + satisfying |
| 🟢 Nice | Opponent hidden in corner scene | `main.ts` | Weird without it |
| 🟢 Nice | SpacetimeDB compression none | `net/server.ts` | Prevents rare WS errors |
