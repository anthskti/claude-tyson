# Boxing CV MVP

A standalone Python OpenCV + MediaPipe provider, a local WebSocket bridge, and a small browser adapter for the team's proposed motion contracts. Copy this entire folder into your repo. It has no dependency on the research harness or its recordings.

**The CV output is a movement attempt. SpacetimeDB decides whether it lands, is blocked, causes damage, or is accepted at all.** The browser owns the fight/round IDs. No frames, face images, or full landmark arrays go over the socket.

## 1. Test integration without a camera

From this folder, use **Python 3.11**. These versions match the tested harness environment.

```sh
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install -e '.[dev]'
python -m cv_mvp --synthetic
```

In a second terminal, from this folder:

```sh
source .venv/bin/activate
python -m http.server 8080 --bind 127.0.0.1 --directory web
```

Open <http://127.0.0.1:8080/smoke.html>, enter the fight/round context, and click **Connect**. Within a few seconds, you should see head/wrist markers, left/right punches, a left dodge, and a return to neutral. This repeats every six seconds. The smoke page deliberately allows synthetic input; the game adapter disables it by default.

The bridge accepts one game client at `ws://127.0.0.1:8765`. It starts processing only after the client supplies context. Use Ctrl-C to stop it. A finite recording closes its client at EOF; the bridge process stays listening until stopped. Restart the bridge to replay a finished recording.

## 2. Run the actual camera pipeline

Stop the synthetic bridge, then:

```sh
python -m pip install -e '.[camera,dev]'
python scripts/download_models.py
python -m cv_mvp --camera 0
```

The downloader saves pinned, checksum-verified MediaPipe model files under `models/`. Weights are excluded from Git. Grant your terminal/Python camera permission if your OS requests it; close other applications using that camera.

Reload the smoke page and connect. Stand far enough back that your head, both shoulders, and hands fit in frame. Hold your head still briefly for dodge initialization. Hand punch detection does not need a saved guard position or punch calibration. `Reset head/history` clears the detector's short hand history and restarts head initialization.

Defaults are **640×480 requested at 30 FPS, pose lite + two hands, parallel pose/hand inference, CPU Tasks VIDEO mode**. Detector timing comes from `configs/game.json`: the harness defaults with a 50 ms per-hand punch cooldown (harness: 170 ms) and 15 ms release (40 ms). Use `--config configs/default.json` for the original harness timing. Camera drivers can ignore requested properties. Inference throughput and camera FPS are separate; 30 FPS is a target, not a guarantee. The capture slot keeps the newest camera frame instead of accumulating a backlog.

Useful alternatives:

```sh
python -m cv_mvp --camera 1 --variant full
python -m cv_mvp --camera 0 --width 640 --height 480 --fps 30
python -m cv_mvp --video /absolute/path/input.avi
python -m cv_mvp --replay /absolute/path/landmarks.jsonl
python -m cv_mvp --camera 0 --config configs/tuned-straights.experimental.json
```

`--variant` changes the pose model; hand inference stays enabled. A video uses the adjacent `input.avi.timestamps.jsonl` sidecar if present. Preserve it when moving harness recordings. `--replay` expects the harness's raw `kind: "frame"` landmark JSONL, not `cv_sample` packets or `--log` output. Video and synthetic sources are paced by default; `--unpaced` is for offline checks. Use `--input-mirrored` only when the actual input pixels are mirrored; the UI already mirrors its marker display separately.

### Punch types (v1.1)

Punch events carry `punchType`: `straight` or `hook`, for either hand (the hand is in `punch_left` / `punch_right`). Logic: `cv_mvp/punch_type.py`.

- **A hook needs a raised elbow and the wrist sweeping in from near the shoulder line or wider.** Raised = upper arm at least `hook_elbow_angle` (55°) from hanging straight down (90° = level with the shoulder), and at least `min_upper_arm` long on screen so an arm pointing at the camera does not count. Straights keep the elbow down or the wrist in front, so they are labeled the moment they fire. Without a visible elbow the wrist path decides alone.
- **The core often fires during a hook's windup**, before the sweep, so a punch with a raised elbow or wide wrist waits up to `defer_ms` (150 ms) for it. `features.punchClass.deferredMs` shows the wait.
- **Fast hooks** blur out of the hand model; the wrist is then followed with the pose model so the sweep is still measured.
- **Flat hooks** the core growth rule misses fire through a lateral trigger (`rule: "hook_lateral"`) that shares the core per-hand cooldown. Disable with `{"hook_trigger": false}`.
- Every punch reports its measurements in `features.punchClass`. Uppercuts and blocks are not classified. Change thresholds with `--punch-config`, e.g. `{"hook_elbow_angle": 70}`.

**Tune to a real player.** On the smoke page, pick a label (keys 1 straight, 2 hook, 0 off), throw 10-15 of only that, switch, and repeat; the table shows what you threw vs what was detected. Then download and fit:

```sh
python scripts/fit_punch_types.py ~/Downloads/labeled-punches-*.json --out configs/punch-types.json
python -m cv_mvp --camera 0 --punch-config configs/punch-types.json
```

The script prints the current confusion table, how well each feature separates straights from hooks, and a leave-one-out estimate for the fitted model it writes.

### Camera preview (debug)

`python -m cv_mvp --camera 0 --preview-port 8766` and open <http://127.0.0.1:8766/> for the camera with pose, hand landmarks, shoulder lines (wrist outside = wide), elbow-raised bars, live per-hand hook evidence and flashing event labels. Off by default, loopback only, separate from the game socket (which still never carries frames). Encoding adds a few ms per frame, so leave it off when measuring latency.

## 3. Connect your frontend

Copy these together into your frontend's source tree:

```text
web/contracts.ts
web/cv-provider.js
web/cv-provider.d.ts
web/integration-example.ts
```

Use `attachCv` in `integration-example.ts` and provide your Three.js marker-rendering hook, SpacetimeDB reducer hook, and a callback that clears held/transient movement when tracking becomes stale. The reducer hook receives a `PlayerAction` containing fight ID, round ID, movement ID, the original `MotionEvent`, and mapped client sample time. Rename fields at that hook to match your actual generated reducer API.

These are concrete MVP definitions derived from the proposal, not an assertion that the team already has matching generated TypeScript. [CONTRACT.md](docs/CONTRACT.md) explains the schema and ownership boundaries. The old integration draft is preserved in [UPSTREAM_CONTRACT.md](docs/UPSTREAM_CONTRACT.md); your newer diagram takes precedence where it places combat authority in SpacetimeDB.

`CvProvider` aligns Python/browser monotonic clocks, rejects stale or malformed samples, deduplicates movement IDs, checks sequence coverage, and clears transient input on disconnect/reset. `canScore` is an **input dispatch gate**, not a hit verdict. The example conservatively waits for valid dodge/head tracking before dispatching; hands can still be tracked while head initialization is pending. Synthetic and replay packets cannot score unless a caller explicitly enables test input. Always consume the provider's filtered `events`, not the raw packet's event array.

Run the frontend locally over HTTP for the simplest MVP. The bridge permits localhost HTTP origins by default. An additional exact origin can be allowed with `--origin https://your-frontend.example`; that does not provide TLS or override browser mixed-content/local-network rules. A hosted HTTPS frontend may require a secure local bridge or a browser-native CV implementation. Keep the default loopback bind for this MVP.

## 4. Measure latency

Follow [LATENCY.md](docs/LATENCY.md). The smoke page reports live camera read-to-result time, sample age at receipt, clock uncertainty, and a rolling p95. Record the same movement ID at reducer submission, authoritative state receipt, and the next rendered frame to locate integration delay. Synthetic input tests wiring; recordings test throughput and behavior. Neither measures webcam latency.

Optional local diagnostics:

```sh
python -m cv_mvp --camera 0 --log /absolute/path/new-producer-samples.jsonl
python -m cv_mvp --synthetic --seconds 5 --unpaced --transport jsonl \
  --fight-id integration-test --round-id round-1 > samples.jsonl
```

`--log` refuses to overwrite an existing file. WebSocket logs are unstamped producer samples; JSONL transport logs are wrapped samples. They contain derived coordinates/features and timings, not pixels. JSONL stdout is a debugging sink and can block on a slow consumer; use WebSocket mode for the integration latency test.

## 5. Verify before pushing

```sh
python -m pytest -q
node --test tests/provider.test.mjs
npm install
npm run check:types
```

See [VALIDATION.md](docs/VALIDATION.md) for the checks performed here. This snapshot preserves the current harness detector and its limitations. It does not claim better punch accuracy, guaranteed 30 FPS, or a completed SpacetimeDB integration. The default tuning is unchanged; the tuned-straights profile is experimental and opt-in.

## Where to change things

| Area | File |
| --- | --- |
| Native inference/capture/detection snapshot | `cv_mvp/core/` |
| Translation to the wire contract | `cv_mvp/adapter.py` |
| Pipeline lifecycle, source clock, reset | `cv_mvp/pipeline.py` |
| Socket protocol and bounded delivery | `cv_mvp/server.py`, `cv_mvp/transport.py` |
| Frontend validation, clock mapping, stale input | `web/cv-provider.js` |
| Proposed TypeScript contracts/reducer boundary | `web/contracts.ts`, `web/integration-example.ts` |
| Example actual synthetic packet | `examples/cv_sample.synthetic.json` |

Keep `adapter.py` and the browser contract mapping isolated while you continue detector tuning. The bundled core is a snapshot, not a live import of the harness. See [SNAPSHOT.json](docs/SNAPSHOT.json) for hashes and [HARNESS_NOTICES.md](docs/HARNESS_NOTICES.md) for source/model notices.
