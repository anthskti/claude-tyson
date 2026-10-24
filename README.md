# Claude Tyson: engine + live AI coach (SpacetimeDB track)

Webcam boxing vs a CPU opponent, with a Claude corner coach talking to you mid-fight.
SpacetimeDB is the source of truth for the fight (matches the team diagram); the CPU runs
server-side on a scheduled tick; the player, the coach and phone spectators all subscribe.
Everything speaks the team contract in `shared/contracts.ts`.

```
CV kit (Hani) ──> input/cvKit.ts ──┐            ┌──────────── SpacetimeDB (source of truth) ────────────┐
keyboard ───────> input/keyboard.ts┼─ act ────> │ fight row · combat_event log · 50ms tick runs engine  │
                                   │            │ coach_cue · coach_effect                              │
                                   │            └───────────────┬───────────────────────────────────────┘
                                   │                            │ subscriptions
                     ┌─────────────┴──────────────┐             v
                     │ player's browser            │   spectator phones: fight + coach captions
                     │  renderer + HUD (Anth)      │
                     │  LiveCoach:                 │
                     │   rules (instant, local) ───┼──> scheduler ──> Cartesia / built-in voice + caption
                     │   every 10s ─> /api/coach ──┼──> Claude (server route, key never in browser)
                     │   ~10s later: did it help?  │──> postCoachCue / postCoachEffect
                     └─────────────────────────────┘
```

## Folders

| Path | What it is | Tested |
|---|---|---|
| `shared/contracts.ts` | The team contract, SpacetimeDB edition. v1.1 changes are additive and marked. | typechecks |
| `engine/engine.ts` | Deterministic combat engine + CPU bot. Held lean, tracking pause, dedupe, guard checks. | 17 tests incl. balance sim |
| `coach/adapter.ts` | Engine events / DB rows -> contract `CombatEvent`, `MotionEvent`, `FightSnapshot` | ✓ |
| `coach/stats.ts` | `FighterStats`, `StyleEvidence`, `FightWindow`, `CoachRequest` builders | ✓ |
| `coach/rules.ts` | Instant coach: local rules, capability-gated | ✓ |
| `coach/scheduler.ts` | One voice at a time; priority, interrupt, no repeats, stale drop | ✓ |
| `coach/claudeCoach.ts` | Server: `CoachRequest` -> Claude (forced tool call) -> validated `CoachResponse` | ✓ mocked API |
| `coach/offlineCoach.ts` | Same contract, no network. Used when Claude is off, errors, or is slow | ✓ |
| `coach/effect.ts` | "Did the advice help?" as `AdaptationResult` (strategyId = cueId) | ✓ |
| `coach/tts.ts`, `coach/browserAudio.ts` | Cartesia speech (server route) + browser playback with built-in fallback | ✓ |
| `coach/liveCoach.ts` | Ties it together; one class used by the arena and the real game | full engine fight test |
| `input/cvKit.ts` | Hani's CV kit `cv_sample` messages -> engine inputs (per INTEGRATION_CONTRACT) | 5 tests |
| `input/motion.ts`, `input/keyboard.ts` | Browser MediaPipe classifier (alternative to the kit), keyboard | ✓ |
| `spacetimedb/src/` | Tables + reducers: `startFight`, `act`, `tick`, `forfeit`, `postCoachCue`, `postCoachEffect` | vitest, real reducers |
| `client/fightClient.ts` | Real game client: SpacetimeDB + LiveCoach + spectators | needs generated bindings |
| `next/app/api/*/route.ts` | Drop-in Next.js routes for `/api/coach` and `/api/tts` | |
| `dev/arena.html`, `dev/server.ts` | Play the engine + coach in a browser | headless browser runs |

## Run it

```sh
bun run test                     # 44 engine/coach/input tests + SpacetimeDB reducer tests

# Arena with the coach (no keys needed: offline coach + built-in voice)
open dev/arena.html
# Arena with real Claude + Cartesia
ANTHROPIC_API_KEY=... CARTESIA_API_KEY=... CARTESIA_COACH_VOICE=<voice id> bun dev/server.ts   # http://localhost:8787

# Real game
spacetime start
./sync-engine.sh
spacetime publish --server local --module-path spacetimedb claude-tyson
spacetime generate --lang typescript --out-dir client/module_bindings --module-path spacetimedb
# Next.js: copy next/app/api/* routes, use connectFight() from client/fightClient.ts
```

Env: `ANTHROPIC_API_KEY`, `COACH_MODEL` (default `claude-haiku-5-5`, the fast tier, because
live tips need low latency), `CARTESIA_API_KEY`, `CARTESIA_COACH_VOICE`, `CARTESIA_OPPONENT_VOICE`,
`NEXT_PUBLIC_STDB_HOST`, `NEXT_PUBLIC_STDB_DB`.

## How the coach works

1. **Instant rules** run on every new event, no network: low HP (urgent, interrupts), guard
   dropping after punches, getting countered, punching into a guard, getting slipped, out of
   stamina, plus short praise ("Nice slip!"). Rule lines are pre-generated as audio at fight start.
2. **Claude tips** every ~10s once there are at least 3 exchanges. The browser builds a
   `CoachRequest` (last 15s of `FighterStats`, `StyleEvidence`, public fight state) and POSTs it to
   `/api/coach`. Claude must answer via a `give_coaching` tool call. Max 18 words, one tip.
3. **Validation**: tips about things the game can't see are rejected (punch types with coarse CV,
   the player's guard without guard tracking, body shots, strength, form). Rejected, errored or
   >6s responses fall back to the offline coach, so the coach never goes silent.
4. **Scheduler**: one line at a time, 4s minimum gap, no repeating a line within 20s, urgent
   interrupts, stale lines expire, wrap-up at the end always plays.
5. **Did it help?** ~10s after a tip, compare before vs after (hit rate; or guard recovery /
   damage taken per second for defensive tips). Saved as `AdaptationResult` in `coach_effect`
   and shown on the results screen. Short windows are reported as inconclusive.
6. **Fight end**: Claude gives a 1-2 sentence wrap-up from the whole fight.
7. **Tracking lost**: the fight pauses, the coach goes quiet, attacks in flight become
   "unscorable" and are left out of every stat.

## Integration contract decisions this implements

* **Capabilities** decide what anyone can say. CV kit = `punch_coarse, dodge, lean`
  ("left hand / right hand", never jab/hook; no guard). Keyboard = `punch_types, guard, dodge, lean`.
  Passed to `startFight` and stored on the fight row.
* **Coarse punches**: `punch_left` -> left straight, `punch_right` -> right straight.
* **Held dodges**: continuous `lateralDisplacementBodyWidths` -> held lean, protects while held,
  drains stamina so it can't be held forever.
* **Dedupe**: `(sessionId, eventId)` in the adapter and again in the engine via `act`'s `eventId`.
* **Stale / lost / gap / recalibration**: pause, require a fresh neutral, never replay backlog punches.
* `guard_return_*` is not treated as blocking.

## Combat rules

| Move | Windup | Damage | Notes |
|---|---|---|---|
| jab / cross | 120 / 200 ms | 4 / 8 | dodged by either slip direction |
| hook L/R | 260 ms | 11 | must slip the matching direction |
| uppercut L/R | 320 ms | 14 | breaks guard: 60% damage + stun |

Guard blocks 85%. Slip window 40 to 300ms; a held lean protects as long as it's held and you have
stamina. Hitting someone mid-windup is a 1.5x counter. Out of stamina = slower, weaker punches.
3s countdown, 90s round. CPU reaction 230ms. All numbers at the top of `engine.ts`.

## For the renderer (Anth)

Read the `fight` row (or `onSnapshot`'s contract `FightSnapshot`): `playerPhase/cpuPhase`,
`playerMove/cpuMove`, guards, HP, stamina, `paused`, `status`, `winner`. Coach UI: `onCoachLine`
(text + source badge: rules / claude / offline), `onCoachStatus` (watching / thinking / offline /
paused / done), `onCoachEffect` for the results screen.
