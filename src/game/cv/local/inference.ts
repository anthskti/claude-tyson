// MediaPipe Tasks in the browser: pixels in, landmarks in the same shape cv-mvp's
// Inference.process returns (core/inference.py). Same models and options; all punch and
// dodge interpretation stays in the detector. Each CV worker runs one model, so pose and
// hands run in parallel like cv-mvp's `parallel` schedule.

import { FilesetResolver, HandLandmarker, PoseLandmarker, type NormalizedLandmark } from '@mediapipe/tasks-vision';
import { CV_ASSETS } from './assets';
import type { HandRecord, Landmark } from './features';

export type Delegate = 'GPU' | 'CPU';
export type ModelKind = 'pose' | 'hands';
export type Landmarks = { pose: Landmark[] } | { hands: HandRecord[] };

// The web landmarks carry visibility but not presence. Like Python's hand points, a
// missing field is a placeholder 1.0, so pose gating rests on visibility alone.
const posePoint = (p: NormalizedLandmark): Landmark => ({ x: p.x, y: p.y, z: p.z, visibility: p.visibility ?? 1, presence: 1 });
const handPoint = (p: NormalizedLandmark): Landmark => ({ x: p.x, y: p.y, z: p.z, visibility: 1, presence: 1 });

export class BrowserLandmarker {
  private constructor(
    private task: PoseLandmarker | HandLandmarker,
    readonly model: ModelKind,
    readonly delegate: Delegate,
  ) {}

  /** GPU when WebGL2 works in this worker, otherwise CPU. */
  static async create(model: ModelKind, base: string, prefer: Delegate = 'GPU'): Promise<BrowserLandmarker> {
    const fileset = await FilesetResolver.forVisionTasks(`${base}/${CV_ASSETS.wasm}`);
    const make = async (delegate: Delegate) => {
      const canvas = delegate === 'GPU' ? new OffscreenCanvas(1, 1) : undefined;
      const task = model === 'pose'
        ? await PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: `${base}/${CV_ASSETS.pose}`, delegate },
          canvas, runningMode: 'VIDEO', numPoses: 1,
          minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5, outputSegmentationMasks: false,
        })
        : await HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: `${base}/${CV_ASSETS.hand}`, delegate },
          canvas, runningMode: 'VIDEO', numHands: 2,
          minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
        });
      return new BrowserLandmarker(task, model, delegate);
    };
    if (prefer === 'CPU' || typeof OffscreenCanvas === 'undefined') return make('CPU');
    try {
      return await make('GPU');
    } catch {
      return make('CPU');
    }
  }

  /** Timestamps must strictly increase (VIDEO mode carries tracking history). */
  process(image: ImageBitmap, timestampMs: number): Landmarks {
    if (this.task instanceof PoseLandmarker) {
      return { pose: this.task.detectForVideo(image, timestampMs).landmarks[0]?.map(posePoint) ?? [] };
    }
    const h = this.task.detectForVideo(image, timestampMs);
    return {
      hands: h.landmarks.map((points, i) => ({
        landmarks: points.map(handPoint),
        model_handedness: h.handedness[i]?.[0]?.categoryName ?? '',
        handedness_score: h.handedness[i]?.[0]?.score ?? 0,
      })),
    };
  }

  close() {
    this.task.close();
  }
}
