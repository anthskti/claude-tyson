// The detector's output in the CV wire contract's observation/event shape, the same
// samples the Python bridge streams as cv_sample. Port of cv-mvp adapter.py.

import { GAME_CONFIG, PUNCH_TYPE_CONFIG, type DetectorConfig, type PunchTypeConfig } from './config';
import { Detector, type MotionEvent } from './detector';
import type { LandmarkFrame } from './features';
import { PunchTyper } from './punchType';

const EVENT_TYPES = ['punch_left', 'punch_right', 'dodge_left', 'dodge_right', 'return_neutral'];

export type LocalTrackingState = 'good' | 'degraded' | 'calibrating' | 'lost';

export interface LocalObservation {
  timestampMs: number;
  trackingState: LocalTrackingState;
  validity: { dodge: boolean; punch_left: boolean; punch_right: boolean };
  calibrationId: string | null;
  markers: { head?: { x: number; y: number }; left?: { x: number; y: number }; right?: { x: number; y: number } };
  features: Record<string, unknown>;
  reason: string | null;
  phases: Record<string, string>;
  punchReadiness: Record<string, string>;
  dodgeReadiness: Record<string, unknown>;
}

export interface LocalSample {
  observation: LocalObservation;
  events: MotionEvent[];
  resetGeneration: number;
}

const inImage = (p: { x: number; y: number }) =>
  [p.x, p.y].every(v => Number.isFinite(v) && v >= 0 && v <= 1);

export class CvAdapter {
  readonly detector: Detector;
  readonly punchTyper: PunchTyper;
  resetGeneration = 0;

  constructor(config: DetectorConfig = GAME_CONFIG, sessionId?: string, punchConfig: PunchTypeConfig = PUNCH_TYPE_CONFIG) {
    this.detector = new Detector(config, sessionId);
    this.punchTyper = new PunchTyper(punchConfig, this.detector.cfg);
  }

  reset() {
    this.detector.resetCalibration();
    this.punchTyper.reset();
    this.resetGeneration += 1;
  }

  process(record: LandmarkFrame, availableMs?: number): LocalSample {
    const [native, coreEvents] = this.detector.process(record, availableMs);
    // punchType on punch events (unclear ones held a few frames), plus flat hooks the
    // core rule misses.
    const nativeEvents = this.punchTyper.process(record, coreEvents, this.detector, availableMs);
    const valid = {
      dodge: !!native.validity.dodge,
      punch_left: !!native.validity.punch_left,
      punch_right: !!native.validity.punch_right,
    };
    const values = Object.values(valid);
    const state: LocalTrackingState = values.every(Boolean) ? 'good'
      : values.some(Boolean) ? 'degraded'
      : native.dodgeReadiness.state === 'warming' ? 'calibrating' : 'lost';
    // Contract markers are wrists, while the detector's hand marker is a palm center.
    const markers: LocalObservation['markers'] = {};
    const head = native.markers.head;
    if (valid.dodge && head && inImage(head)) markers.head = { x: head.x, y: head.y };
    for (const side of ['left', 'right'] as const) {
      if (!valid[`punch_${side}`]) continue;
      const hs = (record.hands ?? []).filter(h => String(h.model_handedness ?? '').toLowerCase() === side);
      if (hs.length !== 1) continue;
      const wrist = hs[0].landmarks[0];
      if (inImage(wrist)) markers[side] = { x: wrist.x, y: wrist.y };
    }
    const events = nativeEvents.map(e => {
      if (!EVENT_TYPES.includes(e.type)) throw new Error('Unsupported detector event');
      return { ...e, schemaVersion: 1, trackingState: state, confidence: null, resetGeneration: this.resetGeneration };
    });
    return {
      observation: {
        timestampMs: record.timestamp_ms,
        trackingState: state,
        validity: valid,
        calibrationId: native.calibrationId,
        markers,
        features: native.features,
        reason: state === 'good' ? null : ((native.dodgeReadiness.reason as string) ?? null),
        phases: native.phases,
        punchReadiness: native.punchReadiness,
        dodgeReadiness: native.dodgeReadiness,
      },
      events,
      resetGeneration: this.resetGeneration,
    };
  }
}
