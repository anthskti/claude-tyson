"""Download versioned Google model assets; never invoked implicitly by the runner."""
import argparse
import hashlib
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
# Versioned model URLs identify the exact Google model binaries being tested.
# Pose Lite/Full change model cost; hands is a separate additional model.
ASSETS = {
    'pose_landmarker_lite.task': 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
    'pose_landmarker_full.task': 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
    'hand_landmarker.task': 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--output', type=Path, default=ROOT/'models')
    a = p.parse_args()
    a.output.mkdir(parents=True, exist_ok=True)
    manifest_path = ROOT/'models'/'manifest.json'
    # Use the checked-in manifest hashes as integrity references when available.
    pinned = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    manifest = {}
    for name, url in ASSETS.items():
        path = a.output/name
        if not path.exists():
            # Write a .part file first. Rename only after download and hash verification,
            # so interrupted transfers cannot leave a seemingly complete model file.
            tmp = path.with_suffix('.part')
            try:
                with urllib.request.urlopen(url, timeout=60) as response, tmp.open('wb') as out:
                    while chunk := response.read(1024*1024):
                        out.write(chunk)
                digest = hashlib.sha256(tmp.read_bytes()).hexdigest()
                if name in pinned and digest != pinned[name]['sha256']:
                    raise RuntimeError(f'Checksum mismatch for {name}; remove .part and investigate')
                tmp.replace(path)
            finally:
                tmp.unlink(missing_ok=True)
        # Also verify already-existing binaries; skip download, not integrity checking.
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if name in pinned and digest != pinned[name]['sha256']:
            raise RuntimeError(f'Checksum mismatch for existing {path}')
        manifest[name] = {'url': url, 'sha256': digest, 'bytes': path.stat().st_size}
        print(f'{name}: verified {path.stat().st_size:,} bytes')
    (a.output/'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')


if __name__ == '__main__':
    main()
