# Fast AirPod demo mode

This opt-in mode predicts straights/hooks earlier using separately fine-tuned weights for each hand. It is intended for the operator's demo video, where additional false positives are acceptable. The default outward model, its weights, and its event policy are preserved.

## Launch

Stop the previous demo with Ctrl-C, leave the Mac and iPhone collectors running, then:

```bash
cd /Users/hanigherwi/Documents/claudetyson
bash scripts/run-cv-local-demo.sh --fast
```

The Mac keeps the left AirPod, and the iPhone sends the right AirPod over the existing USB bridge. No collector rebuild or phone reinstall is needed. The launcher passes `--fast` through the USB bridge into both inference workers.

The native window is titled **Dual AirPod FAST DEMO**, and the browser's motion status begins **FAST DEMO**. The browser indicator comes from the native process, so it confirms the loaded mode rather than a URL preference. Switching weights requires restarting the demo; there is no mid-punch hot swap.

Calibration is unchanged: select left, use SPACE for **one rest, one straight, one hook**, then TAB and repeat for right. Pose is still used only for dodging. The fast models use only six calibrated IMU channels.

To return to the original weights, stop the demo and omit `--fast`:

```bash
bash scripts/run-cv-local-demo.sh
```

Dependency/model checks without starting collectors or the game:

```bash
bash scripts/run-cv-local-demo.sh --fast --check
bash scripts/run-cv-local-demo.sh --check
```

Fast run logs are under `motion/runs/demo-fast-<timestamp>/`. Check `usb/inference/metadata.json` for the mode and per-hand model hashes; `events.jsonl` and each hand's `timeline.jsonl` contain the events/probabilities. Fast events carry `early_outward_demo_v1` and `fastDemoMode: true` in their diagnostics. Browser/backend event shapes are unchanged apart from optional local status metadata.

## What changed

1. Each original punch's positive target starts **120 ms before its outward-turnaround estimate**, clamped to at least 80 ms after motion onset and never later than the original endpoint. The positive interval lasts 400 ms.
2. Both interval boundaries are mapped through each synthetic child's recorded time warp. Original sequences, masks, partition assignments, and augmentation parameters are unchanged. No mirroring or CV features were introduced.
3. Training uses causal prefixes of at most two seconds, emphasizing the first few positive readings. The loss is evaluated at the current endpoint; future samples and annotation timestamps are never model inputs. Some post-consumption suffixes are trained as background to discourage repeat events.
4. Each hand starts from its own original outward checkpoint with a fresh optimizer, learning rate 0.0001. Normalization is verified against the accepted original-training population. Pilot weights and scalers are discarded.
5. Both hands passed the tiny memorization and real-validation pilot checks; no override was used. All accepted training examples were exposed: **1,363 left** and **1,411 right**, including originals and their synthetic descendants. Unusable annotations/quality exclusions remain excluded. The left run selected epoch 12 of 20; right selected epoch 4 of 12.
6. Validation chose a one-reading confirmation policy: left probability 0.45, right 0.65, margin 0.05. Two-reading background rearming and the 200 ms cooldown remain. Selection prioritizes correct first events, recall, then earlier detection; nuisance rejection has lower priority for this demo.
7. Inference keeps the same consumable two-second priority history. It evaluates whatever history is currently available, without waiting two seconds to fill it, and clears the classified history after firing. Gap handling, calibration and transport are unchanged.

## Recorded replay results

Replay uses the actual priority-history, consumption, rearming and gap logic. Timing compares the first correctly classified event on trials detected by both models.

| Partition | Hand | Original correct punches | Fast correct punches | Median earlier on matched punches | Fast negative trials triggering | Fast extra events on punch trials |
|---|---|---:|---:|---:|---:|---:|
| Validation | Left | 16/16 | 16/16 | 200 ms (16 matched) | 1/4 | 5 |
| Validation | Right | 16/16 | 16/16 | 160 ms (16 matched) | 2/4 | 0 |
| Test | Left | 16/16 | 14/16 | 200 ms (14 matched) | 1/4 | 5 |
| Test | Right | 14/14 | 13/14 | 160 ms (13 matched) | 3/4 | 1 |

The original model triggered on 0/4 validation negatives for both hands, 1/4 left test negatives and 0/4 right test negatives. Fast-mode misses, wrong classes and additional events are retained in the reports rather than hidden from the latency comparison.

These are small, previously inspected holdouts, not new independent testing. Labels are automatic outward-turnaround proxies, not measured impact times. Recorded replay is at 25 Hz; live callback cadence can differ. The measured gain is **model-event timing**, not guaranteed end-to-end glove latency. USB, browser scheduling and glove animation time are separate.

Detailed per-trial results: [left](fast-demo/left-comparison.json), [right](fast-demo/right-comparison.json). Learning curves: [left](fast-demo/left-learning.png), [right](fast-demo/right-learning.png).

## Artifacts and reproduction

Runtime bundles are `motion/models/airpod-left-fast-v1/` and `airpod-right-fast-v1/`, selected by `motion/models/fast-pairs.json`. The default `outward-pairs.json` and both original weight files are unchanged. Loaders enforce hand, target meaning, channel order and weight checksums, so fast bundles cannot silently load as original outward bundles.

The separate training entry point remains in the experiment kit, keeping PyTorch training and plotting dependencies out of the demo runtime:

```bash
cd /Users/hanigherwi/Documents/Codex/2026-10-21/i-x20/outputs/adaptive-boxing-cv
MPLCONFIGDIR=/tmp/boxing-fast-mpl .venv/bin/python -m boxing_cv.imu_fast_training \
  --dataset datasets/airpod-left-outward-v1 \
  --base-model models/airpod-left-outward-v1 \
  --hand left --epochs 20 --output models/airpod-left-fast-rerun
```

Replace `left` with `right` to reproduce the right model. Choose a new output directory each time. Full training reports, early-gate diagnostics, dense fast targets and per-example annotations are in the experiment kit's `models/airpod-{left,right}-fast-v1/`. No original training implementation was replaced.
