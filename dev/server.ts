// Serves the standalone arena at localhost:8787 (or PORT).
const port = Number(process.env.PORT ?? 8787);

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
    if (url.pathname === "/") return new Response(await page(), { headers: { "content-type": "text/html; charset=utf-8" } });
    return new Response("not found", { status: 404 });
  },
});
console.log(`arena on http://localhost:${port}`);
