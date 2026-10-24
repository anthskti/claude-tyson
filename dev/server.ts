// Dev server: serves the arena and the two coach endpoints the real Next.js app also exposes.
//   ANTHROPIC_API_KEY=...  CARTESIA_API_KEY=...  CARTESIA_COACH_VOICE=<voice id>  bun dev/server.ts
// Without keys it still works: offline coach + the browser's built-in voice.
import { handleCoachHttp } from "../coach/claudeCoach";
import { handleTtsHttp } from "../coach/tts";

const env = process.env;
const port = Number(env.PORT ?? 8787);

async function page(): Promise<string> {
  const built = await Bun.build({ entrypoints: [`${import.meta.dir}/arena.ts`], minify: true, target: "browser" });
  if (!built.success) throw new Error(built.logs.join("\n"));
  const js = await built.outputs[0].text();
  const shell = await Bun.file(`${import.meta.dir}/arena.shell.html`).text();
  return shell.replace("/*__ARENA_JS__*/", () => js);
}

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/coach")
      return handleCoachHttp(req, { apiKey: env.ANTHROPIC_API_KEY, model: env.COACH_MODEL, baseUrl: env.COACH_API_BASE_URL, log: (m) => console.log("[coach]", m) });
    if (url.pathname === "/api/tts")
      return handleTtsHttp(req, { apiKey: env.CARTESIA_API_KEY, coachVoiceId: env.CARTESIA_COACH_VOICE, opponentVoiceId: env.CARTESIA_OPPONENT_VOICE, model: env.CARTESIA_MODEL });
    if (url.pathname === "/") return new Response(await page(), { headers: { "content-type": "text/html; charset=utf-8" } });
    return new Response("not found", { status: 404 });
  },
});
console.log(`arena on http://localhost:${port}  coach: ${env.ANTHROPIC_API_KEY ? `Claude (${env.COACH_MODEL ?? "claude-haiku-5-5"})` : "offline"}  voice: ${env.CARTESIA_API_KEY ? "Cartesia" : "built-in"}`);
