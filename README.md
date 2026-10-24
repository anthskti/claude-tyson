# Claude Tyson

Browser-based boxing game. Next.js serves the game UI; SpacetimeDB owns matches, combat
resolution, player profiles, and persistence. CV processing stays on the client and sends
classified inputs to the server, never webcam frames.

## Project layout

| Path | Responsibility |
|---|---|
| `src/app/` | Next.js page and API routes |
| `src/game/` | Browser scene, HUD, CV provider, and SpacetimeDB client |
| `spacetimedb/src/` | Database schema, reducers, and authoritative combat |
| `engine/`, `input/` | Pure combat/input utilities and standalone arena support |
| `dev/` | Standalone local arena |
| `CONTRACTS.md` | Design contract for actions and combat shapes |

## Run locally

Start SpacetimeDB in one terminal:

```sh
spacetime start
```

Publish the module and generate client bindings when the module schema changes:

```sh
sh sync-engine.sh
spacetime publish --anonymous --server local --module-path spacetimedb claude-tyson
spacetime generate --lang typescript --out-dir src/game/module_bindings --module-path spacetimedb
```

Start Next.js in another terminal:

```sh
bun run dev
```

The game is served at `http://localhost:3001`; SpacetimeDB listens on port `3000` by default.
The client defaults to `ws://localhost:3000` and database `claude-tyson`; override these with
`NEXT_PUBLIC_STDB_HOST` and `NEXT_PUBLIC_STDB_DB` in `.env.local` if needed.

## Standalone arena

```sh
bun run build:arena
bun run arena
```

This serves `dev/arena.html` at `http://localhost:8787`. It can also be opened directly after
building. The arena is a local combat demo and does not connect to SpacetimeDB.
