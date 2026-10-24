// Keyboard fallback: build/test the whole game before pose tracking works,
// and a demo safety net if the venue lighting breaks MediaPipe.
//   J jab   K cross   U left hook   I right hook   N left uppercut   M right uppercut
//   Space (hold) guard   A dodge left   D dodge right
import type { Input, Punch } from "../engine/engine";

const PUNCH_KEYS: Record<string, Punch> = {
  KeyJ: "jab", KeyK: "cross", KeyU: "hook_l", KeyI: "hook_r", KeyN: "upper_l", KeyM: "upper_r",
};

export function attachKeyboard(onInput: (i: Input) => void): () => void {
  const down = (e: KeyboardEvent) => {
    if (e.repeat) return;
    if (PUNCH_KEYS[e.code]) onInput({ who: "player", kind: "punch", punch: PUNCH_KEYS[e.code] });
    else if (e.code === "Space") { e.preventDefault(); onInput({ who: "player", kind: "guard", on: true }); }
    else if (e.code === "KeyA") onInput({ who: "player", kind: "dodge", dir: "L" });
    else if (e.code === "KeyD") onInput({ who: "player", kind: "dodge", dir: "R" });
  };
  const up = (e: KeyboardEvent) => {
    if (e.code === "Space") onInput({ who: "player", kind: "guard", on: false });
  };
  window.addEventListener("keydown", down);
  window.addEventListener("keyup", up);
  return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
}
