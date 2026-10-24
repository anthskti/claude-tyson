// Builds dev/arena.html as a single-file standalone arena.
const built = await Bun.build({ entrypoints: [`${import.meta.dir}/arena.ts`], minify: true, target: "browser" });
if (!built.success) { console.error(built.logs); process.exit(1); }
const js = await built.outputs[0].text();
const shell = await Bun.file(`${import.meta.dir}/arena.shell.html`).text();
await Bun.write(`${import.meta.dir}/arena.html`, shell.replace("/*__ARENA_JS__*/", () => js));
console.log("wrote dev/arena.html", js.length, "bytes of js");
