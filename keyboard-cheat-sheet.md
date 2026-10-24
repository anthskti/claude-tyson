# Keyboard cheat sheet

The client uses a keyboard stand-in for the webcam. Keys are the player's own body: A is your anatomical left. Holds last until you release the key. The first ~1 second after load (and after C) is calibration; punches during that window are ignored.

Start the scene from the repo root with `bun run dev` (http://localhost:3001). Shadowboxing (your gloves) works with the server offline. The opponent only punches, blocks, and reacts once a match is running (`spacetime start`, then publish the module, then **Fight adaptive bot**).

## Movement and guard

| Key | Hold | What you do |
| --- | --- | --- |
| A | yes | Slip left |
| D | yes | Slip right |
| S | yes | Lean back |
| Q | yes | Block with the left glove |
| E | yes | Block with the right glove |
| W | yes | Block with both gloves |

## Punches

| Key | Hand | Punch |
| --- | --- | --- |
| J | left | Jab |
| U | left | Hook |
| M | left | Uppercut |
| K | right | Straight |
| I | right | Hook |
| , | right | Uppercut |

## Tracking

| Key | What it does |
| --- | --- |
| T | Toggle tracking lost. The fight pauses and incoming hits do not score until you press T again. |
| C | Recalibrate. |

A and D together cancel out. Releasing every key returns you to a neutral stance.

## Webcam (CV bridge)

Pick **Keyboard** or **Camera (CV bridge)** on the menu, or click the `input:` chip at the top right during a fight. The choice is per tab, so two local clients can use different inputs. You can also preset it in the URL: `?input=camera` or `?input=keyboard`.

In camera mode the game connects to the Python CV bridge (`python -m cv_mvp --camera 0` in `cv-mvp/`) at `ws://127.0.0.1:8765` and presses these keys for you. The keyboard's punch, slip and guard keys (J U K I A D Q E W) are ignored, so everything you see came from CV. A small camera box at the top right shows your webcam with the tracked head and wrists; its border is green when your head and both hands are in frame.

Before each camera match, a short calibration runs: step into frame, hold your fighting stance, then hold your block. Blocks are detected by comparing each wrist's position (relative to your head) with those two poses. The calibration is saved, so later matches offer **Use last calibration**. The `last cv:` chip shows each classification and the key it became. The bridge accepts one client at a time, so only one tab can use the camera. `?cvBridge=ws://127.0.0.1:8799` points a tab at a different bridge, such as `python -m cv_mvp --synthetic --port 8799`.

| CV classification | Key |
| --- | --- |
| `punch_left` straight | J |
| `punch_left` hook | U |
| `punch_right` straight | K |
| `punch_right` hook | I |
| `dodge_left` | hold A |
| `dodge_right` | hold D |
| `return_neutral` | release A/D |
| left glove at your block position | hold Q |
| right glove at your block position | hold E |

CV does not classify uppercuts yet. Override the URL, or turn it off with `off`, using `NEXT_PUBLIC_CV_BRIDGE_URL`.
