// Server-side Cartesia text-to-speech: POST {text, persona} -> audio/mpeg.
// No key configured -> 501, and the browser falls back to built-in speech.

export interface TtsOptions {
  apiKey?: string;
  coachVoiceId?: string;
  opponentVoiceId?: string;
  model?: string; // Cartesia docs list sonic-3.6 as the current default
  version?: string; // Cartesia-Version header
  fetchImpl?: typeof fetch;
}

const MAX_CHARS = 240;

export async function handleTtsHttp(request: Request, o: TtsOptions = {}): Promise<Response> {
  if (request.method !== "POST") return Response.json({ error: "method" }, { status: 405 });
  if (!o.apiKey) return Response.json({ error: "tts_unavailable" }, { status: 501 });
  let body: { text?: unknown; persona?: unknown };
  try { body = await request.json(); } catch { return Response.json({ error: "bad_json" }, { status: 400 }); }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text || text.length > MAX_CHARS) return Response.json({ error: "bad_text" }, { status: 400 });
  const voice = body.persona === "opponent" ? o.opponentVoiceId : o.coachVoiceId;
  if (!voice) return Response.json({ error: "no_voice_configured" }, { status: 501 });

  const res = await (o.fetchImpl ?? fetch)("https://api.cartesia.ai/tts/bytes", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${o.apiKey}`,
      "Cartesia-Version": o.version ?? "2026-08-14",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model_id: o.model ?? "sonic-3.6",
      transcript: text,
      voice: { id: voice },
      language: "en",
      output_format: { container: "mp3", sample_rate: 44100, bit_rate: 128000 },
    }),
  });
  if (!res.ok || !res.body) return Response.json({ error: `cartesia_${res.status}` }, { status: 502 });
  return new Response(res.body, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
}
