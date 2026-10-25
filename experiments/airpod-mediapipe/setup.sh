#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
PYTHON="${PYTHON:-python3.11}"
"$PYTHON" -c 'import sys; assert sys.version_info[:2] == (3, 11), "Use Python 3.11"'
"$PYTHON" -m venv harness/.venv
harness/.venv/bin/python -m pip install -r harness/requirements.txt
bash harness/collectors/build.sh
echo 'Ready. Follow README.md for Bluetooth pairing and USB setup.'
