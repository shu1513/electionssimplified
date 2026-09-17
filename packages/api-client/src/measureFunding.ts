import type { BallotMeasureFunding, BallotMeasureFundingSide } from "./types";

// Display rules for "who funds each side of a measure", shared by the web and
// mobile election pages so both say the same thing.

export function measureFundingSharedNote(side: BallotMeasureFundingSide): string | null {
  if (!side.shared_with_other_measures || side.top_donors.length === 0) {
    return null;
  }
  return "Some of this money went to groups that also work on other measures.";
}

/** True when neither side has a donor: the page says so in one line. */
export function measureFundingIsEmpty(funding: BallotMeasureFunding): boolean {
  return funding.support.top_donors.length === 0 && funding.oppose.top_donors.length === 0;
}
