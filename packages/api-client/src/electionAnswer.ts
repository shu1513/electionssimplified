import { formatDistrictName, formatElectionDate, formatOutcome, formatVotePowerLabel } from "./format";
import { profilePartyLabel } from "./partyLabel";
import { isRetentionRace } from "./retention";

/**
 * The one-paragraph, self-contained answer an election page opens with:
 * what the race is, where, when, who is running, and who won if anyone has.
 *
 * Search and AI answer engines lift a passage that fully answers a question
 * on its own — they do not stitch together a header strip, a candidate
 * list, and a results card. Every fact below already renders elsewhere on
 * the page; this is the same data in one place, in plain sentences, so a
 * reader (or an engine) gets the whole picture in one paragraph. The same
 * text feeds the page's meta description and Event JSON-LD description, so
 * the snippet an engine shows matches what the page says.
 *
 * Wording rules: complete sentences, no jargon, no horse-race language.
 * Facts only — it never editorializes about a candidate.
 */

export type ElectionAnswerCandidate = {
  display_name: string;
  party: string;
  is_incumbent: boolean;
  status: string;
};

export type ElectionAnswerInput = {
  race_type: string;
  official_ballot_title: string;
  district: { name: string };
  election_date: string;
  election_stage: string | null;
  seats_to_fill: number | null;
  candidates: readonly ElectionAnswerCandidate[];
  ballot_measure: { summary: string | null; result: "passed" | "failed" | null } | null;
  results: readonly { outcome: string; result_status: string; winners: readonly { candidate_name?: string; party?: string }[] }[];
  vote_power: { label: string };
  /** Present when either competitiveness chip would render. */
  competitiveness_label?: string | null;
};

function candidateLabel(candidate: ElectionAnswerCandidate): string {
  const party = profilePartyLabel(candidate.party);
  return party ? `${candidate.display_name} (${party})` : candidate.display_name;
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) {
    return names[0] ?? "";
  }
  if (names.length === 2) {
    return `${names[0]} and ${names[1]}`;
  }
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

function stageWord(stage: string | null): string {
  // formatOutcome doubles as a stage prettifier ("general" → "General").
  return stage ? `${formatOutcome(stage).toLowerCase()} election` : "election";
}

// The first sentence: what and where and when. Tense follows the date so a
// past race never reads as upcoming.
function leadSentence(input: ElectionAnswerInput, today: string, kind: "race" | "measure"): string {
  const where = formatDistrictName(input.district.name);
  const when = formatElectionDate(input.election_date);
  const upcoming = input.election_date >= today;
  if (kind === "measure") {
    return upcoming
      ? `${input.official_ballot_title} is a ballot measure in ${where} on the ${when} ballot.`
      : `${input.official_ballot_title} was a ballot measure in ${where} on the ${when} ballot.`;
  }
  const stage = stageWord(input.election_stage);
  return upcoming
    ? `The ${input.official_ballot_title} ${stage} in ${where} is on ${when}.`
    : `The ${input.official_ballot_title} ${stage} in ${where} was held on ${when}.`;
}

function rosterSentences(input: ElectionAnswerInput): string[] {
  const active = input.candidates.filter((candidate) => candidate.status !== "withdrawn");
  if (active.length === 0) {
    return [];
  }
  const seats = input.seats_to_fill && input.seats_to_fill > 1 ? input.seats_to_fill : 1;
  const sentences: string[] = [];
  if (isRetentionRace(input)) {
    sentences.push(`Voters decide yes or no on keeping ${joinNames(active.map(candidateLabel))} in office.`);
    return sentences;
  }
  if (active.length === 1 && seats === 1) {
    sentences.push(`One candidate is on the ballot, ${candidateLabel(active[0]!)}, so the race is uncontested.`);
  } else if (active.length <= seats) {
    sentences.push(
      `${active.length} candidates are running for ${seats} seats, ${joinNames(active.map(candidateLabel))}, so every candidate wins a seat.`
    );
  } else {
    const seatNote = seats > 1 ? ` for ${seats} seats` : "";
    sentences.push(`${active.length} candidates are running${seatNote}: ${joinNames(active.map(candidateLabel))}.`);
  }
  const incumbents = active.filter((candidate) => candidate.is_incumbent);
  if (incumbents.length === 1) {
    sentences.push(`${incumbents[0]!.display_name} is the incumbent.`);
  } else if (incumbents.length > 1) {
    sentences.push(`${joinNames(incumbents.map((candidate) => candidate.display_name))} are the incumbents.`);
  }
  return sentences;
}

// Only decided outcomes name anyone. A too-close or unknown row may still
// carry a recorded leader in `winners`, and calling that person the winner
// would decide a race the officials have not (same rule as resultBadges).
// "advanced" and "runoff" are decided but are not wins: say what happened.
function resultSentence(input: ElectionAnswerInput): string | null {
  const current = input.results[0];
  if (!current || current.winners.length === 0) {
    return null;
  }
  const names = joinNames(
    current.winners.map((winner) =>
      winner.party ? `${winner.candidate_name ?? "Unknown"} (${winner.party})` : (winner.candidate_name ?? "Unknown")
    )
  );
  const plural = current.winners.length > 1;
  const status = current.result_status === "certified" ? "Certified result" : "Unofficial result";
  switch (current.outcome) {
    case "won":
      return `${status}: ${plural ? "the winners are" : "the winner is"} ${names}.`;
    case "advanced":
      return `${status}: ${names} advanced to the next round.`;
    case "runoff":
      return `${status}: ${names} ${plural ? "go" : "goes"} to a runoff.`;
    default:
      return null;
  }
}

function measureSentences(input: ElectionAnswerInput): string[] {
  const measure = input.ballot_measure;
  if (!measure) {
    return [];
  }
  const sentences: string[] = [];
  if (measure.summary) {
    sentences.push(measure.summary.trim());
  }
  if (measure.result === "passed") {
    sentences.push("It passed.");
  } else if (measure.result === "failed") {
    sentences.push("It failed.");
  }
  return sentences;
}

function votePowerSentence(input: ElectionAnswerInput): string | null {
  const label = input.vote_power.label;
  if (label === "unknown" || label === "retention") {
    return null;
  }
  return `One vote here carries ${formatVotePowerLabel(label).toLowerCase()} weight compared with other races.`;
}

/**
 * The full paragraph. `today` is YYYY-MM-DD in the reader's US date so the
 * tense is right on election night.
 */
export function electionAnswerText(input: ElectionAnswerInput, today: string): string {
  if (input.race_type === "ballot_measure") {
    return [leadSentence(input, today, "measure"), ...measureSentences(input), resultSentence(input) ?? ""]
      .filter((sentence) => sentence !== "")
      .join(" ");
  }
  return [leadSentence(input, today, "race"), ...rosterSentences(input), resultSentence(input) ?? "", votePowerSentence(input) ?? ""]
    .filter((sentence) => sentence !== "")
    .join(" ");
}

/**
 * The search-snippet cut: whole sentences from the front of the paragraph,
 * up to roughly the length engines show before truncating. Never cuts a
 * sentence in half; a lone over-long first sentence stays whole.
 */
export function electionAnswerSnippet(input: ElectionAnswerInput, today: string, maxLength = 200): string {
  // Split only where end punctuation is followed by whitespace, so "$6.5
  // million" or "St. Louis" inside a measure summary never breaks a sentence.
  const sentences = electionAnswerText(input, today)
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
