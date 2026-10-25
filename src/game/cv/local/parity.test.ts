// Frame-by-frame parity with the Python detector. Fixtures come from
// cv-mvp/scripts/export_parity_fixtures.py (cv-mvp branch): landmark input and the
// adapter's exact output. Regenerate them after any detector change on either side.

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { CvAdapter } from './adapter';
import { GAME_CONFIG, HARNESS_CONFIG } from './config';
import type { LandmarkFrame } from './features';

const DIR = join(import.meta.dir, 'fixtures');
const CONFIGS = { 'harness-timing': HARNESS_CONFIG };

const rows = (file: string) =>
  gunzipSync(readFileSync(join(DIR, file))).toString().trim().split('\n').map(line => JSON.parse(line));

/** First difference between two JSON values, or null. Floats may differ in the last bits. */
function diff(actual: unknown, expected: unknown, path = ''): string | null {
  if (typeof expected === 'number' && typeof actual === 'number') {
    const ok = Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected));
    return ok ? null : `${path}: ${actual} != ${expected}`;
  }
  if (expected === null || typeof expected !== 'object') {
    return actual === expected ? null : `${path}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`;
  }
  if (typeof actual !== 'object' || actual === null || Array.isArray(actual) !== Array.isArray(expected)) {
    return `${path}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`;
  }
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  for (const k of keys) {
    if (!(k in actual)) return `${path}.${k}: missing`;
    if (!(k in expected)) return `${path}.${k}: unexpected`;
    const d = diff(actual[k], expected[k], `${path}.${k}`);
    if (d) return d;
  }
  return null;
}

const scenarios = readdirSync(DIR).filter(f => f.endsWith('.landmarks.jsonl.gz')).map(f => f.split('.')[0]);

describe('detector parity with cv-mvp', () => {
  test('fixtures are present', () => expect(scenarios.length).toBeGreaterThanOrEqual(6));

  for (const name of scenarios) {
    test(name, () => {
      const adapter = new CvAdapter(CONFIGS[name] ?? GAME_CONFIG, 'fixture');
      const expected = rows(`${name}.expected.jsonl.gz`);
      let i = 0;
      let events = 0;
      for (const record of rows(`${name}.landmarks.jsonl.gz`)) {
        if (record.kind === 'reset_calibration') {
          adapter.reset();
          continue;
        }
        const sample = adapter.process(record as LandmarkFrame, record.timestamp_ms);
        const actual = JSON.parse(JSON.stringify({
          timestampMs: sample.observation.timestampMs,
          observation: { ...sample.observation, timestampMs: undefined },
          events: sample.events,
          resetGeneration: sample.resetGeneration,
        }));
        const d = diff(actual, expected[i]);
        if (d) throw new Error(`${name} frame ${i} (t=${record.timestamp_ms})${d}`);
        events += sample.events.length;
        i++;
      }
      expect(i).toBe(expected.length);
      expect(events).toBeGreaterThan(0);
    });
  }
});
