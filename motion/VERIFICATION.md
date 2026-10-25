# Demo verification — 2026-10-25

- Branch: cv-local-demo, based on main at 3c46465.
- 65 frontend/engine/input tests pass, including direct AirPod routing, full punch classes, canonical sessions, reducer ordering/deduplication, stale packets, and visible gloves without wrist markers. Existing browser CV parity and punch-classification tests pass unchanged.
- 52 Python tests pass in the isolated repo environment: quick three-trial calibration for each side, original buffer/gap/rearm policies, model pairing/checksums, independent workers, simulated native UI, USB framing/clock validation, and local WebSocket origin/single-client/overflow behavior.
- Production build and TypeScript validation pass using build:demo. Next's build worker failed under Bun 1.3.3; the demo production commands use Node.
- The Mac collector builds and verifies its ad-hoc signature. The copied iPhone project builds into an unsigned arm64 IPA. No installation or signing change was made on the phone.
- Launcher --check passes: dependencies, paired bundles, USB utility and available ports.
- Numerical extraction parity: all compared model values/events match on 3,709 recorded readings for each bundle; dodge validity/lateral/events match on 4,855 pose frames. See parity-verification.json for scope and digests. This is behavioral preservation, not new accuracy validation.
- Browser smoke test: local page connects to the configured shared backend, initially reports unavailable motion, and displays both hands/pose ready when the simulated local status stream connects. The UI clears readiness and reports lost tracking after disconnect. No punches or user fights were submitted during the smoke test.

## Remaining live checks

Run the launcher with both physical buds. Verify the six calibration trials, each punch class, independent dropout/recalibration, camera handoff, and the event-ID-correlated latency counters during an actual match. Added decision-to-visible-frame p95 <50 ms is a target, not a measured hardware result.

## Existing backend test blocker

bun run test reaches the backend suite but spacetimedb/src/module.test.ts cannot parse because RING_COUNT, fighterAuth, active and tick are declared twice. That file is byte-identical to main at the base commit; no backend code was changed. The separate backend rules suite passes four tests.
