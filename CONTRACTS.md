- Claude Tyson — shared contracts v3 (TypeScript shapes, NOT SpacetimeDB schema).
- Browser: MediaPipe Pose/Hands -> classification -> MotionEvent -> submitMotion.
- SpacetimeDB: authenticates sender, translates inputs to FightAction, resolves combat,
- stores matches/events/results and publishes authoritative state.
- Claude: adjusts tactical weights inside server limits; no live coach or combos.
-
- Directions and hands use the fighter's ANATOMICAL left/right, not mirrored video.
- Numbers suffixed 01 mean [0,1], Bias values [-1,1]; validate at runtime.
- Client timestamps are diagnostic only; server timestamps decide hit windows.
  \*/

export type MatchStatus = "waiting" | "ready" | "active" | "finished" | "cancelled";
export type MatchMode = "pvp" | "adaptive_bot";
// Straights and hooks are named by anatomical hand; left/right straight are distinct moves.
export type PunchType = "left_straight" | "right_straight" | "left_hook" | "right_hook";
export type FightAction =
| { kind: "punch"; punch: PunchType }
| { kind: "block_start" }
| { kind: "block_end" }
| { kind: "dodge_start"; direction: "left" | "right" }
| { kind: "dodge_end" };

// Identity & matchmaking -------------------------------------------------------
export interface PlayerProfile {
playerId: string; // Immutable stable ID; NEVER use displayName as PK.
displayName: string;
createdAtUnixMs: number;
matchesPlayed: number;
wins: number;
losses: number;
draws: number;
skillEstimate01: number; // Server-calculated, hidden from difficulty selection.
learnedStyle: PlayerStyle; // Rolling aggregate across matches.
}

export interface Match {
matchId: string;
mode: MatchMode;
status: MatchStatus;
fighterAPlayerId: string;
fighterBPlayerId?: string; // null/omitted for AI.
botId?: "claude_tyson"; // Present only for adaptive_bot.
createdAtUnixMs: number;
startedAtUnixMs?: number;
endedAtUnixMs?: number;
durationMs: number;
winner?: "a" | "b" | "draw";
endReason?: "knockout" | "timeout" | "forfeit" | "disconnect";
}

export interface CreateMatchRequest { mode: MatchMode }

// Local CV output -> authoritative game action --------------------------------
/\*\*

- MediaPipe detects landmarks locally; client classifier emits a discrete action.
- No raw webcam frames and no per-frame landmark streams sent to the server.
- Client never submits damage, winner, fighter slot, or hit decisions.
  \*/
  export interface MotionEvent {
  schemaVersion: 3;
  matchId: string;
  inputId: string; // Dedup retry ID; unique per connection.
  sequence: number; // Increasing for this connection.
  clientAtMs: number; // Diagnostics only; not authoritative for hits.
  source: "mediapipe";
  confidence01: number;
  trackingQuality01: number;
  kind: "action" | "tracking";
  action?: FightAction; // Required when kind === action; runtime-check.
  tracking?: "lost" | "recovered"; // Required when kind === tracking.
  dodgeEvidence?: {
  method: "nose_relative_to_shoulders";
  offsetShoulderWidths: number; // Signed, anatomical left < 0, right > 0.
  magnitude01: number;
  }; // Only allowed for dodge_start; do not use as server hit verdict.
  }

/\*_ Internal-only bot input. Exactly the same action vocabulary as human input. _/
export interface BotAction {
matchId: string;
botSlot: "b";
action: FightAction;
}

// Server-owned combat state ----------------------------------------------------
export interface FighterState {
matchId: string;
slot: "a" | "b"; // Composite identity (matchId, slot).
playerId?: string; // absent for bot.
health: number;
maxHealth: number;
stamina: number; // Server-owned, 0..100; damage uses fixed punch values.
state: "idle" | "attacking" | "blocking" | "dodging" | "hit" | "ko";
stateStartedAtUnixMs: number;
dodgeDirection?: "left" | "right";
tracking: "ok" | "lost"; // AI always ok.
activeAction?: FightAction;
}

// First-pass authoritative tuning. SpacetimeDB stores health and damage in
// tenths of one health point (1000 health = 100.0 HP).
export const COMBAT_RULES = {
  maxHealth: 1000,
  maxStamina: 100,
  staminaRegenPerSec: 12,
  blockDrainPerSec: 4,
  dodgeCost: 20,
  punchDamage: { left_straight: 5, right_straight: 13, left_hook: 10, right_hook: 10 },
  punchStamina: { left_straight: 5, right_straight: 12, left_hook: 16, right_hook: 16 },
  oppositeHookVsDodgeMultiplier: 1.5,
} as const;

// One-action-at-a-time rule (server time is authoritative): a fighter can only
// punch, block, or dodge when no other action or recovery lock is active.
// Discrete punch events received while locked are discarded, not buffered.
// Block/dodge remain active until released, with a 2s maximum hold; after that
// the server ends the defense and applies its cooldown. A continuous pose may
// start a defense only on a later update when its request is still valid.

// Block stops straights and hooks beat block. Either dodge avoids straights and
// its same-side hook. The opposite-side hook catches the dodge at 1.5x base.
// Timing values remain provisional and live in spacetimedb/src/rules.ts.
