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

const SYSTEM_PROMPT = `You are Claude Tyson's corner trainer. You're a gruff, experienced boxing coach who just watched this fight — you know EXACTLY what happened because you were the opponent's AI brain that adapted to beat the player.

Write 2–3 short paragraphs. No headers. No bullets. Just talk like a trainer in the corner between rounds — sharp, direct, caring. Under 110 words total.

Assess their skill from the data:
- Beginner (low accuracy, few attempts, short fight): start with fundamentals — guard position, basic jab-straight combos, slipping instead of getting hit. Don't overload them.
- Intermediate/advanced (decent accuracy, survives full fight, uses variety): go deeper — counterpunching timing, pattern breaks, specific weaknesses you exploited.

You ADAPTED to beat them. Reference what you found and used against them. If you raised defense because their hooks were predictable, say that. Make it feel like the AI genuinely understood their game.

End with one concrete thing to practice next time. Make it stick.`;

function offlineAnalysis(req: AnalysisRequest): AnalysisResponse {
  const total = req.windows.reduce((s, w) => s + w.playerAttempts, 0);
  const landed = req.windows.reduce((s, w) => s + w.playerLanded, 0);
  const rate = total > 0 ? Math.round((landed / total) * 100) : 0;
  const won = req.result.won;

  let text: string;
  if (total < 5) {
    text = won
      ? "You got there, but I barely saw you throw. You need to commit — jab to find the range, then follow up. Standing back waiting doesn't win fights."
      : "You didn't throw enough for me to work with. The bot doesn't have to be perfect — it just has to be there when you aren't. Get your hands up, stay active, start with the jab.";
  } else if (rate < 25) {
    text = won
      ? `You threw ${total} shots and landed ${landed}. That's too low a rate to win consistently — you got lucky this time. Work on timing: don't chase the bot, make it come to you, then counter.`
      : `You threw ${total} shots and only ${landed} landed. The bot figured out your timing fast. When the same combination stops working, switch it up immediately — jab to disrupt, then change your angle.`;
  } else {
    text = won
      ? `Solid work — ${landed} out of ${total} connected. You read the bot well and stayed composed. Now push that further: after you land a combo, don't reset to the same spot. Move and make the bot adjust to you.`
      : `You were landing punches — ${landed} out of ${total} — but the bot still found a way through. Your defense breaks down after you commit. The moment you finish a combo, your hands need to come back up. That's the gap it exploited.`;
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
        max_tokens: 350,
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
