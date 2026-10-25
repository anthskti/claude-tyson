/** Concrete MVP definitions derived from the team's conceptual proposal. */
export interface FightStamped { fightId: string; roundId: string }
export type MotionType = 'punch_left' | 'punch_right' | 'dodge_left' | 'dodge_right' | 'return_neutral';
export type TrackingState = 'calibrating' | 'good' | 'degraded' | 'lost';
export interface MotionBase {
  confidence: null; // No calibrated classifier confidence exists.
  qualityScore: null;
  qualityKind: 'not_estimated';
  trackingState: TrackingState;
}
export interface MotionEvent extends MotionBase {
  schemaVersion: 1; eventId: string; sessionId: string; type: MotionType;
  onsetMs: number; sampleMs: number; detectedMs: number;
  sideConvention: 'player_anatomical'; calibrationId: string | null;
  experimental: boolean; resetGeneration: number; features: Record<string, unknown>;
}
export interface CvObservation extends MotionBase {
  schemaVersion: 1; kind: 'observation'; sessionId: string;
  timestampMs: number; availableMs: number; calibrationId: string | null;
  validity: { dodge: boolean; punch_left: boolean; punch_right: boolean };
  markers: Partial<Record<'head' | 'left' | 'right', { x: number; y: number }>>;
  features: { lateralDisplacementBodyWidths?: number; [key: string]: unknown };
  reason: string | null;
}
export interface CvSample extends FightStamped {
  contractVersion: 1; kind: 'cv_sample'; seq: number; source: 'live' | 'replay' | 'synthetic';
  observation: CvObservation; events: MotionEvent[];
  batch: { firstSeq: number; lastSeq: number; coalescedObservations: number };
  trace: {
    clock: 'producer_monotonic_ms'; captureReadMs?: number;
    inferenceStartMs?: number; inferenceEndMs?: number;
    detectionEndMs?: number; enqueuedMs?: number; sentMs?: number;
    readToResultMs?: number; liveLatencyMeasurable: boolean;
    [key: string]: unknown;
  };
  producer: { detector: 'recent_hand_motion'; nativeSchemaVersion: 2;
    resetGeneration: number; coordinateSpace: 'canonical_unmirrored_image' };
}
/** A movement command for a SpacetimeDB reducer; it is never a CombatEvent. */
export interface PlayerAction extends FightStamped {
  movementId: string; motion: MotionEvent; source: CvSample['source'];
  /** Preserve producer time; map/validate again at the authoritative boundary. */
  clientSampleMs: number | null;
}
export function toPlayerActions(sample: CvSample, mappedSampleMs: (ms: number) => number | null): PlayerAction[] {
  return sample.events.map(motion => ({ fightId: sample.fightId, roundId: sample.roundId,
    movementId: motion.eventId, motion, source: sample.source, clientSampleMs: mappedSampleMs(motion.sampleMs) }));
}
