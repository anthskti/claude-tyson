# AGENTS.md — Claude Tyson

## Project goal

Claude Tyson is a browser-based boxing game with two match modes: human vs. human (PvP) and human vs. an adaptive Claude-controlled sparring bot. Players use a webcam to throw punches, block, and dodge. The server runs authoritative combat, and each player has a persistent profile that helps the bot become an appropriately challenging sparring partner over multiple sessions.

**Current priority: a correct, playable combat engine.** Optimize for a reliable hackathon demo, not a comprehensive boxing simulator.

## Source of truth

- Treat `CONTRACTS.md` as the current **design contract** until the repository adopts a newer agreed version. These are TypeScript shapes, **not** generated SpacetimeDB schema definitions.
- Treat `schema-diagram.md` as a conceptual reference; where it differs from `CONTRACTS.md`, follow v4 and flag the discrepancy.
- Read the actual repository, installed dependency versions, and package scripts before making assumptions about paths, APIs, or commands.
- Keep any shared contracts, server schema, reducers, and client consumers consistent. Never silently change wire contracts.

## Stack and boundaries

- Frontend: Next.js / TypeScript and Three.js for rendering and animation.
- Local input: MediaPipe Pose/Hands -> motion classifier -> discrete `MotionEvent`.
- Backend: SpacetimeDB for match state, identity, validation, combat resolution, persistence, and real-time subscriptions.
- AI: Claude for bounded tactical strategy during bot matches and post-fight analysis. AI calls must not block combat.
- Do not send raw webcam video or per-frame landmark streams to the server. Keep camera processing client-side.
- Client handles immediate visual feedback; server is authoritative for accepted actions, health, timing, damage, KO, and match outcome.

## Required gameplay scope

- Modes: `pvp` and `adaptive_bot`; both use the **same** action vocabulary and combat resolution rules.
- Actions: idle/guard, `block_start`, `block_end`, `dodge_start(left|right)`, `dodge_end`, left straight, right straight, left hook, right hook. Straights are named by anatomical hand; they still use the jab and cross combat stats, and the HUD may say jab and cross.
- Dodges are inferred from **nose displacement relative to shoulders** using MediaPipe, with calibrated thresholds and debounce/hysteresis where needed. Anatomical left/right must be consistent despite mirrored camera preview.
- No world-position movement, walking, ducking, uppercut, combos, coach, or live commentary in the MVP. Idle animation may include visual stepping, but has no gameplay displacement.
- KO is terminal. Once health reaches zero, stop accepting combat actions and play knockout animation once; no get-up mechanic.

## Combat rules (current design)

- Base damage: jab `0.5`, cross `1.3`, left hook `1.0`, right hook `1.0`.
- Left dodge avoids straight punches and the **left hook**; a right hook that lands against it gets `1.5x` base damage.
- Right dodge avoids straight punches and the **right hook**; a left hook that lands against it gets `1.5x` base damage.
- Active head block prevents head-punch damage. Bound block duration and/or cooldown to prevent indefinite blocking.
- Hit windows, attack startup/recovery, block/dodge validity, cooldowns, and damage are decided server-side. Timing constants are tunable; do not invent final values without indicating they are provisional.
- Use server time for resolution. Client timestamps are diagnostic only and never proof that an action succeeded.
- Deduplicate `inputId` and reject out-of-order or invalid sequences; authenticate the submitting connection and ensure it belongs to the match.

## Input/event pipeline

1. MediaPipe produces local landmarks.
2. Client classifier emits a **discrete** `MotionEvent` (`kind: action` or `kind: tracking`) with confidence and tracking quality.
3. Client calls the server input reducer (conceptually `submitMotion`); it never sends damage, hit decisions, winner, or an arbitrary fighter slot.
4. SpacetimeDB validates identity, sequence, tracking confidence, match state, action legality, and cooldowns, then maps the input to `FightAction`.
5. The **same combat engine** processes validated human actions and internally generated `BotAction`s; it updates `FighterState` and emits `CombatEvent`s.
6. Subscribed clients render authoritative updates, optionally reconciling locally predicted animations.
7. End-of-match results update records, player style/skill aggregates, and post-fight analysis.

## Adaptive bot rules

- No Easy/Medium/Hard setting. Hidden server-owned `BotBalance` gradually adjusts challenge within bounded limits.
- Prefer adjusting reaction delay, attack frequency/aggression, defensive and counter tendencies over changing base punch damage.
- Claude produces `StrategyUpdate` / tactical patches based on a bounded recent fight window plus `PlayerProfile.learnedStyle`; it does **not** directly set health, damage, hit outcomes, or winner.
- Validate/clamp incoming model output. Reject stale responses; retain previous safe tactics on timeout or failure.
- `BotTactics.guardBias` and `dodgeBias` use `[-1, 1]`; `*01` fields use `[0, 1]`. Normalize punch weights before use.
- The bot should stay competitive rather than become unbeatable; adjust its balance smoothly, not on every frame or hit.
- Preserve useful per-player style aggregates keyed by immutable `playerId`, not mutable display names. Avoid unbounded history arrays on the profile.

## Persistence and multi-match isolation

- Model player profiles, matches, two fighter slots per match, combat events, results, adaptive balance, strategies, and per-player analyses as separate records where appropriate.
- Use unique `matchId`; never share mutable combat state across simultaneous matches.
- Maintain event IDs and match IDs for replay/debugging. Storing combat events is in scope; raw camera data is not.
- Dojo/arena presentation, spectators, and complex matchmaking are later-stage UI/features; do not couple them to core combat resolution.

## Engineering conventions

- Prefer simple, typed, deterministic functions. Separate pure combat rules from database reducers, camera classification, Three.js animation, and Claude API integration.
- Keep contracts lean: don't add aliases or elaborate generic abstractions unless they clearly improve safety or reuse.
- Validate untrusted input at runtime even when TypeScript types exist.
- Never perform HTTP/LLM requests from deterministic combat reducers; use a supported procedure or trusted worker and apply the validated result safely.
- Don't add dependencies or reshape the architecture without explaining the reason and checking with the user first.
- Don't modify unrelated code or fabricate package commands. Use the repo's actual scripts.
- Before editing, identify the root cause and scope. After editing, summarize what changed, why, and how it was verified.

## Testing priorities

1. Damage matrix across jab/cross/hooks vs. idle, block, dodge-left, dodge-right.
2. Startup/active/recovery timing, overlapping inputs, spam/cooldown enforcement.
3. KO terminal behavior (no additional actions; animation/state transition once).
4. Match membership, event deduplication, out-of-order events, tracking loss.
5. Two concurrent matches cannot leak state.
6. Human and bot actions produce identical engine outcomes under identical state.
7. Claude timeout/invalid patch/stale response leaves combat playable.
8. Persistence and profile aggregation are stable across successive matches.

## Agent response format

Be concise. For implementation work, state: **root cause / approach**, **files changed**, **tests run**, and **remaining risks**. Ask only when a decision materially affects the architecture or scope; otherwise use the simplest documented assumption and call it out.
