// Independent 2D hand and body measurements; inferred z never gates scoring.
// Port of cv-mvp core/features.py.

import type { DetectorConfig } from './config';

export type Side = 'left' | 'right';
export const SIDES: Side[] = ['left', 'right'];
const PALM = [0, 5, 9, 13, 17];

/** A MediaPipe landmark in normalized, canonical (unmirrored) image coordinates. */
export interface Landmark {
  x: number;
  y: number;
  z?: number;
  visibility?: number;
  presence?: number;
}

export interface HandRecord {
  landmarks: Landmark[];
  model_handedness: string;
  handedness_score: number;
}

/** One inference result, in the same shape cv-mvp's Inference.process returns. */
export interface LandmarkFrame {
  kind?: 'frame';
  timestamp_ms: number;
  width: number;
  height: number;
  pose: Landmark[];
  hands: HandRecord[];
}

export interface HandFeature {
  x: number;
  y: number;
  size: number;
  marker: { x: number; y: number };
  handednessScore: number;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function pointOk(p: Landmark, threshold = 0): boolean {
  return ['x', 'y'].every(k => finite(p[k]) && p[k] >= 0 && p[k] <= 1)
    && ['visibility', 'presence'].every(k => {
      const v = p[k] ?? 0;
      return finite(v) && v >= threshold;
    });
}

/**
 * Tasks handedness names are retained as anatomical sides on canonical input. No
 * index-based identity and no Pose dependency. Duplicate side assignments are rejected
 * rather than joining two people's/hands' motion histories.
 */
export function handFeatures(record: LandmarkFrame, cfg: DetectorConfig) {
  const aspect = record.height / record.width;
  const candidates: Record<Side, HandRecord[]> = { left: [], right: [] };
  let unknown = false;
  for (const hand of record.hands ?? []) {
    const side = String(hand.model_handedness ?? '').toLowerCase();
    if (side === 'left' || side === 'right') candidates[side].push(hand);
    else unknown = true;
  }
  const result: Partial<Record<Side, HandFeature>> = {};
  const reasons: Partial<Record<Side, string>> = {};
  for (const side of SIDES) {
    const hands = candidates[side];
    let reason = unknown ? 'Ambiguous handedness' : !hands.length ? 'No hand detected' : null;
    if (hands.length > 1) reason = 'Duplicate handedness assignment';
    if (reason) {
      reasons[side] = reason;
      continue;
    }
    const hand = hands[0];
    const score = hand.handedness_score ?? 0;
    if (!finite(score) || score < cfg.min_handedness_score) {
      reasons[side] = 'Handedness uncertain';
      continue;
    }
    const pts = hand.landmarks ?? [];
    if (pts.length < 18 || !PALM.every(i => pointOk(pts[i]))) {
      reasons[side] = 'Palm points missing, invalid or outside image';
      continue;
    }
    const distance = (a: Landmark, b: Landmark) => Math.hypot(a.x - b.x, aspect * (a.y - b.y));
    let squares = 0;
    for (const i of PALM.slice(1)) squares += distance(pts[0], pts[i]) ** 2;
    const size = Math.sqrt((squares + distance(pts[5], pts[17]) ** 2) / 5);
    if (size < 1e-5) {
      reasons[side] = 'Palm size too small to measure';
      continue;
    }
    let cx = 0;
    let cy = 0;
    for (const i of PALM) cx += pts[i].x;
    for (const i of PALM) cy += pts[i].y;
    const center = { x: cx / PALM.length, y: cy / PALM.length };
    result[side] = { x: center.x, y: aspect * center.y, size, marker: center, handednessScore: score };
  }
  return { hands: result, reasons };
}

export function bodyFeatures(record: LandmarkFrame, cfg: DetectorConfig) {
  const pose = record.pose ?? [];
  if (pose.length !== 33 || ![0, 11, 12].every(i => pointOk(pose[i], cfg.min_visibility))) {
    return { body: null, reason: 'Head/shoulders unavailable' };
  }
  const aspect = record.height / record.width;
  const width = Math.hypot(pose[11].x - pose[12].x, aspect * (pose[11].y - pose[12].y));
  if (!(cfg.min_body_width <= width && width <= cfg.max_body_width)) {
    return { body: null, reason: 'Body framing outside supported range' };
  }
  if (pose[11].x <= pose[12].x) return { body: null, reason: 'Face camera; check input orientation' };
  return { body: { head: pose[0], scale: width }, reason: null };
}
