// Types mirroring INTEGRATION_CONTRACT.md §2 and §4. These describe what Hani's CV
// provider emits; the game must not depend on anything beyond these fields.

export type TrackingState = 'calibrating' | 'good' | 'degraded' | 'lost';

// ── Proposed extension (not produced by the CV kit yet) ──────────────────────
// The kit only reports lateral displacement and coarse punch_left/right. These
// optional fields carry richer classification once CV supports it; when absent the
// game falls back to lateral thresholds and an 'unclassified' punch.
export type Body = 'neutral' | 'lean_left' | 'lean_right';
export type Guard = 'neutral' | 'block';
export type PunchType = 'left_straight' | 'right_straight' | 'left_hook' | 'right_hook';

export interface PoseState {
  body: Body;
  guards: { left: Guard; right: Guard };
}

export interface Marker {
  x: number; // normalized, unmirrored image coords, 0..1
  y: number;
}

export interface Observation {
  schemaVersion: 1;
  kind: 'observation';
  sessionId: string;
  timestampMs: number;
  availableMs: number;
  trackingState: TrackingState;
  validity: { dodge: boolean; punch_left: boolean; punch_right: boolean };
  calibrationId: string | null;
  markers: { head?: Marker; left?: Marker; right?: Marker };
  features: { lateralDisplacementBodyWidths?: number; [k: string]: unknown };
  qualityScore: number;
  reason?: string;
  pose?: PoseState; // proposed extension
}

export type MotionEventType =
  | 'dodge_left'
  | 'dodge_right'
  | 'return_neutral'
  | 'punch_left'
  | 'punch_right'
  | 'guard_return_left'
  | 'guard_return_right';

export interface MotionEvent {
  schemaVersion: 1;
  eventId: string;
  sessionId: string;
  type: MotionEventType;
  onsetMs: number;
  sampleMs: number;
  detectedMs: number;
  sideConvention: 'player_anatomical';
  trackingState: TrackingState;
  qualityScore: number;
  qualityKind: string;
  calibrationId: string | null;
  experimental: boolean;
  features?: Record<string, unknown>;
  punchType?: PunchType; // only on punch_left / punch_right; hand and name must agree
}

export interface CvSample {
  contractVersion: 1;
  kind: 'cv_sample';
  fightId: string;
  roundId: string;
  seq: number;
  source: 'live' | 'replay' | 'synthetic';
  observation: Observation;
  events: MotionEvent[];
}

const SLIP_THRESHOLD_BODY_WIDTHS = 0.35;

/** Pose for gameplay: the CV's classification if present, else derived from lateral. */
export function poseOf(obs: Observation): PoseState {
  if (obs.pose) return obs.pose;
  const lateral = obs.features.lateralDisplacementBodyWidths ?? 0;
  const body: Body =
    lateral <= -SLIP_THRESHOLD_BODY_WIDTHS ? 'lean_left' : lateral >= SLIP_THRESHOLD_BODY_WIDTHS ? 'lean_right' : 'neutral';
  return { body, guards: { left: 'neutral', right: 'neutral' } };
}

// The frontend boundary every CV implementation (Python bridge, browser worker,
// or the keyboard simulator) plugs into.
export interface CvProvider {
  readonly source: CvSample['source'];
  start(onSample: (observation: Observation, events: MotionEvent[]) => void): void;
  stop(): void;
}
