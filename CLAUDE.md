# Claude Tyson (Cal Hacks 13.0, SpacetimeDB track)

Webcam Wii-Sports-style boxing vs a CPU opponent, with a live AI corner coach (Claude + Cartesia voice).
Team: Anthony Pham (anthskti, 3D scene/animations), Hani (CV/MediaPipe kit), Yejia Shen (strategist/voice), Abdullah.
Repo: github.com/anthskti/claude-tyson. Do not push without asking Abdullah.

**Read `docs/PROJECT_CONTEXT.md` first**: the full plan, sponsor-track criteria, team diagram, Excalidraw
ideas, both contracts, design decisions, status and the demo we're aiming for.
Submission deadline: Devpost, Sunday Oct 25, 9:00 AM; live demo judging 10:30 AM.

## Architecture (see README.md, docs/architecture.webp)
- SpacetimeDB is the source of truth for the fight: `spacetimedb/src/index.ts` (tables fight, combat_event,
  coach_cue, coach_effect, fight_tick; reducers startFight, act, tick (50ms scheduled), forfeit, postCoachCue, postCoachEffect).
- `engine/engine.ts` is the pure deterministic combat engine (no deps, seeded RNG). It runs inside the module.
  `spacetimedb/src/engine.ts` is a COPY: after editing engine/engine.ts run `./sync-engine.sh`.
- `shared/contracts.ts` is the team's wire contract (v1 original in docs/contracts.v1.original.ts).
  Changes must stay additive and be marked `v1.1`. `coach/adapter.ts` maps engine/DB rows to contract types.
- `coach/` is the live coach: rules (instant) + Claude every ~10s via /api/coach + offline fallback,
  scheduler (one voice at a time), effect measurement (AdaptationResult). `coach/liveCoach.ts` ties it together.
- Inputs: `input/cvKit.ts` (Hani's kit `cv_sample` messages, per docs/INTEGRATION_CONTRACT.md),
  `input/keyboard.ts`, `input/motion.ts` (browser MediaPipe alternative).
- `client/fightClient.ts`: real game client (needs `spacetime generate` bindings in client/module_bindings).
- `next/app/api/{coach,tts}/route.ts`: drop-in Next.js routes. `dev/server.ts` + `dev/arena.html`: playable test arena.

## Rules that matter
- Capabilities decide what the coach can say. CV kit = punch_coarse, dodge, lean (no punch types, no guard).
  Keyboard = punch_types, guard, dodge, lean. Never coach body shots, strength, form.
- Tracking lost pauses the fight; in-flight attacks are "unscorable" and excluded from all stats.
- API keys only server-side (.env.local, see .env.example).

## Commands
- `bun run test` (bun tests for engine/input/coach, then vitest for the SpacetimeDB module; run `bun install` in spacetimedb/ first)
- `bun dev/server.ts` -> http://localhost:8787 arena with coach (offline without keys)
- `bun dev/build-arena.ts` -> rebuild standalone dev/arena.html
- SpacetimeDB: `spacetime start`, `./sync-engine.sh`, `spacetime publish --server local --module-path spacetimedb claude-tyson`,
  `spacetime generate --lang typescript --out-dir client/module_bindings --module-path spacetimedb`
- Windows: run sync-engine.sh from Git Bash, or copy engine/engine.ts to spacetimedb/src/engine.ts manually.

## Not done yet
- Next.js app scaffold + three.js scene (Anth), hooking renderer to fight rows.
- fightClient.ts hasn't been typechecked against generated bindings (needs the spacetime CLI).
- Claude strategist (OpponentTuning patches via a reducer) is stubbed: applyTuningPatch exists in the engine.
