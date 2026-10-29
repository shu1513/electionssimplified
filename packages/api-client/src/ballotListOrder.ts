import type { ElectionSummary } from "./types";

// The backend's hasNothingToRead: an office race with no published candidate
// list and no recorded result shows a placeholder card, so the list sinks it
// below every readable race. Measures are exempt (zero candidates is their
// normal state).
function hasNothingToRead(election: Pick<ElectionSummary, "race_type" | "candidate_count" | "has_results">): boolean {
  return election.race_type !== "ballot_measure" && election.candidate_count === 0 && !election.has_results;
}

/**
 * The order a flat list (the mobile ballot screens) renders a ballot payload
 * in: readable races first, earliest election date first, the payload's own
 * order within a date (sort() is stable). Under every list sort but
 * state_baseline the payload already reads this way, so this is the identity
 * for them. state_baseline ("Ballot order") is positional — ranked across
 * dates, no empty-race sink — because the ballot preview needs the raw slot;
 * this restores the date sections and the sink around it and keeps the
 * ballot order within each date. Applied regardless of which sort produced
 * the payload, so a list whose sort is not yet known (the saved ballot
 * before its preferences load) still reads right. The web list pages do the
 * same regrouping in ElectionList.
 */
export function ballotListOrder<
  Election extends Pick<ElectionSummary, "election_date" | "race_type" | "candidate_count" | "has_results">,
>(elections: readonly Election[]): Election[] {
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
