#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
PYTHON_BIN="${PYTHON_BIN:-python3.11}"
"$PYTHON_BIN" -c 'import sys; assert sys.version_info[:2] == (3,11), "Use Python 3.11 for the pinned runtime"'
if [[ ! -x motion/.venv/bin/python ]]; then "$PYTHON_BIN" -m venv motion/.venv; fi
motion/.venv/bin/python -m pip install -r motion/requirements.txt
bash motion/collectors/build.sh
printf '\nReady. Connect the right AirPod to your iPhone, open its collector over USB.\nRun: bash scripts/run-motion-companion.sh --website https://YOUR-DEPLOYMENT.vercel.app\n'
