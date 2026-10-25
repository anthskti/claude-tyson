// Player-facing labels for the four supported anatomical punch actions.
export const PUNCH_NAME: Record<string, string> = {
  left_straight: 'LEFT STRAIGHT',
  right_straight: 'RIGHT STRAIGHT',
  left_hook: 'LEFT HOOK',
  right_hook: 'RIGHT HOOK',
};

export const ANSWER: Record<string, string> = {
  left_straight: 'block or dodge either direction',
  right_straight: 'block or dodge either direction',
  left_hook: 'dodge left; block loses to hooks',
  right_hook: 'dodge right; block loses to hooks',
};

export const DEFENSE_TEXT: Record<string, string> = {
  slipped: 'DODGED',
  blocked: 'BLOCKED',
  hook_beats_block: 'HOOK BEATS BLOCK',
  hook_beat_slip: 'HOOK CAUGHT YOUR DODGE',
  slipped_into_hook: 'CAUGHT THEM DODGING',
  clean: 'CLEAN HIT',
};

export const OFFENSE_TEXT: Record<string, string> = {
  slipped: 'they dodged it',
  blocked: 'blocked',
  hook_beats_block: 'HOOK BEATS BLOCK',
  hook_beat_slip: 'HOOK BEATS DODGE',
  slipped_into_hook: 'CAUGHT THEM DODGING',
  clean: 'CLEAN',
};

export const RULES_HTML = `
  <table class="rules">
    <tr><th>Defence</th><th>Beats</th><th>Beaten by</th></tr>
    <tr><td>Block (both gloves) · 4 stamina/s</td><td>either straight</td><td><b>either hook</b></td></tr>
    <tr><td>Dodge · 20 stamina</td><td>either straight + same-side hook</td><td><b>opposite hook</b> (×1.5)</td></tr>
  </table>
  <div class="dim">Stamina pool: 200. Left straight: 0.5 damage / 5 stamina. Right straight: 1.3 / 12. Hooks: 1.0 / 16.
  Stamina regenerates at 18/s while idle. Server decides accepted actions and damage.</div>`;
