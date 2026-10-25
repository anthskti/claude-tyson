// Deterministic source ZIP with only an explicit set of redistributable files.
// No shell zip/Python dependency on the Vercel builder, no local logs/signing files.
import { readFileSync, readdirSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of data) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function sourceFiles(root: string): string[] {
  const files = ['motion/companion.py','motion/requirements.txt','scripts/setup-motion-companion.sh',
    'scripts/run-motion-companion.sh','docs/HOSTED_MOTION.md','assets/mediapipe/README.md','assets/mediapipe/pose_landmarker_lite.task'];
  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (['build','runs','__pycache__','xcuserdata'].includes(entry.name) || entry.isSymbolicLink()) continue;
      const name = join(path, entry.name);
      if (entry.isDirectory()) walk(name);
      else if (/\.(py|swift|plist|pbxproj|xcscheme|sh|json|pt)$/.test(name) && !name.includes('DualCollector')) files.push(relative(root,name));
    }
  };
  for (const folder of ['motion/boxing_cv','motion/collectors','motion/models']) walk(join(root,folder));
  return files.sort();
}

export function makeZip(files: { name: string; bytes: Buffer }[]): Buffer {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from('motion-companion/'+file.name);
    const compressed = deflateRawSync(file.bytes);
    const crc = crc32(file.bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20,4);
    header.writeUInt16LE(8,8); header.writeUInt16LE(33,12); // deflate, Jan 1 1980
    header.writeUInt32LE(crc,14); header.writeUInt32LE(compressed.length,18);
    header.writeUInt32LE(file.bytes.length,22); header.writeUInt16LE(name.length,26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20,4); directory.writeUInt16LE(20,6);
    directory.writeUInt16LE(8,10); directory.writeUInt16LE(33,14);
    directory.writeUInt32LE(crc,16); directory.writeUInt32LE(compressed.length,20);
    directory.writeUInt32LE(file.bytes.length,24); directory.writeUInt16LE(name.length,28);
    directory.writeUInt32LE(offset,42);
    local.push(header,name,compressed); central.push(directory,name);
    offset += header.length+name.length+compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length,8); end.writeUInt16LE(files.length,10);
  end.writeUInt32LE(directory.length,12); end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,directory,end]);
}

if (import.meta.main) {
  const root = resolve(import.meta.dir,'..');
  const files = sourceFiles(root).map(name => {
    if (!lstatSync(join(root,name)).isFile()) throw new Error('Not a regular package file: '+name);
    return { name, bytes: readFileSync(join(root,name)) };
  });
  const zip = makeZip(files), out=join(root,'public/downloads');
  mkdirSync(out,{recursive:true}); writeFileSync(join(out,'motion-companion.zip'),zip);
  writeFileSync(join(out,'motion-companion.sha256'), createHash('sha256').update(zip).digest('hex')+'  motion-companion.zip\n');
  console.log(`Companion: ${files.length} source/model files, ${zip.length} bytes`);
}
