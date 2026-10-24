// Next.js App Router: POST /api/coach  (CoachRequest -> CoachResponse)
// Copy into your app's app/api/coach/route.ts and fix the import path.
// Env: ANTHROPIC_API_KEY (no key = offline coach), optional COACH_MODEL.
import { handleCoachHttp } from "../../../../coach/claudeCoach";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handleCoachHttp(req, {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.COACH_MODEL,
    log: (m) => console.log("[coach]", m),
  });
}
