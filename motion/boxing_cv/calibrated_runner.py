"""Bounded live JSONL reader extracted from the experiment harness."""
import os, json, hashlib, time
from pathlib import Path
class SampleTail:
    """Follow only NEW rows; preserve every sample, bounded IO, partial-line safe."""
    def __init__(self, path):
        self.path = Path(path)
        self.file = self.path.open('rb')
        self.file.seek(0, 2)
        self.offset = self.file.tell()
        self.discard_partial = False
        if self.offset:
            self.file.seek(-1, 2)
            self.discard_partial = self.file.read(1) != b'\n'
        self.pending = b''
        self.identity = (self.path.stat().st_dev, self.path.stat().st_ino)

    def poll(self):
        stat = self.path.stat()
        if (stat.st_dev, stat.st_ino) != self.identity or stat.st_size < self.file.tell():
            raise RuntimeError('Motion log replaced/truncated. Restart with a fresh calibration.')
        data = self.file.read(256*1024)
        lines = (self.pending+data).split(b'\n')
        self.pending = lines.pop()
        if self.discard_partial and lines:
            lines.pop(0)
            self.discard_partial = False
        if len(data) == 256*1024 or len(self.pending) > 256*1024:
            raise RuntimeError('Motion reader fell behind/oversize row. Restart; do not replay a backlog live.')
        rows = []
        for line in lines:
            if line.strip():
                try:
                    row = json.loads(line)
                    # Non-finite external numbers must not break strict audit JSON.
                    json.dumps(row, allow_nan=False)
                    rows.append(row)
                except (ValueError, UnicodeError):
                    rows.append(dict(kind='invalid', state='malformed_or_nonfinite'))
        return rows

    def close(self):
        self.file.close()

    def snapshot(self, destination):
        """Archive original collector bytes after the sensor worker has stopped.

        The collector may keep appending. Read only the size captured at open;
        record the cutoff and any partial final row instead of altering its data.
        """
        destination = Path(destination)
        with self.path.open('rb') as source:
            stat = os.fstat(source.fileno())
            if (stat.st_dev, stat.st_ino) != self.identity or stat.st_size < self.file.tell():
                raise RuntimeError('Collector source changed; cannot archive the original motion log')
            size, remaining = stat.st_size, stat.st_size
            digest = hashlib.sha256()
            last_byte = b''
            with destination.open('xb') as target:
                while remaining:
                    chunk = source.read(min(1024*1024, remaining))
                    if not chunk:
                        raise RuntimeError('Collector source truncated during archival')
                    target.write(chunk)
                    digest.update(chunk)
                    last_byte = chunk[-1:]
                    remaining -= len(chunk)
        info = dict(sourcePath=str(self.path.resolve()), snapshotBytes=size, sha256=digest.hexdigest(),
                    readerStartByteOffset=self.offset, readerEndByteOffset=self.file.tell(),
                    snapshotUnixMs=time.time()*1000, finalRowComplete=not size or last_byte == b'\n',
                    content='Original collector bytes from file start through captured EOF; includes samples before this experiment joined the stream')
        destination.with_name('collector-motion.manifest.json').write_text(json.dumps(info, indent=2)+'\n')
        return info
