# Claude Tyson

Webcam boxing game. Three.js client + SpacetimeDB (TypeScript module) server. Flow and boundaries: [INTEGRATION_CONTRACT.md](INTEGRATION_CONTRACT.md).

```
client/                  Vite + TS + Three.js
  src/cv/contract.ts     Observation / MotionEvent / CvProvider types (contract §2, §4)
  src/cv/simulatedProvider.ts  keyboard stand-in for the CV provider
  src/scene/ring.ts      placeholder ring + arena lights; loads public/models/ring.glb if present
  src/scene/boxer.ts     placeholder opponent + first-person gloves
  src/net/server.ts      SpacetimeDB connection, subscriptions, CV forwarding
  src/module_bindings/   GENERATED, don't edit
server/spacetimedb/src/index.ts  tables + reducers (match, combat, bot, strategy, persistence)
```

## Run locally

```sh
# one-time: install CLI  ->  curl -sSf https://install.spacetimedb.com | sh
spacetime start                                   # terminal 1, local DB on :3000

cd server && spacetime publish claude-tyson --server local --yes
spacetime generate --lang typescript --out-dir ../client/src/module_bindings --module-path ./spacetimedb --yes

cd ../client && npm install && npm run dev        # http://localhost:5173
```

After any schema/reducer change, rerun `publish` + `generate` (add `--delete-data=always` to publish if the schema change is breaking). Or use `spacetime dev` for auto-rebuild/publish.

Controls (simulated CV):

| | |
|---|---|
| Body (hold) | **A** slip left · **D** slip right · **S** lean back |
| Guard (hold) | **Q** left · **E** right · **W** both |
| Left fist | **J** jab · **U** hook · **M** uppercut |
| Right fist | **K** straight · **I** hook · **,** uppercut |
| Debug | **T** toggle tracking loss · **C** recalibrate |
PvP in one browser: open a second tab with `?player=2` for a separate identity.

## Blender ring

Export as glTF binary to `client/public/models/ring.glb` (+Y up, 1 unit = 1 m, canvas top at y=0, centred on origin). It replaces the placeholder automatically.

## Combat rules

Source of truth: `server/spacetimedb/src/rules.ts`. Every defence has exactly one punch that beats it:

| Defence | Avoids | Beaten by |
|---|---|---|
| Slip (lean left/right) | jab, straight, uppercut | **hook** (×1.25; ×1.5 if you slip *into* it) |
| Lean back | jab, hook, uppercut | **straight** (×1.25, longest reach) |
| Block | jab, hook *on the guarded side*, straight (25% chip) | **uppercut** (×1.25, through the guard) |
| Neutral | nothing | everything |

| Punch | Damage | Wind-up | Role |
|---|---|---|---|
| Jab | 5 | 150 ms | fast probe, beats no defence |
| Straight | 9 | 240 ms | punishes lean back |
| Hook | 13 | 340 ms | punishes slips, arrives from one side (your left hook hits their right) |
| Uppercut | 15 | 400 ms | splits the guard |

- A successful slip or lean back opens a 700 ms counter window: your next punch does ×1.5. Blocking is safe, so it gives no counter.
- Throwing a punch drops that hand's guard until it's back.
- An unknown CV punch type is `unclassified` and fights like a jab.

**CV dependency:** the kit only gives lateral displacement and coarse punch_left/right (contract §2B). Lean back, block, and punch type are a proposed extension (`Observation.pose`, `MotionEvent.punchType` in `client/src/cv/contract.ts`). Without them the game falls back to slips from lateral, no blocks, and unclassified punches.

## Server model

| Step | Server piece |
|---|---|
| 1 Match creation | `start_bot_match`, `join_pvp_queue` → `fight_match` + two `fighter` rows |
| 2 Motion input | `update_pose` (~20 Hz body/guard state + validity), `submit_motion_event` (deduped by session:eventId) |
| 3 Combat | punches create an `attack` row; `resolve_attack` fires at impact and checks the defender's *current* body/guard against `rules.ts`. Stale/invalid pose → `unscorable` |
| 4 Adaptation | `close_window` writes a `fight_window` every 6 s; strategist calls `apply_strategy_update` (clamped, revision-checked); `bot_act` reads `bot_strategy` |
| 5 Persistence | match end writes `fight_result` + updates `fighter_profile`; `submit_fight_analysis` stores Claude's write-up |
