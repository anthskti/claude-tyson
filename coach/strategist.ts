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
const MAX_EXPLANATION_CHARS = 120;
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

const SYSTEM_PROMPT = `You are the AI strategist for Claude Tyson, an adaptive CPU boxer in a webcam boxing game.
Every 6 seconds you receive a fight window showing how the player attacked, and the current bot settings.
Your job: adjust the bot behavior knobs to make the fight challenging without being unfair.

Bot behavior knobs:
- aggression (0–1): how often the bot initiates attacks
- punchIntervalMs (600–4000): milliseconds between bot punches (lower = faster)
- jabWeight/straightWeight/hookWeight/uppercutWeight (0–1 each, unnormalized): punch type distribution
- leftBias (−1 to +1): −1 = all left-hand punches, +1 = all right-hand, 0 = balanced
- defenseRate (0–0.8): fraction of incoming punches the bot attempts to block or slip
- telegraphMs (200–1000): how early (ms before impact) the visual cue appears (lower = harder to react)

Counter-triangle (exploit the player's patterns):
- Player hooking a lot → shift leftBias to attack the opposite side (punish their hook opening)
- Player throwing many straights → raise defenseRate (make them slip more)
- Player uppercutting → raise hookWeight (counter the uppercut stance)
- Player landing high %  → lower telegraphMs or raise aggression to pressure them
- Player blocked often  → raise aggression, lower defenseRate

History: if a previous strategy "worsened" or "inconclusive", try a different angle; don't repeat the same change.
If the window has < 5 player attempts or trackingCoverage < 0.5, set skip=true.
Keep explanation ≤ ${MAX_EXPLANATION_CHARS} characters. Cite the specific stat that drove the change.`;

function tool() {
  return {
    name: "update_strategy",
    description: "Update the bot strategy, or skip if already working or data is insufficient.",
    input_schema: {
      type: "object",
      properties: {
        skip: { type: "boolean", description: "true if strategy needs no change or data is insufficient" },
        aggression: { type: "number", minimum: 0, maximum: 1 },
        punchIntervalMs: { type: "number", minimum: 600, maximum: 4000 },
        jabWeight: { type: "number", minimum: 0, maximum: 1 },
        straightWeight: { type: "number", minimum: 0, maximum: 1 },
        hookWeight: { type: "number", minimum: 0, maximum: 1 },
        uppercutWeight: { type: "number", minimum: 0, maximum: 1 },
        leftBias: { type: "number", minimum: -1, maximum: 1 },
        defenseRate: { type: "number", minimum: 0, maximum: 0.8 },
        telegraphMs: { type: "number", minimum: 200, maximum: 1000 },
        explanation: {
          type: "string",
          description: `≤${MAX_EXPLANATION_CHARS} chars: what changed and why (cite a stat)`,
        },
      },
      required: [
        "skip", "aggression", "punchIntervalMs", "jabWeight", "straightWeight",
        "hookWeight", "uppercutWeight", "leftBias", "defenseRate", "telegraphMs", "explanation",
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

export async function coachWithStrategist(req: StrategistRequest, o: StrategistOptions = {}): Promise<StrategistResponse> {
  const log = o.log ?? (() => {});
  if (!o.apiKey) return offlineResponse(req);

  const f = o.fetchImpl ?? fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 4000);

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
        messages: [{ role: "user", content: `Fight window:\n${JSON.stringify(req)}` }],
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
      uppercutWeight: clamp(Number(inp.uppercutWeight ?? req.strategy.uppercutWeight), 0, 1),
      leftBias: clamp(Number(inp.leftBias ?? req.strategy.leftBias), -1, 1),
      defenseRate: clamp(Number(inp.defenseRate ?? req.strategy.defenseRate), 0, 0.8),
      telegraphMs: Math.round(clamp(Number(inp.telegraphMs ?? req.strategy.telegraphMs), 200, 1000)),
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
