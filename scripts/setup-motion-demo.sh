#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
PYTHON_BIN="${PYTHON_BIN:-python3.11}"
"$PYTHON_BIN" -c 'import sys; assert sys.version_info[:2] == (3,11), "Use Python 3.11 for the pinned runtime"'
if [[ ! -x motion/.venv/bin/python ]]; then "$PYTHON_BIN" -m venv motion/.venv; fi
motion/.venv/bin/python -m pip install -r motion/requirements.txt
if command -v bun >/dev/null; then
  BUN_BIN="$(command -v bun)"
else
  npm install --prefix motion/.tools --no-audit --no-fund bun@1.3.3
  BUN_BIN="$PWD/motion/.tools/node_modules/.bin/bun"
fi
"$BUN_BIN" install
(cd spacetimedb && "$BUN_BIN" install)
bash motion/collectors/build.sh
printf '\nReady. Keep the installed iPhone collector; no reinstall is needed.\nRun: bash scripts/run-cv-local-demo.sh\n'
