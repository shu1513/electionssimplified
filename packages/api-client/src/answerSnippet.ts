/**
 * The search-snippet cut of an answer paragraph: whole sentences from the
 * front, up to roughly the length engines show before truncating. Never
 * cuts a sentence in half; a lone over-long first sentence stays whole.
 * Shared by the election and candidate answer paragraphs so both pages'
 * meta descriptions are cut by one rule.
 */
export function answerSnippet(text: string, maxLength = 200): string {
  // Split only where end punctuation is followed by whitespace, so "$6.5
  // million" or "St. Louis" inside a summary never breaks a sentence.
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== "");
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
