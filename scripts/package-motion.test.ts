import { expect, test } from 'bun:test';
import { crc32, makeZip, sourceFiles } from './package-motion';
import { resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';

test('source download excludes fast weights, recordings, environments and signing products', () => {
  const files=sourceFiles(resolve(import.meta.dir,'..'));
  expect(files).toContain('motion/companion.py');
  expect(files).toContain('motion/models/airpod-left-outward-v1/weights.pt');
  expect(files).toContain('motion/models/airpod-right-outward-v1/weights.pt');
  expect(files).toContain('motion/collectors/iphone/AirPodUSBCollector/CollectorApp.swift');
  expect(files.some(p => /fast-v1|\.venv|\/runs\/|\/build\/|xcuserdata|pairing\.private|\.mobileprovision|\.p12/.test(p))).toBeFalse();
});

test('ZIP entries have correct CRC, deflate payload and deterministic output', () => {
  expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  const file={name:'readme.txt',bytes:Buffer.from('hello companion')};
  const zip=makeZip([file]);
  expect(zip.equals(makeZip([file]))).toBeTrue();
  expect(zip.readUInt32LE(0)).toBe(0x04034b50);
  const length=zip.readUInt16LE(26), compressed=zip.readUInt32LE(18);
  expect(zip.subarray(30,30+length).toString()).toBe('motion-companion/readme.txt');
  expect(inflateRawSync(zip.subarray(30+length,30+length+compressed)).equals(file.bytes)).toBeTrue();
  expect(zip.readUInt32LE(zip.length-22)).toBe(0x06054b50);
});
