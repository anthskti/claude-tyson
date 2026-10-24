#!/bin/sh
# The SpacetimeDB module bundles only files inside spacetimedb/, so keep a copy of the engine there.
# Run this after every change to engine/engine.ts (before `spacetime publish`).
cp "$(dirname "$0")/engine/engine.ts" "$(dirname "$0")/spacetimedb/src/engine.ts"
echo "engine synced into spacetimedb/src/engine.ts"
