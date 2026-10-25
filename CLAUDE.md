# Claude Tyson

Browser-based boxing game using Next.js, Three.js, Bun, and SpacetimeDB.
Repo: github.com/anthskti/claude-tyson. Do not push without asking Abdullah.

## Architecture

- `src/app/` contains the Next.js page and API routes.
- `src/game/` contains browser rendering, HUD, CV provider, and SpacetimeDB client.
- `spacetimedb/src/` owns match state, validation, combat resolution, profiles, and persistence.
- CV processing stays on the client. Send classified actions and tracking state; never send frames or raw landmark streams.
- Client animation may respond immediately, but server state decides accepted actions, damage, health, KO, and results.
- `input/` and `engine/` also support the standalone local arena in `dev/`; that arena is not the authoritative online game.
- Adaptive opponent strategy remains separate from live coaching. Model output may adjust bounded tactics, never health, damage, hit outcomes, or winner.

## Commands

- `bun run dev` serves Next.js at http://localhost:3001.
- `bun run build` builds the Next.js app.
- `bun run test` runs the engine/input tests and SpacetimeDB module tests.
- `bun run build:arena` builds the standalone arena; `bun run arena` serves it at http://localhost:8787.
- Local database: `spacetime start`, then `spacetime publish --anonymous --server local --module-path spacetimedb claude-tyson`.
- Regenerate bindings after schema changes with `spacetime generate --lang typescript --out-dir src/game/module_bindings --module-path spacetimedb`.

## Current notes

- The live game uses `SimulatedCvProvider` for keyboard input. Camera input (`src/game/cv/input.ts`) presses the same control keys, so the webcam and keyboard share one input path. Blocks are classified client-side from head/wrist markers against a pre-match calibration (`src/game/cv/guard.ts`).
- Camera input is classified in the browser by default (`src/game/cv/browserCv.ts`): MediaPipe in two workers plus a TypeScript port of the cv-mvp detector (`src/game/cv/local/`). The Python bridge (`cv-mvp`, ws://127.0.0.1:8765, `src/game/cv/bridge.ts`) is the dev/tuning source: `?cvSource=bridge` or `NEXT_PUBLIC_CV_SOURCE=bridge`.
- The TS detector must match Python frame for frame: after changing either side, regenerate fixtures with `python scripts/export_parity_fixtures.py --out <repo>/src/game/cv/local/fixtures` (cv-mvp branch) and keep `src/game/cv/local/game.json` in step with `cv-mvp/configs/game.json`.
- `scripts/cv-assets.ts` (run by `dev` and `build`) copies the MediaPipe WASM and models into `public/cv/` (gitignored). `?cvVideo=<url>` plays a clip as the camera; `?cvDelegate=GPU|CPU|mixed` overrides the MediaPipe delegate.
- Multiplayer: every match (bot or PvP) occupies one of `RING_COUNT` rings (4, in a 2 × 2 grid; the constant lives in both `spacetimedb/src/index.ts` and `src/game/scene/arena.ts`). A full arena holds the PvP queue; a human bot match or PvP pairing claims an exhibition ring when needed. While rings are spare, the PvP queue is empty, and someone is online, two bots fight an `exhibition` in each spare ring. Exhibitions begin together on the arena tick, and each ring waits for its own finished exhibition to be cleaned up before restarting. Clients subscribe only to live matches, exhibitions, and their own latest match. The lobby camera orbits the grid origin between all four rings; spectating focuses one ring.
- The standalone arena uses its own local engine and is for input/animation experiments.
- `.env.example` contains the local SpacetimeDB settings and optional server-side Claude API settings.
