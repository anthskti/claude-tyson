# AirPod + MediaPipe inference test kit

A standalone snapshot of the working `cv-local-demo` harness, with frozen model bundles. This folder is for local testing and comparison; it is separate from the hosted companion in `motion/` and is not included in its download ZIP. No Next.js server, SpacetimeDB credentials, or web client is required to see inference events.

Punches use **AirPod IMU only**. MediaPipe runs **Pose only for dodges**; hand inference and CV punch fallback remain disabled. The live defaults preserve the existing outward model, two-second history, event rearming, per-hand model selection, and quick calibration.

## Included files

| Path | Purpose |
| --- | --- |
| `harness/boxing_cv/` | Dual IMU inference, native OpenCV UI, pose dodges, USB bridge, async logs |
| `harness/models/` | Weights, normalization, channel/class order, thresholds, hand identities, provenance |
| `harness/collectors/` | Mac Swift collector and iPhone USB collector source/Xcode project |
| `harness/tests/` | Model loading, masking, calibration, buffering, dual streams and transport tests |
| `assets/mediapipe/` | Frozen Pose Lite task and source/hash notices |
| `provenance.json` | Source snapshot and copied-file hashes |

The two `airpod-*-outward-v1` bundles are the default left/right **GRU** models. `--fast` explicitly selects the separate `airpod-*-fast-v1` early-target demo models; they do not overwrite the outward weights. Despite the general “CNN models” name, the current live classifiers are GRUs. The historical `airpod-left-cnn-v1` and `airpod-left-cnn-1500-v1` bundles are **CNN–GRU complete-trial classifiers**, retained for offline comparison only. There is no historical right-hand CNN bundle in this snapshot.

## 1. Setup on the Mac

Use macOS 14+ and Python 3.11 (the existing dependency pins were tested on Apple Silicon). Xcode command-line tools are needed to compile the Mac collector. USB forwarding needs `iproxy`, provided by Homebrew's `libusbmuxd` package.

From the repository root:

```bash
# Only if these tools are not already installed:
brew install python@3.11 libusbmuxd

bash experiments/airpod-mediapipe/setup.sh
```

The setup creates an isolated `harness/.venv`, installs the pinned inference dependencies, and builds the Mac collector. It does not install a simulator, launch a collector, or modify your installed iPhone app. If needed, select another Python 3.11 executable with `PYTHON=/path/to/python3.11 bash experiments/airpod-mediapipe/setup.sh`.

## 2. Connect the two sources

1. Keep the **left AirPod connected to the Mac**, and the **right AirPod connected to the iPhone**. Use the known working two-host setup. Pairing both to the Mac does not give this harness independently selectable Core Motion streams.
2. Connect the iPhone by USB, unlock it, and trust the Mac if prompted. Keep only the intended phone connected, or pass `--udid YOUR_PHONE_UDID` to `run.sh`.
3. Open the existing iPhone collector, select the AirPod source, and start it. Keep it foregrounded. The existing working app uses the same protocol and can be reused.
4. Quit the demo's Mac collector before starting this copy, then launch:

   ```bash
   open experiments/airpod-mediapipe/harness/collectors/build/AirPodsCollector.app
   ```

   Allow Motion access and start collection in the app. This copy uses bundle ID `local.boxing.AirPodsCollector.testing`, so macOS may request its own permission. Its logs are under `harness/collectors/runs/`.

If installing on a new iPhone, open `harness/collectors/iphone/AirPodUSBCollector.xcodeproj`, use your own signing team, and install through an Xcode version compatible with the phone. The included `package-iphone-sideload.sh` can build an unsigned IPA for your existing signing installer; it does not itself sign or install the app. Provisioning profiles, account credentials, and compiled apps are not committed.

## 3. Launch inference and calibrate

Stop any other harness using localhost port 8765 or USB forwarding port 18765 first. From the repository root:

```bash
# Default outward weights, independent left and right models:
bash experiments/airpod-mediapipe/run.sh

# Alternative early-target demo weights:
bash experiments/airpod-mediapipe/run.sh --fast

# Optional video plus timestamp logs:
bash experiments/airpod-mediapipe/run.sh --record-video
```

Run one command at a time. The bridge starts `iproxy`, waits for fresh samples from both hosts, and opens the native harness. Allow camera access for the terminal/Python process. Move one AirPod at a time and verify the correct side responds.

The selected hand starts on left. Follow the on-screen prompt: press **Space** to record **rest**, then a **straight**, then a **hook**, one trial at a time. Keep your grip consistent. Press **Tab** to select the other hand and repeat. Quick calibration establishes the IMU reference frame; it does not retrain the weights. Failed rest/direction quality checks must be repeated. Detection starts independently for each hand once its calibration succeeds. **R** recalibrates the selected hand; **Q** exits the harness. **Ctrl-C** stops the bridge and its forwarding process.

To reuse an already-running Mac collector instead of starting this copy:

```bash
bash experiments/airpod-mediapipe/run.sh --left-log /absolute/path/to/current/motion.jsonl
```

For an existing **live** `streams.json` manifest or a different camera/bridge port, run the harness directly:

```bash
cd experiments/airpod-mediapipe/harness
.venv/bin/python -m boxing_cv --airpod-streams /absolute/path/to/streams.json --camera 0 --bridge-port 8766
```

This tails fresh data; it is not an offline recording replay command. You must keep the USB bridge running separately when using this direct entry point.

## 4. Find logs

The terminal prints the exact run directory. By default it is `harness/runs/airpod-usb-TIMESTAMP/`:

- `right/phone-raw.jsonl`: phone packets; `right/motion.jsonl`: mapped motion samples; `right/transport.jsonl`: clock/relay diagnostics.
- `streams.json` and `metadata.json`: source identities and transport settings.
- `inference/events.jsonl`: combined punch/dodge events with input stream identity.
- `inference/left/` and `inference/right/`: independent events, timeline, diagnostics, trials, calibration, and raw motion logs.
- `inference/pose-observations.jsonl` and `landmarks.jsonl`: CV dodge debugging.
- `inference/input.avi` and timestamp sidecar: only when `--record-video` is supplied.

Logs, videos, virtual environments, signing artifacts, and build products are ignored. Model execution and transport timings are diagnostics, not physical-punch-to-screen latency measurements.

## 5. Load the historical CNN baselines

These models require a **complete calibrated trial** at approximately 25 Hz, not a 100–200 ms live fragment. Input must be an NPZ containing `x` with shape `[T,6]` in physical units and a boolean `mask` with shape `[T]`, without batch padding. Channel order is `a_forward, a_side, a_up` (g), then `w_forward, w_side, w_up` (rad/s). Supply calibration-frame values, not the AirPod's raw device-axis API values. The loader applies the saved normalization; do not normalize twice.

```bash
cd experiments/airpod-mediapipe/harness
.venv/bin/python -m boxing_cv.cnn_baseline \
  --model models/airpod-left-cnn-1500-v1 \
  --trial /absolute/path/to/calibrated-left-trial.npz
```

The loader checks the bundle checksum, class/channel order, normalization, and original quality requirements. It prints probabilities, argmax, and the thresholded label (possibly `abstain`). These CNN bundles use class order `hook, non_punch, straight`; the live GRUs use `non_punch, straight, hook`. Always read each bundle's metadata. Full training scripts and datasets are not part of this inference snapshot.

## 6. Verify after checkout

```bash
cd experiments/airpod-mediapipe/harness
.venv/bin/python -m pytest -q
.venv/bin/python -m boxing_cv --help
.venv/bin/python -m boxing_cv.iphone_bridge --help
.venv/bin/python -m boxing_cv.cnn_baseline --help
```

Tests exercise both model pairs and both source protocols with simulated streams; they do not start a physical camera or Bluetooth collector. Loopback socket access is required. The bundled pose task and model weights are frozen copies; `provenance.json` records their source hashes. New testing changes belong here until explicitly promoted to the hosted companion.
