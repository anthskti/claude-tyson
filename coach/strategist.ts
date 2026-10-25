// Server-side Claude strategist: mutates botStrategy every 6s fight window.
// Forced tool call pattern mirrors claudeCoach.ts. API key never reaches the browser.

export interface StrategistOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

export const DEFAULT_STRATEGIST_MODEL = "claude-haiku-4-5-20251001";
const MAX_EXPLANATION_CHARS = 130;
const MAX_BODY_BYTES = 32_000;

export interface StrategistRequest {
  windowId: string;
  matchId: string;
  strategyRevision: number;
  window: {
    playerLanded: number;
    playerAttempts: number;
    playerHealth: number;
    botHealth: number;
    trackingCoverage: number;
    playerJabs: number;
    playerStraights: number;
    playerHooks: number;
    playerUppercuts: number;
    playerSlips: number;
    playerBlocks: number;
    playerCaught: number;
    botAttacks: number;
  };
  strategy: {
    aggression: number;
    punchIntervalMs: number;
    jabWeight: number;
    straightWeight: number;
    hookWeight: number;
    uppercutWeight: number;
    leftBias: number;
    defenseRate: number;
    telegraphMs: number;
    explanation: string;
  };
  history: Array<{
    windowId: string;
    outcome: "improved" | "worsened" | "inconclusive";
    explanation: string;
  }>;
}

export interface StrategistResponse {
  skip: boolean;
  aggression: number;
  punchIntervalMs: number;
  jabWeight: number;
  straightWeight: number;
  hookWeight: number;
  uppercutWeight: number;
  leftBias: number;
  defenseRate: number;
  telegraphMs: number;
  explanation: string;
}

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

Keep explanation ≤ ${MAX_EXPLANATION_CHARS} chars. Always cite the key stat (e.g., "hooks 63%, raising straight weights to counter").`;

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
        explanation: {
          type: "string",
          description: `≤${MAX_EXPLANATION_CHARS} chars: what changed and why (cite a stat)`,
        },
      },
      required: [
        "skip", "aggression", "punchIntervalMs", "jabWeight", "straightWeight",
        "hookWeight", "leftBias", "defenseRate", "telegraphMs", "explanation",
      ],
    },
  };
}

function offlineResponse(req: StrategistRequest): StrategistResponse {
  return { skip: true, ...req.strategy, explanation: "offline fallback" };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

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

export async function coachWithStrategist(req: StrategistRequest, o: StrategistOptions = {}): Promise<StrategistResponse> {
  const log = o.log ?? (() => {});
  if (!o.apiKey) return offlineResponse(req);

  const f = o.fetchImpl ?? fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 7000);

  try {
    const res = await f(`${o.baseUrl ?? "https://api.anthropic.com"}/v1/messages`, {
      method: "POST",
      signal: ctl.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": o.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: o.model ?? DEFAULT_STRATEGIST_MODEL,
        max_tokens: 400,
        system: SYSTEM_PROMPT,
        tools: [tool()],
        tool_choice: { type: "tool", name: "update_strategy" },
        messages: [{ role: "user", content: buildUserMessage(req) }],
      }),
    });

    if (!res.ok) {
      log(`strategist http ${res.status}`);
      return offlineResponse(req);
    }

    const data = (await res.json()) as { content?: { type: string; name?: string; input?: any }[] };
    const call = data.content?.find((c) => c.type === "tool_use" && c.name === "update_strategy");
    const inp = call?.input;
    if (!inp) {
      log("strategist: no tool call");
      return offlineResponse(req);
    }

    if (inp.skip) {
      return { skip: true, ...req.strategy };
    }

    const explanation = String(inp.explanation ?? "").slice(0, MAX_EXPLANATION_CHARS).trim();

    return {
      skip: false,
      aggression: clamp(Number(inp.aggression ?? req.strategy.aggression), 0, 1),
      punchIntervalMs: Math.round(clamp(Number(inp.punchIntervalMs ?? req.strategy.punchIntervalMs), 600, 4000)),
      jabWeight: clamp(Number(inp.jabWeight ?? req.strategy.jabWeight), 0, 1),
      straightWeight: clamp(Number(inp.straightWeight ?? req.strategy.straightWeight), 0, 1),
      hookWeight: clamp(Number(inp.hookWeight ?? req.strategy.hookWeight), 0, 1),
      uppercutWeight: 0,
      leftBias: clamp(Number(inp.leftBias ?? req.strategy.leftBias), 0, 1),
      defenseRate: clamp(Number(inp.defenseRate ?? req.strategy.defenseRate), 0, 0.8),
      telegraphMs: Math.round(clamp(Number(inp.telegraphMs ?? req.strategy.telegraphMs), 350, 1200)),
      explanation,
    };
  } catch (e) {
    log(`strategist error: ${(e as Error).name}`);
    return offlineResponse(req);
  } finally {
    clearTimeout(timer);
  }
}

/** HTTP handler: POST StrategistRequest JSON -> StrategistResponse JSON. Works as a Next.js route body. */
export async function handleStrategistHttp(request: Request, o: StrategistOptions = {}): Promise<Response> {
  if (request.method !== "POST") return Response.json({ error: "method" }, { status: 405 });
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return Response.json({ error: "too_large" }, { status: 413 });
  let body: unknown;
  try { body = JSON.parse(text); } catch { return Response.json({ error: "bad_json" }, { status: 400 }); }
  if (!body || typeof body !== "object" || !("windowId" in body)) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  return Response.json(await coachWithStrategist(body as StrategistRequest, o));
}
