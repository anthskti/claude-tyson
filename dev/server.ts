// Dev server: serves the arena and the strategist/analysis endpoints the real Next.js app also exposes.
//   ANTHROPIC_API_KEY=...  bun dev/server.ts
// Without keys the endpoints return offline fallbacks.
import { handleStrategistHttp } from "../coach/strategist";
import { handleAnalysisHttp } from "../coach/analysis";

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
    if (url.pathname === "/api/strategist" && req.method === "POST")
      return handleStrategistHttp(req, { apiKey: env.ANTHROPIC_API_KEY, model: env.COACH_MODEL, baseUrl: env.COACH_API_BASE_URL, log: (m) => console.log("[strategist]", m) });
    if (url.pathname === "/api/analysis" && req.method === "POST")
      return handleAnalysisHttp(req, { apiKey: env.ANTHROPIC_API_KEY, model: env.COACH_MODEL, baseUrl: env.COACH_API_BASE_URL, log: (m) => console.log("[analysis]", m) });
    if (url.pathname === "/") return new Response(await page(), { headers: { "content-type": "text/html; charset=utf-8" } });
    return new Response("not found", { status: 404 });
  },
});
console.log(`arena on http://localhost:${port}  strategist/analysis: ${env.ANTHROPIC_API_KEY ? `Claude (${env.COACH_MODEL ?? "claude-haiku-5-5"})` : "offline"}`);
