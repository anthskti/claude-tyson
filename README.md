# Claude Tyson

A browser boxing game you play with your body. Your webcam tracks your head and hands, so
you throw real punches, raise your gloves and slip to dodge, against another player (PvP)
or an adaptive Claude sparring bot. A keyboard mode plays the same game without a camera.

**Play:** https://claude-tyson.vercel.app

Next.js and Three.js render the game in the browser. SpacetimeDB runs every match:
it decides which actions count, how much damage lands, stamina, KOs and results, and it
keeps player profiles. Computer vision runs entirely on the player's machine; only
classified actions (a punch, a dodge, which gloves are up) are sent to the server, never
webcam frames or landmark streams.

## How to play

Pick **Keyboard** or **Camera** on the menu, then **Fight adaptive bot** or **Find PvP match**.
Camera mode first walks you through a short calibration (step into frame, show your
stance, show your block) and remembers it on that machine.

| Defence | Beats | Beaten by |
|---|---|---|
| Block (both gloves up) · drains 4 stamina/s | either straight | either hook |
| Dodge (slip left/right) · 20 stamina | either straight, same-side hook | opposite hook (×1.5 damage) |

- A block needs **both** gloves up. One glove alone does not block.
- Left straight: 0.5 damage, 5 stamina. Right straight: 1.3, 12. Hooks: 1.0, 16.
- Stamina regenerates at 12/s while you are idle. Both fighters' health and stamina bars
  are shown at the top of the screen.
- A successful dodge opens a short counter window (×1.5 damage).

### Keyboard controls

| Keys | Action |
|---|---|
| `A` / `D` (hold) | slip left / right |
| `S` (hold) | lean back |
| `W` (hold), or `Q` + `E` | raise both gloves (block) |
| `J` / `U` | left straight / left hook |
| `K` / `I` | right straight / right hook |
| `C` | recalibrate · `T` simulate losing tracking |

See [keyboard-cheat-sheet.md](keyboard-cheat-sheet.md) for details.

### Camera input

Camera input is classified in the browser: MediaPipe pose and hand models run in two Web
Workers, and a TypeScript port of the cv-mvp punch/dodge detector turns their landmarks
into actions, which press the same controls as the keyboard. The first time you pick
Camera the page downloads about 22 MB (models and WASM), cached afterwards. Use a desktop
browser (Chrome, Edge or Firefox), stand back so your head and both hands are in frame,
and allow camera access. The camera chip in the top bar shows tracking status and frame
rate (hover for timings); below 20 FPS the HUD warns that punches may not register.

The original Python pipeline (`cv-mvp/`, on the `cv-mvp` branch) is still available as a
local bridge for tuning and replays: run `python -m cv_mvp --camera 0` there and open the
game with `?cvSource=bridge`.

## Architecture

| Path | Responsibility |
|---|---|
| `src/app/` | Next.js page |
| `src/game/` | Three.js scene, HUD, SpacetimeDB client (`net/`) |
| `src/game/cv/` | Camera input: `input.ts` (actions to controls), `browserCv.ts` (in-browser source), `bridge.ts` (Python bridge source), `guard.ts` (block calibration), `cameraFeed.ts` (preview) |
| `src/game/cv/local/` | In-browser CV: MediaPipe workers and the detector port, with parity fixtures from cv-mvp |
| `spacetimedb/src/` | Schema, reducers, authoritative combat, bot, profiles |
| `engine/`, `input/` | Pure combat/input utilities used by the standalone arena |
| `dev/` | Standalone local arena (not the online game) |
| `cv-mvp/models/` | MediaPipe models, copied into `public/cv/` at build time |
| `CONTRACTS.md` | Design contract for actions and combat shapes |

The client may animate immediately, but the server decides accepted actions, damage,
health, KO and results. The adaptive bot adjusts bounded tactics only, never damage, hit
outcomes or the winner.

## Run locally

Requires [Bun](https://bun.sh) and the [SpacetimeDB CLI](https://spacetimedb.com/install).

```sh
bun install
spacetime start                                   # terminal 1
spacetime publish --anonymous --server local --module-path spacetimedb claude-tyson
bun run dev                                       # terminal 2: http://localhost:3001
```

The module bundles only files inside `spacetimedb/`; `spacetimedb/src/rules.ts` is the live
rule set. Do not run `sync-engine.sh` for now: `engine/rules.ts` is an older design and the
script would overwrite the server's rules with it. After changing the module schema,
regenerate the client bindings:

```sh
spacetime generate --lang typescript --out-dir src/game/module_bindings --module-path spacetimedb
```

The client defaults to `ws://localhost:3000` and database `claude-tyson`; set
`NEXT_PUBLIC_STDB_HOST` and `NEXT_PUBLIC_STDB_DB` in `.env.local` to change them (see
`.env.example`). `bun run dev` and `bun run build` first run `scripts/cv-assets.ts`, which
copies the MediaPipe WASM and hash-checked models into `public/cv/` (generated, gitignored).

Debug URL parameters: `?input=camera|keyboard`, `?cvSource=bridge`,
`?cvVideo=/clip.mp4` (play a same-origin clip as the camera), `?cvDelegate=GPU|CPU|mixed`.

## Tests

```sh
bun run test
```

Runs the engine, input and CV tests (including frame-by-frame parity between the
TypeScript detector and the Python one) and the SpacetimeDB module tests. After changing
the detector on either side, regenerate the parity fixtures from the `cv-mvp` branch:

```sh
python scripts/export_parity_fixtures.py --out <this repo>/src/game/cv/local/fixtures
```

## Deploy

Two pieces, deployed separately:

- **Backend:** the SpacetimeDB module on Maincloud.
  `spacetime publish --server maincloud --module-path spacetimedb claude-tyson`
- **Frontend:** the Next.js app on Vercel, with `NEXT_PUBLIC_STDB_HOST=wss://maincloud.spacetimedb.com`
  and `NEXT_PUBLIC_STDB_DB=claude-tyson` set for Production. `vercel deploy --prod`.

Players connect to the Vercel page, which talks to SpacetimeDB directly over a WebSocket.

## Standalone arena

```sh
bun run build:arena
bun run arena          # http://localhost:8787
```

A local combat and animation demo with its own engine; it does not connect to SpacetimeDB.
