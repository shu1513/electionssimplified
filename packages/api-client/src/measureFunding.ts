import { formatMoney } from "./format";
import type { BallotMeasureFunding, BallotMeasureFundingSide } from "./types";

// Display rules for "who funds each side of a measure", shared by the web and
// mobile election pages so both say the same thing.

// A side's money can sit partly in committees that also work on other
// measures. Below this share of the side's total the note is noise (a small
// multi-measure PAC next to an $8 million single-measure committee).
const SHARED_NOTE_MIN_SHARE = 0.1;

export function measureFundingSharedNote(side: BallotMeasureFundingSide): string | null {
  if (side.total_raised <= 0 || side.shared_with_other_measures_raised / side.total_raised < SHARED_NOTE_MIN_SHARE) {
    return null;
  }
  if (side.shared_with_other_measures_raised >= side.total_raised) {
    return "The groups that raised this also work on other measures.";
  }
  return `${formatMoney(side.shared_with_other_measures_raised)} of this was raised by groups that also work on other measures.`;
}

/** True when neither side reported any money: the page says so in one line. */
export function measureFundingIsEmpty(funding: BallotMeasureFunding): boolean {
  return funding.support.total_raised <= 0 && funding.oppose.total_raised <= 0;
}
