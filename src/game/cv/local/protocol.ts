// Messages between the page and a CV worker (worker.ts).

import type { HandRecord, Landmark } from './features';
import type { Delegate, ModelKind } from './inference';

export type WorkerRequest =
  | { kind: 'init'; model: ModelKind; base: string; delegate: Delegate }
  | { kind: 'frame'; bitmap: ImageBitmap; timestampMs: number }
  | { kind: 'close' };

export type WorkerReply =
  | { kind: 'ready'; delegate: Delegate }
  | { kind: 'error'; message: string }
  | { kind: 'landmarks'; timestampMs: number; ms: number; pose?: Landmark[]; hands?: HandRecord[] };
