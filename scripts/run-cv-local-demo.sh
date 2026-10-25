#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ ! -x motion/.venv/bin/python ]]; then
  echo 'Run bash scripts/setup-motion-demo.sh once first.' >&2
  exit 1
fi
exec motion/.venv/bin/python motion/demo.py "$@"
