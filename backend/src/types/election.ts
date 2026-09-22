export type ElectionItemType = "election";

export type ElectionRaceType = "office" | "ballot_measure";
export type ElectionStage = "primary" | "general" | "runoff" | "special";
export type ElectionSenateClass = "class_i" | "class_ii" | "class_iii";
export const ELECTION_CONTEST_FAMILIES = [
  "non_judicial_office",
  "judicial_office",
  "ballot_measure",
  "us_senate",
] as const;
export type ElectionContestFamily = (typeof ELECTION_CONTEST_FAMILIES)[number];
export const ELECTION_CONTEST_SCOPES = ["all", ...ELECTION_CONTEST_FAMILIES] as const;
export type ElectionContestScope = (typeof ELECTION_CONTEST_SCOPES)[number];

export type ElectionDistrictType =
  | "statewide"
  | "us_house"
  | "state_upper"
  | "state_lower"
  | "county"
  | "place"
  | "school_elementary"
  | "school_secondary"
  | "school_unified";

export type OfficeScope = ElectionDistrictType | "presidential";

// District types whose election discovery runs split per-family passes
// (statewide/county/place); their entries must each carry a
// discovery_contest_family. All other types run one combined "all" pass and
// omit it. Shared by the discovery planner and the payload contract so the
// plan and the validation can never disagree.
export function districtTypeRequiresContestFamily(districtType: ElectionDistrictType): boolean {
  return districtType === "statewide" || districtType === "county" || districtType === "place";
}

export type ElectionEntryPayload = {
  official_ballot_title: string;
  election_date: string; // YYYY-MM-DD
  race_type: ElectionRaceType;
  is_partisan?: boolean;
  // How many seats this contest fills ("vote for up to 3" at-large races).
  // Omitted = not recorded; display treats absent and 1 identically.
  seats_to_fill?: number;
  election_stage?: ElectionStage;
  senate_class?: ElectionSenateClass;
  term_end_year?: string;
  discovery_contest_family?: ElectionContestFamily;
  sources: string[];
};

export type ElectionEnrichedPayload = {
  district_id: string;
  district_name: string;
  district_type: ElectionDistrictType;
  state: string;
  entries: ElectionEntryPayload[];
  review_decision?: "approve" | "reject";
  review_reason?: string;
  /**
   * Manual payloads only: write entries whose identity sits in the
   * retired_election_identities ledger and close those ledger rows. Requires
   * review_reason, and the injector's --reinstate-retired flag stamps the
   * staging row before the writer honors it.
   */
  reinstate_retired?: boolean;
};

export type ElectionDraftPayload = {
  district_id: string;
  district_name: string;
  district_type: ElectionDistrictType;
  state: string;
};
