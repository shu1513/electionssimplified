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
// US Senate is the one level the scope cannot tell — its offices are scope
// "statewide" — so the election's contest family lifts it to Federal.

export const BALLOT_LEVELS = [
  { key: "presidential", label: "Presidential" },
  { key: "federal", label: "Federal" },
  { key: "state", label: "State" },
  { key: "county", label: "County" },
  { key: "city", label: "City" },
  { key: "other", label: "Other" },
] as const;

export type BallotLevel = (typeof BALLOT_LEVELS)[number]["key"];

export function ballotLevel(
  scope: string | null | undefined,
  districtType: string,
  contestFamily?: string | null
): BallotLevel {
  if (contestFamily === "us_senate") {
    return "federal";
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

export function ballotLevelLabel(level: BallotLevel): string {
  return BALLOT_LEVELS.find((entry) => entry.key === level)?.label ?? "Other";
}
