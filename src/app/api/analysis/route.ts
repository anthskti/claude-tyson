import { handleAnalysisHttp } from '../../../../coach/analysis';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return handleAnalysisHttp(request, {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.COACH_MODEL,
  });
}
