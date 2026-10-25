# Claude Tyson — live game contract

This document describes the online game implemented by `spacetimedb/src/index.ts` and
`spacetimedb/src/rules.ts`. It is a design reference, not generated SpacetimeDB schema.
The standalone arena in `engine/engine.ts` is a separate prototype and currently has a
different combat model; it is not authoritative for online matches.

## Match and action vocabulary

```ts
export type MatchMode = 'bot' | 'pvp';
export type MatchStatus = 'active' | 'finished';
export type Body = 'neutral' | 'lean_left' | 'lean_right';
export type Guard = 'neutral' | 'block';
export type Hand = 'left' | 'right';
export type PunchType = 'left_straight' | 'right_straight' | 'left_hook' | 'right_hook';
export type AttackResult = 'pending' | 'landed' | 'blocked' | 'dodged' | 'unscorable' | 'cancelled';
```

Hands and directions are anatomical. The online game has four punches: left/right
straight and left/right hook. There are no uppercuts, combos, or world-position movement.
Animation clip names and keyboard bindings are client presentation/input details; they
do not change the server action vocabulary. Current keyboard bindings are J/C for left and
right straight, Q/E for left and right hook, A/D for left and right dodge, and B (held)
for a two-glove block.

## Client input to SpacetimeDB

The live client calls two reducers. It does not send a generic `MotionEvent` object to a
`submitMotion` reducer.

```ts
export interface UpdatePoseArgs {
  matchId: bigint;
  cvSessionId: string;
  calibrationId: string;
  trackingState: 'good' | 'degraded' | 'lost' | 'calibrating';
  dodgeValid: boolean;
  punchLeftValid: boolean;
  punchRightValid: boolean;
  bodyState: Body;
  leftGuard: Guard;
  rightGuard: Guard;
  lateral: number; // rendering only; clamped to [-3, 3]
}

export interface SubmitMotionEventArgs {
  matchId: bigint;
  cvSessionId: string;
  eventId: string;
  eventType: string;
  punchType: string; // '' falls back to the straight for the event's hand
}
```

`updatePose` carries continuous body, guard, validity, and tracking state. Defense is
derived from this pose; there are no separate server `block_start`, `block_end`,
`dodge_start`, or `dodge_end` reducer calls. The client submits discrete punch events
through `submitMotionEvent`; only `punch_left` and `punch_right` start attacks. A supplied
`punchType` must match the event hand. Unknown or absent punch types fall back to that
hand's straight.

The server authenticates the sender as a fighter in the active match. It deduplicates
`cvSessionId:eventId`, rejects events from an old CV session, and requires a fresh usable
pose (at most 250 ms old) when resolving attacks. Human pose is usable when tracking is
`good` or `degraded` and dodge tracking is valid. No camera frames or landmark streams
are sent to the server. The server clock controls cooldowns, attack timing, and hit
resolution; client timestamps are not authoritative.

## Authoritative combat rules

Health is stored as integer tenths: `100` means 10 HP (the starting health). Stamina is a server-owned
floating value from 0 to 200. Damage, stamina costs, startup, and recovery below are the
current first-pass tuning in `spacetimedb/src/rules.ts`.

| Punch | Damage | Startup | Recovery | Stamina |
| --- | ---: | ---: | ---: | ---: |
| Left straight | 0.5 HP | 120 ms | 220 ms | 5 |
| Right straight | 1.3 HP | 200 ms | 320 ms | 12 |
| Left hook | 1.0 HP | 220 ms | 360 ms | 16 |
| Right hook | 1.0 HP | 220 ms | 360 ms | 16 |

- Punches lock the whole fighter for the greater of the punch's recovery or startup plus
  150 ms. Either hand's punch is rejected during that lock; missed punches are discarded
  rather than buffered.
- Block requires both gloves to be raised and neither punch recovery lock to be active.
  It starts protecting after 80 ms, blocks straights, and does not stop hooks. It drains
  4 stamina per second and ends when stamina is exhausted or after a maximum 2 seconds.
  Releasing block starts a 300 ms defense cooldown. A block timed out at 2 seconds stays
  locked until the player releases it. One raised glove does not stop punches from
  landing, but still prevents the fighter from starting a punch until lowered.
- A dodge costs 20 stamina and starts protecting after 100 ms. Dodges avoid all straights
  and the same-side hook. The opposite-side hook lands for 1.5 times base damage. The
  dodge protection window is 350 ms; holding the pose does not extend that window. A
  dodge may remain visually held until release, with a 2 second maximum, and has a
  260 ms cooldown after release.
- Block and dodge cannot start while another action/recovery lock is active or switch
  directly into each other. The server is authoritative; late or invalid requests do not
  create a queued action.
- Stamina regenerates at 18 per second when not actively blocking, dodging, or under a
  punch recovery lock. Punches require enough stamina to pay their listed cost.
- A successful dodge opens a 700 ms counter window. Attacks inside it are marked as
  counters, and the bot favors a straight counter. The current resolver does not apply a
  separate counter damage multiplier.
- A match starts at 10 HP and lasts 30 seconds. Reaching zero health ends it immediately by KO; otherwise
  the higher-health fighter wins the decision. KO is terminal.
- If the defender's pose is unusable at impact, the attack is `unscorable` and causes no
  damage. Unscorable attacks are excluded from fight statistics.

The client pauses defense animation clips at authored points (`Hard_Block` at 0.33 s,
`Left_Dodge` and `Right_Dodge` at 0.25 s). Those visual pauses do not change server
startup, active windows, maximum holds, or cooldowns.

## Bot strategy

The server creates bot attacks and resolves them through the same punch and damage rules
as player attacks. Bot defense is selected at attack impact. Strategy updates are accepted
only for the current revision and a fight window belonging to that match; values are
clamped server-side. Aggression is `[0, 1]`, punch interval is 600–4000 ms, punch weights
are individually clamped to `[0, 1]`, left bias is `[0, 1]`, defense rate is `[0, 0.8]`,
and telegraph time is 350–1200 ms. Text explanation is limited to 500 characters.

The strategy/schema still carries an `uppercutWeight` field for compatibility, but the
current online bot selects only the four supported straight and hook actions. There is
no separate `BotBalance`, `PlayerStyle`, or `Analysis` table in the current module; the
analysis text is stored on `fight_result` and the profile stores aggregate counters.

## Hosted AirPod companion adapter

Native motion is a local input provider for the hosted game; the reducers above are unchanged.
`motion/` publishes contractVersion 1 `cv_sample` packets over loopback. One canonical
`sessionId` covers pose plus both hand streams; unique native event IDs survive mapping.
Punch classes are full anatomical names. IMU hand validity is independent of webcam
wrist visibility; Pose determines dodge validity. AirPod guards are always neutral.
Locally, `onsetMs` and `qualityScore` may be null (unknown physical onset / uncalibrated
model confidence); neither is added to reducer arguments. The browser submits only
classified events and pose state, never raw sensor vectors or landmarks. See
[the hosted integration contract and setup](docs/HOSTED_MOTION.md).
An optional rawImu array carries bounded fresh API readings to the same browser only.
It is diagnostic data and must never be forwarded to reducers. Website origin and
per-run pairing token are checked before a hosted page receives any samples.
