# Claude Tyson: full project context

Everything the team has planned, decided and built so far, collected from the planning doc, the
Excalidraw board, the team architecture diagram, `contracts.ts`, `INTEGRATION_CONTRACT.md`, the
Cal Hacks hacker guide, and the build sessions. Read this before making design decisions.

---

## 1. The hackathon

**Cal Hacks 13.0**, Palace of Fine Arts, San Francisco, Oct 23 to 25, 2026.

| When | What |
|---|---|
| Fri 4:00 to 6:00 PM | Opening ceremony |
| Sat night | Submit a **draft** on Devpost (organizers strongly recommend it) |
| **Sun 9:00 AM** | **Devpost submission deadline.** Late = not judged |
| Sun 10:30 AM to 12:30 PM | Judging at assigned tables. **Whole team must be present.** **Live demo required** |
| Sun 2:00 to 4:00 PM | Closing ceremony |

Rules: teams of 1 to 4, all code started during the event, MLH code of conduct. Judges score impact,
quality, technical complexity and creativity, and care about the idea and thought process.
Prepare a 2-minute pitch. Wifi: "Cal Hacks 13.0".

## 2. Team

| Person | Role (planning doc Features tab) |
|---|---|
| **Anthony Pham** (GitHub `anthskti`, owns the repo `anthskti/claude-tyson`) | 3D modeled + animated character (Blender), local combat engine, Three.js scene + HUD. Wrote the planning doc, the Excalidraw and `contracts.ts` |
| **Hani** | CV: MediaPipe pose tracking controls, hand masking. Has a Python CV "experiment kit" (`boxing_cv/detector.py`) |
| **Yejia Charles Shen** | Claude adaptive strategist, visible adaptation feedback, fight-data storage, Cartesia/Moss voice coach |
| **Abdullah Yousafi** | Engine + SpacetimeDB backend + live AI coach (this repo's code). Post-analysis / cross-fight memory were "anybody" |

Exact ownership of aggregation, collision rules, tracking-pause policy and clock alignment was still
to be confirmed at kickoff (INTEGRATION_CONTRACT §7).

## 3. The idea

**Wii Sports Boxing with just a laptop webcam, against a Claude-driven opponent, with fight analysis.**

Pitch angles from the planning doc:
- Everyone grew up on Wii Sports Boxing, but Wiis need proprietary remotes. Almost everyone has a laptop webcam.
- "We always use Claude to work *for* us. Here we go head to head *against* Claude." Just as Claude Code
  finds bugs in your code, it can find the bugs in your fighting.
- Fights produce messy data (people literally throwing punches), but where there's data there's a pattern.
  Break down both fighters' inputs, map the fight, let Claude explain pros and cons.
- Inspiration: GothamChess playing AI agents; they adapt and go head to head with specialists.
- Possible story: Anthony did some taekwondo and self-taught muay thai, and struggled with no one to
  critique his form. Also: an interactive game that gets people into self-defense training.
  Anthony flagged that the pitch needs a strong "why"; demo is everything.

**Name: "Claude Tyson"** (team picked it, Anthony: "bingo"). Deliberately outlandish to stand out,
inspired by the Devpost project "Claude Whipper 9000". Rejected: BoxMe, BoxAI, Boxrothpic, OpenPuncher,
RingAroundtheAI, Claude Can Box 999, Claude Fighter 999.

Fun ideas from the team (Yejia):
- Stamina bar where a tired bot is "low on tokens". **Implemented**: at 0 stamina punches are slower/weaker.
- When the bot gets up after a knockdown: "my usage got reset". (Not built; we use single-round KO.)
- Multiplayer could be cool (PvP is in the team diagram).

## 4. Sponsor tracks and the decision

The Excalidraw listed current tracks (Convex, Cartesia, Meta, Claude, Figma), with SpacetimeDB and Moss as
alternates. **The team then decided to go for the SpacetimeDB track** and build an MVP first.

| Track | What judges want | Prize | Our angle |
|---|---|---|---|
| **SpacetimeDB** (chosen) | SpacetimeDB as the **core real-time backend**: live shared state, multiplayer, instant sync between users/agents/systems, server-side logic close to the data. "Meaningfully used, not just added on the side." | $2,048 / $1,024 / $512 | Fight lives in SpacetimeDB; CPU runs as a scheduled reducer; player, coach and phone spectators all subscribe to one shared fight state |
| Anthropic | A **named community**, a real problem you lived or heard about, one thing that works well and is usable Monday, thoughtful use of Claude including where it could go wrong | $5k credits + Max | Claude coach + adaptive opponent. Needs a specific community story (e.g. people learning to box/self-defense alone with no coach) |
| Cartesia | Voice must be **core**, not a bolt-on. 2-min demo-first pitch, README with Cartesia features used and limitations, no keys in repo. Ideas list includes "live coach" | Meta glasses (TBD) | Live spoken coaching. Excalidraw worried Cartesia "requires the app to revolve around them" |
| Convex | Reactive backend platform | $5,000 | Was the original backend; dropped for SpacetimeDB. Excalidraw noted Convex's prize is "K.O. boxing related" |
| Moss | Voice AI / personal agent / social post | AirPods | Alternate voice option |
| General | First/second/third overall, Most Creative, Most Technically Complex, Best People-First, Hacker's Choice | | |

Excalidraw notes on the choice:
- "Convex vs SpacetimeDB: they honestly do the same job in the current system since most of it runs on
  the client, unless another computer hosts the match." Resolved by making **SpacetimeDB own the fight**.
- "Moss is much lighter. If we talk to both Convex and SpacetimeDB and they like our idea, we can switch,
  but we'd have to look into more server-side running (ex. multiplayer)."
- **"To hit Convex or SpacetimeDB better: a live ringside screen that spectators can open on their phones
  to see the player's stats and Claude's latest adaptation."** This is the strongest SpacetimeDB demo moment.
- "SpacetimeDB is moving away from choosing games, but ours is quite interactive."
- "Claude prize track is targeted toward very impactful causes. We can story-ify our reasoning."

## 5. Architecture

### 5a. Team diagram (`docs/architecture.webp`)
**Client side (local processing)**, for Player A and Player B (PvP only): Webcam -> MediaPipe + Motion
Classifier, plus Three.js Renderer + UI.

**SpacetimeDB (source of truth)**:
- **Lobby + Matchmaking**: PvP or Adaptive AI
- **Combat Engine**: action validation, hit windows, damage, dodge, cooldowns
- **Match Session**: players, health, timer, status
- **Adaptive Bot Controller**: converts strategy to actions (inputs: recent combat data, historical tendencies, AI mode)
- **Combat Events + Fight History**
- **Persistent Player Profile**: skill, habits, weaknesses
- **Post-Fight Analysis**

**Claude API (strategy + analysis)**: receives "Periodic Strategy Request" and "End-of-Match Data";
returns "Adaptive Strategy JSON" and "Fight Analysis".

Flows: Create/Join Match, Join PvP Match, Player Action, PvP Action, Authoritative State Updates,
PvP State Updates, Results.

### 5b. Excalidraw architecture (earlier, Convex era)
Browser (Next.js + three.js): **MediaPipe Pose Tracking** (client-side landmarks: nose = head movement/dodge,
elbow + wrist = speed and contact) -> **Motion Engine** (jab / left hook / uppercut / direct, hit / block)
-> **Game Engine** (health, timer, opponent, KO) -> **Scene + HUD** (Blender objects, character position).
Backend: **Strategist** (live, every ~6 s), **Analysis**, **Voice Proxy** (Cartesia audio: coach / smack talk),
**Storage DB**. "Log all adaptations, maybe snapshots of why he did what he did."

**The adaptation loop** (Excalidraw "analysis loop"):
1. **Observe**: "Player uses left jab 70% of the time"
2. **Hypothesize**: "Claude predicts a left-side attack bias"
3. **Adapt**: "Opponent changes guard position"
4. **Evaluate**: "Did the player's successful hit rate decrease?"
5. **Repeat, revise, or revert**

**Coach examples** from the Excalidraw (live coaching with replies, flagged "idk if scoped well enough"):
- Coach: "You're throwing too many jabs. Mix in some body shots!" Player: "But he keeps blocking everything!"
  Coach: "He's guarding high. Try targeting his body."
- Coach: "Keep your guard up, forearms guarding your head, tuck your core in, shifted stance." Player: "Is this good?"
  Coach: "Flare out your arms a bit, you're too open."
- Excalidraw idea: instead of one-way coaching, another agent in your ear giving tips that you can reply to mid-fight.

Note: several of those example lines (body shots, form, stance) are things the current CV **cannot detect**,
so the built coach deliberately does not say them (see §8).

### 5c. What we actually built (this repo)
```
CV kit / keyboard -> input adapters -> act reducer -> SpacetimeDB fight (authoritative)
   50 ms scheduled tick runs engine.ts: timers, hit resolution, CPU bot, KO
   combat_event log -> player's browser: renderer/HUD + LiveCoach
   LiveCoach: instant rules + Claude every ~10 s (/api/coach) + offline fallback
            -> scheduler -> Cartesia/built-in voice + caption -> coach_cue table (spectators)
            -> ~10 s later "did it help?" -> coach_effect table
```

## 6. Product design (planning doc)

**Gameplay**: client-side rendering for latency, predictive landmarks for margin of error. 3D scene or 3D
character with a parallax background. CPU gets a script like normal game bots, with a Claude agent in the
background shifting its attributes.

**Screens**: Entry screen (rotating 3D boxing gloves; Convex-prize-inspired design reference: Teenage
Engineering EP-133) -> loading ("check your surroundings") -> **calibration** ("line up your arms + head
into ellipses", head and hands) -> intro -> **boxing scene** (fist view / point of view camera) ->
**results / analysis scene**. Excalidraw listed "4 pages": landing, loading/calibration, boxing, analysis.

**Pick your opponent**: pre-trained AI -> live Claude instructor, or pre-trained AI -> Mike Tyson persona prompt.

**Music/SFX**: battle soundtrack (YouTube link in planning doc), Pokemon low-HP sound at low health,
Pokemon level-up sound at end of match.

**Camera work**: dodging, going to the "Claude coach corner".

**Bot animations** (original 2006 Wii Sports Boxing style, not realistic): idle/guard (gloves near face,
subtle bounce, torso sway), left jab, right cross, left/right hook, left/right uppercut, body punch,
high block, low block, dodge left/right, lean back, duck, head hit left/right, body hit, block impact,
knockdown. Durations: jab 0.25 to 0.35 s, cross 0.35 to 0.45, hook 0.4 to 0.55, uppercut 0.45 to 0.6,
dodge 0.3 to 0.45, hit reaction 0.35 to 0.6, knockdown 0.8 to 1.3 s. Idle loop: 48 frames at 24 FPS.
Anthony has a Blender MCP prompt for generating the idle animation.

**Planned tech stack**: TypeScript + Next.js (frontend), TypeScript + Bun (backend), Google MediaPipe,
Blender, Claude, Cartesia, ~~Convex~~ SpacetimeDB. Hardware: a computer + webcam (accessibility).
`bun add three @react-three/fiber @react-three/drei`, `bun --bun dev`.

**Reference projects**: Punching Face (similar CV fighting), Oboxle (1v1 fighting), Poddle (Wii pickleball,
opponent script), HackMIT Fight Labs (coach analysis, terminal only), Blender MCP agent, low-poly modeling,
rigging and boxing arena tutorials.

**Features table (priority / owner)**:
| Feature | Priority | Who | Status in repo |
|---|---|---|---|
| Pose tracking MediaPipe controls | Required | Hani | Adapter for his kit: `input/cvKit.ts`; browser alt: `input/motion.ts` |
| 3D modeled + animated controls | Required | Anth | Not in repo |
| Local combat engine | Required | Anth | `engine/engine.ts` (runs in SpacetimeDB) |
| Claude adaptive strategist | Required | Yejia | Stub: `applyTuningPatch` + contract types |
| Visible adaptation feedback | Required | Yejia | Coach effect panel; strategist feedback not yet |
| Hand masking | Required | Hani | Not built (kit doesn't produce masks) |
| Fight data storage (Convex/SpacetimeDB) | Desired | Yejia | SpacetimeDB tables |
| Cartesia/Moss live feedback coach | Desired | Yejia | **Built**: `coach/` |
| Post analysis | Desired | anybody | Fight-end Claude wrap-up + effects; full analysis not yet |
| Cross-fight adaptive memory | Stretch | anybody | Not built |
| Live spectator screen | Idea | | Data ready (public tables); page not built |
| 3D face print, two-player, live analytics/bets | Idea / Alt | | Not built |

## 7. The contracts

### 7a. `shared/contracts.ts` (Anthony's v1 + our additive v1.1)
Original in `docs/contracts.v1.original.ts`. Sections:
1. `MotionEvent`: CV output only, no damage/hit judgment (punch with hand/punchType/speed, guard_change, dodge, tracking lost/recovered)
2. `CombatEvent`: authoritative outcomes (`attack_resolved` with exactly one resolution per attackId, round transitions, strategy applied)
3. `FightSnapshot`: live state (status, timer, player/opponent health, opponent world position, state, animation clip, stamina)
4. `PunchCounts`, `FighterStats`, `StyleEvidence` (tags: jab_heavy, hook_heavy, left/right_biased, guard_drops, unpredictable), `FightWindow`, `FightSummary` (with S to D grade, per fight)
5. `OpponentTuning`: **the only knobs Claude may change** (aggression, reaction delay never instant, guard bias/height, distance, stamina conservation, counter/feint chance, movement/punch/combo weights)
6. `StrategyRequest`: compact input to the strategist, no raw frames or full logs
7. `StrategyUpdate` + `TuningPatch`: validate, clamp, apply at a safe boundary; includes HUD-readable hypothesis, evidence, optional opponent taunt
8. `AdaptationResult`: before/after windows, improved/worsened/inconclusive, keep/adjust/revert; "correlation, not causation"
9. `CoachRequest` / `VoiceCue` / `CoachResponse`: coach sees observable state only, not hidden strategy; two personas (coach, opponent); priority + delivery (queue/interrupt/drop_if_busy)
10. `PlayerProfile`, `FightRecord`: persistence; don't embed ever-growing history arrays

v1.1 (ours, additive only): Convex -> SpacetimeDB; `Capability`; `unscorable` result + `detail: counter | guard_break`;
`guard_check` and `tracking_pause` events; window `supportedActions/unscorableCount/pausedMs`;
`CoachRequest.capabilities/playerStyle/window/fightState`; `CoachResponse.source`.

### 7b. `docs/INTEGRATION_CONTRACT.md` (CV boundary, draft v1, Oct 22)
- CV supplies positions and movement; the combat engine turns it into gameplay; the backend proposes opponent adjustments.
- The kit is **Python**. Options: Python localhost WebSocket bridge (weekend fallback) or a browser worker port. Choose early. No cloud round trip for movement.
- **Observation**: trackingState (calibrating/good/degraded/lost), per-action validity (dodge, punch_left, punch_right), markers (head = nose, left/right = wrists), `lateralDisplacementBodyWidths` (negative = player-left).
- **Events**: `dodge_left/right`, `return_neutral`, `punch_left/right` (coarse), `guard_return_left/right` (NOT a block detector). **No jab/cross/hook/uppercut, no block, no body-shot, no force classification.**
- Coordinates normalized, unmirrored; mirror preview with `1 - x`, never swap labels.
- Time: Python and browser clocks can't be subtracted; needs offset mapping.
- Lifecycle: start only after calibration + fresh observation; new calibration/session clears state.
- Lost/stale tracking: pause the fight, 250 ms freshness budget, require fresh neutral before resuming, never treat invalid time as a failed dodge.
- Adapter rules: dedupe by (sessionId, eventId), ordered event buffer, no backlog punch replay after reconnect.
- Dodges need **state** (held lean), not just edge events.
- Report "left-hand attempts" until jab classification exists; don't turn "70% left jab" into a CV fact.
- Coach: only observable, supported statistics. No body-shot, form or strength feedback.
- Kickoff decisions: browser port vs Python bridge (and who builds it), enable coarse punches now or dodge-first, what "hand masking" means (camera cutouts vs tracked 3D gloves), who owns aggregator/collision/pause/clock alignment.

## 8. Decisions made in the build sessions

1. **SpacetimeDB owns the fight** (not client-side 60 fps state). Matches the team diagram and the track criteria.
   The player's own windup animation plays instantly (client prediction) and the server row corrects it.
2. **MVP first**: game engine without AI, 3-hour target. Then the live coach was added on top.
3. **One deterministic engine** (`engine/engine.ts`, seeded RNG) runs inside the SpacetimeDB module; also usable in the browser.
4. **Capability-gated coaching**: CV kit = `punch_coarse, dodge, lean`; keyboard = `punch_types, guard, dodge, lean`.
   Coach rules and Claude output are filtered so they never mention undetectable signals.
5. **Two-speed coach**: instant local rules + Claude strategic tip every ~10 s + offline fallback (coach never goes silent).
   Claude model default `claude-haiku-5-5` for latency, forced tool call `give_coaching`, max 18 words.
6. **"Did it help?"** measured as `AdaptationResult` per tip, shown on results, stored in `coach_effect`.
7. One-way spoken coaching for now; player voice replies (speech-to-text) cut for scope.
8. Combat rules: timing rock-paper-scissors. Jab 120 ms / cross 200 / hook 260 (dodge the matching side) /
   uppercut 320 (breaks guard). Counter = hit during windup x1.5. CPU reaction 230 ms. 90 s round, KO or decision.
   Balance sim: random masher wins ~48%, fights ~19 s.

## 9. Status

**Built and tested** (44 bun tests + SpacetimeDB module tests through the real reducers):
engine, coach (rules, scheduler, Claude route, offline coach, effects, Cartesia TTS route, browser audio),
CV kit adapter, browser MediaPipe classifier, keyboard, SpacetimeDB module with coach tables, Next.js
route files, playable arena with the coach (`dev/arena.html`, `bun dev/server.ts`).

**Not built yet**:
- Next.js app scaffold, Three.js scene with Anthony's Blender character, mapping fight rows to animation clips
- Calibration screen, entry/loading/results pages, music
- **Ringside spectator page** (phone): subscribe to `fight`, `combat_event`, `coach_cue`; show stats + latest coach line / adaptation
- Claude **strategist** (OpponentTuning patches through a reducer, visible "Claude adapted: ..." HUD), Excalidraw loop
- Opponent taunts (second Cartesia voice, `persona: "opponent"`)
- Python CV bridge (WebSocket) feeding `input/cvKit.ts`
- Persistent player profile, cross-fight memory, PvP lobby
- `src/game/fightClient.ts` not yet typechecked against generated bindings (needs the `spacetime` CLI)

## 10. Demo we're aiming for

Judge stands in front of the webcam, calibrates, fights Claude Tyson. Coach voice calls out a pattern
("You're all left hand, throw the right"), the judge adapts, the results screen shows the improvement.
Meanwhile a phone ringside screen shows the live fight and every coach line through SpacetimeDB.
Keyboard fallback is ready if venue lighting breaks pose tracking.

Submission checklist: Devpost draft Saturday night; README with how SpacetimeDB is core (and Cartesia
features + limitations if entering that track); no API keys in the repo; 2-minute demo-first pitch;
whole team at the table 10:30 AM Sunday.
