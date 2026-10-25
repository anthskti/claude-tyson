export interface AnalysisRequest {
  matchId: string;
  playerName?: string;
  playerHealth: number;
  won: boolean;
  reason: string;
  attempts: number;
  landed: number;
  straights: number;
  hooks: number;
  slips: number;
  blocks: number;
  hitsTaken: number;
}

export interface AnalysisResponse {
  text: string;
  source: 'claude' | 'offline';
}

const SYSTEM_PROMPT = `You are Claude Crab, a warm and enthusiastic boxing coach who wants this fighter to grow. Give a post-match analysis in exactly 2 or 3 sentences. Address the fighter by name when one is provided.

Be encouraging and direct, like a supportive gym coach. If the fighter won, recognize what worked and name one habit to sharpen. If they lost, lead with something that showed promise, then give one practical adjustment.

Use only the supplied match summary. This game has left and right straights, left and right hooks, blocks, and left and right dodges. Never mention jabs, crosses, uppercuts, body shots, footwork, stance, video, or form. Describe patterns in plain language. Do not include stats, numerals, percentages, or numerical comparisons. Do not refer to future sessions or anything outside this match. Write plain sentences only, with no markdown, dashes, colons, semicolons, or asterisks.`;

function cleanName(name: string | undefined): string {
  const cleaned = name?.replace(/[^\p{L}\p{M}' ]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return cleaned || 'fighter';
}

function buildUserPrompt(req: AnalysisRequest): string {
  const accuracy = req.attempts > 0 ? Math.round(req.landed / req.attempts * 100) : 0;
  const hookRate = req.attempts > 0 ? Math.round(req.hooks / req.attempts * 100) : 0;
  const straightRate = req.attempts > 0 ? Math.round(req.straights / req.attempts * 100) : 0;
  const name = cleanName(req.playerName);

  return `Fighter name: ${JSON.stringify(name)}
Outcome: ${req.won ? 'win' : 'loss'} by ${req.reason}.
Punches: ${req.landed} of ${req.attempts} landed (${accuracy}%); ${req.straights} straights (${straightRate}%), ${req.hooks} hooks (${hookRate}%).
Defense: ${req.slips} successful slips, ${req.blocks} blocks, ${req.hitsTaken} hits taken.
Health remaining: ${Math.max(0, Math.min(10, req.playerHealth)).toFixed(1)} of 10.

Give ${name} a short post-fight corner talk based on the overall patterns. Use no stats or numbers in the response.`;
}

function fallback(req: AnalysisRequest): string {
  const name = cleanName(req.playerName);
  if (req.won) {
    return `${name}, you earned this win by making your chances count. Keep changing your rhythm and bring your guard back after every punch.`;
  }
  if (req.landed > 0) {
    return `${name}, you found openings and made some punches count even under pressure. Pick your openings with patience, then protect yourself as you reset.`;
  }
  return `${name}, you stayed with a tough fight and kept looking for openings. Take a breath between attacks and bring your guard back as you reset.`;
}

export async function getAnalysis(req: AnalysisRequest, apiKey?: string, fetchImpl: typeof fetch = fetch): Promise<AnalysisResponse> {
  const offline = fallback(req);
  if (!apiKey) return { text: offline, source: 'offline' };
  try {
    const response = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: AbortSignal.timeout(8000),
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: process.env.ANALYSIS_MODEL || process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001',
        max_tokens: 250,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserPrompt(req) }],
      }),
    });
    if (!response.ok) return { text: offline, source: 'offline' };
    const body = await response.json() as { content?: { type: string; text?: string }[] };
    const text = body.content?.find(c => c.type === 'text')?.text?.trim().slice(0, 1200);
    const sentenceCount = text?.match(/[.!?](?=\s|$)/g)?.length ?? 0;
    if (!text || sentenceCount < 2 || sentenceCount > 3 ||
        /\b(uppercut|body shot|footwork|stance|jab|cross)\b/i.test(text) || /[\d%:;*—-]/.test(text)) {
      return { text: offline, source: 'offline' };
    }
    return { text, source: 'claude' };
  } catch {
    return { text: offline, source: 'offline' };
  }
}
