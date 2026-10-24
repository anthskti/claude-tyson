#!/bin/sh
# The SpacetimeDB module bundles only files inside spacetimedb/, so keep copies of shared files there.
# Run this after every change to engine/engine.ts or engine/rules.ts (before `spacetime publish`).
cp "$(dirname "$0")/engine/engine.ts" "$(dirname "$0")/spacetimedb/src/engine.ts"
echo "engine synced into spacetimedb/src/engine.ts"
cp "$(dirname "$0")/engine/rules.ts" "$(dirname "$0")/spacetimedb/src/rules.ts"
echo "rules synced into spacetimedb/src/rules.ts"
