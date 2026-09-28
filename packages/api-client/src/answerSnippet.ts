// A period after one of these is not a sentence end: a middle initial
// ("John A. Smith"), a suffix ("George Psoras Jr."), or a title/place
// abbreviation ("St. Louis", "Dr. Lee"). Without this, a long lead sentence
// naming "John A. Smith" would be cut to "John A.".
const NOT_A_SENTENCE_END = /(?:^|\s)(?:[A-Z]|Jr|Sr|St|Mt|Ft|Dr|Mr|Mrs|Ms|Gen|Col|Lt|Sgt|Rep|Sen|Gov|Hon|Inc|Co)\.$/;

/** Whole sentences of `text`, split only at real sentence ends. */
export function splitSentences(text: string): string[] {
  // Split only where end punctuation is followed by whitespace, so "$6.5
  // million" never breaks a sentence; then glue back the pieces whose
  // "period" was an initial or abbreviation.
  const pieces = text
    .split(/(?<=[.!?])\s+/)
    .map((piece) => piece.trim())
    .filter((piece) => piece !== "");
  const sentences: string[] = [];
  for (const piece of pieces) {
    const previous = sentences[sentences.length - 1];
    if (previous !== undefined && NOT_A_SENTENCE_END.test(previous)) {
      sentences[sentences.length - 1] = `${previous} ${piece}`;
    } else {
      sentences.push(piece);
    }
  }
  return sentences;
}

/**
 * The search-snippet cut of an answer paragraph: whole sentences from the
 * front, up to roughly the length engines show before truncating. Never
 * cuts a sentence in half; a lone over-long first sentence stays whole.
 * Shared by the election and candidate answer paragraphs so both pages'
 * meta descriptions are cut by one rule.
 */
export function answerSnippet(text: string, maxLength = 200): string {
  const sentences = splitSentences(text);
  let snippet = "";
  for (const sentence of sentences) {
    const next = snippet ? `${snippet} ${sentence}` : sentence;
    if (snippet && next.length > maxLength) {
      break;
    }
    snippet = next;
  }
  return snippet;
}
