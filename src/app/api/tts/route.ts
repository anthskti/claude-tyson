// POST /api/tts  ({text, persona} -> audio/mpeg via Cartesia)
// Env: CARTESIA_API_KEY, CARTESIA_COACH_VOICE, optional CARTESIA_OPPONENT_VOICE, CARTESIA_MODEL.
// No key = 501, and the browser uses its built-in voice instead.
import { handleTtsHttp } from '../../../../coach/tts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  return handleTtsHttp(req, {
    apiKey: process.env.CARTESIA_API_KEY,
    coachVoiceId: process.env.CARTESIA_COACH_VOICE,
    opponentVoiceId: process.env.CARTESIA_OPPONENT_VOICE,
    model: process.env.CARTESIA_MODEL,
  });
}
