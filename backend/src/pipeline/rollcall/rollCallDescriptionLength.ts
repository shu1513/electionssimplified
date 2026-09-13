// Hard length gate for roll-call vote descriptions (plan §3: "opener +
// one-line effect, tally closes; ≤ 2 sentences"). An audit on 2026-09-13
// found every approved state roll call had drifted to a bill digest —
// 4,900 rolls averaging 6 sentences / 523 characters, fanned out to 251k
// candidate records — because nothing checked length at approval time.
// The gate runs when a judgment is applied or rewritten, never on stored
// rows, so re-applying a committed pre-gate file verbatim stays a no-op.
//
// Only length is checked. Whether the sentence states the bill's plain
// effect on people, rather than its mechanics, stays a human judgment.

export const ROLL_CALL_DESCRIPTION_MAX_SENTENCES = 3;
export const ROLL_CALL_DESCRIPTION_MAX_CHARS = 320;
export const ROLL_CALL_DESCRIPTION_MAX_SENTENCE_WORDS = 30;

// Dots that do not end a sentence: bill-type prefixes ("H.R. 1", "S. 5",
// "S.J.Res. 3"), initials ("A.J.", "John R. Lewis"), and common title/time
// abbreviations.
// They are masked before splitting so "H.R. 1. It passed 215-214." counts
// as two sentences, not four.
// Known limit: an abbreviation that itself ends a sentence ("… in the U.S.
// The House passed it") is not split, because "U.S. House" must not be.
// Zero approved rolls end a sentence that way (checked 2026-09-13); if one
// does and the gate complains about a long sentence, spell the word out.
const ABBREVIATION_DOT =
  /\b(?:H\.R|H\.J\.Res|H\.Con\.Res|H\.Res|S\.J\.Res|S\.Con\.Res|S\.Res|U\.S|a\.m|p\.m|No|Nos|Rep|Sen|Gov|Dr|Mr|Mrs|Ms|Jr|Sr|St|vs|Inc|Co|Corp|Ltd|Sec|Art|Ch|Amdt|Const)\.|\b(?:[A-Za-z]\.){2,}|\b[A-Z]\.(?=\s[A-Z][a-z])|\bS\.(?=\s\d)/g;
const SENTENCE_BREAK = /(?<=[.!?])\s+(?=["'“(]?[A-Z0-9$])/;

export function splitRollCallSentences(text: string): string[] {
  const masked = text.trim().replace(ABBREVIATION_DOT, (match) => match.replace(/\./g, "․"));
  return masked
    .split(SENTENCE_BREAK)
    .map((sentence) => sentence.replace(/․/g, ".").trim())
    .filter((sentence) => sentence.length > 0);
}

function countWords(sentence: string): number {
  return sentence.split(/\s+/).filter((token) => token.length > 0).length;
}

/**
 * Returns null when the description fits, otherwise one plain sentence
 * naming the first limit it breaks (sentences, characters, longest
 * sentence), so the operator knows which to cut.
 */
export function describeRollCallDescriptionLengthProblem(text: string): string | null {
  const trimmed = text.trim();
  const sentences = splitRollCallSentences(trimmed);
  if (sentences.length > ROLL_CALL_DESCRIPTION_MAX_SENTENCES) {
    return `has ${sentences.length} sentences (max ${ROLL_CALL_DESCRIPTION_MAX_SENTENCES}): vote + plain effect, then the tally`;
  }
  if (trimmed.length > ROLL_CALL_DESCRIPTION_MAX_CHARS) {
    return `is ${trimmed.length} characters (max ${ROLL_CALL_DESCRIPTION_MAX_CHARS})`;
  }
  const longest = sentences.reduce((worst, sentence) => Math.max(worst, countWords(sentence)), 0);
  if (longest > ROLL_CALL_DESCRIPTION_MAX_SENTENCE_WORDS) {
    return `has a ${longest}-word sentence (max ${ROLL_CALL_DESCRIPTION_MAX_SENTENCE_WORDS} words per sentence)`;
  }
  return null;
}
