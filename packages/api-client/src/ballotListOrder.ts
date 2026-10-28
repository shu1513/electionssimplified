import type { ElectionSummary } from "./types";

// The backend's hasNothingToRead: an office race with no published candidate
// list and no recorded result shows a placeholder card, so the list sinks it
// below every readable race. Measures are exempt (zero candidates is their
// normal state).
function hasNothingToRead(election: Pick<ElectionSummary, "race_type" | "candidate_count" | "has_results">): boolean {
  return election.race_type !== "ballot_measure" && election.candidate_count === 0 && !election.has_results;
}

/**
 * The order a flat list (the mobile ballot screens) should render a ballot
 * payload in. Under every list sort but state_baseline the payload already
 * reads earliest date first with the candidate-less races sunk to the end,
 * so it is returned as-is. state_baseline ("Ballot order") is positional —
 * ranked across dates, no sink — because the ballot preview needs the raw
 * slot; a list restores the date sections and the sink here and keeps the
 * ballot order within each date (sort() is stable). The web list pages do
 * the same regrouping in ElectionList.
 */
export function ballotListOrder<Election extends Pick<ElectionSummary, "election_date" | "race_type" | "candidate_count" | "has_results">>(
  elections: readonly Election[],
  sort: string
): Election[] {
  if (sort !== "state_baseline") {
    return [...elections];
  }
  return [...elections].sort((a, b) => {
    const aEmpty = hasNothingToRead(a) ? 1 : 0;
    const bEmpty = hasNothingToRead(b) ? 1 : 0;
    if (aEmpty !== bEmpty) {
      return aEmpty - bEmpty;
    }
    if (a.election_date !== b.election_date) {
      return a.election_date < b.election_date ? -1 : 1;
    }
    return 0;
  });
}
