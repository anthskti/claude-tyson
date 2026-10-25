# Local demo: inference event → player glove latency audit

Date: 2026-10-25. Branch: `cv-local-demo`. Scope: the player's own first-person glove starting late after the native harness records a punch.

## Decision

The first demo improvement should be a **fast local glove animation triggered by the existing confirmed IMU event**, together with event-ID-correlated timing that measures actual glove displacement. Preserve the current animation as a fallback. Do not start with model retraining, a shorter history window, USB replacement, or backend combat changes for this particular symptom.

The normal code already calls the glove animation before sending the event to SpacetimeDB. I reproduced that path in an isolated full-client test: synthetic decision → render submission was typically 6–8 ms, with p95 about 10–12 ms. The existing animation then takes roughly 27 ms to move 5 cm, 78 ms to reach half extension, and 164 ms to reach its peak. A prototype reached those points in roughly 7, 23, and 63 ms.

**This audit has not reproduced or conclusively explained a much larger live delay.** The user's game had closed by the time inspection began, and its browser stage logs were not saved. The tests below use synthetic events, a mocked backend, and real client code. The contention test runs both real GRU loops but does not include live Bluetooth, camera/Pose, full logging, or actual backend updates. Do not interpret it as a physical punch-to-display measurement or a guarantee of the same latency during a live match.

No production classifier, calibration, collector, browser, or combat behavior was changed during this audit. The fast curve exists only in the isolated benchmark.

## 1. Actual path and where waiting can occur

```text
Mac left / phone right AirPod callback
  → collector JSONL (right crosses USB first)
  → independent Python sensor worker
  → calibrated six-channel input → outward model → confirmation → event
  → SideSink → GameBridge event queue + immediate thread-safe wake
  → localhost WebSocket
  → AirPodProvider: validate, clock/freshness checks, deduplicate
  → main.onInput → gloves.punch()             [LOCAL FEEDBACK]
  → next animation frame → gloves.update → renderer.render

In parallel, after gloves.punch():
  → updatePose + submitMotionEvent → SpacetimeDB
  → acceptance, startup, impact resolution → opponent reaction / damage
```

| Stage | What the code actually does | Latency implication |
|---|---|---|
| Collectors and USB | Native callbacks, line-oriented logs; phone relay uses TCP over USB with clock alignment | Upstream of the event the user already sees. Cannot explain a later glove start by itself. |
| Sensor worker | Polls at 5 ms; two independent workers; logs through bounded async queues | A small polling cost; CPU/logging contention can still delay scheduling. |
| Outward model | Replays unconsumed history of **up to** 2 seconds; requires two qualifying predictions | There is no mandatory 2-second wait. Confirmation happens before the emitted event. |
| Python publisher | Punch calls `_wake()` immediately; 20 ms interval is for ordinary status/pose messages | Punches do not intentionally wait for the camera frame or status interval. Thread scheduling remains measurable overhead. |
| Browser provider | Receives direct WebSocket messages; no simulated keyboard or batching | No intentional debounce after a confirmed event. Old events are dropped, not queued for later playback. |
| Game callback | Calls `gloves.punch()` before `server.forwardCv()` | Local glove does not wait for a reducer, round trip, or hit decision. |
| Rendering | Uses the next animation frame; updates arena, opponent, gloves, then submits rendering | Main-thread stalls, visibility/occlusion, GPU pressure, loading, and HUD work can delay visible feedback. |
| Glove motion | 280 ms sine curve plus positional interpolation | Even on a fast renderer, meaningful extension takes another 75–165 ms. |
| Backend | Existing startup: left straight 120 ms, right straight 200 ms, hooks 220 ms | Affects damage/opponent hit reaction. It is not on the local glove-start dependency path. |

Source references:

- [`SideSink` and independent loops](../motion/boxing_cv/dual_airpod.py)
- [Sensor polling and asynchronous logs](../motion/boxing_cv/calibrated_runtime.py)
- [Bounded history policy](../motion/boxing_cv/airpod_buffered.py)
- [Event decision timestamps](../motion/boxing_cv/airpod_model.py)
- [Immediate local publication and freshness gates](../motion/boxing_cv/game_bridge.py)
- [Browser receive, callback and stage counters](../src/game/cv/airpods.ts)
- [`onInput` and render loop](../src/game/main.ts)
- [`PlayerGloves.punch` / `update`](../src/game/scene/boxer.ts)
- [Reducer forwarding](../src/game/net/server.ts)
- [Server startup constants](../spacetimedb/src/rules.ts) and [acceptance/resolution](../spacetimedb/src/index.ts)

## 2. Evidence from the actual run

Inspected `motion/runs/demo-20261025-015432/usb/inference/`, session `704d4881bd08`. There are 425 emitted punch events: 172 left and 253 right. These statistics describe emitted events only, not all candidates or detection accuracy.

| Measurement, ms | Left median / p95 | Right median / p95 |
|---|---:|---:|
| Latest Mac callback receipt → emitted event | 10.5 / 21.8 | 16.3 / 41.2 |
| Model execution | 6.0 / 16.9 | 8.4 / 17.3 |
| Callback waiting before inference processing | 3.8 / 6.9 | 7.0 / 28.0 |
| First qualifying prediction → confirmed event | 36.2 / 62.1 | 17.4 / 48.4 |
| Phone callback → Mac relay estimate | — | 1.1 / 1.9 |

Do not add every row: some intervals overlap. These clocks exclude unknown sensor/Bluetooth delay and do not identify physical punch onset. The relay statistics above are for the readings that produced punch events; transport-wide outliers were also present.

Additional observations:

- Left samples commonly arrive about every 40 ms; right about every 20 ms. The right stream is therefore effectively around 50 Hz, although the shared history/gap logic describes approximately 25 Hz. This is a separate model-cadence/CPU concern. Do not silently discard every other right sample without replay validation: that changes classifier behavior.
- The saved pose observations include 27,696 `good`, 10,439 `lost`, and 1,812 `calibrating` frames. This includes setup/testing, so it is not an active-match tracking-failure rate. Pose timestamps normally differ by 33 ms, p95 38 ms, with a 4.1-second maximum gap.
- The native log shows repeated sensor availability transitions and client disconnects. A dropped event, hidden glove, or tracking overlay can look like delayed input. The next live test must log those alongside event timing.
- The two sensor timelines alone occupy about 807 MB. Disk writes are off the sensor path, but JSON encoding, feature construction and Python scheduling still cost CPU. Measure before reducing diagnostics.
- The last inference process exited with signal 11. The macOS crash report points into AVFoundation/CoreMediaIO on the main thread. This is an availability issue, not proven to be the glove-delay cause. Avoid unnecessary camera release/reopen during the demo; investigate ownership/reconnection separately.

Raw summary: [run-metrics.json](latency-audit/run-metrics.json).

## 3. Browser measurements on this Mac

Chrome 149, Apple M1 Pro/Metal, 1512 × 731 CSS viewport, device pixel ratio 2. The full-game test uses the actual `startGame`, HUD, provider and scene code. Only the database wrapper is replaced with an in-memory active-match fixture; no real matches or server mutations occur. Synthetic alternating straight events pass through the actual Python `GameBridge` and WebSocket provider. Warm-up frames are excluded. Sample counts are small and the comparisons are exploratory, sequential tests, not a randomized performance study.

### Full client, no inference workload

| Measurement | Current curve median / p95 | Fast prototype median / p95 |
|---|---:|---:|
| Native synthetic event → render submission | 7.6 / 11.8 ms | 6.9 / 11.8 ms |
| Browser receipt → 5 cm forward displacement | 26.6 / 29.9 ms | 7.3 / 12.7 ms |
| Browser receipt → 50% extension | 77.7 / 80.7 ms | 22.9 / 27.4 ms |
| Browser receipt → peak extension | 163.9 / 168.1 ms | 63.3 / 65.9 ms |
| Callback execution | 0.3 / 0.9 ms | 0.2 / 0.4 ms |
| Frame interval | 8.3 / 12.1 ms | 8.2 / 12.0 ms |

22 baseline and 23 prototype punches. The 5 cm and half-extension thresholds measure model-space movement, not a perceptual threshold or physical screen scan-out. `renderer.render()` returns after submitting work; it does not prove pixels have reached the display.

### With both real GRU history loops consuming CPU

The same process as the bridge ran the original bounded-history GRU calculations at 25 Hz left and 50 Hz right. Inputs were zero vectors; no camera or raw/derived logging ran.

| Measurement | Current curve median / p95 | Fast prototype median / p95 |
|---|---:|---:|
| Synthetic event → render submission | 6.1 / 9.9 ms | 8.1 / 9.7 ms |
| Browser receipt → 5 cm displacement | 27.8 / 31.4 ms | 6.9 / 11.0 ms |
| Browser receipt → 50% extension | 75.7 / 80.0 ms | 22.8 / 28.6 ms |
| Browser receipt → peak extension | 165.3 / 168.7 ms | 63.5 / 67.6 ms |

22 punches per variant. This did not reproduce a large post-event queue delay. It does not rule out real camera, logging, thermal, tab-visibility, or backend-update load.

### Rendering quality sweep

An isolated scene test compared the current DPR 2 + shadows + arena with DPR 1, shadows disabled, and only the focused ring. All had roughly 8.3 ms median frame intervals and approximately 10–12 ms p95 synthetic-event-to-render delay. **There is no evidence here that reducing resolution or shadows is the primary fix on this Mac.** Keep a low-quality option for a loaded laptop/external display, but do not sacrifice visuals by default on this evidence.

Results:

- [Full game comparison](latency-audit/full-game-results.json)
- [Full game with dual-model CPU load](latency-audit/full-game-load-results.json)
- [Rendering quality sweep](latency-audit/browser-results.json)

## 4. Prioritized implementation plan

### P0 — Make confirmed local punches look immediate (roughly 30–45 minutes)

Change `PlayerGloves` only for AirPod demo mode; retain the existing curve behind a runtime switch.

1. Keep smoothing the guard/rest position.
2. Apply the punch offset directly on top of that smoothed base. Do not interpolate the entire punch target again.
3. Use approximately 65 ms to peak, with a fast ease-out extension and approximately 175 ms return. This is the straight-only prototype tested above; tune the hook's existing lateral arc separately rather than making hooks straight-shaped.
4. Trigger on the same confirmed event; do not emit early speculative classifier events. Keep independent left/right state and normal cancellation on mode changes.
5. Preserve backend validation, startup, damage, cooldowns and existing model thresholds. A faster visual does not establish an earlier authoritative hit.
6. Test all four classes, alternating hands, same-hand repeats, tracking loss, mode changes, and KO. A new event must not wait for an old animation to finish.

Expected benefit from these tests: about 20 ms less time to initial substantial movement, about 55 ms less to half extension, and about 100 ms less to peak extension. These are animation-stage improvements, not a claim that a larger unexplained live stall is solved.

### P0 — Save an accurate end-to-end trace (roughly 30–45 minutes, alongside the curve)

The existing `decision → frame` metric is too optimistic as a visible-response metric. `frameRendered()` marks the next first-person render even if the relevant hand is hidden or movement is barely detectable. Console traces disappear when the tab closes and do not record drop reasons consistently.

For every event ID, save:

```text
native decisionUnixMs
native publication/queue dwell
browser receiptPerf + clock uncertainty
glove.punch callPerf
first rendered frame with that hand visible and changed
time to a meaningful extension threshold
frame interval / long-task count / document visibility
hand readiness + pose readiness + first-person state
drop reason if it never reaches the animation
submission / acceptance / resolution (separate branch of the trace)
```

Use a bounded client diagnostic buffer and export it after the test, or send batched local diagnostic records off the hot path. No await or disk/network round trip should precede `gloves.punch`. Show p50/p95 and counts for accepted-for-render versus dropped/hidden events. Rename the existing metric to `decision → render submission`; keep physical onset/display latency explicitly unknown.

Diagnosis by split:

- Native decision → browser receipt high: inspect Python scheduling, queue dwell and socket scheduling.
- Browser receipt → `gloves.punch` high: browser callback/HUD/JS work.
- `gloves.punch` → first visible movement high: render stalls, visibility, hidden hand or animation curve.
- Only acceptance/resolution high: backend/network; unrelated to the own-glove-start issue.

### P1 — Eliminate startup and focus-related stalls

Warm the first-person assets/materials before declaring the game ready. The synthetic full-client startup briefly reported stale motion while assets loaded; warm-up was excluded from performance measurements. Asset and shader initialization should finish before the first judged punch.

Keep the game tab foregrounded during the actual test. Calibrate first, then focus Chrome; keep the harness available beside it or minimize its diagnostic rendering after calibration. Add a visible notice for a hidden tab or frame stalls. Do not accumulate events to replay when a backgrounded tab returns.

Only enable DPR 1 / reduced shadows / focused-ring rendering if live frame p95 exceeds the target under the real sensor workload. Coalesce unchanged HUD status/pose updates and cap diagnostic text refresh to 5–10 Hz while keeping events immediate. `Hud.renderPose` currently replaces HTML on every observation; some other HUD content is rebuilt frequently too. The measured callback cost was small, so these are robustness improvements, not proven major savings.

### P1 — Address intermittent tracking/connection visibility

Log when a glove becomes invisible because its latest status is stale. Preserve input freshness checks. Do not simply increase every timeout to make delayed events appear valid. If live data proves single-packet status flicker hides a confirmed punch, consider a short, bounded visual-only completion grace for that existing animation; it must never authorize new actions or keep combat tracking valid.

Keep camera ownership stable through an AirPod match. Investigate the AVFoundation crash separately with the crash report before changing camera behavior. Do not use CV punch fallback.

### P2 — Optimize native inference only if the new trace implicates it

The current bounded window reruns the GRU for every retained sample; at 50 Hz the right side can process about 100 history steps each callback. Consider a numerically verified fused/batched implementation, and independently validate the right input cadence against training. Preserve consumable history semantics, gap masking, confirmation and rearming. Do not replace bounded history with indefinitely retained hidden state without treating it as a behavior change.

Offer a lean demo logging level that retains raw IMU, calibration, emitted events and latency summaries while reducing repeated full derived/timeline snapshots. It may reduce Python contention, but it should follow measurement. The async log queue does not impose a fixed 200 ms event delay; 200 ms is its disk-flush cadence.

### Low priority for the reported symptom

- Replacing USB or WebSocket transport: measured relay/bridge times are already small.
- Retraining on shorter windows: changes detection timing before event emission, not post-event glove delay.
- Reducing server startup or hosting SpacetimeDB locally: affects hit outcomes, not the direct glove path.
- Disabling all visuals immediately: quality sweep did not show a meaningful frame-latency improvement.

## 5. Demo acceptance test

1. Start the ordinary launcher and perform the six calibration trials. Wait for assets and tracking to stabilize; focus the game tab.
2. Record 10 left straights, 10 right straights, 10 left hooks, 10 right hooks, then 20 alternating punches at realistic spacing. Include several dodges and a deliberate sensor disconnect. Identify expected actions separately from model detections.
3. Save the native and browser traces with shared event IDs. Compare the existing and fast animation with the same model/configuration; include the loaded full demo workload.
4. Target post-decision software latency: p95 event → browser receipt <20 ms, p95 browser receipt → first meaningful visible movement <35 ms, p95 native event → meaningful movement <50 ms. These are engineering targets for the demo, not already achieved live guarantees.
5. Report missed/dropped/hidden events and stalls, not only latency for successful events. Keep backend acceptance and damage timing separate.
6. Film the physical fist, harness event and screen together at high frame rate if total perceived latency is still disputed. Software receipt timestamps cannot measure the Bluetooth/sensor and final display portions.

Keep the original curve selectable for an immediate fallback. Do not change classification thresholds, calibration, or backend combat rules during this animation A/B test.

## Audit artifacts and limits

The isolated benchmark sources are in `/Users/hanigherwi/Documents/Codex/2026-10-21/i-x20/work/latency-audit/`: `probe.ts`, `game-probe.ts`, `fake-server.ts`, `build-game.ts`, and `serve.py`. They use absolute local paths and are audit tools, not shipped runtime code. The fake server never contacts the live backend. The prototype currently exercises straights only.

All temporary benchmark servers and tabs were stopped after measurements. The original experiment kit and running Mac collector were left unchanged. No production code was modified, no backend deployment occurred, and no match was created by this audit.
