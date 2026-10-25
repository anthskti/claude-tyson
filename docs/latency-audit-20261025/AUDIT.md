# Local demo: inference event to visible glove audit

Date: 2026-10-25. Branch inspected: `cv-local-demo` in `/Users/hanigherwi/Documents/claudetyson`.
The reported symptom was clarified as **the player's own glove starting late**.

## 1. Conclusion and limits

The player's glove already bypasses the backend. No server acknowledgement, impact timer, two-second history fill, or camera frame is intentionally awaited after a punch is emitted.

There is a confirmed, easily improved animation delay: the 280 ms sine motion is passed through the same smoothing as wrist/guard tracking. In an isolated test of the complete game callback, HUD, scene, provider, and native WebSocket bridge, a punch reached the next rendered frame in about 8 ms, but took 27 ms to move 5 cm, 78 ms to reach half extension, and 164 ms to peak. A temporary animation-only prototype brought those last three numbers to 7 / 23 / 63 ms.

This **does not reproduce or explain a several-hundred-millisecond delay before motion starts**. The live browser's event traces were not saved, and its tab and inference process had closed before inspection. The benchmarks exclude real camera processing, real collector callbacks, real backend subscriptions, OS occlusion/background throttling, and physical display scanout. They identify an improvement, not a proven complete root cause for the live symptom.

No production inference, thresholds, animation, backend, or model weights were changed during this audit. Prototype changes exist only in the isolated benchmark.

## 2. Exact path

1. Mac Core Motion callback writes `motion.jsonl`; the right phone callback travels over USB and is written to its separate log. `motion/collectors/swift/Collector.swift`, `motion/boxing_cv/iphone_bridge.py`.
2. Independent `SensorLoop` threads poll logs every 5 ms, run each hand's calibrated outward model, and assign `detectedUnixMs`. `calibrated_runtime.py`, `airpod_model.py`.
3. `SideSink.submit` submits the diagnostic record to an asynchronous logger and calls `GameBridge.punch` directly. It does **not** wait for a log flush, native window draw, or pose inference. `dual_airpod.py`.
4. `GameBridge.punch` wakes the WebSocket publisher immediately. The 20 ms periodic publisher is for status/pose, not an intentional punch batch delay. `game_bridge.py`.
5. `AirPodProvider.receive` validates the packet, checks clock alignment/freshness, deduplicates it, and synchronously calls `onInput`. `src/game/cv/airpods.ts`.
6. `onInput` calls `gloves.punch` **before** `server.forwardCv`. Forwarding calls `updatePose` then `submitMotionEvent` without awaiting a round trip. `src/game/main.ts`, `src/game/net/server.ts`.
7. The next animation frame calls `gloves.update` then `renderer.render`. `src/game/scene/boxer.ts` implements the sine movement and smoothing.
8. Separately, SpacetimeDB accepts or rejects the punch. The opponent's landed-hit reaction waits for resolution. Server startup is 120 ms left straight, 200 ms right straight, 220 ms hooks, plus network/scheduling. This delay affects hit reaction/damage, **not the player's local glove start**.

## 3. Actual run evidence

Source: `motion/runs/demo-20261025-015432/usb/inference/events.jsonl`; 425 emitted punches, 172 left and 253 right. These are software timings for emitted events, not all attempted punches or physical-onset measurements. Percentiles are recorded in [run-metrics.json](run-metrics.json).

| Stage | Left median / p95 | Right median / p95 |
|---|---:|---:|
| Latest Mac receipt → model event | 10.5 / 21.8 ms | 16.4 / 41.2 ms |
| Model execution | 6.0 / 16.9 ms | 8.4 / 17.3 ms |
| First qualifying prediction → confirmed event | 36.2 / 62.1 ms | 17.4 / 48.4 ms |
| Phone callback → Mac receipt, for emitted punches | — | 1.1 / 1.9 ms |

These rows overlap and must not be added as independent stages. Bluetooth and physical onset remain unknown. The broader transport log also contains larger relay spikes; event-only statistics do not summarize every callback.

The right input arrives at approximately 50 Hz, while the models declare 25 Hz and the left stream is approximately 25 Hz. Right histories therefore contain up to about 100 updates versus about 50 on the left. This doubles some history-replay work and introduces a training/deployment cadence mismatch. It should be tested independently, with raw callbacks preserved and timestamp-aware causal sampling. It does not explain an additional delay after `detectedUnixMs`.

The run's pose records include 27,696 good, 10,439 lost, and 1,812 calibrating observations. Some may be deliberate time out of frame. Freshness transitions can hide gloves or display the tracking overlay; that can look like failed/delayed input. They must be correlated with event IDs rather than assumed to be lag.

The run ended with inference exit `-11`. The corresponding `Python-2026-10-25-022459.ips` has a main-thread AVFoundation/CoreMediaIO capture stack. This is a separate demo stability issue; the report does not prove its trigger. Avoid repeated camera handoffs during the demo until reproduced and fixed.

## 4. Controlled browser measurements

Chrome 149, Apple M1 Pro, 1512×731 CSS pixels, device pixel ratio 2. Actual scene and application code; backend replaced by an offline fixture, synthetic punches sent by the real Python bridge. No remote fight was created or changed. The full-client measurements include its HUD/status callback. Times after receipt are CPU-side submitted-render/geometry timings, not camera-observed pixels.

| Metric, median | Current full client, 22 punches | Fast-animation prototype, 23 punches |
|---|---:|---:|
| Event → browser receipt estimate | 1.0 ms | 1.1 ms |
| Browser callback work | 0.3 ms | 0.2 ms |
| Event → next rendered frame | 7.6 ms | 6.9 ms |
| Receipt → 5 cm glove displacement | 26.6 ms | 7.3 ms |
| Receipt → half straight extension | 77.7 ms | 22.9 ms |
| Receipt → maximum extension | 163.9 ms | 63.3 ms |

Frame interval median was 8.3 ms, p95 12.1 ms. A separate scene test reduced pixel ratio to 1, disabled shadows, and hid other rings; it did not materially improve latency on this machine in these conditions. Do not assume reduced visual quality is the primary fix.

A repeat with the actual two GRU history loops running at 25/50 Hz in the bridge process produced similar timings: baseline event → frame median 6.1 ms / p95 9.9 ms; visible displacement median 27.8 ms; prototype displacement 6.9 ms. This is a CPU-contention check using zero vectors, not a recording replay; camera processing and diagnostic logging were not included.

Evidence: [browser-results.json](browser-results.json), [full-game-results.json](full-game-results.json), [full-game-load-results.json](full-game-load-results.json).

## 5. Demo fixes, in priority order

### A. Make the punch animation respond sharply

Keep guard/wrist smoothing, but add the punch offset **after** smoothing the baseline. Replace the symmetric 280 ms sine with an approximately 60–80 ms ease-out attack and 150–180 ms recovery. Preserve each hook's distinct lateral arc. The measured prototype uses a 65 ms attack and 175 ms recovery for straights. Apply it initially to the AirPod mode with a fallback switch; it must not change server cooldowns, damage, hit acceptance, or model thresholds.

Expected benefit based on the isolated test: about 20 ms earlier substantial movement, 55 ms earlier half extension, and 100 ms earlier peak extension. That is a measured animation improvement, not a promise of equivalent physical end-to-end savings.

### B. Save event-correlated browser timing during a real reproduction

Current `decision → frame` records the next render call, even if the glove has barely moved or is hidden. Add distinct markers for native decision, native enqueue/send, browser receive, `gloves.punch`, first **visible displaced** glove frame, half extension, and peak. Record visibility/tracking state, frame gaps, long tasks, stale drops, socket reconnects, and hidden-tab changes. Persist bounded traces locally so closing the tab does not discard the evidence. Do not send them to SpacetimeDB.

Use a short high-frame-rate video showing the hand and display if physical motion-to-photon latency is needed. Sensor receipt timestamps alone cannot establish it.

### C. Investigate any residual long delay using those stages

- Native decision → enqueue/send slow: inspect GIL contention, logging load, sensor backlog and WebSocket wake scheduling.
- Send → browser callback slow: inspect browser long tasks, background/occluded state, extension activity, and missed frames.
- Callback → visible glove slow: inspect animation smoothing, frame rate, visibility toggles, tracking overlay, and asset/shader warmup.
- Glove immediate but opponent late: inspect backend latency and authored startup separately.
- Missing event: freshness drops, rearming, or server rejection are not a queue delay. Do not relax freshness limits to replay stale punches.

### D. Reduce avoidable work after measuring it

Throttle unchanged diagnostics and HUD text; avoid rebuilding strategy and pose HTML on every 50 Hz sample. Cache percentile summaries rather than sorting recent latency history at status rate. Add a demo logging level that preserves raw motion and event timing while reducing duplicate feature/timeline output (this run's two timeline files alone were about 807 MB). Reduce native preview refresh to 10–15 Hz if it competes with browser rendering. Keep sensor processing and event publication at full cadence. Leave video recording off, as it already was.

Preload the first-person model and warm its shaders before the first demo punch. Keep the game foregrounded. Add a DPR 1/no-shadow fallback for a projector or slower GPU, but enable it based on frame metrics; it was not necessary in this benchmark.

### E. Earlier model recognition is a separate experiment

The current target is already the first outward-turnaround proxy, not full settling. The network predicts every reading and has no two-second warmup. Moving its supervised target earlier can advance the trigger, but cannot repair a delay that occurs after the trigger. Keep the existing models as a fallback.

## 6. Quick early-recognition training experiment

Start with a 120 ms lead, then compare 80/160 ms on the original validation trials if needed. At 25 Hz these are 2/3/4 sample intervals. For each original, define an early target start from its reviewed outward endpoint minus the lead, bounded to remain at least 80–120 ms after motion onset. Preserve a finite 0.4 s class-label interval starting there. Keep pre-onset, genuine nuisance motions, and rest as non-punch. Flag uncertain boundaries for review or mask them from supervision rather than inventing reliable labels.

Use the existing six channels, separate models per hand, training-only normalization, parent-isolated splits, and recorded augmentation warp mappings. Derive annotations on original parents and warp the new boundaries to descendants. Do not simply subtract a fixed duration from each already warped child. Synthetic examples do not add independent gesture diversity.

Train on causal prefixes/windows ending at a variety of times before, during and after the new target; never feed future samples relative to the prediction timestamp. Retain up to two seconds of past context. Balance parents and phases so idle/late positives do not overwhelm the early decision. The current GRU is unidirectional; full-sequence training itself is causal, but its uninterrupted hidden-state evaluation differs from live consumed-history inference.

Evaluate by running the **exact live buffer, consumption, gap, confirmation, cooldown and rearm policy** over originals. The present `event_metrics` accepts only events at or after turnaround and counts earlier ones as false events. It must be updated to recognize valid pre-turnaround detections while still penalizing pre-onset events, wrong classes, duplicates, wrist twists, flicks, and dodges.

Compare baseline versus each lead using first-event precision/recall, class confusion, nuisance false-punch rates and duplicate counts alongside median/p95 signed lead relative to the proxy endpoint. Select on validation with a false-positive constraint; preserve an untouched final test partition, and call previously inspected clips development replays. Do not let annotation-derived class IDs, endpoint times, or timing offsets become model inputs.

A short fine-tune from each current bundle (fresh optimizer, initial LR around 1e-4, 10–20 epochs) is a practical candidate. Re-run the applicable learning/quality checks for the new target and preserve their failure behavior. Existing full-training records took about 43 s right and 110 s left for training alone; relabeling, validation/replay, and implementation are the larger effort. Keep one-vs-two confirmation changes as a separate measured comparison, not an automatic threshold reduction.

Usable original **training** onset-to-turnaround proxies: left straight n=22, median 389 ms; left hook n=22, median 358 ms; right straight n=22, median 361 ms; right hook n=24, median 376 ms. Overall range 239–517 ms. These provisional endpoints leave room for a 120 ms lead; they do not prove early class separability or true contact timing.

## 7. Acceptance run

After changes, replay the same recorded streams and then do a short live session with both buds, pose, logging and the actual browser/backend running together. Include each hand/class, alternating rapid punches, idle, flicks, twists and dodges. Save event IDs at every stage. Targets to test, not achieved live guarantees: post-decision first visible movement p95 under 50 ms, no replayed/duplicate punches, no degradation in nuisance rejection, and no camera crash. Retain existing model/animation behavior as a selectable fallback until this passes.

Benchmark sources are in the same audit working directory: `probe.ts`, `game-probe.ts`, `fake-server.ts`, `build-game.ts`, and `serve.py`. They import the local repo code; they are test fixtures, not additions to the shipping runtime.
