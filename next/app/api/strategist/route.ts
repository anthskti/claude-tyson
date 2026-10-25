import { handleStrategistHttp } from '../../../../coach/strategist';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return handleStrategistHttp(request, {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.COACH_MODEL,
  });
}
