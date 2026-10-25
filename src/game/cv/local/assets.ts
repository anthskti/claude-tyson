// Where scripts/cv-assets.ts puts the CV runtime under public/, and where the worker
// loads it from. TASKS_VISION_VERSION must match the pinned @mediapipe/tasks-vision
// (assets.test.ts checks); model names carry their hash prefix so paths never go stale.

export const TASKS_VISION_VERSION = '0.10.21';

export const CV_ASSETS = {
  root: `cv/${TASKS_VISION_VERSION}`,
  wasm: 'wasm',
  pose: 'models/pose_landmarker_lite-59929e1d.task',
  hand: 'models/hand_landmarker-fbc2a300.task',
};
