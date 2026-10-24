// Player-facing wording for combat outcomes. Mirrors server/spacetimedb/src/rules.ts.

export const PUNCH_NAME: Record<string, string> = {
  jab: 'JAB',
  straight: 'STRAIGHT',
  hook: 'HOOK',
  uppercut: 'UPPERCUT',
  unclassified: 'PUNCH',
};

/** What to do about an incoming punch: shown with the telegraph while learning. */
export const ANSWER: Record<string, string> = {
  jab: 'slip, lean back or block',
  straight: 'slip or block',
  hook: 'lean back or block that side',
  uppercut: 'slip or lean back',
  unclassified: 'slip, lean back or block',
};

/** Toast text when *I* defend (or fail to). */
export const DEFENSE_TEXT: Record<string, string> = {
  slipped: 'SLIPPED',
  leaned_back: 'LEANED BACK',
  blocked: 'BLOCKED',
  chip: 'BLOCKED (chip)',
  hook_beat_slip: 'HOOK CAUGHT YOUR SLIP',
  slipped_into_hook: 'SLIPPED INTO THE HOOK',
  straight_beat_lean: 'STRAIGHT REACHED YOU',
  around_guard: 'HOOK AROUND THE GUARD',
  through_guard: 'UPPERCUT THROUGH THE GUARD',
  clean: 'CLEAN HIT',
};

/** Toast text when *my* punch resolves. */
export const OFFENSE_TEXT: Record<string, string> = {
  slipped: 'they slipped it',
  leaned_back: 'they leaned back',
  blocked: 'blocked',
  chip: 'chip',
  hook_beat_slip: 'HOOK BEATS SLIP',
  slipped_into_hook: 'CAUGHT THEM SLIPPING IN',
  straight_beat_lean: 'STRAIGHT BEATS LEAN',
  around_guard: 'AROUND THE GUARD',
  through_guard: 'THROUGH THE GUARD',
  clean: 'CLEAN',
};

export const RULES_HTML = `
  <table class="rules">
    <tr><th>Defence</th><th>Avoids</th><th>Beaten by</th></tr>
    <tr><td>Slip (lean L/R)</td><td>jab · straight · uppercut</td><td><b>hook</b> (worse if you slip into it)</td></tr>
    <tr><td>Lean back</td><td>jab · hook · uppercut</td><td><b>straight</b></td></tr>
    <tr><td>Block</td><td>jab · hook on that side · straight (chip)</td><td><b>uppercut</b></td></tr>
  </table>
  <div class="dim">Jab is fast and safe. Slip or lean back successfully → your next punch is a <b>counter</b> (×1.5).
  Punching drops that hand's guard.</div>`;
