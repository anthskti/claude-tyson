# CLAUDE TYSON
## Combat Rules & Adaptive Sparring Bot — Gameplay Specification
**Draft v1 · 24 October 2026**  
**Scope:** Gameplay mechanics, combat adjudication, scripted bot behavior, and Claude-adjustable tactics. This is intentionally **not** a software architecture, feature catalog, pipeline, or implementation workflow.

> **Status legend:** **Agreed** = established in the current discussion contracts. **Proposed** = suggested deterministic rule or starting tuning value that needs testing. All timing numbers below are initial tuning suggestions, not previously agreed requirements.

## 1. Design intent
The game is a short, readable boxing duel with stationary fighters. There is no walking, distancing, circling, or arena positioning in the MVP. Players attack with recognized left/right punches, defend by blocking, and dodge by moving their nose relative to their shoulders. An adaptive opponent should feel like a fair sparring partner: challenging, interpretable, imperfect, and progressively aware of the player's habits. A match can also be human versus human; **the rules are identical** regardless of controller.

**Agreed:** Client vision classifies actions; combat outcomes are authoritative; match histories and player styles are persistent; knockout is terminal; there is no live coach, uppercut, combo system, or preset difficulty selection. **Proposed:** Balance should focus on timing and move choices, never secretly inflating per-punch damage.

## 2. Move vocabulary and intended matchups

| Action / animation | Meaning in the game | Damage or interaction | Status |
|---|---|---|---|
| Idle / guard | Default stance with subtle in-place stepping animation (not actual movement) | No damage | Agreed |
| Hard head block | A raised guard protecting the head | Negates valid head hits while active; limited duration to avoid holding forever | Agreed / limit proposed |
| Dodge left | Nose shifts to the fighter's anatomical left relative to shoulder center | Avoids either straight and left hook; vulnerable to right hook | Agreed |
| Dodge right | Nose shifts to anatomical right | Avoids either straight and right hook; vulnerable to left hook | Agreed |
| Left straight | Faster, lower-cost straight attack | 0.5 base damage (provisional) | Proposed balance |
| Right straight | Slower, more demanding straight attack | 1.3 base damage (provisional) | Proposed balance |
| Left hook | Slower swinging punch | 1.0 base damage; beats block; 0 vs left dodge; 1.5× vs right dodge | Proposed balance |
| Right hook | Slower swinging punch | 1.0 base damage; beats block; 0 vs right dodge; 1.5× vs left dodge | Proposed balance |
| Hit reaction | Brief stagger when a hit lands | Temporarily prevents new actions | Proposed timing |
| Knockout | Full fall; does not stand up | End of combat, plays exactly once | Agreed |

**Proposed rock-paper-scissors loop:** block beats straights, hooks beat block, and dodge beats straights plus the hook on its own side. The opposite-side hook catches a dodge for **1.5×** damage. This makes block the cheap, reliable answer to straight pressure, while dodge costs more but can evade either straight. Hooks are the costly answer to passive blocking, but their directional dodge counterplay remains. Hook base damage and all multipliers are provisional. **No uppercut or combo logic in the MVP.**

### Resolution truth table (provided defender is in an active dodge window)

| Incoming attack | No defense | Dodge left | Dodge right | Active head block |
|---|---|---|---|---|
| Left straight | Base 0.5* | 0 — dodged | 0 — dodged | 0 — blocked |
| Right straight | Base 1.3* | 0 — dodged | 0 — dodged | 0 — blocked |
| Left hook | Base 1.0* | 0 — dodged | 1.5× — hit | Base — hook beats block |
| Right hook | Base 1.0* | 1.5× — hit | 0 — dodged | Base — hook beats block |

*All damage values are provisional starting values. Hook-vs-block could instead deal reduced chip damage if full hook damage makes blocking feel useless; playtest this before locking it. If no valid hit opportunity exists, the result is `missed`, not `hit`. Block and dodge are mutually exclusive; reject conflicting starts.*

### Stamina (proposed first pass)
Use a server-owned **100 point** stamina pool. Stamina limits repeated high-value actions, while punch type—not measured webcam speed—determines damage. First implementation values: left straight **5**, right straight **12**, either hook **16**, dodge **20**. Holding block drains **4 points/second** after its 80 ms startup, with a 900 ms maximum duration and 300 ms release cooldown. Dodge has a 100 ms startup, 250 ms active window, and 260 ms release cooldown. Regenerate **12 points/second** while idle. These remain starting values for playtesting.

At insufficient stamina, reject the action; don't silently weaken a punch or allow negative stamina. The current reducer rejects it without a client-facing reason, so feedback remains follow-up work. Do not charge again for duplicate inputs. Ensure a player can always recover: regeneration continues while idle, and reaching zero does not disable movement-independent defense forever. Dodge is deliberately costly because it avoids straights; block remains the economical defense, but a hook can punish a held block. Tune costs and regeneration before adding exhaustion damage or speed penalties.

## 3. Combat timing and action legality
Gameplay must be judged in discrete server time, independently of which animation has completed rendering. Each move follows **startup → active window → recovery**. A hit only resolves once, at its scheduled impact window. Both humans and bots obey the same timing rules. A client may render immediately for responsiveness, but cannot award damage, declare a dodge successful, or issue a knockout.

**Proposed first-pass timing (tune after playtesting):**

| Move | Startup | Active | Recovery | Notes |
|---|---:|---:|---:|---|
| Left straight | 120 ms | 100 ms | 220 ms | Fast and low cost |
| Right straight | 200 ms | 100 ms | 320 ms | Slower, more stamina, more damage |
| Left/right hook | 220 ms | 120 ms | 360 ms | Slower, directional punish |
| Dodge left/right | 100 ms | 250 ms | 260 ms | Dodge window must overlap impact |
| Block | 80 ms | Up to 900 ms | 300 ms | Low stamina drain; hooks beat it |
| Hit stagger | — | — | 250 ms | Cancels/restricts attacks according to one consistent policy |

Those timings are provisional constants under balancing review. The first server implementation resolves each punch once at its scheduled startup impact; a sustained active hit window is not implemented yet. Avoid reapplying a new action during recovery. Track action identity so one attack cannot deal damage twice. Reject impossible state transitions and repeated block/dodge starts. A tracking-loss event prevents **new** human attacks while tracking is unreliable; an unscorable in-flight attack is excluded from the result statistics.

**Proposed deterministic priority for an impact:** (1) match already finished → ignore; (2) defender already knocked out → ignore; (3) valid active block → `blocked`; (4) valid active dodge → lookup matchup; (5) otherwise hit if attack valid, else `missed`. The rule above makes a block more protective than a dodge when both would somehow overlap; the cleaner option is to enforce mutually exclusive defensive states so that case never occurs. Fix this rule before coding tests.

### Knockouts
At health ≤ 0, clamp health to zero, emit a single match finish reason `knockout`, lock further actions, and play the full KO animation only once. There is **no standing eight-count, revive, or second round** in the MVP. The other fighter may play a victory pose later, but it is not required.

### Timeouts and ties
**Proposed:** A short timed bout ends when its countdown reaches zero. Higher remaining health wins; exact equality is a draw. Do not create a knockout just because a timer expires. The v4 contracts allow `timeout`, `forfeit`, and `disconnect` termination reasons; exact grace periods are not yet decided.

## 4. Motion recognition and combat input quality
**Agreed:** MediaPipe is the only input mechanism for the current MVP. Recognition runs on visible head, shoulder, and hand landmarks and creates discrete action changes, rather than treating every camera frame as an attack. Directions refer to the **fighter's anatomical left/right** regardless of mirrored selfie preview.

**Proposed recognition criteria:** Use a calibrated neutral shoulder width and shoulder-center reference. A left dodge happens when the nose moves sufficiently left relative to shoulder center **with a meaningful torso-relative displacement**. Requiring stable confidence over multiple frames reduces jitter. Return to near-neutral before a subsequent dodge counts. Track `dodge_start` and `dodge_end`; do not award a dodge simply because the head is permanently tilted to one side. The shoulder-relative offset signed range is distinct from normalized bot tuning: signed direction may be negative or positive while confidence/magnitude remains [0,1].

**Input failure behavior:** If MediaPipe loses reliable tracking, publish tracking loss, ignore newly inferred attacks, and show a neutral status indication. Already accepted actions and a finished bout remain authoritative. Do not send raw image frames, per-frame landmark histories, or client-reported damage to determine hits.

**Punch classification:** Recognize left straight, right straight, left hook, and right hook only. Keep classification simple and consistent; reject uncertain punches instead of incorrectly turning ambiguous movement into high-damage hooks. **Recommendation for speed/power:** use wrist speed only as a local recognition threshold; don't send client-reported speed or use it to multiply damage. Webcam distance, frame rate, and tracking noise make speed a poor authority signal. Keep power fixed by punch type on the server. The implemented contract has no speed field. Left/right naming is anatomical; the MVP assumes left straight is quicker and lighter and right straight is slower and stronger.

## 5. Deterministic scripted opponent (works without Claude)
The bot is a real combat participant, not an animation playlist. It observes the current combat situation, selects legal actions, and commits to startup/active/recovery just like a human. The script remains fully playable even when Claude has not responded, is disabled, or produces invalid output.

### Decision principles
1. **Legal actions first.** Never schedule a punch during KO, stun, recovery, or after the match ends; no overlapping incompatible block/dodge/attack states.
2. **React with delay.** The bot must not instant-read attacks. Its reaction delay creates a human-like chance to be caught.
3. **Weighted choices, not random chaos.** Aggression, defense chances, punch weights, tactical bias, and a small random element guide decisions.
4. **Respect openings.** A recently failed enemy attack can raise counter preference, but only if the bot is free to act.
5. **Be fallible.** Sometimes wait, choose the wrong dodge, block prematurely, or fail to punish a predictable move.
6. **Avoid repeated robotic loops.** Introduce bounded timing jitter and discourage the same punch dominating indefinitely without erasing Claude's selected preference.

### Suggested decision sketch (behavioral pseudocode)
```text
if match finished or bot KO: do nothing
if bot stunned/recovering: wait until legal
if imminent threat:
    after reaction delay, choose block or directional dodge
    based on bounded defensive rates and tactical biases
else if recently saw enemy recovery and counter roll succeeds:
    choose weighted legal punch
else if attack opportunity and aggression roll succeeds:
    choose weighted legal punch
else:
    stay in idle/guard for a bounded pause
```

This is **not a promise that the bot can predict an unseen punch**. Threat awareness is limited to observable/accepted match events and the configured reaction delay. Different reaction rolls should not create multiple defensive actions for one threat.

### Default weights and bounded human imperfections (proposed)
- Punch selection: left straight 45%, right straight 30%, left hook 12.5%, right hook 12.5% before normalization.
- Favor short pauses rather than constant punching; attack cadence can rise with aggression.
- Reaction delay starting band: **250–650 ms**, subject to playtesting and CV input latency. Do not drop to zero.
- Block / dodge / counter probability fields live in [0,1]; successful outcomes are **not guaranteed** even when the action is chosen.
- Tactical `guardBias` and `dodgeBias` live in [-1,1], with negative/positive interpreted as consistent anatomical directional preferences.

## 6. Claude's job: adapt tactics, not adjudicate combat
Claude is a **strategist**, never a hit referee. It may update the bot's tactical tendencies, but not the rules. A strategy is a bounded recommendation and may be delayed, stale, or rejected without interrupting the bout.

**Claude may suggest:**
- `punchWeights` for left straight, right straight, left hook, right hook.
- `guardBias` in [-1,1] to cover the player's habitual attack lane.
- `dodgeBias` in [-1,1] to favor left/right defense.
- `counterPreference01` in [0,1] to reward punishing predictable attacking patterns.

**Claude must not set:** health, damage, knockout, hit result, timing truth, fighter state, winner, secret difficulty level, or unrestricted reaction time. It must not introduce uppercuts, footwork, combos, or moves the player cannot perform.

### Example strategic interpretation
- A player overuses left straights → increase defensive attention toward that attack and counter frequency, within limits.
- A player repeatedly dodges right → prefer **left hook**, since a left hook lands for 1.5× against a right dodge.
- A player repeatedly dodges left → prefer **right hook**, for the symmetric matchup.
- A player blocks frequently → vary approach timing and attack choice; **do not hallucinate an unblockable uppercut**.
- A player mixes attacks unpredictably → avoid extreme biases and retain defensive balance.

### Example Claude-adjustable strategy
```json
{
  "hypothesis": "Player dodges right after straight punches",
  "confidence01": 0.78,
  "patch": {
    "punchWeights": { "left_hook": 0.42, "left_straight": 0.28 },
    "dodgeBias": -0.15,
    "counterPreference01": 0.62
  },
  "validForMs": 6000
}
```
Partial punch weights must be merged with the current values, clamped, and normalized before the bot uses them. The example only illustrates a tactical update, not an authoritative combat decision. Strategy IDs, request IDs, schema versions, and stale-response rejection remain required by v4.

### Adaptation stability
**Proposed:** Update tactics no faster than every ~5 seconds when there is enough new combat evidence. Ignore windows with too few observed actions, stale results, or low-confidence tracking. Smooth changes so tactics are recognizable but not jerky. Never let a failed Claude call pause the game. Retain a valid prior tactic or the default script.

## 7. Adaptive challenge — no Easy / Medium / Hard
The bot should aim to feel like an approximately equal sparring partner. **Its strategy and challenge are different variables.** Claude chooses the tactical approach; deterministic balancing adjusts how hard that approach is to execute.

**Agreed:** No user-visible difficulty selector, no uncontrolled AI adjustment of damage, and no perfectly reactive opponent. Use a hidden, rolling player skill estimate plus observable recent performance. **Proposed:** Preserve a target competitive band rather than forcing a strict 50% win rate each match, which can feel manipulated.

### Practical balancing rules
- When the player consistently dominates, gradually shorten bot reaction delay within its allowed range; increase willingness to attempt legal counters or attacks.
- When the player consistently struggles, gradually increase bot reaction delay and reduce offensive pressure.
- If players are evenly matched, avoid changing numbers purely for the sake of changing them.
- Do not modify base damage to manufacture closeness.
- Make bounded changes at defined observation intervals, not in response to a single lucky punch.
- Never rewrite the outcome of an accepted hit or punish a player retroactively.

**Proposed initial clamps:** reaction delay 250–650 ms; `aggression01`, `blockChance01`, `dodgeChance01`, and `counterChance01` within [0.10, 0.85] unless intentionally overridden by a designer; maximum normalized adjustment around 0.05 per observation window. These numbers are **tuning hypotheses**, not confirmed balance values. Some chance fields may reasonably need a true zero for debugging.

### Fairness guardrails
Do not let strategy and difficulty both independently multiply the same offensive propensity without a cap. Preserve a minimum idle/readability interval so the bot doesn't spam. If the player stops moving or tracking becomes unreliable, do not interpret zero attacks as proof of low skill. Reduce confidence in the skill estimate rather than aggressively lowering difficulty.

## 8. Player memory and post-fight coaching
A fighter's identity is keyed by an immutable `playerId`, not their nickname. Every completed match can contribute **validated aggregates** to that player's long-term style profile. Keep raw combat history available for replay/diagnostics if desired, but do not ask Claude to ingest entire lifetime event logs for each match.

**Current persistent style dimensions:** left/right straight shares, left/right hook shares, dodge direction, block rate, hit rate, confidence, sample matches, and readable behavioral tags. Updates should be sample-size-aware so one unusual match doesn't redefine a player's identity.

**Post-fight analysis** is the only user-facing commentary in the MVP. It should identify concrete strengths, specific weaknesses, and a single next-session focus, all grounded in counts or observed comparisons. Avoid saying a behavior caused an outcome when only correlation was observed. PvP can produce a separate analysis for each participant. No mid-fight coach or spoken commentary.

## 9. Edge cases and acceptance criteria
These are gameplay invariants to verify before visual polish:

| Scenario | Required behavior |
|---|---|
| Duplicate attack submission | Never apply damage twice for the same accepted attack |
| Rapid repeated motion samples | At most one action for a physical gesture; cooldown applies |
| Dodge begins after impact | Does not retroactively avoid the hit |
| Both fighters hit at the same instant | Consistent resolution order; define whether double KO is a draw (open choice) |
| Block is held continuously | Forced expiration or guard limit; can't be permanent immunity |
| Left dodge vs left hook | 0 damage if dodge active at impact |
| Left dodge vs right hook | 1.5× hook base if attack otherwise connects |
| Right dodge vs right hook | 0 damage if dodge active at impact |
| Right dodge vs left hook | 1.5× hook base if attack otherwise connects |
| Either dodge vs straight punches | 0 damage if dodge active at impact |
| Knockout occurs | Health zero, one KO transition, no more inputs accepted |
| Claude stalls or sends invalid weights | Continue fighting under last valid/default tactics |
| Tracking lost midfight | No new inferred actions accepted; accepted events remain valid |
| Bot raises difficulty | Never bypasses fixed hit rules, cooldowns, or damage values |
| PvP instead of bot | Exactly the same damage/defense/KO rules |

## 10. Decisions not yet locked
1. **Damage and matchup values:** implementation starts at left straight 0.5, right straight 1.3, hooks 1.0, opposite-dodge hook multiplier 1.5, and hooks deal base damage through block. Confirm with playtesting.
2. **Frame/timing numbers:** all startup, active, recovery, and block limits above are starting suggestions.
3. **Simultaneous double KO:** choose draw or fixed ordering; avoid arbitrary network-order wins.
4. **Hook vs block:** this draft proposes hooks beat block, while straights are fully blocked. Test whether hooks should deal full damage or reduced chip through block.
5. **Match timer and timeout winner rule:** confirm duration and whether remaining health or percentage determines win.
6. **CV thresholds:** calibrate on real people and lighting; no threshold value is established yet.
7. **Bot balance clamps:** validate against responsiveness and fun; don't treat example bounds as settled facts.

## 11. Suggested implementation order
Keep the first pass small and tune from playtests:

1. **Authoritative combat:** the SpacetimeDB rules and reducers now use the four-punch vocabulary, server damage, stamina, and defense timing. Tune values through playtests.
2. **Input and security:** action membership, duplicate IDs, tracking status, and stamina are checked server-side. Per-connection sequence ordering and explicit action-rejection feedback still need work.
3. **Real camera recognition:** the online page still uses `SimulatedCvProvider`; connect a MediaPipe provider through `src/game/cv/contract.ts` and classify only the four supported punches plus dodge/block/tracking.
4. **Bot and profile polish:** bot attacks use the shared damage/defense resolver, but its defense is still a simple random response and strategy weights keep some legacy field names. Refine after human input is connected.
5. **Tune:** verify match isolation and simultaneous impacts, then playtest damage, stamina, timing, and dodge thresholds in the browser. No new dependency or environment variable is required for the current code changes.

**Primary blast radius:** shared `CONTRACTS.md`, SpacetimeDB combat and reducers, generated bindings, CV/input adapter, and game client rendering. Risks to resolve during implementation include deterministic simultaneous-hit ordering, tracking loss during an accepted attack, and keeping all state isolated by match ID. `docs/PROJECT_CONTEXT.md` referenced by the planning workflow is absent in this checkout; `CLAUDE.md` and the current source were used instead.

---
**Guiding rule:** Claude can choose *what the bot tries*. The fixed combat rules decide *what actually happens*. The balancing script adjusts *how formidable the bot feels*, within fair and visible gameplay constraints.
