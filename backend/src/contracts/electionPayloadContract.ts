import type {
  ElectionContestFamily,
  ElectionContestScope,
  ElectionDistrictType,
  ElectionEnrichedPayload,
  ElectionEntryPayload,
} from "../types/election.js";
import {
  ELECTION_CONTEST_FAMILIES,
  ELECTION_CONTEST_SCOPES,
  districtTypeRequiresContestFamily,
} from "../types/election.js";
import {
  ELECTION_ALLOWED_DISTRICT_TYPES,
  ELECTION_RACE_TYPES,
  ELECTION_SENATE_CLASSES,
  ELECTION_STAGES,
} from "./electionEnrichmentContract.js";
import { normalizeHttpUrl } from "../utils/normalizeHttpUrl.js";
import { resolveCandidateContestPartisanshipByPolicy } from "../ai/electionPartisanshipPolicy.js";

type ParseResult =
  | { ok: true; payload: ElectionEnrichedPayload }
  | { ok: false; reason: string };

type ParseAiEntriesResult =
  | {
      ok: true;
      payload: {
        entries: ElectionEntryPayload[];
        review_decision?: "approve" | "reject";
        review_reason?: string;
      };
    }
  | { ok: false; reason: string };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const [year, month, day] = value.split("-").map((part) => Number.parseInt(part, 10));
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return false;
  }

  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function isDistrictType(value: unknown): value is ElectionDistrictType {
  return typeof value === "string" && ELECTION_ALLOWED_DISTRICT_TYPES.includes(value as ElectionDistrictType);
}

function isElectionContestFamily(value: unknown): value is ElectionContestFamily {
  return typeof value === "string" && ELECTION_CONTEST_FAMILIES.includes(value as ElectionContestFamily);
}

function isDiscoveryContestFamilyCompatible(args: {
  raceType: "office" | "ballot_measure";
  discoveryContestFamily: ElectionContestFamily;
  hasSenateMetadata: boolean;
}): boolean {
  if (args.raceType === "ballot_measure") {
    return args.discoveryContestFamily === "ballot_measure";
  }
  if (args.discoveryContestFamily === "ballot_measure") {
    return false;
  }
  if (args.hasSenateMetadata) {
    return args.discoveryContestFamily === "us_senate";
  }
  return true;
}

function isElectionStage(value: unknown): value is NonNullable<ElectionEntryPayload["election_stage"]> {
  return typeof value === "string" && ELECTION_STAGES.includes(value as NonNullable<ElectionEntryPayload["election_stage"]>);
}

// Accepts the canonical enum plus unambiguous operator spellings of the same
// class ("2", "II", "Class II", "class 2"); anything else stays rejected.
const SENATE_CLASS_BY_TOKEN: Record<string, NonNullable<ElectionEntryPayload["senate_class"]>> = {
  "1": "class_i",
  i: "class_i",
  "2": "class_ii",
  ii: "class_ii",
  "3": "class_iii",
  iii: "class_iii",
};

function normalizeElectionSenateClass(
  value: unknown
): NonNullable<ElectionEntryPayload["senate_class"]> | null {
  if (typeof value !== "string") {
    return null;
  }
  if (ELECTION_SENATE_CLASSES.includes(value as NonNullable<ElectionEntryPayload["senate_class"]>)) {
    return value as NonNullable<ElectionEntryPayload["senate_class"]>;
  }
  const token = value.trim().toLowerCase().replace(/^class[\s_-]*/, "");
  return SENATE_CLASS_BY_TOKEN[token] ?? null;
}

function normalizeSources(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") {
      return null;
    }
    const url = normalizeHttpUrl(item);
    if (!url) {
      return null;
    }
    if (!seen.has(url)) {
      seen.add(url);
      normalized.push(url);
    }
  }

  return normalized.length > 0 ? normalized : null;
}

export type ParseFamilySourceUrlsResult =
  | { ok: true; familySourceUrls: Partial<Record<ElectionContestScope, string[]>> | null }
  | { ok: false; reason: string };

// The seed URLs a discovery pass reused, keyed by contest family. This map is
// carried on the payload but not on the canonical entries: the writer lifts it
// out of ai_raw_debug into election_seed_urls, so a shape the writer cannot
// read is dropped after the payload has already been accepted. That silent drop
// shipped districts with zero seed URLs (single string instead of an array is
// the easy mistake), so every deviation fails here instead.
export function parseFamilySourceUrls(value: unknown): ParseFamilySourceUrlsResult {
  if (value === undefined || value === null) {
    return { ok: true, familySourceUrls: null };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      reason: "payload.family_source_urls must be an object keyed by contest family",
    };
  }

  const familySourceUrls: Partial<Record<ElectionContestScope, string[]>> = {};
  for (const [family, urls] of Object.entries(value as Record<string, unknown>)) {
    if (!ELECTION_CONTEST_SCOPES.includes(family as ElectionContestScope)) {
      return {
        ok: false,
        reason: `payload.family_source_urls.${family} is not a known contest family (${ELECTION_CONTEST_SCOPES.join("|")})`,
      };
    }
    if (!Array.isArray(urls)) {
      return {
        ok: false,
        reason: `payload.family_source_urls.${family} must be an array of URL strings`,
      };
    }
    if (urls.length === 0) {
      return {
        ok: false,
        reason: `payload.family_source_urls.${family} must contain at least one URL string`,
      };
    }

    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const item of urls) {
      if (typeof item !== "string") {
        return {
          ok: false,
          reason: `payload.family_source_urls.${family} must be an array of URL strings`,
        };
      }
      // normalizeHttpUrl is what the writer applies before insert, so anything
      // it rejects would be dropped there just as silently.
      const url = normalizeHttpUrl(item);
      if (!url) {
        return {
          ok: false,
          reason: `payload.family_source_urls.${family} contains a URL that is not a valid http(s) URL: ${item}`,
        };
      }
      if (!seen.has(url)) {
        seen.add(url);
        normalized.push(url);
      }
    }
    familySourceUrls[family as ElectionContestScope] = normalized;
  }

  return {
    ok: true,
    familySourceUrls: Object.keys(familySourceUrls).length > 0 ? familySourceUrls : null,
  };
}

function parseEntry(value: unknown): ElectionEntryPayload | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const input = value as Record<string, unknown>;
  if (!isNonEmptyString(input.official_ballot_title)) {
    return null;
  }
  if (!isNonEmptyString(input.election_date) || !isIsoDate(input.election_date.trim())) {
    return null;
  }
  if (typeof input.race_type !== "string" || !ELECTION_RACE_TYPES.includes(input.race_type as "office" | "ballot_measure")) {
    return null;
  }
  const raceType = input.race_type as "office" | "ballot_measure";
  const sources = normalizeSources(input.sources);
  if (!sources) {
    return null;
  }

  let electionStage: ElectionEntryPayload["election_stage"] | undefined;
  if (input.election_stage !== undefined) {
    if (raceType !== "office") {
      return null;
    }
    if (!isElectionStage(input.election_stage)) {
      return null;
    }
    electionStage = input.election_stage;
  }

  let senateClass: ElectionEntryPayload["senate_class"] | undefined;
  if (input.senate_class !== undefined && input.senate_class !== null) {
    if (raceType !== "office") {
      return null;
    }
    const normalizedSenateClass = normalizeElectionSenateClass(input.senate_class);
    if (!normalizedSenateClass) {
      return null;
    }
    senateClass = normalizedSenateClass;
  }

  let termEndYear: string | undefined;
  if (input.term_end_year !== undefined && input.term_end_year !== null) {
    if (raceType !== "office") {
      return null;
    }
    if (!isNonEmptyString(input.term_end_year)) {
      return null;
    }
    const normalized = input.term_end_year.trim();
    if (!/^\d{4}$/.test(normalized)) {
      return null;
    }
    termEndYear = normalized;
  }

  let isPartisan: boolean | undefined;
  if (input.is_partisan !== undefined && input.is_partisan !== null) {
    if (typeof input.is_partisan !== "boolean") {
      return null;
    }
    if (raceType === "ballot_measure" && input.is_partisan) {
      isPartisan = false;
    } else {
      isPartisan = input.is_partisan;
    }
  }

  let seatsToFill: number | undefined;
  if (input.seats_to_fill !== undefined && input.seats_to_fill !== null) {
    if (raceType !== "office") {
      return null;
    }
    if (typeof input.seats_to_fill !== "number" || !Number.isInteger(input.seats_to_fill) || input.seats_to_fill < 1) {
      return null;
    }
    seatsToFill = input.seats_to_fill;
  }

  let discoveryContestFamily: ElectionContestFamily | undefined;
  if (input.discovery_contest_family !== undefined && input.discovery_contest_family !== null) {
    if (!isElectionContestFamily(input.discovery_contest_family)) {
      return null;
    }
    discoveryContestFamily = input.discovery_contest_family;
    if (
      !isDiscoveryContestFamilyCompatible({
        raceType,
        discoveryContestFamily,
        hasSenateMetadata: Boolean(senateClass || termEndYear),
      })
    ) {
      return null;
    }
  }

  return {
    official_ballot_title: input.official_ballot_title.trim(),
    election_date: input.election_date.trim(),
    race_type: raceType,
    ...(isPartisan !== undefined ? { is_partisan: isPartisan } : {}),
    ...(seatsToFill !== undefined ? { seats_to_fill: seatsToFill } : {}),
    ...(electionStage ? { election_stage: electionStage } : {}),
    ...(senateClass ? { senate_class: senateClass } : {}),
    ...(termEndYear ? { term_end_year: termEndYear } : {}),
    ...(discoveryContestFamily ? { discovery_contest_family: discoveryContestFamily } : {}),
    sources,
  };
}

function parseReviewDecisionAndReason(input: Record<string, unknown>): {
  ok: true;
  review_decision?: "approve" | "reject";
  review_reason?: string;
} | {
  ok: false;
  reason: string;
} {
  let reviewDecision: "approve" | "reject" | undefined;
  if (input.review_decision !== undefined) {
    if (input.review_decision !== "approve" && input.review_decision !== "reject") {
      return { ok: false, reason: "payload.review_decision must be approve|reject when present" };
    }
    reviewDecision = input.review_decision;
  }

  let reviewReason: string | undefined;
  if (input.review_reason !== undefined) {
    if (!isNonEmptyString(input.review_reason)) {
      return { ok: false, reason: "payload.review_reason must be non-empty string when present" };
    }
    reviewReason = input.review_reason.trim();
  }

  return {
    ok: true,
    ...(reviewDecision ? { review_decision: reviewDecision } : {}),
    ...(reviewReason ? { review_reason: reviewReason } : {}),
  };
}

export function parseAiElectionEntriesPayload(payload: unknown): ParseAiEntriesResult {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: "payload must be an object" };
  }

  const input = payload as Record<string, unknown>;
  if (!Array.isArray(input.entries)) {
    return { ok: false, reason: "payload.entries must be array" };
  }

  const entries: ElectionEntryPayload[] = [];
  for (const row of input.entries) {
    const parsed = parseEntry(row);
    if (!parsed) {
      return { ok: false, reason: "payload.entries contains invalid row" };
    }
    entries.push(parsed);
  }

  const review = parseReviewDecisionAndReason(input);
  if (!review.ok) {
    return review;
  }

  return {
    ok: true,
    payload: {
      entries,
      ...(review.review_decision ? { review_decision: review.review_decision } : {}),
      ...(review.review_reason ? { review_reason: review.review_reason } : {}),
    },
  };
}

export function parseCanonicalElectionPayload(payload: unknown): ParseResult {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: "payload must be an object" };
  }

  const input = payload as Record<string, unknown>;
  if (!isNonEmptyString(input.district_id)) {
    return { ok: false, reason: "payload.district_id must be non-empty string" };
  }
  if (!isNonEmptyString(input.district_name)) {
    return { ok: false, reason: "payload.district_name must be non-empty string" };
  }
  if (!isDistrictType(input.district_type)) {
    return { ok: false, reason: "payload.district_type is invalid" };
  }
  if (!isNonEmptyString(input.state)) {
    return { ok: false, reason: "payload.state must be non-empty string" };
  }

  if (!Array.isArray(input.entries)) {
    return { ok: false, reason: "payload.entries must be array" };
  }

  const familySourceUrls = parseFamilySourceUrls(input.family_source_urls);
  if (!familySourceUrls.ok) {
    return { ok: false, reason: familySourceUrls.reason };
  }

  const entries: ElectionEntryPayload[] = [];
  for (const [index, row] of input.entries.entries()) {
    const parsed = parseEntry(row);
    if (!parsed) {
      return { ok: false, reason: "payload.entries contains invalid row" };
    }
    // Split-pass district types research each contest family in its own
    // pass, and downstream stages read the family off the entry (judicial
    // office matching, roster research mode). An entry without one is
    // pipeline-survivable but silently loses that provenance — two live runs
    // collapsed the split passes into one and were only caught by a manual
    // post-write audit, so fail it here instead.
    if (districtTypeRequiresContestFamily(input.district_type) && !parsed.discovery_contest_family) {
      return {
        ok: false,
        reason: `payload.entries[${index}] is missing discovery_contest_family; ${input.district_type} districts research per-family passes (non_judicial_office|judicial_office|ballot_measure${input.district_type === "statewide" ? "|us_senate" : ""})`,
      };
    }
    // The inverse also holds: combined-pass types have no family plan (the
    // AI path maps scope "all" to no family), and a persisted family would
    // flip downstream office matching and record research to that family's
    // objective — e.g. a us_house entry stamped judicial_office switches the
    // race to the judicial research mode.
    if (!districtTypeRequiresContestFamily(input.district_type) && parsed.discovery_contest_family) {
      return {
        ok: false,
        reason: `payload.entries[${index}] must omit discovery_contest_family; ${input.district_type} districts research one combined pass with no per-entry family`,
      };
    }
    if (parsed.race_type === "office" && parsed.is_partisan !== undefined) {
      const fixedPolicyValue = resolveCandidateContestPartisanshipByPolicy({
        districtType: input.district_type,
        state: input.state,
        officialBallotTitle: parsed.official_ballot_title,
      });
      if (fixedPolicyValue !== undefined && parsed.is_partisan !== fixedPolicyValue) {
        return {
          ok: false,
          reason:
            `payload.entries[${index}].is_partisan=${parsed.is_partisan} contradicts fixed partisanship policy ` +
            `for ${input.state.trim()} ${input.district_type} (expected ${fixedPolicyValue})`,
        };
      }
    }
    entries.push(parsed);
  }

  const review = parseReviewDecisionAndReason(input);
  if (!review.ok) {
    return review;
  }

  // Reinstating a retired contest is a deliberate, sourced decision: the
  // flag is boolean-only and must travel with a review_reason.
  let reinstateRetired = false;
  if (input.reinstate_retired !== undefined) {
    if (typeof input.reinstate_retired !== "boolean") {
      return { ok: false, reason: "payload.reinstate_retired must be boolean when present" };
    }
    reinstateRetired = input.reinstate_retired;
  }
  if (reinstateRetired && !review.review_reason) {
    return {
      ok: false,
      reason: "payload.reinstate_retired requires a non-empty review_reason citing the source that shows the contest is real",
    };
  }

  return {
    ok: true,
    payload: {
      district_id: input.district_id.trim(),
      district_name: input.district_name.trim(),
      district_type: input.district_type,
      state: input.state.trim(),
      entries,
      ...(review.review_decision ? { review_decision: review.review_decision } : {}),
      ...(review.review_reason ? { review_reason: review.review_reason } : {}),
      ...(reinstateRetired ? { reinstate_retired: true } : {}),
    },
  };
}
