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
