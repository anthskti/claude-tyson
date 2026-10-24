/**
 * Claude Tyson — shared wire contracts, v1.
 * Framework-independent TypeScript; import into Next.js and Convex.
 * Numbers with suffix 01 must be validated/clamped to [0, 1] at runtime.
 * atMs/windowStartMs/windowEndMs are elapsed milliseconds since the fight started,
 * NOT Unix timestamps. Wall-clock fields explicitly end in UnixMs.
 * Motion-event left/right: player anatomical side. Combat hand: attacker anatomical side.
 * Guard bias: player-viewpoint attack lane. Movement direction: opponent-local view.
 * This file defines compile-time types; validate untrusted API/model input at runtime.
 */

export type Side = "left" | "right";
export type Normalized01 = number; // [0,1], runtime-validated
export type SignedBias = number; // [-1,1], runtime-validated
export type FightId = string;
export type PlayerId = string;
export type StrategyId = string;
export type EventId = string;
export type Fighter = "player" | "opponent";
export type FightStatus = "waiting" | "calibrating" | "active" | "break" | "finished";
export type PunchType = "jab" | "cross" | "hook" | "uppercut";
export type TargetZone = "head" | "body";
export type ComboId = "jab_cross" | "double_jab" | "jab_hook" | "hook_uppercut";
export type InputSource = "pose" | "keyboard" | "replay";

interface FightStamped {
  schemaVersion: 1;
  fightId: FightId;
  roundIndex: number; // zero-based
  atMs: number; // monotonic elapsed time since fight start
}

/** 1) CV output. NO damage or hit judgment here. Emit only state changes/attacks. */
interface MotionBase extends FightStamped {
  eventId: EventId;
  source: InputSource;
  confidence01: Normalized01;
  trackingQuality01: Normalized01;
}

export type MotionEvent =
  | (MotionBase & {
      kind: "punch";
      hand: Side; // player's anatomical hand
      punchType: PunchType;
      speed01: Normalized01; // calibrated coarse/relative speed; NOT m/s
      reach01?: Normalized01;
      wrist?: { x01: number; y01: number }; // webcam normalized frame coords
    })
  | (MotionBase & {
      kind: "guard_change";
      guard: "up" | "down";
    })
  | (MotionBase & {
      kind: "dodge";
      direction: "left" | "right" | "duck";
      magnitude01?: Normalized01;
    })
  | (MotionBase & {
      kind: "tracking";
      state: "lost" | "recovered";
    });

/** 2) Authoritative game events; resolved by the LOCAL fight engine. */
export type CombatEvent =
  | (FightStamped & {
      kind: "attack_resolved";
      eventId: EventId;
      attackId: EventId; // exactly ONE resolution for each attack
      inputEventId?: EventId; // links player attack to MotionEvent
      attacker: Fighter;
      punchType: PunchType;
      hand: Side; // attacker's anatomical left/right
      target: TargetZone;
      result: "hit" | "blocked" | "dodged" | "missed";
      damage: number; // 0 for non-hit outcomes
      defenderHealthAfter: number;
    })
  | (FightStamped & {
      kind: "round_transition";
      phase: "started" | "ended";
      reason?: "timer" | "knockout" | "forfeit";
    })
  | (FightStamped & {
      kind: "strategy_applied";
      strategyId: StrategyId;
      priorStrategyId?: StrategyId;
    });

/** 3) Live game state. In memory at 60fps; publish sparse snapshots to Convex only if needed. */
export interface FightSnapshot extends FightStamped {
  status: FightStatus;
  roundTimeRemainingMs: number;
  player: { health: number; maxHealth: number; tracking: "ok" | "lost" };
  opponent: {
    health: number;
    maxHealth: number;
    worldX: number; // Three.js world units, not pixels
    worldZ: number;
    state: "idle" | "stepping" | "attacking" | "blocking" | "dodging" | "stunned" | "ko";
    animation: string; // current glTF clip name; runtime must validate availability
    stamina01: Normalized01;
    activeStrategyId?: StrategyId;
  };
}

/** 4) Aggregated analytics. Counting is based on unique attackId, never frame samples. */
export interface PunchCounts {
  attempted: number;
  landed: number;
  blocked: number;
  dodged: number;
  missed: number;
  damage: number;
}

export interface FighterStats {
  punches: Record<PunchType, PunchCounts>;
  leftAttempts: number;
  rightAttempts: number;
  headHits: number;
  bodyHits: number;
  blocksAttempted: number;
  successfulBlocks: number;
  dodgesAttempted: number;
  successfulDodges: number;
  damageDealt: number;
  damageTaken: number;
  longestCombo: number;
  averageInterPunchMs?: number;
  // Calculate overall accuracy as total landed / total attempted (null when 0).
}

export interface StyleEvidence {
  tags: Array<"jab_heavy" | "hook_heavy" | "left_biased" | "right_biased" | "guard_drops" | "unpredictable">;
  leftAttackShare01?: Normalized01;
  jabShare01?: Normalized01;
  guardDropAfterPunchRate01?: Normalized01; // only if guard is trackable
  repeatedCombo?: ComboId;
  confidence01: Normalized01;
}

export interface FightWindow {
  windowStartMs: number;
  windowEndMs: number;
  player: FighterStats;
  opponent: FighterStats;
  playerStyle: StyleEvidence;
  opponentStyle?: StyleEvidence; // inferred from observed scripted behavior
  motionEventsCount: number;
  resolvedAttacksCount: number;
  trackingQuality01: Normalized01;
}

export interface FightSummary extends FightStamped {
  scope: "window" | "round" | "fight";
  window: FightWindow;
  playerHealthRemaining: number;
  opponentHealthRemaining: number;
  winner?: Fighter | "draw";
  scoreGrade?: "S" | "A" | "B" | "C" | "D"; // per-fight, not intrinsic player skill
}

/** 5) Runtime behavior configuration. This is the only set of knobs Claude can modify. */
export interface OpponentTuning {
  aggression01: Normalized01;
  reactionDelayMs: number; // bounded: never instantaneous perfect counters
  guardBias: SignedBias; // -1: defend PLAYER-left attacks; +1: PLAYER-right; 0 neutral
  guardHeight01: Normalized01; // 0 body-focused, 1 head-focused
  preferredDistance: number; // Three.js world units
  staminaConservation01: Normalized01;
  counterAttackChance01: Normalized01;
  feintChance01: Normalized01;
  movementWeights: {
    approach: number;
    retreat: number;
    circleLeft: number;
    circleRight: number;
  }; // nonnegative; normalize to sum=1 before use
  punchWeights: Record<PunchType, number>; // nonnegative; normalize to sum=1
  comboWeights: Partial<Record<ComboId, number>>; // allowlisted combos only
}

export interface HistoricalMatch {
  style: StyleEvidence;
  strategy: Pick<OpponentTuning, "guardBias" | "guardHeight01" | "counterAttackChance01">;
  sampleSize: number;
  observedChangeInPlayerHitRate: number; // signed; correlation, not causation
}

/** 6) Compact input to the Convex action / Claude strategist. No raw frames or full event logs. */
export interface StrategyRequest {
  schemaVersion: 1;
  requestId: string;
  fightId: FightId;
  roundIndex: number;
  requestedAtMs: number;
  reason: "periodic" | "round_start" | "player_pattern_changed";
  activeStrategyId?: StrategyId;
  currentTuning: OpponentTuning;
  currentWindow: FightWindow;
  previousWindow?: FightWindow;
  recentEvents: CombatEvent[]; // e.g. last <= 12, truncated at request builder
  recentAdaptations: AdaptationResult[]; // e.g. last <= 3
  historicalMatches?: HistoricalMatch[]; // optional future feature; <= 3
  availableCombos: ComboId[];

/** Partial patches mean Claude needn't resend 20 unchanged fields every cycle. */
export type TuningPatch = Partial<Omit<OpponentTuning, "movementWeights" | "punchWeights" | "comboWeights">> & {
  movementWeights?: Partial<OpponentTuning["movementWeights"]>;
  punchWeights?: Partial<OpponentTuning["punchWeights"]>;
  comboWeights?: Partial<OpponentTuning["comboWeights"]>;
};

/** 7) Claude strategist output: validate, clamp, then apply at a safe game-state boundary. */
export interface StrategyUpdate {
  schemaVersion: 1;
  requestId: string; // caller correlates response, rejects stale responses
  strategyId: StrategyId;
  basedOnWindowEndMs: number;
  hypothesis: {
    label: string; // HUD-readable, e.g. "Repeated left jabs"
    evidence: string[]; // concise data-backed observations
    confidence01: Normalized01;
  };
  tuningPatch: TuningPatch;
  preferredCombo?: ComboId;
  validForMs: number;
  reasonForChange: string;
  opponentTaunt?: string; // optional separate Cartesia voice cue
}

/** 8) Re-evaluate in the next matched time window; don't claim causal proof. */
export interface AdaptationResult {
  schemaVersion: 1;
  fightId: FightId;
  strategyId: StrategyId;
  appliedAtMs: number;
  evaluatedAtMs: number;
  before: {
    durationMs: number;
    playerAttempts: number;
    playerHitRate01: Normalized01 | null;
    damageToOpponent: number;
  };
  after: {
    durationMs: number;
    playerAttempts: number;
    playerHitRate01: Normalized01 | null;
    damageToOpponent: number;
  };
  outcome: "improved" | "worsened" | "inconclusive";
  confidence01: Normalized01; // weak if windows contain few punches
  nextDecision: "keep" | "adjust" | "revert";
  notes?: string;
}

/** 9) Two different voices and permissions. Coach sees observable game state, not hidden private strategy. */
export interface CoachRequest {
  schemaVersion: 1;
  requestId: string;
  fightId: FightId;
  atMs: number;
  trigger: "proactive" | "player_question" | "round_break" | "fight_end";
  transcript?: string; // STT text only for question requests; never store mic audio by default
  followUpToCueId?: string; // links a question to the coach line that prompted it
  player: FighterStats;
  opponent: FighterStats;
  observableOpponent: {
    guardHeight01: Normalized01;
    recentPunches: PunchType[];
    perceivedOpenings: TargetZone[];
  };
  previousCoachLines: string[]; // small bounded history for non-repetition
}

export interface VoiceCue {
  cueId: string;
  fightId: FightId;
  atMs: number;
  persona: "coach" | "opponent";
  trigger: "proactive" | "player_question" | "adaptation" | "round_break" | "fight_end";
  text: string; // both caption and Cartesia speech source
  priority: "low" | "normal" | "urgent";
  delivery: "queue" | "interrupt" | "drop_if_busy";
  voiceId: string; // configured Cartesia voice identifier; not an auth secret
  cooldownMs: number;
}

export interface CoachResponse {
  schemaVersion: 1;
  requestId: string;
  advice: string;
  referencedEvidence: string[];
  cue?: VoiceCue;
  suggestedTactic?: "attack_head" | "attack_body" | "mix_punches" | "defend" | "change_rhythm";
}

/** 10) Persist in Convex. Do NOT embed ever-growing battleHistory arrays in a player doc. */
export interface PlayerProfile {
  playerId: PlayerId;
  displayName: string;
  avatarStorageId?: string; // only if player opts in; no face photo required
  createdAtUnixMs: number;
  totalFights: number;
  wins: number;
  losses: number;
  draws: number;
  bestGrade?: FightSummary["scoreGrade"];
  latestStyle?: StyleEvidence;
}

export interface FightRecord {
  fightId: FightId;
  playerId?: PlayerId; // guest matches allowed
  nicknameAtFight: string;
  status: FightStatus;
  startedAtUnixMs: number;
  endedAtUnixMs?: number;
  roundCount: number;
  winner?: Fighter | "draw";
  finalSummary?: FightSummary;
  gameBuildVersion: string;
  calibrationVersion: string;
  opponentConfigVersion: string;
  // List history by querying/indexing FightRecord.playerId, not via player.battleHistory[].
}
