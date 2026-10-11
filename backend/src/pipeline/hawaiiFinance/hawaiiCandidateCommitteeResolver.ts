import { firstNameVariants } from "../finance/personFirstNameNicknames.js";
import { hasMiddleNameConflict } from "../finance/personNameMiddleEvidence.js";
import {
  normalizeHawaiiCscPersonNameKeys,
  searchHawaiiCscCandidateCommittees,
  type HawaiiCscCandidateCommitteeSummary,
  type HawaiiCscClientOptions,
} from "./hawaiiCscClient.js";
import {
  normalizeHawaiiCscDistrict,
  normalizeHawaiiCscOfficeLabel,
  mapHawaiiCscOffice,
  toHawaiiCscOfficeSearchInput,
} from "./hawaiiFinanceEligibleOffices.js";

export type HawaiiCandidateCommitteeResolverInput = {
  candidateName: string;
  officeScope: string;
  officeName: string;
  electionYear: number;
  district?: string | null;
  summaries: readonly HawaiiCscCandidateCommitteeSummary[];
};

export type HawaiiCandidateCommitteeSearchInput = Omit<HawaiiCandidateCommitteeResolverInput, "summaries">;

export type HawaiiCandidateCommitteeMatch = {
  committeeId: string;
  committeeName: string;
  electionPeriod: string;
  totalAmount: number;
  confidence: "exact";
  source: "csc_api";
  sourceUrl: string | null;
  matchedSummaryRowCount: number;
};

export type HawaiiCandidateCommitteeResolution =
  | ({ status: "matched" } & HawaiiCandidateCommitteeMatch)
  | {
      status: "unmatched";
      reason:
        | "missing_candidate_name"
        | "unsupported_office"
        | "missing_legislative_district"
        | "no_candidate_committee_match";
      candidateNameNormalized: string;
      officeNameNormalized: string;
    }
  | {
      status: "ambiguous";
      reason: "multiple_matching_committees";
      candidateNameNormalized: string;
      officeNameNormalized: string;
      matches: HawaiiCandidateCommitteeMatch[];
    };

type CandidateCommitteeAccumulator = {
  committeeId: string;
  committeeName: string;
  electionPeriod: string;
  rows: HawaiiCscCandidateCommitteeSummary[];
};

const HAWAII_CSC_CANDIDATE_CONTRIBUTIONS_SOURCE_URL =
  "https://hicscdata.hawaii.gov/dataset/Campaign-Contributions-Received-By-Hawaii-State-an/jexd-xbcg";

function normalizeElectionYear(value: number): number {
  if (!Number.isInteger(value) || value < 2000 || value > 2100) {
    throw new Error(`Invalid Hawaii candidate committee election year: ${value}`);
  }
  return value;
}

function normalizeTextKey(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    // Drop apostrophes and the Hawaiian okina inside names: "Pa'ele" must
    // key as PAELE (CSC files "Kiakona, Paele"), not PA ELE.
    .replace(/['\u2018\u2019\u02bb`]/g, "")
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\b(THE|OF|FOR)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePersonName(value: string): string {
  return normalizeTextKey(value)
    // Bare "V" is a middle initial, not a suffix (GENERATIONAL_SUFFIX_RANK in
    // finance/personNameMiddleEvidence.ts): stripping it erased middle evidence.
    .replace(/\b(JR|SR|II|III|IV)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeHawaiiCandidateNameKeys(value: string): Set<string> {
  const keys = normalizeHawaiiCscPersonNameKeys(value);
  const normalized = normalizePersonName(value.trim());
  if (normalized) {
    keys.add(normalized);
  }
  // CSC summaries name candidates surname-first ("Brown, Robert J.",
  // "Chock, Sr., Mason"). Flip to "First M Last" before deriving the first+last
  // key — split on the raw comma form it came out as "BROWN J", so a "Robert
  // Brown" candidate never key-matched and the middle-name gate never ran.
  const commaParts = value
    .split(",")
    .map((part) => normalizePersonName(part))
    .filter(Boolean);
  const ordered = commaParts.length >= 2 ? `${commaParts.slice(1).join(" ")} ${commaParts[0]}` : normalized;
  if (ordered) {
    keys.add(ordered);
  }
  const parts = ordered.split(" ").filter(Boolean);
  if (parts.length >= 2) {
    keys.add(`${parts[0]} ${parts[parts.length - 1]}`);
  }
  return keys;
}

// CSC files the formal first name ("Lee, Michael", "Lee Loy, Susan") while
// VoteApp stores the campaign name ("Mike Lee", "Sue Lee Loy"). Expand the
// VoteApp side only (personFirstNameNicknames.ts explains why).
function candidateNameKeysWithNicknames(value: string): Set<string> {
  const keys = normalizeHawaiiCandidateNameKeys(value);
  const parts = normalizePersonName(value.trim()).split(" ").filter(Boolean);
  if (parts.length >= 2) {
    const last = parts[parts.length - 1];
    for (const variant of firstNameVariants(parts[0] ?? "")) {
      keys.add(`${variant} ${last}`);
    }
  }
  return keys;
}

function nicknameFirstNamesEquivalent(candidateFirst: string, rowFirst: string): boolean {
  return candidateFirst === rowFirst || firstNameVariants(candidateFirst).includes(rowFirst);
}

function candidateNameNormalized(value: string): string {
  return [...normalizeHawaiiCandidateNameKeys(value)][0] ?? normalizePersonName(value);
}

function summaryMatchesCandidateName(input: {
  summary: HawaiiCscCandidateCommitteeSummary;
  candidateName: string;
  candidateNameKeys: ReadonlySet<string>;
  expandNicknames: boolean;
}): boolean {
  let keyMatched = false;
  for (const key of normalizeHawaiiCandidateNameKeys(input.summary.candidateName)) {
    if (input.candidateNameKeys.has(key)) {
      keyMatched = true;
      break;
    }
  }
  if (!keyMatched) {
    return false;
  }
  // Key overlap collapses names to first+last, which would link
  // "John A. Smith" to a summary naming "John B. Smith" as an "exact" match
  // whenever the office, district, and election period agree. A contradicting
  // middle name rejects the row (georgia pattern).
  return !hasMiddleNameConflict({
    candidateName: input.candidateName,
    rowNames: [input.summary.candidateName],
    normalizePersonName,
    firstNamesEquivalent: input.expandNicknames ? nicknameFirstNamesEquivalent : undefined,
  });
}

function summaryMatchesExpectedOffice(input: {
  summary: HawaiiCscCandidateCommitteeSummary;
  expectedCscOffice: string;
  expectedDistrict: string | null;
}): boolean {
  // A blank district is unknown, not a mismatch: current-cycle CSC rows
  // mostly omit it (live: "Evslin, Luke", House, 2024-2026, no district).
  // Match on office alone there; a row that names a different district is
  // still rejected below.
  if (!input.summary.district?.trim()) {
    const officeLabel = normalizeHawaiiCscOfficeLabel(input.summary.office);
    return officeLabel !== null && officeLabel === normalizeHawaiiCscOfficeLabel(input.expectedCscOffice);
  }
  const mappedOffice = mapHawaiiCscOffice({ office: input.summary.office, district: input.summary.district });
  if (!mappedOffice || mappedOffice.cscOffice !== input.expectedCscOffice) {
    return false;
  }
  if (input.expectedDistrict !== null) {
    return mappedOffice.district === input.expectedDistrict;
  }
  return true;
}

function electionPeriodMatchesYear(electionPeriod: string, electionYear: number): boolean {
  const years = [...electionPeriod.matchAll(/\b(\d{4})\b/g)].map((match) => Number(match[1]));
  return years.length > 0 && years[years.length - 1] === electionYear;
}

function toCommitteeMatch(accumulator: CandidateCommitteeAccumulator): HawaiiCandidateCommitteeMatch {
  return {
    committeeId: accumulator.committeeId,
    committeeName: accumulator.committeeName,
    electionPeriod: accumulator.electionPeriod,
    totalAmount: Math.round(accumulator.rows.reduce((sum, row) => sum + row.totalAmount, 0) * 100) / 100,
    confidence: "exact",
    source: "csc_api",
    sourceUrl: HAWAII_CSC_CANDIDATE_CONTRIBUTIONS_SOURCE_URL,
    matchedSummaryRowCount: accumulator.rows.length,
  };
}

// Literal names first; nickname equivalence only when nothing matches
// literally, so a candidate filed under both "Mike" and "Michael" keeps the
// literal committee instead of turning ambiguous (New Hampshire pattern).
export function resolveHawaiiCandidateCommittee(
  input: HawaiiCandidateCommitteeResolverInput
): HawaiiCandidateCommitteeResolution {
  const literal = resolveHawaiiCandidateCommitteeByName(input, false);
  if (literal.status !== "unmatched" || literal.reason !== "no_candidate_committee_match") {
    return literal;
  }
  return resolveHawaiiCandidateCommitteeByName(input, true);
}

function resolveHawaiiCandidateCommitteeByName(
  input: HawaiiCandidateCommitteeResolverInput,
  expandNicknames: boolean
): HawaiiCandidateCommitteeResolution {
  const electionYear = normalizeElectionYear(input.electionYear);
  const candidateNameKeys = expandNicknames
    ? candidateNameKeysWithNicknames(input.candidateName)
    : normalizeHawaiiCandidateNameKeys(input.candidateName);
  const candidateNameKey = candidateNameNormalized(input.candidateName);
  const officeSearchInput = toHawaiiCscOfficeSearchInput({
    officeScope: input.officeScope,
    officeCanonicalName: input.officeName,
    district: input.district,
  });
  const officeNameNormalized = officeSearchInput?.cscOffice ?? normalizeTextKey(input.officeName);

  if (candidateNameKeys.size === 0) {
    return {
      status: "unmatched",
      reason: "missing_candidate_name",
      candidateNameNormalized: candidateNameKey,
      officeNameNormalized,
    };
  }
  if (!officeSearchInput) {
    const isLegislativeOffice =
      (input.officeScope === "state_upper" && input.officeName.trim() === "State Senator") ||
      (input.officeScope === "state_lower" && input.officeName.trim() === "State Lower Chamber Legislator");
    const hasDistrict = normalizeHawaiiCscDistrict(input.district) !== null;
    return {
      status: "unmatched",
      reason: isLegislativeOffice && !hasDistrict ? "missing_legislative_district" : "unsupported_office",
      candidateNameNormalized: candidateNameKey,
      officeNameNormalized,
    };
  }

  const rowsByCommittee = new Map<string, CandidateCommitteeAccumulator>();
  for (const summary of input.summaries) {
    const committeeId = summary.committeeId.trim();
    const committeeName = summary.candidateName.trim();
    const electionPeriod = summary.electionPeriod.trim();
    if (!committeeId || !committeeName || !electionPeriod) {
      continue;
    }
    if (!electionPeriodMatchesYear(electionPeriod, electionYear)) {
      continue;
    }
    if (
      !summaryMatchesExpectedOffice({
        summary,
        expectedCscOffice: officeSearchInput.cscOffice,
        expectedDistrict: officeSearchInput.district,
      })
    ) {
      continue;
    }
    if (!summaryMatchesCandidateName({ summary, candidateName: input.candidateName, candidateNameKeys, expandNicknames })) {
      continue;
    }

    const key = `${committeeId}\u0000${electionPeriod}`;
    const accumulator = rowsByCommittee.get(key) ?? {
      committeeId,
      committeeName,
      electionPeriod,
      rows: [],
    };
    accumulator.rows.push(summary);
    rowsByCommittee.set(key, accumulator);
  }

  if (rowsByCommittee.size === 0) {
    return {
      status: "unmatched",
      reason: "no_candidate_committee_match",
      candidateNameNormalized: candidateNameKey,
      officeNameNormalized,
    };
  }

  const matches = [...rowsByCommittee.values()]
    .map(toCommitteeMatch)
    .sort((left, right) => left.committeeId.localeCompare(right.committeeId) || left.electionPeriod.localeCompare(right.electionPeriod));

  if (matches.length === 1) {
    return {
      status: "matched",
      ...matches[0],
    };
  }

  return {
    status: "ambiguous",
    reason: "multiple_matching_committees",
    candidateNameNormalized: candidateNameKey,
    officeNameNormalized,
    matches,
  };
}

export async function searchAndResolveHawaiiCandidateCommittee(
  input: HawaiiCandidateCommitteeSearchInput,
  options: HawaiiCscClientOptions = {}
): Promise<HawaiiCandidateCommitteeResolution> {
  const officeSearchInput = toHawaiiCscOfficeSearchInput({
    officeScope: input.officeScope,
    officeCanonicalName: input.officeName,
    district: input.district,
  });
  if (!officeSearchInput) {
    return resolveHawaiiCandidateCommittee({ ...input, summaries: [] });
  }

  const summaries = await searchHawaiiCscCandidateCommittees(
    {
      candidateName: input.candidateName,
      electionYear: input.electionYear,
      office: officeSearchInput.cscOffice,
      district: officeSearchInput.district,
      // The surname LIKE filter and the blank-district rows share this page,
      // ordered by total raised, so a common surname could push the wanted
      // candidate past a small page. One request either way.
      limit: 500,
    },
    options
  );
  return resolveHawaiiCandidateCommittee({ ...input, summaries });
}
