// Colorado elects the University of Colorado Board of Regents and the State
// Board of Education one member per congressional district (Colo. Const.
// art. IX §§ 1 and 12), on the same ballot as the U.S. House seat ("Regent
// of the University of Colorado - Congressional District 2", "State Board of
// Education Member - Congressional District 1", county sample ballots, live).
// Those contests hang off the us_house district row, and each resolves to a
// us_house-scoped board office (migration 304) instead of the House seat.
//
// Colorado only: no other state elects either board from a congressional
// district, so the same title on another state's us_house row is a
// mis-scoped entry and keeps failing loudly.

export const US_HOUSE_STATE_BOARD_OF_REGENTS_CANONICAL_NAME = "State Board of Regents Member";
export const US_HOUSE_STATE_BOARD_OF_EDUCATION_CANONICAL_NAME = "State Board of Education Member";

const CONGRESSIONAL_DISTRICT_BOARD_OFFICE_NAMES = new Set<string>([
  US_HOUSE_STATE_BOARD_OF_REGENTS_CANONICAL_NAME,
  US_HOUSE_STATE_BOARD_OF_EDUCATION_CANONICAL_NAME,
]);

const STATE_BOARD_OF_EDUCATION_PATTERN = /\bstate board of education\b/i;
const REGENT_PATTERN = /\bregents?\b/i;

function isColorado(state: string): boolean {
  const normalized = state.trim().toLowerCase();
  return normalized === "co" || normalized === "colorado";
}

// The us_house-scoped board office a Colorado congressional-district title
// names, or null when the title is not one of those two boards.
export function congressionalDistrictBoardOfficeName(state: string, titleText: string): string | null {
  if (!isColorado(state)) {
    return null;
  }
  if (STATE_BOARD_OF_EDUCATION_PATTERN.test(titleText)) {
    return US_HOUSE_STATE_BOARD_OF_EDUCATION_CANONICAL_NAME;
  }
  if (REGENT_PATTERN.test(titleText)) {
    return US_HOUSE_STATE_BOARD_OF_REGENTS_CANONICAL_NAME;
  }
  return null;
}

// True when a title names a regent or state board of education seat. Used
// where only the title is known: such a seat is never a U.S. House race, even
// when its title says "Congressional District".
export function namesCongressionalDistrictBoardSeat(titleText: string): boolean {
  return STATE_BOARD_OF_EDUCATION_PATTERN.test(titleText) || REGENT_PATTERN.test(titleText);
}

// True for a resolved us_house-scoped office that is one of the boards, not
// the House seat.
export function isCongressionalDistrictBoardOfficeName(canonicalName: string | null | undefined): boolean {
  return canonicalName != null && CONGRESSIONAL_DISTRICT_BOARD_OFFICE_NAMES.has(canonicalName.trim());
}
