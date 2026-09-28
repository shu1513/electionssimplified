import { answerSnippet } from "./answerSnippet";
import { formatDistrictName, formatElectionDate } from "./format";
import { profilePartyLabel } from "./partyLabel";
import { isJudicialRetentionTitle } from "./retention";

/**
 * The one-paragraph, self-contained answer a candidate page opens with:
 * who the person is, what they are running for and where and when, whether
 * they hold the office now, the profile summary, and how much sourced
 * record history the page holds.
 *
 * Same idea as electionAnswerText: an answer engine lifts one passage that
 * answers "who is Jordan Voter?" on its own, and this is every header fact
 * in plain sentences in one place. The same text feeds the page's meta
 * description, so the snippet an engine shows matches what the page says.
 *
 * Wording rules: complete sentences, no jargon, no horse-race language,
 * facts only. The summary is the researched profile summary verbatim.
 */

export type CandidateAnswerElection = {
  official_ballot_title: string;
  election_date: string;
  district: { name: string };
  is_incumbent: boolean;
  status: string;
};

export type CandidateAnswerInput = {
  display_name: string;
  party: string;
  state: string;
  current_office: string | null;
  summary: string | null;
  records: readonly unknown[];
  records_researched_through: string | null;
  elections: readonly CandidateAnswerElection[];
};

function nameWithParty(input: CandidateAnswerInput): string {
  const party = profilePartyLabel(input.party);
  return party ? `${input.display_name} (${party})` : input.display_name;
}

// "State's Attorney, Carroll County in Carroll County, Maryland" says the
// place twice: when the ballot title already names the district, the
// title stands alone. A retention question ("Shall Judge X be retained in
// office?") is not an office to run for; it reads as a retention vote.
function raceLabel(election: CandidateAnswerElection): string {
  const district = formatDistrictName(election.district.name);
  if (isJudicialRetentionTitle(election.official_ballot_title)) {
    return `a yes-or-no retention vote in ${district}`;
  }
  const place = district.split(",")[0]!.trim().toLowerCase();
  if (place && election.official_ballot_title.toLowerCase().includes(place)) {
    return election.official_ballot_title;
  }
  return `${election.official_ballot_title} in ${district}`;
}

function joinRaces(elections: readonly CandidateAnswerElection[]): string {
  const labels = elections.map((election) => `${raceLabel(election)} (${formatElectionDate(election.election_date)})`);
  if (labels.length <= 1) {
    return labels[0] ?? "";
  }
  if (labels.length === 2) {
    return `${labels[0]} and ${labels[1]}`;
  }
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

// Same status rule as the candidate page's history split: a withdrawn or
// lost candidacy is not "running" in a race whose date is still ahead.
function isExited(election: CandidateAnswerElection): boolean {
  return election.status === "withdrawn" || election.status === "lost";
}

// The first sentence: who and what race, in the tense the dates call for.
function leadSentence(input: CandidateAnswerInput, today: string): string {
  const byDate = [...input.elections].sort((a, b) => b.election_date.localeCompare(a.election_date));
  const ongoing = byDate.filter((election) => election.election_date >= today);
  const active = ongoing.filter((election) => !isExited(election));
  const who = nameWithParty(input);
  if (active.length === 1) {
    const race = active[0]!;
    const verb = isJudicialRetentionTitle(race.official_ballot_title) ? "faces" : "is running for";
    return `${who} ${verb} ${raceLabel(race)} in the ${formatElectionDate(race.election_date)} election.`;
  }
  if (active.length > 1) {
    return `${who} is on the ballot for ${joinRaces(active)}.`;
  }
  // A withdrawn candidate's name can still be printed on the ballot (the
  // roster keeps such links on purpose), so say what happened, not where
  // the name is.
  const exited = ongoing.find(isExited);
  if (exited) {
    const what = exited.status === "withdrawn" ? "withdrew from" : "is no longer a candidate for";
    return `${who} ${what} ${raceLabel(exited)} (${formatElectionDate(exited.election_date)}).`;
  }
  const past = byDate.find((election) => election.election_date < today);
  if (past) {
    const verb = isJudicialRetentionTitle(past.official_ballot_title) ? "faced" : "ran for";
    return `${who} ${verb} ${raceLabel(past)} in the ${formatElectionDate(past.election_date)} election.`;
  }
  const party = profilePartyLabel(input.party);
  return party
    ? `${input.display_name} is a ${party} candidate in ${input.state}.`
    : `${input.display_name} is a candidate in ${input.state}.`;
}

// Office held now beats the incumbent flag: it names the job.
function officeSentence(input: CandidateAnswerInput, today: string): string | null {
  const office = input.current_office?.trim();
  if (office) {
    return `${input.display_name} currently serves as ${office}.`;
  }
  const incumbent = input.elections.some(
    (election) => election.election_date >= today && !isExited(election) && election.is_incumbent
  );
  return incumbent ? `${input.display_name} is the incumbent.` : null;
}

// How much record history the page holds, and how fresh it is. Null
// records_researched_through means no records search has run yet, so an
// empty list says nothing (it is "not researched", not "none found").
function recordsSentence(input: CandidateAnswerInput): string | null {
  const through = input.records_researched_through;
  if (!through) {
    return null;
  }
  const count = input.records.length;
  const when = formatElectionDate(through);
  if (count === 0) {
    return `No verified public records were found for this candidate through ${when}.`;
  }
  return `${count === 1 ? "1 public record" : `${count} public records`} with sources, researched through ${when}, ${count === 1 ? "is" : "are"} listed below.`;
}

/**
 * The full paragraph. `today` is YYYY-MM-DD in the reader's US date so
 * "is running" turns into "ran" the day after the election.
 */
export function candidateAnswerText(input: CandidateAnswerInput, today: string): string {
  return [leadSentence(input, today), officeSentence(input, today) ?? "", input.summary?.trim() ?? "", recordsSentence(input) ?? ""]
    .filter((sentence) => sentence !== "")
    .join(" ");
}

/** The meta-description cut: whole leading sentences under the length cap. */
export function candidateAnswerSnippet(input: CandidateAnswerInput, today: string, maxLength = 200): string {
  return answerSnippet(candidateAnswerText(input, today), maxLength);
}
