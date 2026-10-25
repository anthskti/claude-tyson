# Hosted CV and motion integration

`feat/cv-and-motion` starts from main. It replaces the deprecated `cv-mvp` Python package with the tested `motion/` runtime. The game continues to run on Vercel and uses the existing SpacetimeDB reducers. The companion starts no frontend or database server.

## Input paths

- **Keyboard:** unchanged.
- **Camera:** the website obtains camera permission and runs the existing Pose and Hands MediaPipe workers (`src/game/cv/browserCv.ts`). This capability was already implemented on main; it does not need a Python process.
- **AirPods + camera:** the downloaded Mac companion runs the two independent Python outward models and OpenCV/MediaPipe Pose in parallel. Left AirPod stays on the Mac; right AirPod stays on the iPhone and crosses USB. Pose supplies dodges only. No CV hand inference or fallback punch thresholds run in this mode. The companion's native window owns the webcam and calibration.

The browser receives classified events, pose validity/state, and raw accelerometer/gyro/gravity/attitude samples over a loopback WebSocket. Raw samples populate `AirPodProvider.latestRaw` for browser diagnostics and are never sent to SpacetimeDB. The raw browser feed is bounded, freshness-limited telemetry; complete original logs stay in the companion's run directory. The browser uses the existing contracted event/reducer path, retaining anatomical hand, class, session, event identity and immediate local animation. The backend remains authoritative for accepted actions and damage.

The standard branch ships only the original outward-aligned left/right weights. The permissive early-target fast models remain on `cv-local-demo`.

## Deploy and install

This feature must first be deployed to a Vercel preview or production. Merely running the companion against the old production page will not add the new browser input provider. This work does not deploy or change the current production website.

The build generates `/downloads/motion-companion.zip` and its SHA-256 checksum. The input menu includes **Download Mac companion**. The archive contains source, frozen original models, the native Pose model, Mac/iPhone collectors, and setup scripts. It excludes recordings, environments, signing profiles, build products, private pairing tokens, training code and demo-fast weights.

On an Apple Silicon Mac with macOS 14+, install Python 3.11, Xcode command-line tools, and `iproxy` (`brew install libusbmuxd`). Extract the archive, enter `motion-companion`, then:

```bash
bash scripts/setup-motion-companion.sh
bash scripts/run-motion-companion.sh --check --website https://YOUR-PREVIEW.vercel.app
bash scripts/run-motion-companion.sh --website https://YOUR-PREVIEW.vercel.app
```

No Node, Bun, Next development server or local database is required by the downloaded companion. Building the website remains a normal repository/Vercel operation.

Keep the existing iPhone collector if already installed. For a new phone, open `motion/collectors/iphone/AirPodUSBCollector.xcodeproj`, choose your signing team and the physical device, enable Developer Mode and run it. Apple signing/device support still applies; the download is not a pre-signed distributable iPhone app.

1. Connect the left bud to the Mac and the right bud from the other pair to the iPhone. Plug the phone into the Mac via USB.
2. On the iPhone, select Right AirPod and start. Keep it foregrounded. Start a left recording in the Mac collector.
3. Open the private pairing link printed by the companion in Chrome/Edge. Allow the site's local/loopback-network permission if prompted.
4. In the native window: SPACE through **rest → straight → hook** for left, TAB, then repeat for right. Keep your head centered briefly for the pose reference.
5. Choose AirPods + camera in the game. Both hands and pose must be fresh before starting a match. Keyboard and camera-only modes remain available.

`--left-log /absolute/path/motion.jsonl` reuses an existing Mac collector. `--udid PHONE_ID` pins the USB phone. `--no-open` prints the pairing link without opening a browser. The existing collectors' wire protocols are unchanged.

Only one companion and one consuming game tab can run at once. Stop the local demo before starting this companion because both use ports 8765/18765 and the webcam. Ctrl-C stops only this launcher's child processes. Logs are under `motion/runs/companion-<timestamp>/`; pose/calibration/model diagnostics remain in `usb/inference/`.

## Hosted connection boundary

The bridge binds **127.0.0.1**. The companion accepts exactly the website origin specified with `--website`; there are no wildcard Vercel origins. Hosted connections must authenticate with a fresh random per-run token before they can receive raw motion or events. The token travels in the page fragment, which is not sent in the HTTP request, and is removed from the address bar and retained only in that tab's session storage. A private local pairing file is mode 0600, ignored by Git and deleted on normal shutdown. Reconnecting is supported; another origin or wrong token is rejected.

Chromium's Local Network Access policy now covers WebSockets; the site may need explicit permission to connect to the companion. See [Chrome 147 release notes](https://developer.chrome.com/release-notes/147) and [MDN Local network access](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Local_network_access). This initial hosted path targets Chrome/Edge. Cross-browser HTTPS-to-loopback behavior and real Vercel preview permissions need end-to-end verification; do not disable browser security or expose the companion on a public interface.

## Remaining integration work

The first working slice deliberately reuses the proven native pose/calibration pipeline. Moving AirPod-mode Pose into the existing browser worker, and replacing native calibration controls with browser controls, is the next step; it is not implemented by this change. It will require merging browser pose and native IMU events under one session and preserving stale-stream behavior. No raw camera frames should cross the WebSocket or backend.

Before merge, exercise the feature on an actual HTTPS preview with physical controllers, verify allowed/denied local-network permissions, switch all input modes, and record event-to-glove timing. Automated tests can verify protocol/hand isolation, auth, telemetry and reducer shapes; they cannot establish that live hosted latency or platform permission flow has passed.

## Development checks

```bash
bun test engine input src/game/cv scripts/package-motion.test.ts
motion/.venv/bin/python -m pip install -r motion/requirements-dev.txt
motion/.venv/bin/python -m pytest -q motion/tests
bun run build
```

No backend gameplay changes are introduced by this integration. The branch includes the latest main updates, including the backend test fixes.
