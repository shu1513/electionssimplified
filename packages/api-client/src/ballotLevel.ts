// The government level a race belongs to, for the district-size sorts'
// collapsible level sections on the elections list. Mirrors ballotLevelRank
// in the backend's ballotElectionOrdering.ts, which orders the payload by
// this rank (biggest: presidential → city; smallest: the reverse) before
// population, so the list's level grouping stays purely presentational —
// consecutive runs, never a reorder.
//
// Keyed on office.scope with district_type as the fallback (ballot measures
// have no office): the two vocabularies share their words. School boards
// fold into "City" — "school district" is a level no voter thinks in, and
// the section label says "City" rather than "place" for the same reason.
// US Senate is one level the scope cannot tell — its offices are scope
// "statewide" — so the election's contest family lifts it to Federal.
// Colorado's regent and State Board of Education seats are the other: their
// offices are scope "us_house" (one seat per congressional district), but
// they are state offices, so the office name puts them under State.

export const BALLOT_LEVELS = [
  { key: "presidential", label: "Presidential" },
  { key: "federal", label: "Federal" },
  { key: "state", label: "State" },
  { key: "county", label: "County" },
  { key: "city", label: "City" },
  { key: "other", label: "Other" },
] as const;

export type BallotLevel = (typeof BALLOT_LEVELS)[number]["key"];

// Mirrors congressionalDistrictBoardOffice.ts in the backend.
const CONGRESSIONAL_DISTRICT_BOARD_OFFICE_NAMES = new Set([
  "State Board of Regents Member",
  "State Board of Education Member",
]);

export function ballotLevel(
  scope: string | null | undefined,
  districtType: string,
  contestFamily?: string | null,
  officeName?: string | null
): BallotLevel {
  if (contestFamily === "us_senate") {
    return "federal";
  }
  if (scope === "us_house" && officeName && CONGRESSIONAL_DISTRICT_BOARD_OFFICE_NAMES.has(officeName.trim())) {
    return "state";
  }
  switch (scope ?? districtType) {
    case "presidential":
      return "presidential";
    case "us_house":
      return "federal";
    case "statewide":
    case "state_upper":
    case "state_lower":
    case "state_executive_council":
      return "state";
    case "county":
      return "county";
    case "place":
    case "school_unified":
    case "school_elementary":
    case "school_secondary":
      return "city";
    default:
      return "other";
  }
}

/**
 * President, US Senate and US House office races: under the vote-power sort
 * they lead each date, ahead of the vote-power bands. Mirrors
 * isFederalLeadRace in the backend's ballotElectionOrdering.ts.
 */
export function isFederalLeadRace(raceType: string | undefined, level: string | undefined): boolean {
  return raceType !== "ballot_measure" && (level === "presidential" || level === "federal");
}

export function ballotLevelLabel(level: BallotLevel): string {
  return BALLOT_LEVELS.find((entry) => entry.key === level)?.label ?? "Other";
}
