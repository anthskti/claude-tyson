#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/harness"
if [[ ! -x .venv/bin/python ]]; then
  echo 'Run bash experiments/airpod-mediapipe/setup.sh from the repo root first.' >&2
  exit 1
fi
exec .venv/bin/python -m boxing_cv.iphone_bridge --launch-inference "$@"
