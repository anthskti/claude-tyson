import { getStrategy, parseRequest } from '../../../../coach/strategist';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const text = await request.text();
  if (text.length > 16000) return Response.json({ error: 'too_large' }, { status: 413 });
  let value: unknown;
  try { value = JSON.parse(text); } catch { return Response.json({ error: 'bad_json' }, { status: 400 }); }
  const parsed = parseRequest(value);
  if (!parsed) return Response.json({ error: 'bad_request' }, { status: 400 });
  return Response.json(await getStrategy(parsed, process.env.ANTHROPIC_API_KEY));
}
