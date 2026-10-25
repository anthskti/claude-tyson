import { getAnalysis, type AnalysisRequest } from '../../../../coach/analysis';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const text = await request.text();
  if (text.length > 16000) return Response.json({ error: 'too_large' }, { status: 413 });
  let value: unknown;
  try { value = JSON.parse(text); } catch { return Response.json({ error: 'bad_json' }, { status: 400 }); }
  if (!value || typeof value !== 'object') return Response.json({ error: 'bad_request' }, { status: 400 });
  const v = value as Record<string, unknown>;
  if (typeof v.matchId !== 'string' || !/^\d+$/.test(v.matchId) || typeof v.won !== 'boolean' ||
      (v.playerName !== undefined && (typeof v.playerName !== 'string' || v.playerName.length > 40)) ||
      typeof v.playerHealth !== 'number' || !Number.isFinite(v.playerHealth) || v.playerHealth < 0 || v.playerHealth > 10 ||
      typeof v.reason !== 'string' || !['ko', 'decision', 'forfeit'].includes(v.reason) ||
      !['attempts', 'landed', 'straights', 'hooks', 'slips', 'blocks', 'hitsTaken'].every(k =>
        typeof v[k] === 'number' && Number.isFinite(v[k]) && (v[k] as number) >= 0)) {
    return Response.json({ error: 'bad_request' }, { status: 400 });
  }
  return Response.json(await getAnalysis(v as unknown as AnalysisRequest, process.env.ANTHROPIC_API_KEY));
}
