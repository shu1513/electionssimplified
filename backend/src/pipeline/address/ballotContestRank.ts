import { isCongressionalDistrictBoardOfficeName } from "../../utils/congressionalDistrictBoardOffice.js";
import type { BallotLookupElectionSummary } from "./ballotLookup.js";

// ---------------------------------------------------------------------------
// State-baseline contest ranking for the `state_baseline` ballot sort: the
// generic order contests appear on US general-election ballots — federal,
// then statewide, then state legislature, then county, then municipal, then
// school districts, then ALL judicial races as a late block (highest court
// first), and ballot measures last.
//
// Judicial-at-the-end is the majority pattern, not a simplification: every
// retention state prints retention questions as a section after the other
// offices, and the nonpartisan-section states do the same for contested
// judicial races (MN Rule 8250.1810 subp 5 puts Judicial Offices dead last;
// Ohio RC 3505.04 and Michigan's ballot standards put judges on the
// nonpartisan ballot after every partisan office). Placing judges inside
// their level (TX Elec. Code 52.092, NC GS 163-165.6 style) is the minority.
//
// This is an APPROXIMATION of each state's ballot-arrangement law, good
// enough to render a ballot-shaped preview; it is not a per-state statute
// encoding. When a state's real order diverges enough to matter, add a
// per-state override here (keyed by district.state_fips) rather than
// widening the generic tiers — and validate it against that state's current
// official sample ballots, not statute text alone (several states delegate
// detail to secretary-of-state or election-board rules).
// ---------------------------------------------------------------------------

// Sparse tiers so a future per-state override can slot a contest between two
// generic levels without renumbering.
const MEASURE_RANK = 100;
const UNKNOWN_RANK = 95;

// Sub-rank inside one judicial tier: higher courts print first everywhere
// the judicial block exists (MN Rule 8250.1810: Chief Justice -> Court of
// Appeals -> District Court; same shape in MI and CA). Court level isn't in
// the data model, so the two names that are unambiguous nationwide come off
// the title; everything else shares the tier's last slot and falls to the
// generic title tie-break. (NY's trial-level "Supreme Court" is fine here:
// its scope tier is lower, and within it NY does print Supreme Court
// Justice before County Court Judge.) Fractional on purpose — the offset
// must never cross into the next integer tier. Exported for the per-state
// overrides (stateBallotOrderRules.ts), which reuse the same court split at
// their own tier positions.
export function judicialCourtOffset(title: string): number {
  if (/\bsupreme\b/i.test(title)) {
    return 0;
  }
  if (/\bappeal/i.test(title)) {
    return 0.3;
  }
  return 0.6;
}

// Rank of a summary election under the generic baseline. Lower = earlier on
// the ballot.
export function stateBaselineContestRank(
  election: Pick<
    BallotLookupElectionSummary,
    "race_type" | "discovery_contest_family" | "district" | "office" | "official_ballot_title"
  >
): number {
  if (election.race_type === "ballot_measure") {
    return MEASURE_RANK;
  }
  // The office scope names WHAT is elected; the district type only says where
  // the row is attached (a county row carries municipal ward seats too), so
  // scope wins and district_type is the fallback for unresolved offices.
  const scope = election.office?.scope ?? election.district.district_type;
  // The judicial block: 82-90, after school (80), before unknown (95).
  // Within the block, higher courts come first (judicialCourtOffset).
  const judicial = election.discovery_contest_family === "judicial_office";
  const courtOffset = judicial ? judicialCourtOffset(election.official_ballot_title) : 0;
  switch (scope) {
    case "presidential":
      return 0;
    case "statewide":
      // US Senate is a statewide-scope office but federal on the ballot.
      if (election.discovery_contest_family === "us_senate") {
        return 10;
      }
      return judicial ? 82 + courtOffset : 30;
    case "us_house":
      // Colorado's congressional-district regent and State Board of
      // Education seats print after the statewide offices and before the
      // legislature, not with the House seat.
      return isCongressionalDistrictBoardOfficeName(election.office?.canonical_name) ? 35 : 20;
    case "state_upper":
      return judicial ? 84 + courtOffset : 40;
    case "state_lower":
      return judicial ? 85 + courtOffset : 50;
    case "state_executive_council":
      // New Hampshire prints Executive Councilor after Governor and before
      // State Senator.
      return 35;
    case "county":
      return judicial ? 86 + courtOffset : 60;
    case "place":
      return judicial ? 88 + courtOffset : 70;
    case "school_elementary":
    case "school_secondary":
    case "school_unified":
      return 80;
    default:
      // Open union guard: an unmodeled scope sorts just above measures
      // instead of throwing the whole ballot render away.
      return judicial ? 90 + courtOffset : UNKNOWN_RANK;
  }
}
