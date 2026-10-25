// A CV worker: runs one MediaPipe model (pose or hands) on camera frames and returns
// its landmarks. The page runs one of each and merges them for the detector. One frame
// at a time; frames stay in this worker and are closed after inference.

import { BrowserLandmarker } from './inference';
import type { WorkerReply, WorkerRequest } from './protocol';

let landmarker: BrowserLandmarker | null = null;

const reply = (msg: WorkerReply) => postMessage(msg);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.kind === 'init') {
    try {
      landmarker = await BrowserLandmarker.create(msg.model, msg.base, msg.delegate);
      reply({ kind: 'ready', delegate: landmarker.delegate });
    } catch (err) {
      reply({ kind: 'error', message: message(err) });
    }
  } else if (msg.kind === 'frame') {
    try {
      if (!landmarker) return;
      const start = performance.now();
      const landmarks = landmarker.process(msg.bitmap, msg.timestampMs);
      reply({ kind: 'landmarks', timestampMs: msg.timestampMs, ms: performance.now() - start, ...landmarks });
    } catch (err) {
      reply({ kind: 'error', message: message(err) });
    } finally {
      msg.bitmap.close();
    }
  } else if (msg.kind === 'close') {
    landmarker?.close();
    landmarker = null;
    close();
  }
};
