import type { CvSample, FightStamped, MotionEvent } from './contracts';
export interface SampleDelivery {
  sample: CvSample; events: MotionEvent[]; canScore: boolean; mappedSampleMs: number | null;
  latency: null | { sampleToReceiveMs: number; readToResultMs: number | null;
    producerToReceiveMs: number | null; clockUncertaintyMs: number };
}
export function validateSample(sample: unknown): sample is CvSample;
export class CvProvider {
  constructor(options?: { url?: string; freshnessMs?: number; allowTestInput?: boolean;
    onSample?: (value: SampleDelivery) => void; onState?: (state: string) => void; onReset?: (reason: string) => void });
  connect(context: FightStamped): Promise<unknown>;
  mapTime(ms: number): number | null;
  resetCalibration(): Promise<unknown>;
  close(): void;
}
