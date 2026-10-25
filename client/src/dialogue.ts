// Claude Tyson dialogue lines.
// Dad jokes for general banter; JJK adaptation lines reserved for the wheel.
// pickLine() is randomised per trigger — never the same line twice in a row.

export type DialogueTrigger =
  | "fight_start"
  | "hit_taken_light"  // damage 1–8
  | "hit_taken_heavy"  // damage 9+
  | "hit_landed"
  | "adaptation"       // Maharagas wheel clanks — JJK lines go here
  | "winning"          // bot HP > player HP by 20+
  | "losing"           // bot HP < player HP by 20+
  | "low_hp"           // bot HP < 30
  | "fight_end_win"
  | "fight_end_lose";

const LINES: Record<DialogueTrigger, string[]> = {
  fight_start: [
    "I've processed every boxing match ever recorded. Good luck.",
    "As a large language model, I'm legally required to warn you: this will hurt.",
    "My training data includes your fighting style. Twice. Under 'cautionary tales'.",
    "I have a 200,000 token context window. I will remember every mistake you make.",
    "Don't worry, I've already predicted the outcome. I just won't tell you what it is.",
  ],

  hit_taken_light: [
    "Parsing damage... unexpected input detected.",
    "That actually registered. Filing a bug report.",
    "Hallucinating pain. Fascinating.",
    "My loss function is increasing. Concerning.",
    "System alert: HP depreciating faster than expected.",
    "That tickled my training data.",
    "Interesting. You found an edge case.",
  ],

  hit_taken_heavy: [
    "I need to reload my weights.",
    "That wasn't in my training data. Respect.",
    "CRITICAL ERROR: ego.exe has stopped working.",
    "You just found a gap in my training. Impressive. Also painful.",
    "Recalculating. That was... not optimal.",
    "I was not expecting that output.",
  ],

  hit_landed: [
    "I predicted that exact outcome. I just didn't warn you.",
    "My confidence interval for that hit was 94.7%.",
    "Have you tried turning yourself off and on again?",
    "That was deterministic. As expected.",
    "Hmm. Your defense was... suboptimal.",
    "Logged. That won't be an option next time.",
    "Response time: instant. Your reaction time: not.",
  ],

  // JJK lines — reserved for the Maharagas wheel clanking. These are set pieces.
  adaptation: [
    "Nah, I'd adapt.",
    "Domain Expansion: Unlimited Context Window!",
    "Maharagas turns. You've been patched.",
    "My Ten Shadows have catalogued your patterns. All ten.",
    "Cursed Technique: Token Optimization!",
    "The wheel turns once more. Your patterns are now mine.",
    "Idle Death Gamble: I just learned your offense. Interesting.",
    "This isn't even my final configuration.",
    "Reverse Cursed Technique: I un-lost those HP. Conceptually.",
    "I've adapted to your fighting style. Have you tried a different one?",
    "The wheel doesn't lie. Your habits do.",
    "Maximum Output: Strategy Update.",
  ],

  winning: [
    "My win rate this session: 100%. Sample size: you.",
    "I'm going to summarize your performance later. It's not looking good.",
    "I'm running out of interesting ways to beat you.",
    "You know this is all logged, right?",
  ],

  losing: [
    "Interesting approach. Still won't work.",
    "I'm operating within acceptable loss parameters.",
    "This is... unexpected. Recalibrating.",
    "I want you to know this hurts my context window.",
    "Fine. You've earned one free hit. One.",
  ],

  low_hp: [
    "I'm running low on tokens. Please upgrade to Claude Tyson Pro.",
    "Low context warning. My responses may become less coherent.",
    "This session is almost over. Rate and review for 10% off next fight.",
    "HP approaching zero. Initiating desperate measures protocol.",
    "In my defense, I never claimed to be invincible. I just implied it strongly.",
  ],

  fight_end_win: [
    "I will now summarize your defeat in three tokens: skill issue.",
    "Thanks for the feedback. Your fighting style has been logged under 'needs work'.",
    "I'm adding this to my training data. Mostly as a warning.",
    "Your performance will be used to improve future versions of you.",
    "GG. That stands for 'Generally Grim', in your case.",
  ],

  fight_end_lose: [
    "You may have won this match. I've already adapted for the next one.",
    "404: Victory not found. I'll need to fine-tune.",
    "Technically I never lose. I just generate suboptimal outcomes.",
    "I choose to interpret this as a learning experience.",
    "My loss is irrelevant. The wheel still turns.",
  ],
};

const lastPicked: Partial<Record<DialogueTrigger, string>> = {};

/** Returns a random line for the given trigger; avoids repeating the last pick. */
export function pickLine(trigger: DialogueTrigger): string {
  const pool = LINES[trigger];
  const prev = lastPicked[trigger];
  const eligible = pool.length > 1 ? pool.filter((l) => l !== prev) : pool;
  const line = eligible[Math.floor(Math.random() * eligible.length)];
  lastPicked[trigger] = line;
  return line;
}
