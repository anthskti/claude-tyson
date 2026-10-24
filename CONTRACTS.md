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
// Straights and hooks are named by anatomical hand. Left/right straight are distinct
// moves; they do not expose jab/cross as gameplay action names.
export type PunchType = "left_straight" | "right_straight" | "left_hook" | "right_hook";
export type FightAction =
| { kind: "punch"; punch: PunchType; speed01?: number }
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
state: "idle" | "attacking" | "blocking" | "dodging" | "hit" | "ko";
stateStartedAtUnixMs: number;
dodgeDirection?: "left" | "right";
tracking: "ok" | "lost"; // AI always ok.
activeAction?: FightAction;
