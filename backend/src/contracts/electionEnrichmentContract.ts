import type { ElectionDistrictType, ElectionSenateClass, ElectionStage } from "../types/election.js";

export const ELECTION_DRAFT_SCHEMA_VERSION = "elections_draft_v1" as const;
export const ELECTION_ENRICHMENT_SCHEMA_VERSION = "elections_enrichment_v1" as const;
export const ELECTION_PROMPT_VERSION = "elections_v2" as const;

export const ELECTION_RACE_TYPES = ["office", "ballot_measure"] as const;
export const ELECTION_STAGES: readonly ElectionStage[] = [
  "primary",
  "general",
  "runoff",
  "special",
] as const;

export const ELECTION_SENATE_CLASSES: readonly ElectionSenateClass[] = [
  "class_i",
  "class_ii",
  "class_iii",
] as const;

export const ELECTION_ALLOWED_DISTRICT_TYPES: readonly ElectionDistrictType[] = [
  "statewide",
  "us_house",
  "state_upper",
  "state_lower",
  "county",
  "place",
  "school_elementary",
  "school_secondary",
  "school_unified",
  "local_special",
] as const;
