export interface StrategyRequest {
  windowId: string;
  matchId: string;
  revision: number;
  attempts: number;
  landed: number;
  leftAttempts: number;
  rightAttempts: number;
  straights: number;
  hooks: number;
  slips: number;
  blocks: number;
  hitsTaken: number;
  trackingCoverage: number;
  profile: { leftAttempts: number; rightAttempts: number; straights: number; hooks: number; punchesLanded: number };
  strategy: StrategyPatch;
}

export interface StrategyPatch {
  aggression: number;
  punchIntervalMs: number;
  jabWeight: number;
  straightWeight: number;
  hookWeight: number;
  leftBias: number; // -1 right, 0 balanced, +1 left
  defenseRate: number;
  telegraphMs: number;
  explanation: string;
}

export type StrategyResponse = { skip: true; reason: string } | ({ skip: false } & StrategyPatch);

const bounds = {
  aggression: [0, 1], punchIntervalMs: [600, 4000], jabWeight: [0, 1],
  straightWeight: [0, 1], hookWeight: [0, 1], leftBias: [-1, 1],
  defenseRate: [0, 0.8], telegraphMs: [350, 1200],
} as const;

const SYSTEM_PROMPT = `You are the adaptive strategist for Claude Tyson, a boxing game bot that adjusts its tactics between fight windows.

The bot can throw only left and right straights and left and right hooks. jabWeight is the left-straight weight, straightWeight is the right-straight weight, and hookWeight is shared by both hooks. leftBias ranges from -1 (always right hand) through 0 (balanced) to 1 (always left hand).

Tune attack aggression, punch interval, punch mix, hand bias, defense rate, and telegraph time to create a competitive, fair fight. Never propose changes to damage, health, match results, or unsupported actions. Use the current window and profile trends as evidence. Make a meaningful adjustment when a pattern is clear; otherwise skip. Do not repeat the current values when skipping.

Skip when fewer than 3 punches were attempted or tracking coverage is below 50 percent. Keep the explanation under 120 characters and cite an observed stat. Return exactly one update_strategy tool call.`;

function buildUserMessage(req: StrategyRequest): string {
  const accuracy = req.attempts > 0 ? Math.round(req.landed / req.attempts * 100) : 0;
  const hookRate = req.attempts > 0 ? Math.round(req.hooks / req.attempts * 100) : 0;
  const straightRate = req.attempts > 0 ? Math.round(req.straights / req.attempts * 100) : 0;
  const s = req.strategy;
  const p = req.profile;

  return `Fight window ${req.windowId} for match ${req.matchId} (strategy revision ${req.revision})

Player this window: ${req.landed}/${req.attempts} landed (${accuracy}% accuracy); ${req.hooks} hooks (${hookRate}%), ${req.straights} straights (${straightRate}%).
Defense this window: ${req.slips} slips, ${req.blocks} blocks, ${req.hitsTaken} hits taken.
Tracking coverage: ${Math.round(req.trackingCoverage * 100)}%.

Player profile totals: ${p.leftAttempts} left-hand attempts, ${p.rightAttempts} right-hand attempts, ${p.straights} straights, ${p.hooks} hooks, ${p.punchesLanded} landed punches.

Current strategy:
  aggression=${s.aggression.toFixed(2)}, interval=${s.punchIntervalMs}ms, telegraph=${s.telegraphMs}ms
  left straights=${s.jabWeight.toFixed(2)}, right straights=${s.straightWeight.toFixed(2)}, hooks=${s.hookWeight.toFixed(2)}
  leftBias=${s.leftBias.toFixed(2)} (-1 right, 0 balanced, 1 left), defense=${s.defenseRate.toFixed(2)}
  previous explanation: ${JSON.stringify(s.explanation)}

Choose an evidence-based update or skip if the window does not support a useful change.`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function parseRequest(value: unknown): StrategyRequest | null {
  const v = record(value), w = record(v?.strategy), p = record(v?.profile);
  if (!v || !w || !p || typeof v.windowId !== 'string' || typeof v.matchId !== 'string' ||
      !/^\d+$/.test(v.windowId) || !/^\d+$/.test(v.matchId) ||
      !Number.isInteger(v.revision) || (v.revision as number) < 0) return null;
  for (const key of ['attempts', 'landed', 'leftAttempts', 'rightAttempts', 'straights', 'hooks', 'slips', 'blocks', 'hitsTaken', 'trackingCoverage']) {
    if (typeof v[key] !== 'number' || !Number.isFinite(v[key]) || (v[key] as number) < 0) return null;
  }
  if ((v.trackingCoverage as number) > 1) return null;
  for (const key of ['leftAttempts', 'rightAttempts', 'straights', 'hooks', 'punchesLanded']) {
    if (typeof p[key] !== 'number' || !Number.isFinite(p[key]) || (p[key] as number) < 0) return null;
  }
  for (const key of Object.keys(bounds)) {
    if (typeof w[key] !== 'number' || !Number.isFinite(w[key])) return null;
  }
  if (typeof w.explanation !== 'string') return null;
  return v as unknown as StrategyRequest;
}

export function parsePatch(value: unknown): StrategyResponse | null {
  const v = record(value);
  if (!v || typeof v.skip !== 'boolean') return null;
  if (v.skip) return { skip: true, reason: typeof v.reason === 'string' ? v.reason : 'Claude kept the current strategy' };
  const patch: Record<string, number | string | boolean> = { skip: false };
  for (const [key, [min, max]] of Object.entries(bounds)) {
    const n = v[key];
    if (typeof n !== 'number' || !Number.isFinite(n)) return null;
    patch[key] = Math.max(min, Math.min(max, n));
  }
  if (typeof v.explanation !== 'string') return null;
  patch.explanation = v.explanation.trim().slice(0, 120);
  if (!patch.explanation) return null;
  if (Number(patch.jabWeight) + Number(patch.straightWeight) + Number(patch.hookWeight) === 0) return null;
  return patch as StrategyResponse;
}

export async function getStrategy(req: StrategyRequest, apiKey?: string, fetchImpl: typeof fetch = fetch): Promise<StrategyResponse> {
  if (req.attempts < 3 || req.trackingCoverage < 0.5) return { skip: true, reason: 'Not enough reliable punches in this window' };
  if (!apiKey) return { skip: true, reason: 'Claude API key is not configured; baseline strategy stays active' };
  try {
    const response = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: AbortSignal.timeout(7000),
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: process.env.COACH_MODEL || process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001', max_tokens: 250,
        system: SYSTEM_PROMPT,
        tools: [{ name: 'update_strategy', description: 'Update bounded bot tactics using fight evidence, or skip when evidence is insufficient.', input_schema: {
          type: 'object', properties: {
            skip: { type: 'boolean', description: 'True when data is insufficient or no useful change is supported.' },
            aggression: { type: 'number', minimum: 0, maximum: 1, description: 'How often the bot initiates attacks.' },
            punchIntervalMs: { type: 'number', minimum: 600, maximum: 4000, description: 'Target milliseconds between bot punches.' },
            jabWeight: { type: 'number', minimum: 0, maximum: 1, description: 'Probability weight for left-hand straight punches.' },
            straightWeight: { type: 'number', minimum: 0, maximum: 1, description: 'Probability weight for right-hand straight punches.' },
            hookWeight: { type: 'number', minimum: 0, maximum: 1, description: 'Probability weight shared by left and right hooks.' },
            leftBias: { type: 'number', minimum: -1, maximum: 1, description: 'Hand bias: -1 always right, 0 balanced, 1 always left.' },
            defenseRate: { type: 'number', minimum: 0, maximum: 0.8, description: 'Fraction of incoming attacks the bot attempts to defend.' },
            telegraphMs: { type: 'number', minimum: 350, maximum: 1200, description: 'Milliseconds of visual warning before impact.' },
            explanation: { type: 'string', description: 'Brief reason under 120 characters citing an observed stat.' },
          }, required: ['skip', ...Object.keys(bounds), 'explanation'],
        } }],
        tool_choice: { type: 'tool', name: 'update_strategy' },
        messages: [{ role: 'user', content: buildUserMessage(req) }],
      }),
    });
    if (!response.ok) return { skip: true, reason: `Claude request failed (${response.status}); strategy unchanged` };
    const body = await response.json() as { content?: { type: string; name?: string; input?: unknown }[] };
    return parsePatch(body.content?.find(c => c.type === 'tool_use' && c.name === 'update_strategy')?.input) ??
      { skip: true, reason: 'Claude returned an invalid update; strategy unchanged' };
  } catch {
    return { skip: true, reason: 'Claude timed out or was unavailable; strategy unchanged' };
  }
}
