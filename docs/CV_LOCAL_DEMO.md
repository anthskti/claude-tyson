# Local AirPod demo

This branch runs the frontend on your Mac and keeps the existing shared SpacetimeDB backend authoritative. The Vercel integration is not implemented here.

```text
Left AirPod → Mac collector ──────────────→ left outward model ─┐
Right AirPod → iPhone collector → USB ─────→ right outward model ├→ localhost WebSocket → local game → existing reducers
Mac webcam → OpenCV + MediaPipe Pose → dodge state ────────────┘
```

AirPod mode uses IMU inputs for all punch decisions and Pose for dodges. It initializes no HandLandmarker, never calls a CV punch classifier, and keeps both guards neutral. Camera-only retains the current browser Pose/Hands workers and straight/hook/block logic. Keyboard remains available.

## 1. One-time setup

Requires macOS, Python **3.11**, Node/npm, Xcode command-line tools, and `iproxy` (`brew install libusbmuxd` if missing). The setup installs a local Python environment, the existing frontend dependencies, a local Bun executable when needed, and builds the Mac collector. No backend publish occurs.

```sh
cd /Users/hanigherwi/Documents/claudetyson
bash scripts/setup-motion-demo.sh
bash scripts/run-cv-local-demo.sh --check
```

Keep the iPhone app you already installed. Its protocol is unchanged; no reinstall is needed. Collector sources are under `motion/collectors/`. If installing on another phone, open `motion/collectors/iphone/AirPodUSBCollector.xcodeproj` and select your own signing team, or run `bash motion/collectors/package-iphone-sideload.sh` and sign/install that IPA using your existing Sideloadly procedure. No signing identity or provisioning profile is stored in the repository.

## 2. Start the demo

Connect only the **left bud / pair A to the Mac**. Connect the **right bud / pair B to the iPhone**. Plug the phone into the Mac with USB, open AirPod USB, select **Right AirPod**, and tap Start. Keep the phone app foregrounded.

```sh
cd /Users/hanigherwi/Documents/claudetyson
bash scripts/run-cv-local-demo.sh
```

The launcher opens the packaged Mac collector (a separate app identity from the experiment kit). Stop your old collector first, or use `--left-log` below to reuse it. Click **Start new recording** there. It waits up to two minutes for a fresh physical-left stream, starts the USB relay, opens the inference harness once both streams are fresh, and opens `http://localhost:3001/?input=airpods`.

If your original collector is already recording, use its current log explicitly:

```sh
bash scripts/run-cv-local-demo.sh --left-log '/absolute/path/to/current/motion.jsonl'
```

Optional flags: `--udid PHONE_UDID` to select one USB phone, `--record-video` to save an AVI, or `--dev` for the existing Next development server. Production is the default. It rebuilds when source/config/backend settings change, and otherwise reuses the verified build.

Default backend: `wss://maincloud.spacetimedb.com`, database `claude-tyson`. To select another shared deployment, set `NEXT_PUBLIC_STDB_HOST` and `NEXT_PUBLIC_STDB_DB` in the launcher environment. The launcher deliberately overrides the normal localhost database defaults and prints its destination. It never starts or publishes a database.

Ports: local game **3001**, browser motion bridge **8765**, Mac USB forwarder **18765 → phone 8765**. The same port number on the phone is not a conflict. Only one game tab can consume motion at a time. The demo bridge binds loopback and accepts the localhost:3001 / 127.0.0.1:3001 origins.

## 3. Calibrate six trials total

Focus the **native OpenCV harness**. The left hand is selected first.

1. Press **Space**, wait for the two-second countdown, then hold still for the two-second rest recording.
2. Press **Space**, wait for the countdown, perform **one deliberate left straight toward the camera**, and return to guard.
3. Press **Space**, wait for the countdown, perform **one left hook**. After this trial, left detection enables.
4. Press **Tab** to select right; repeat **rest → straight → hook** with the right hand.
5. Hold your head centered briefly so Pose establishes the dodge reference. The browser must show both hands and pose ready before starting a match.

Rest estimates up and residual acceleration bias. The straight establishes horizontal forward, and `sideways = up × forward`. A single straight has no cross-trial agreement statistic. The hook trial records verification evidence; its old threshold/sign checks do not gate the model. No model weights or event thresholds are fitted during calibration. Use the same grip afterwards.

**R** recalibrates the selected hand and resets the head reference. A USB reconnection or sensor reference change invalidates only the affected hand's IMU calibration. Repeat its three trials. A short sample gap follows the original model's recovery policy. Optional labeled tests after calibration: **1** straight, **2** hook, **3** wrist twist, **4/5** dodges, **6** short flick. These record diagnostics; they do not train.

## 4. Play and verify

Choose **AirPods (local demo)**, then fight the adaptive bot or join PvP. The browser does not request a second webcam stream in this mode. The camera preview and calibration remain in the native harness.

- Move each bud separately: only its model should report motion/events.
- Throw each of the four punches, then dodge left/right. AirPod mode has no gesture blocks or block calibration.
- Disconnect the right stream: left stays calibrated; the HUD reports right unavailable. Backend acceptance still requires fresh usable pose.
- Cover/lose the camera: pose becomes invalid and the backend will not accept punches without usable tracking. The IMU workers remain separate; camera reconnection resets its reference.
- Switch to **Keyboard** or **Camera** in the menu. The motion socket closes and the native worker releases the webcam. Camera mode runs the existing browser classifier and guard calibration. Switching back reconnects the harness and reacquires Pose. If another application owns the camera, close that application and retry.

Punch animation is predicted locally as soon as the event arrives; server acceptance can still reject recovery/stamina/defense violations. Model detection, reducer submission, server acceptance, and damage resolution are different stages.

## 5. Timing and logs

Every run prints `motion/runs/demo-YYYYMMDD-HHMMSS/`:

```text
frontend.log
motion.log                         relay and harness terminal output
usb/streams.json                   exact source paths
usb/right/phone-raw.jsonl           original iPhone messages
usb/right/motion.jsonl              validated/mapped right stream
usb/right/transport.jsonl           clock, rejection, relay timing diagnostics
usb/inference/events.jsonl          combined native punches and dodges
usb/inference/pose-observations.jsonl
usb/inference/left/                 calibration, raw-motion, timeline, derived diagnostics, events
usb/inference/right/                same, independent model/profile
```

Optional video is `usb/inference/input.avi` with timestamp sidecar. Video is off by default. Raw data and detailed metrics stay local; only contracted classified events and pose/validity fields go to SpacetimeDB.

The game HUD shows **detected → submitted → accepted → resolved** counts. Open browser DevTools, enable verbose logs, and filter **`[motion]`** for event-ID-correlated stage records. `submitted` means the reducer was called; `accepted` means its attack row appeared. Resolved attacks may miss, be blocked, or be cancelled. A count difference is not automatically a classifier failure.

Timing fields distinguish:

- **Receipt → decision:** latest Mac sensor callback receipt to model decision, retained from the working harness.
- **Confirmation → decision:** first qualifying prediction to the confirmed event.
- **Decision → frame:** estimated additional native-to-browser/render time; clock alignment uses ping/pong and logs RTT/2 uncertainty. The HUD's added p95 uses visible first-person frames only.
- **Submit → accepted:** browser reducer submission to observing the matching authoritative attack row.
- **USB relay:** phone callback → Mac receipt, with clock uncertainty, in transport logs/native UI.

These are software timing measurements. They exclude unknown physical onset and Bluetooth delivery. Server startup/impact animation timing is not model inference time. The target is added decision-to-visible-frame p95 below 50 ms on the actual demo machine; do not treat that target as a measured result until a live session records it.

## 6. Stop and troubleshoot

**Q** in the harness stops inference. **Ctrl-C** in the launcher stops its frontend, bridge, and USB forwarder. Collector apps can be stopped separately; the launcher does not terminate unrelated processes.

- “No fresh LEFT”: click Start in the Mac collector, verify `sensorLocation=left`, or supply `--left-log`.
- USB waiting: keep the iPhone unlocked/foregrounded, select Right AirPod, check trust/data cable and host pairing.
- Port busy: stop the prior launcher/forwarder; this launcher will not reuse someone else's listener.
- Missing camera permission: allow the terminal/Python application camera access, close competing camera apps, rerun.
- One hand needs recalibration: focus the harness, Tab to that hand, then Space through three trials.
- Failed calibration: repeat cleanly. Stillness, sample coverage, forward-direction, source identity, and gravity consistency checks remain active.

## 7. Implementation boundary and tests

The original experiment kit is untouched. This repo contains only the live runtime, collector sources, frozen bundles and focused tests. Training, augmentation, datasets and research reports are excluded. The old `cv-mvp` Python package and its camera bridge were replaced; its browser detector port and frozen parity fixtures remain. MediaPipe assets moved to `assets/mediapipe` with identical hashes and browser URLs.

The model still normalizes the same six physical channels, uses independent left/right weights and state, examines a causal unconsumed priority history of up to two seconds, consumes classified history, and retains confirmation/rearm/cooldown behavior. There is no two-second warmup requirement.

The local adapter maps generic `straight`/`hook` to `left_straight`, `right_straight`, `left_hook`, `right_hook`, retains unique event IDs and native identities in diagnostics, and uses one canonical session for pose and both hands. `onsetMs` and `qualityScore` can be null locally because the IMU model does not measure physical onset or calibrated accuracy. Reducer schemas are unchanged. Pose/session/validity changes and punch events trigger a current `updatePose` before `submitMotionEvent`, without awaiting an extra network round trip.

```sh
# From repository root, after setup
motion/.venv/bin/python -m pytest -q motion/tests
motion/.tools/node_modules/.bin/bun test engine input src/game/cv
motion/.tools/node_modules/.bin/bun run build:demo
# Use `bun` instead if setup found an existing installation.
```

`bun run test` also invokes the backend tests. At base commit `3c46465`, `spacetimedb/src/module.test.ts` contains duplicate top-level declarations (`RING_COUNT`, `fighterAuth`, `active`, `tick`), so that suite fails to parse before executing. This demo does not modify backend rules or those unrelated tests. The new client tests verify exact reducer payloads, ordering, session/hand mapping and duplicate suppression.
