// Post-fight AI analyst: Strava-style athlete intelligence for Claude Tyson.
// Called once after the match ends. Returns a structured ~100-word breakdown.
// Personality: direct, data-driven, slightly clinical-snarky — "smart AI watched your fight".

export interface FightWindowSummary {
  playerLanded: number;
  playerAttempts: number;
  playerJabs: number;
  playerStraights: number;
  playerHooks: number;
  playerUppercuts: number;
  playerSlips: number;
  playerBlocks: number;
  playerCaught: number;
  botHealth: number;
  playerHealth: number;
}

export interface AnalysisRequest {
  matchId: string;
  result: { won: boolean; reason: string };
  windows: FightWindowSummary[];
  adaptationCount: number;
}

export interface AnalysisResponse {
  text: string;        // full analysis text
  source: "claude" | "offline";
}

export interface AnalysisOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

export const DEFAULT_ANALYSIS_MODEL = "claude-haiku-4-5-20251001";

const MAX_BODY_BYTES = 32_000;

const SYSTEM_PROMPT = `You are Claude Tyson's corner coach. Two sentences MAX. No paragraphs. Talk exactly like a boxing trainer yelling across the corner stool — blunt, vivid, specific.

First sentence: one sharp observation about what they did (cite the actual numbers if useful — accuracy, punch mix, caught hits).
Second sentence: one concrete thing to fix next time. Make it stick.

Under 45 words total. If they won, still find the flaw. If they lost, find the silver lining. Never generic.`;

function offlineAnalysis(req: AnalysisRequest): AnalysisResponse {
  const total = req.windows.reduce((s, w) => s + w.playerAttempts, 0);
  const landed = req.windows.reduce((s, w) => s + w.playerLanded, 0);
  const rate = total > 0 ? Math.round((landed / total) * 100) : 0;
  const won = req.result.won;

  let text: string;
  if (total < 5) {
    text = won
      ? "Win, but you barely threw — get your hands moving or the next one won't be so easy. Stay active: straight to set range, hook to finish."
      : "You didn't throw enough for me to read. Hands up, stay active — mix your straights and hooks and make the bot react to you.";
  } else if (rate < 25) {
    text = won
      ? `${landed}/${total} landed — too low to rely on. Stop chasing and make the bot come to you, then counter.`
      : `${landed}/${total} landed — the bot cracked your timing. Switch up combos the moment one stops working.`;
  } else {
    text = won
      ? `${landed}/${total} connected — solid. After a combo, don't reset to the same spot; move and make the bot guess.`
      : `${landed}/${total} landed but your hands dropped after each combo — that's the gap it used. Hands back up the instant you finish.`;
  }
  return { text, source: "offline" };
}

function buildUserPrompt(req: AnalysisRequest): string {
  const total = req.windows.reduce((s, w) => s + w.playerAttempts, 0);
  const landed = req.windows.reduce((s, w) => s + w.playerLanded, 0);
  const slips = req.windows.reduce((s, w) => s + w.playerSlips, 0);
  const blocks = req.windows.reduce((s, w) => s + w.playerBlocks, 0);
  const caught = req.windows.reduce((s, w) => s + w.playerCaught, 0);
  const jabs = req.windows.reduce((s, w) => s + w.playerJabs, 0);
  const hooks = req.windows.reduce((s, w) => s + w.playerHooks, 0);
  const straights = req.windows.reduce((s, w) => s + w.playerStraights, 0);
  const uppers = req.windows.reduce((s, w) => s + w.playerUppercuts, 0);
  const acc = total > 0 ? Math.round((landed / total) * 100) : 0;
  const lastHealth = req.windows.at(-1)?.playerHealth ?? 100;
  const skill = total < 10 || acc < 20 ? 'beginner' : acc > 40 && req.windows.length >= 4 ? 'advanced' : 'intermediate';

  return `Outcome: ${req.result.won ? 'player WON' : 'Claude Tyson WON'} by ${req.result.reason}.
Skill level (inferred): ${skill}
Total punches thrown: ${total} | landed: ${landed} (${acc}%)
Punch mix: jabs ${jabs}, straights ${straights}, hooks ${hooks}, uppercuts ${uppers}
Defense: ${slips} slips, ${blocks} blocks, took ${caught} hits
Player health remaining: ${lastHealth}/100
Claude adapted ${req.adaptationCount} times during the fight.
Fight windows (each ~6s): ${req.windows.length}

Give them your corner speech now.`;
}

export async function analyzeWithClaude(req: AnalysisRequest, o: AnalysisOptions = {}): Promise<AnalysisResponse> {
  const log = o.log ?? (() => {});
  if (!o.apiKey) return offlineAnalysis(req);

  const f = o.fetchImpl ?? fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 8000);

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
        model: o.model ?? DEFAULT_ANALYSIS_MODEL,
        max_tokens: 120,
        system: SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: buildUserPrompt(req),
        }],
      }),
    });

    if (!res.ok) {
      log(`analysis http ${res.status}`);
      return offlineAnalysis(req);
    }

    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = data.content?.find((c) => c.type === "text")?.text?.trim() ?? "";
    if (!text) {
      log("analysis: empty response");
      return offlineAnalysis(req);
    }

    return { text, source: "claude" };
  } catch (e) {
    log(`analysis error: ${(e as Error).name}`);
    return offlineAnalysis(req);
  } finally {
    clearTimeout(timer);
  }
}

export async function handleAnalysisHttp(request: Request, o: AnalysisOptions = {}): Promise<Response> {
  if (request.method !== "POST") return Response.json({ error: "method" }, { status: 405 });
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return Response.json({ error: "too_large" }, { status: 413 });
  let body: unknown;
  try { body = JSON.parse(text); } catch { return Response.json({ error: "bad_json" }, { status: 400 }); }
  if (!body || typeof body !== "object" || !("matchId" in body)) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  return Response.json(await analyzeWithClaude(body as AnalysisRequest, o));
}
