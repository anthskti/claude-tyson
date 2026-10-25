import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TASKS_VISION_VERSION } from './assets';

test('asset paths track the pinned tasks-vision version', () => {
  const root = join(import.meta.dir, '..', '..', '..', '..');
  const installed = JSON.parse(readFileSync(join(root, 'node_modules/@mediapipe/tasks-vision/package.json'), 'utf8'));
  const pinned = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies['@mediapipe/tasks-vision'];
  expect(installed.version).toBe(TASKS_VISION_VERSION);
  expect(pinned).toBe(TASKS_VISION_VERSION);
});
