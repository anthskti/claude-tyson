# Measuring integration latency

## 1. Establish the wiring baseline

Start `python -m cv_mvp --synthetic`, connect the smoke page, and verify repeated movement IDs/events. Integrate the provider into your actual renderer and reducer hook. Confirm one accepted action per movement ID and that disconnect/reset clears transient input. Synthetic source tags must reach the reducer; allow them only in a deliberate test match.

This tests routing and contract compatibility. Its timestamps are a generated source timeline, so the provider reports live latency as `null`.

## 2. Switch to a real camera

Restart with `python -m cv_mvp --camera 0 --log /absolute/path/new-run.jsonl`. Test with the actual game rendering and reducers running, since CPU/GPU contention can change performance. Warm models and head initialization before collecting steady-state numbers. Also record startup time separately.

Collect p50 and p95 across at least 30 seconds and several punches/dodges. Include valid-channel fraction, longest tracking gap, camera properties, capture-read/processed counts, overwritten frames, and the active detector config. A fast system that loses a hand needs different work from one that buffers valid events.

## 3. Interpret the timestamps correctly

For **live** input, these share one producer monotonic origin:

| Field | Meaning |
| --- | --- |
| `observation.timestampMs` | Host time immediately after OpenCV reads a frame, rounded to ordered milliseconds. |
| `trace.captureReadMs` | Higher precision host time at that same boundary. |
| `trace.inferenceStartMs`, `inferenceEndMs` | Start/end around MediaPipe inference and conversion. |
| `trace.detectionEndMs`, `observation.availableMs` | Adapter/detection completion. |
| `trace.enqueuedMs` | Offered to the socket mailbox. |
| `trace.sentMs` | Just before JSON serialization and WebSocket send. |
| `event.sampleMs` | Frame where the movement threshold/hold condition emitted the attempt. |
| `event.onsetMs` | Start of the detector evidence window. |

`readToResultMs = detectionEndMs - captureReadMs`. This includes the pending-frame wait plus inference and the adapter. Native pose and hand timings overlap; **do not add them** to infer wall time. Inspect `inferenceEndMs - inferenceStartMs` for the outer wall duration.

OpenCV does not expose sensor exposure time here. Read-to-receive excludes unknown camera/driver buffering before the read. Frame overwrites are expected when inference is slower than capture; they bound application backlog while reducing temporal coverage. Zero overwrites does not prove the camera driver has zero buffering.

## 4. Align Python and browser clocks

`performance.now()` and Python `perf_counter()` have different origins. Do not subtract raw values or compare them to `Date.now()`.

The provider takes six local ping samples and uses the smallest adjusted round trip. With client send/receive `c0,c3` and server receive/send `s1,s2`:

```text
rtt = (c3 - c0) - (s2 - s1)
offset = ((s1 - c0) + (s2 - c3)) / 2     # server minus browser
browserTime(producerTime) = producerTime - offset
```

Offset estimation assumes roughly symmetric transit. Report `rtt/2` as an uncertainty estimate, not a precision guarantee. It refreshes every 30 seconds; live input dispatch pauses if estimated uncertainty exceeds 25 ms. A stalled browser can make samples stale even when inference is fast.

For live packets the provider exposes:

- `sampleToReceiveMs`: receipt time minus mapped camera-read sample time.
- `producerToReceiveMs`: receipt time minus mapped `sentMs`; includes serialization, transport, event-loop delivery and clock-estimation error.
- `readToResultMs`: native producer work from read to result.
- `clockUncertaintyMs`: estimate from the best recent ping.

The smoke page shows the latest timings and a rolling p95 of sample age over at most 300 received samples. This is a diagnostic display, not a persisted benchmark.

## 5. Add game and SpacetimeDB markers

Use the **same `movementId`** throughout. In your browser, record `performance.now()` when:

1. `onSample` receives the filtered event.
2. The reducer hook is invoked.
3. A matching authoritative result/state update arrives.
4. That result is applied during the next `requestAnimationFrame` render.

Compare times on that browser clock. Correlating the authoritative acknowledgement to the movement ID lets you measure dispatch-to-result without subtracting a server timestamp. Server receive/apply/send timestamps can separately measure internal server work on its own clock. If you need cross-host one-way times, explicitly synchronize/map those clocks too.

This module supplies the CV trace and reducer hook; it cannot produce authoritative ACK/render timings without your actual game and SDK. An animation-frame callback is a scheduling proxy, not a display-photon timestamp.

## 6. Locate the delay

| Evidence | Likely area to investigate |
| --- | --- |
| High read-to-result, pose/hand wall duration | Native inference or shared CPU/GPU contention. |
| High age despite fast read-to-result | Serialization, socket/browser scheduling, or clock alignment. |
| Low receive age, late reducer/state update | Integration dispatch, reducer scheduling, state subscriptions. |
| Fast authoritative update, late visual response | Rendering/interpolation/game animation. |
| Event missing despite fresh samples | Tracking validity or detector thresholds/release; not proven by latency alone. |
| High camera read-to-display delay invisible in trace | Driver/sensor buffering; measure externally. |

The hand detector needs at least four samples and an evidence span near its 120 ms window; dodge detection has a hold condition. That intentional evidence latency is separate from transport latency. Film a physical motion and the displayed response together with a high-frame-rate external camera if you need true motion-to-photon latency.

## 7. Use recordings for reproducibility

Run a video with its timestamp sidecar to compare event behavior/configurations. `--unpaced` removes realtime pacing for throughput tests. Recording observations/events use source time while trace timestamps use current host time. Never subtract a replay `sampleMs` from a current trace or claim replay throughput proves live webcam FPS.

If the socket or browser falls behind, the correct MVP behavior is to mark coverage uncertain and clear input. Do not increase the event buffer/freshness deadline until delayed punches look responsive; that can hide the problem by accepting old movements.
