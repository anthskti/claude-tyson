// Copies the in-browser CV runtime into public/cv/ before dev and build: the MediaPipe
// tasks-vision WASM from node_modules and the two models from cv-mvp/models, checked
// against their known hashes. Paths are versioned so they can be cached forever.
// public/cv/ is generated; it is gitignored.

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CV_ASSETS } from '../src/game/cv/local/assets';

const root = join(import.meta.dir, '..');
const out = join(root, 'public', CV_ASSETS.root);

const MODELS: Record<string, { file: string; sha256: string }> = {
  [CV_ASSETS.pose]: { file: 'pose_landmarker_lite.task', sha256: '59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a' },
  [CV_ASSETS.hand]: { file: 'hand_landmarker.task', sha256: 'fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1' },
};

rmSync(join(root, 'public', 'cv'), { recursive: true, force: true });
mkdirSync(join(out, 'models'), { recursive: true });

const wasm = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
if (!existsSync(wasm)) throw new Error('Missing @mediapipe/tasks-vision; run bun install');
cpSync(wasm, join(out, CV_ASSETS.wasm), { recursive: true });

for (const [target, { file, sha256 }] of Object.entries(MODELS)) {
  const bytes = readFileSync(join(root, 'cv-mvp', 'models', file));
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== sha256) throw new Error(`${file} hash ${actual} does not match ${sha256}`);
  cpSync(join(root, 'cv-mvp', 'models', file), join(out, target));
}

console.log(`cv assets -> public/${CV_ASSETS.root}`);
