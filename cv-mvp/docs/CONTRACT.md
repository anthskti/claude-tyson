# MVP motion contract

## 1. Ownership and proposal mapping

The latest system diagram is the design authority: webcam → local MediaPipe/motion classification → player action → SpacetimeDB combat validation → authoritative state → Three.js UI. Claude receives downstream summaries and never blocks CV dispatch.

| Team proposal | This module's responsibility |
| --- | --- |
| FightStamped | Browser-supplied `fightId`, `roundId`; a movement is identified by `movementId`/`eventId`. |
| MotionBase | Tracking state and explicit nullable confidence/quality. |
| MotionEvent | Observed `punch_left`, `punch_right`, `dodge_left`, `dodge_right`, `return_neutral`. |
| Player Action in diagram | `PlayerAction` reducer-hook envelope. This name is a proposed boundary type. |
| CombatEvent | Owned by SpacetimeDB after action validation, hit windows, cooldowns and outcome resolution. |
| FightSnapshot, PunchCounts, FighterStats, StyleEvidence | Derived by game/backend from accepted actions and authoritative combat outcomes. |
| FightWindow, FightSummary, StrategyRequest/Update, OpponentTuning, TuningPatch | Downstream aggregation and strategy; no implementation invented here. |
| CoachRequest/Response, VoiceCue, PlayerProfile, Fight Record, HistoricalMatch, AdaptionResult | Outside the CV module. |

Confidence is **not available** from this heuristic as a calibrated probability, so `confidence: null`, `qualityScore: null`, and `qualityKind: "not_estimated"` are intentional. MediaPipe handedness confidence is used for identity filtering, not repurposed as punch certainty. A punch is an attempt, not a hit or an authoritative attempted-punch statistic until the game's validation policy accepts it.

## 2. Sample envelope

The exact MVP definitions are in `web/contracts.ts`. A complete emitted example is in `examples/cv_sample.synthetic.json`.

```json
{
  "contractVersion": 1,
  "kind": "cv_sample",
  "fightId": "from-frontend",
  "roundId": "from-frontend",
  "seq": 42,
  "source": "live",
  "observation": {"schemaVersion": 1, "kind": "observation"},
  "events": [],
  "batch": {"firstSeq": 40, "lastSeq": 42, "coalescedObservations": 2},
  "producer": {
    "detector": "recent_hand_motion",
    "nativeSchemaVersion": 2,
    "resetGeneration": 0,
    "coordinateSpace": "canonical_unmirrored_image"
  },
  "trace": {"clock": "producer_monotonic_ms", "liveLatencyMeasurable": true}
}
```

This excerpt abbreviates `observation`; it is not a valid full packet. The wrapper remains draft contract v1. The current harness's native schema is v2; `CvAdapter` explicitly translates it rather than silently pretending v2 is v1. It preserves event IDs, event types, evidence/features, onset and sample timing. The live runner sets `detectedMs` at the actual adapter completion boundary. Additive fields include readiness diagnostics, trace, batch coverage, reset generation and producer metadata.

Sequence numbers increase for every processed frame within a detector session. They do not restart at each round. `sessionId` identifies a provider process; event IDs are unique within that session. A consumer should deduplicate by `(sessionId, eventId)`; event IDs already contain the session prefix. A reset changes the calibration ID and reset generation but not the session or sequence counter.

## 3. Observation and event semantics

- `timestampMs`: source sample time. Live uses producer monotonic time immediately after camera read; recordings use their source/sidecar timeline.
- `availableMs`: live adapter-result time; replay uses source time. See the separate host trace for replay processing throughput.
- `validity`: always includes Boolean `dodge`, `punch_left`, `punch_right`. Missing native flags normalize to false.
- `trackingState`: `good` if all channels valid, `degraded` if some valid, `calibrating` if none valid while head initialization warms, otherwise `lost`. Read per-channel validity for partial tracking.
- `markers.head`: head/nose position when dodge tracking is valid. `markers.left/right`: **hand landmark 0, wrist**, for the matching hand when valid and inside the image. They are optional and must be cleared when absent. Native palm centers are not mislabeled as contract wrists.
- Coordinates are normalized canonical image x/y. UI may draw `1-x` for a mirror. Event sides remain **player anatomical**, never screen left/right. `dodge_left` means the player moves to their anatomical left.
- `onsetMs`: start of the evidence window, not a measured instant of fist acceleration. `sampleMs`: frame where the detector emitted the event. `detectedMs`: result time. An event can precede the newest observation in a coalesced batch.
- `return_neutral`: a head/dodge state transition. It is **not punch recovery**. Punch recovery is internal per-hand slowdown/rearm; no synthetic `guard_return` event is emitted.
- `resetGeneration` on every event allows consumers to reject pre-reset events that happen to share a batch with newer observations.

Current punch logic uses recent palm-size growth and palm-center image speed over a 120 ms window, independent per-hand cooldown/release, and handedness filtering. It does not require depth, elbow extension, a fist classifier, or a historical guard coordinate. Head calibration remains independent. Hooks/hits/damage are not separately classified.

## 4. Socket handshake and controls

The server sends `cv_hello` with its session, supported wire versions, detector configuration, source, and capabilities. The provider aligns clocks and then sends context. Every client control has `contractVersion: 1` and a unique `requestId` string (1–64 characters).

```json
{"contractVersion":1,"kind":"set_context","requestId":"7","fightId":"fight-123","roundId":"round-1"}
```

The server returns `cv_ack` with operation, request ID, fight/round/session IDs before publishing samples. IDs must be nonempty strings of at most 128 characters. No fake fight context is created. New context discards the old mailbox so old-round events are not reassigned to the new round. Reconnect starts a fresh delivery buffer; it does not replay disconnected movements. Use a new provider/connect call at each round boundary and reset head/history if recentering is needed; context change alone does not recalibrate the detector.

```json
{"contractVersion":1,"kind":"clock_sync","requestId":"8","clientSendMs":123.45}
{"contractVersion":1,"kind":"reset_calibration","requestId":"9"}
```

Clock replies echo client time and contain `serverReceiveMs`, `serverSendMs` on the producer clock. Reset returns `cv_ack`, `status: "queued"`, and `targetResetGeneration`; it applies at the next frame boundary. Repeated pending resets can coalesce. The provider immediately pauses input until an observation reaches that generation. Invalid controls return `cv_error` with request ID/reason. Completion/errors/coverage failure return `cv_status`. Closing or any uncertain coverage clears transient client input.

## 5. Bounded delivery and authority

The native producer is independent of socket writes. The mailbox retains one newest observation and **all ordered events** between deliveries, up to 128 events by default. `batch.firstSeq..lastSeq` announces observation coalescing, so the client can distinguish it from unexplained loss. Events retain their original sample times and reset generations. This keeps marker updates responsive without silently dropping punches.

A live sample/event older than 250 ms, event-buffer overflow, or a socket send that takes longer than the freshness deadline invalidates coverage and closes the connection. There is no late-action backlog after reconnect. The browser also runs a freshness watchdog, deduplicates events and closes on malformed samples or unexplained sequence gaps.

The browser example deliberately requires valid head/dodge tracking and good clock alignment before dispatching attempts. It still renders available hands during head initialization. `canScore` does not certify accuracy or fairness. The authoritative reducer must independently validate session/round ownership, movement IDs, source policy, timing windows, rate limits/cooldowns and outcomes. Never trust client confidence or client clocks as authority.

No SpacetimeDB SDK calls or generated reducer signatures are assumed. `submitPlayerAction` is the single hook your team supplies. A `clientSampleMs` value is mapped into the browser's `performance.now()` domain, **not Unix time or server time**. Preserve the original motion timestamps; map/validate again at the authoritative boundary if the combat engine needs them.
