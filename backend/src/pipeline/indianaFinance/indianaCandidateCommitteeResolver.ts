import { firstNameVariants } from "../finance/personFirstNameNicknames.js";
import { hasMiddleNameConflict } from "../finance/personNameMiddleEvidence.js";
import type { IndianaCampaignFinanceContributionRow } from "./indianaCampaignFinanceReader.js";
import { isIndianaFinanceEligibleOffice } from "./indianaFinanceEligibleOffices.js";

export type IndianaCandidateCommitteeResolverInput = {
  candidateName: string;
  officeScope: string;
  officeName: string;
  electionYear: number;
  district?: string | null;
  contributionRows: readonly IndianaCampaignFinanceContributionRow[];
  sourceUrl?: string | null;
};

export type IndianaCandidateCommitteeMatch = {
  committeeId: string;
  committeeName: string;
  confidence: "exact";
  source: "public_bulk";
  sourceUrl: string | null;
  matchedContributionRowCount: number;
};

export type IndianaCandidateCommitteeResolution =
  | ({ status: "matched" } & IndianaCandidateCommitteeMatch)
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
      matches: IndianaCandidateCommitteeMatch[];
    };

type CandidateCommitteeAccumulator = {
  committeeId: string;
  committeeName: string;
  rows: IndianaCampaignFinanceContributionRow[];
};

function normalizeElectionYear(value: number): number {
  if (!Number.isInteger(value) || value < 2000 || value > 2100) {
    throw new Error(`Invalid Indiana candidate committee election year: ${value}`);
  }
  return value;
}

function normalizeTextKey(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
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

// expandNicknames adds first+last keys for the first name's nickname
// variants ("Greg Ballard" → "GREGORY BALLARD"): the source files the formal name while VoteApp
// stores the campaign name. Expand the VoteApp side only
// (personFirstNameNicknames.ts explains why).
export function normalizeIndianaCandidateNameKeys(
  value: string,
  options: { expandNicknames?: boolean } = {}
): Set<string> {
  const trimmed = value.trim();
  const normalized = normalizePersonName(trimmed);
  const keys = new Set<string>();
  const nicknameKeys = new Set<string>();
  function addFirstLast(first: string, last: string): void {
    keys.add(`${first} ${last}`);
    if (options.expandNicknames) {
      for (const variant of firstNameVariants(first)) {
        nicknameKeys.add(`${variant} ${last}`);
      }
    }
  }
  // Nickname keys go last so the first key (used for storage) is unchanged.
  function withNicknameKeys(): Set<string> {
    for (const key of nicknameKeys) {
      keys.add(key);
    }
    return keys;
  }
  if (normalized) {
    keys.add(normalized);
  }

  const commaParts = trimmed
    .split(",")
    .map((part) => normalizePersonName(part))
    .filter(Boolean);
  if (commaParts.length >= 2) {
    const lastName = commaParts[0] ?? "";
    const firstNames = commaParts.slice(1).join(" ").trim();
    const flipped = normalizePersonName(`${firstNames} ${lastName}`);
    if (flipped) {
      keys.add(flipped);
      const flippedParts = flipped.split(" ").filter(Boolean);
      if (flippedParts.length >= 2) {
        addFirstLast(flippedParts[0] ?? "", flippedParts[flippedParts.length - 1] ?? "");
      }
      if (flippedParts.length === 3 && flippedParts[0]?.length === 1) {
        addFirstLast(flippedParts[1] ?? "", flippedParts[2] ?? "");
      }
    }
    return withNicknameKeys();
  }

  const parts = normalized.split(" ").filter(Boolean);
  if (parts.length >= 2) {
    addFirstLast(parts[0] ?? "", parts[parts.length - 1] ?? "");
  }
  if (parts.length === 3 && parts[0]?.length === 1) {
    addFirstLast(parts[1] ?? "", parts[2] ?? "");
  }
  return withNicknameKeys();
}

function normalizeOfficeScope(value: string): "statewide" | "state_upper" | "state_lower" | null {
  const normalized = value.trim();
  return normalized === "statewide" || normalized === "state_upper" || normalized === "state_lower"
    ? normalized
    : null;
}

function canonicalOfficeNameForInput(officeName: string): string | null {
  switch (normalizeTextKey(officeName)) {
    case "GOVERNOR":
      return "Governor";
    case "LIEUTENANT GOVERNOR":
      return "Lieutenant Governor";
    case "SECRETARY STATE":
      return "Secretary of State";
    case "ATTORNEY GENERAL":
      return "Attorney General";
    case "STATE TREASURER":
    case "TREASURER":
      return "State Treasurer";
    case "STATE AUDITOR":
    case "AUDITOR":
      return "State Auditor";
    case "COMPTROLLER":
    case "STATE COMPTROLLER":
      return "Comptroller";
    case "SUPERINTENDENT PUBLIC INSTRUCTION":
    case "STATE SUPERINTENDENT":
    case "STATE SUPERINTENDENT PUBLIC INSTRUCTION":
      return "Superintendent of Public Instruction";
    case "STATE SENATOR":
    case "STATE SENATE":
      return "State Senator";
    case "STATE REPRESENTATIVE":
    case "STATE HOUSE":
    case "STATE LOWER CHAMBER LEGISLATOR":
      return "State Lower Chamber Legislator";
    default:
      return null;
  }
}

function isExpectedLegislativeOffice(officeScope: string | null, officeCanonicalName: string | null): boolean {
  return (
    (officeScope === "state_upper" && officeCanonicalName === "State Senator") ||
    (officeScope === "state_lower" && officeCanonicalName === "State Lower Chamber Legislator")
  );
}

function normalizeDistrict(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return "";
  }
  const numeric = Number(trimmed);
  if (Number.isInteger(numeric) && numeric >= 0) {
    return String(numeric);
  }
  return normalizeTextKey(trimmed);
}

function parseIndianaDateYear(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const isoMatch = /^(\d{4})-\d{2}-\d{2}/.exec(trimmed);
  if (isoMatch) {
    return Number(isoMatch[1]);
  }
  const slashMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(trimmed);
  if (slashMatch) {
    return Number(slashMatch[3]);
  }
  return null;
}

function isElectionCycleContribution(row: IndianaCampaignFinanceContributionRow, electionYear: number): boolean {
  const year = parseIndianaDateYear(row.ContributionDate);
  return year !== null && year >= electionYear - 1 && year <= electionYear;
}

function isCandidateCommittee(row: IndianaCampaignFinanceContributionRow): boolean {
  return normalizeTextKey(row.CommitteeType) === "CANDIDATE";
}

function rowMatchesCandidateName(input: {
  row: IndianaCampaignFinanceContributionRow;
  candidateName: string;
  candidateNameKeys: ReadonlySet<string>;
}): boolean {
  let keyMatched = false;
  for (const key of normalizeIndianaCandidateNameKeys(input.row.CandidateName)) {
    if (input.candidateNameKeys.has(key)) {
      keyMatched = true;
      break;
    }
  }
  if (!keyMatched) {
    return false;
  }
  // Key overlap collapses names to first+last, which would link
  // "John A. Smith" to a row naming "John B. Smith" as an "exact" match
  // whenever the office, district, and cycle agree. A contradicting middle
  // name rejects the row (georgia pattern).
  return !hasMiddleNameConflict({
    candidateName: input.candidateName,
    rowNames: [input.row.CandidateName],
    normalizePersonName,
    firstNamesEquivalent: (candidateFirst, rowFirst) =>
      candidateFirst === rowFirst || firstNameVariants(candidateFirst).includes(rowFirst),
  });
}

function toCommitteeMatch(input: {
  accumulator: CandidateCommitteeAccumulator;
  sourceUrl: string | null;
}): IndianaCandidateCommitteeMatch {
  return {
    committeeId: input.accumulator.committeeId,
    committeeName: input.accumulator.committeeName,
    confidence: "exact",
    source: "public_bulk",
    sourceUrl: input.sourceUrl,
    matchedContributionRowCount: input.accumulator.rows.length,
  };
}

// Literal first name first, nicknames only when nothing matched literally: a
// "Greg" candidate must not turn ambiguous because a different "Gregory" with
// the same surname also filed, and a candidate registered under both the
// nickname and the formal name keeps the literal committee (georgia pattern).
export function resolveIndianaCandidateCommittee(
  input: IndianaCandidateCommitteeResolverInput
): IndianaCandidateCommitteeResolution {
  const literal = resolveIndianaCandidateCommitteeByName(input, false);
  if (literal.status !== "unmatched" || literal.reason !== "no_candidate_committee_match") {
    return literal;
  }
  return resolveIndianaCandidateCommitteeByName(input, true);
}

function resolveIndianaCandidateCommitteeByName(
  input: IndianaCandidateCommitteeResolverInput,
  expandNicknames: boolean
): IndianaCandidateCommitteeResolution {
  const electionYear = normalizeElectionYear(input.electionYear);
  const officeScope = normalizeOfficeScope(input.officeScope);
  const officeCanonicalName = canonicalOfficeNameForInput(input.officeName);
  const officeNameNormalized = officeCanonicalName ?? normalizeTextKey(input.officeName);
  const candidateNameKeys = normalizeIndianaCandidateNameKeys(input.candidateName, { expandNicknames });
  const candidateNameNormalized = [...candidateNameKeys][0] ?? normalizePersonName(input.candidateName);
  const expectedDistrict = normalizeDistrict(input.district);

  if (candidateNameKeys.size === 0) {
    return {
      status: "unmatched",
      reason: "missing_candidate_name",
      candidateNameNormalized,
      officeNameNormalized,
    };
  }
  if (
    !officeScope ||
    !officeCanonicalName ||
    !isIndianaFinanceEligibleOffice({ officeScope, officeCanonicalName })
  ) {
    return {
      status: "unmatched",
      reason: "unsupported_office",
      candidateNameNormalized,
      officeNameNormalized,
    };
  }
  if (isExpectedLegislativeOffice(officeScope, officeCanonicalName) && !expectedDistrict) {
    return {
      status: "unmatched",
      reason: "missing_legislative_district",
      candidateNameNormalized,
      officeNameNormalized,
    };
  }

  const rowsByCommittee = new Map<string, CandidateCommitteeAccumulator>();
  for (const row of input.contributionRows) {
    const committeeId = row.FileNumber.trim().toUpperCase();
    const committeeName = row.Committee.trim();
    if (!committeeId || !committeeName) {
      continue;
    }
    if (!isCandidateCommittee(row)) {
      continue;
    }
    if (!isElectionCycleContribution(row, electionYear)) {
      continue;
    }
    if (!rowMatchesCandidateName({ row, candidateName: input.candidateName, candidateNameKeys })) {
      continue;
    }

    const existing = rowsByCommittee.get(committeeId);
    if (existing) {
      existing.rows.push(row);
      continue;
    }
    rowsByCommittee.set(committeeId, {
      committeeId,
      committeeName,
      rows: [row],
    });
  }

  const matches = [...rowsByCommittee.values()]
    .map((accumulator) => toCommitteeMatch({ accumulator, sourceUrl: input.sourceUrl ?? null }))
    .sort((left, right) => left.committeeId.localeCompare(right.committeeId));

  if (matches.length === 0) {
    return {
      status: "unmatched",
      reason: "no_candidate_committee_match",
      candidateNameNormalized,
      officeNameNormalized,
    };
  }
  if (matches.length > 1) {
    return {
      status: "ambiguous",
      reason: "multiple_matching_committees",
      candidateNameNormalized,
      officeNameNormalized,
      matches,
    };
  }
  return {
    status: "matched",
    ...matches[0],
  };
}
