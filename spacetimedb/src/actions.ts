// Kept out of index.ts so the module file only exports tables/reducers.
import { ALL_PUNCHES, type Input, type Punch } from "./engine";

/** Parse an `act` action string into an engine Input (exported for tests and the client). */
export function parseAction(action: string): Input | null {
  if ((ALL_PUNCHES as string[]).includes(action)) return { who: "player", kind: "punch", punch: action as Punch };
  switch (action) {
    case "guard_on": case "guard_off": return { who: "player", kind: "guard", on: action === "guard_on" };
    case "dodge_L": case "dodge_R": return { who: "player", kind: "dodge", dir: action === "dodge_L" ? "L" : "R" };
    case "lean_L": case "lean_R": return { who: "player", kind: "lean", dir: action === "lean_L" ? "L" : "R" };
    case "lean_off": return { who: "player", kind: "lean", dir: null };
    case "tracking_lost": case "tracking_ok": return { who: "player", kind: "tracking", ok: action === "tracking_ok" };
  }
  return null;
}
