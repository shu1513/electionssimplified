import { firstNameVariants } from "../finance/personFirstNameNicknames.js";
import { personNameParseVariants, personNamesMatchWithMiddleEvidence } from "../finance/personNameMiddleEvidence.js";
import type { MaineCfisContributionRow } from "./maineCfisArtifactReader.js";
import { isMaineFinanceEligibleOffice } from "./maineFinanceEligibleOffices.js";

export type MaineCandidateCommitteeResolverInput = {
  candidateName: string;
  officeScope: string;
  officeName: string;
  electionYear: number;
  district?: string | null;
  contributionRows: readonly MaineCfisContributionRow[];
  sourceUrl?: string | null;
};

export type MaineCandidateCommitteeMatch = {
  committeeId: string;
  committeeName: string;
  confidence: "exact";
  source: "cfis_bulk";
  sourceUrl: string | null;
  matchedContributionRowCount: number;
};

export type MaineCandidateCommitteeResolution =
  | ({ status: "matched" } & MaineCandidateCommitteeMatch)
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
      matches: MaineCandidateCommitteeMatch[];
    };

type CandidateCommitteeAccumulator = {
  committeeId: string;
  committeeName: string;
  fallbackCandidateName: string;
  rows: MaineCfisContributionRow[];
};

function normalizeElectionYear(value: number): number {
  if (!Number.isInteger(value) || value < 2000 || value > 2100) {
    throw new Error(`Invalid Maine candidate committee election year: ${value}`);
  }
  return value;
}

function normalizeTextKey(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\b(THE|OF|FOR|TO|ELECT|COMMITTEE|FRIENDS|CITIZENS)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePersonName(value: string | null | undefined): string {
  return normalizeTextKey(value)
    // Bare "V" is a middle initial, not a suffix (GENERATIONAL_SUFFIX_RANK in
    // finance/personNameMiddleEvidence.ts): stripping it erased middle evidence.
    .replace(/\b(JR|SR|II|III|IV)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeMaineCandidateNameKeys(value: string): Set<string> {
  const trimmed = value.trim();
  const normalized = normalizePersonName(trimmed);
  const keys = new Set<string>();
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
    }
    return keys;
  }

  return keys;
}

// First+last keys for every parse of a name ("David G. Haggan" and
// "Haggan, David" both give DAVID HAGGAN). The auto-link pre-filter uses them
// so it admits every row the resolver's middle-evidence fallback could match.
// expandNicknames adds the first name's nickname variants ("Mike Smith" ->
// MICHAEL SMITH). Expand the VoteApp side only and read the source literally
// (personFirstNameNicknames.ts explains why).
export function maineCandidateFirstLastKeys(
  value: string,
  options: { expandNicknames?: boolean } = {}
): Set<string> {
  const keys = new Set<string>();
  for (const parse of personNameParseVariants(value, normalizePersonName)) {
    if (!parse.first || !parse.last) {
      continue;
    }
    keys.add(`${parse.first} ${parse.last}`);
    if (options.expandNicknames) {
      for (const variant of firstNameVariants(parse.first)) {
        keys.add(`${variant} ${parse.last}`);
      }
    }
  }
  return keys;
}

function maineFirstNamesEquivalent(candidateFirst: string, rowFirst: string): boolean {
  return candidateFirst === rowFirst || firstNameVariants(candidateFirst).includes(rowFirst);
}

export function normalizeMaineCandidateNameForStorage(value: string): string {
  const trimmed = value.trim();
  const commaParts = trimmed
    .split(",")
    .map((part) => normalizePersonName(part))
    .filter(Boolean);
  if (commaParts.length >= 2) {
    const lastName = commaParts[0] ?? "";
    const firstNames = commaParts.slice(1).join(" ").trim();
    return normalizePersonName(`${firstNames} ${lastName}`);
  }
  return normalizePersonName(trimmed);
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
    case "STATE SENATOR":
    case "STATE SENATE":
    case "SENATOR":
      return "State Senator";
    case "REPRESENTATIVE":
    case "STATE REPRESENTATIVE":
    case "STATE HOUSE":
    case "HOUSE REPRESENTATIVES":
    case "STATE LOWER CHAMBER LEGISLATOR":
      return "State Lower Chamber Legislator";
    default:
      return null;
  }
}

function sourceOfficeCanonicalName(row: MaineCfisContributionRow): string | null {
  switch (normalizeTextKey(row.Office)) {
    case "GOVERNOR":
      return "Governor";
    case "SENATOR":
    case "STATE SENATOR":
    case "STATE SENATE":
      return "State Senator";
    case "REPRESENTATIVE":
    case "STATE REPRESENTATIVE":
    case "STATE HOUSE":
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

function parseMaineCfisDateYear(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const slashMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(trimmed);
  if (slashMatch) {
    return Number(slashMatch[3]);
  }
  const isoMatch = /^(\d{4})-\d{2}-\d{2}/.exec(trimmed);
  if (isoMatch) {
    return Number(isoMatch[1]);
  }
  return null;
}

function isElectionCycleContribution(row: MaineCfisContributionRow, electionYear: number): boolean {
  const year = parseMaineCfisDateYear(row["Receipt Date"]);
  return year !== null && year >= electionYear - 1 && year <= electionYear;
}

function isCandidateCommittee(row: MaineCfisContributionRow): boolean {
  const committeeType = normalizeTextKey(row["Committee Type"]);
  return (
    committeeType === "CANDIDATE" ||
    committeeType === "CANDIDATE COMMITTEE" ||
    committeeType === "PUBLIC FINANCING" ||
    committeeType === "PUBLIC FINANCING COMMITTEE"
  );
}

function rowMatchesCandidateName(input: {
  row: MaineCfisContributionRow;
  candidateName: string;
  candidateNameKeys: ReadonlySet<string>;
  expandNicknames: boolean;
}): boolean {
  for (const key of normalizeMaineCandidateNameKeys(input.row["Candidate Name"])) {
    if (input.candidateNameKeys.has(key)) {
      return true;
    }
  }
  // The key set carries only full-string and comma-flip keys, so a name that
  // differs in middle content on one side ("John A. Smith" vs "Smith, John")
  // never overlaps and the link silently strands. Recover it through the
  // middle-evidence gate: first+last alignment matches unless the middles
  // contradict.
  return personNamesMatchWithMiddleEvidence({
    candidateName: input.candidateName,
    rowNames: [input.row["Candidate Name"]],
    normalizePersonName,
    ...(input.expandNicknames ? { firstNamesEquivalent: maineFirstNamesEquivalent } : {}),
  });
}

function rowMatchesOffice(input: {
  row: MaineCfisContributionRow;
  officeCanonicalName: string;
}): boolean {
  const rowOffice = sourceOfficeCanonicalName(input.row);
  return rowOffice === null || rowOffice === input.officeCanonicalName;
}

function rowMatchesDistrict(input: { row: MaineCfisContributionRow; expectedDistrict: string }): boolean {
  const rowDistrict = normalizeDistrict(input.row.District);
  return !rowDistrict || rowDistrict === input.expectedDistrict;
}

function toCommitteeMatch(input: {
  accumulator: CandidateCommitteeAccumulator;
  sourceUrl: string | null;
}): MaineCandidateCommitteeMatch {
  return {
    committeeId: input.accumulator.committeeId,
    // CFIS exports leave "Committee Name" blank on many candidate rows; fall
    // back to the row's candidate name so downstream non-empty checks hold.
    committeeName: input.accumulator.committeeName || input.accumulator.fallbackCandidateName,
    confidence: "exact",
    source: "cfis_bulk",
    sourceUrl: input.sourceUrl,
    matchedContributionRowCount: input.accumulator.rows.length,
  };
}

// Literal first name first, nicknames only when nothing matched literally: a
// "Mike" candidate must not turn ambiguous because a different "Michael" with
// the same surname also filed, and a candidate filed under both forms keeps
// the literal committee (georgia pattern).
export function resolveMaineCandidateCommittee(
  input: MaineCandidateCommitteeResolverInput
): MaineCandidateCommitteeResolution {
  const literal = resolveMaineCandidateCommitteeByName(input, false);
  if (literal.status !== "unmatched" || literal.reason !== "no_candidate_committee_match") {
    return literal;
  }
  return resolveMaineCandidateCommitteeByName(input, true);
}

function resolveMaineCandidateCommitteeByName(
  input: MaineCandidateCommitteeResolverInput,
  expandNicknames: boolean
): MaineCandidateCommitteeResolution {
  const electionYear = normalizeElectionYear(input.electionYear);
  const officeScope = normalizeOfficeScope(input.officeScope);
  const officeCanonicalName = canonicalOfficeNameForInput(input.officeName);
  const officeNameNormalized = officeCanonicalName ?? normalizeTextKey(input.officeName);
  const candidateNameKeys = normalizeMaineCandidateNameKeys(input.candidateName);
  const candidateNameNormalized = normalizeMaineCandidateNameForStorage(input.candidateName);
  const expectedDistrict = normalizeDistrict(input.district);

  if (candidateNameKeys.size === 0) {
    return {
      status: "unmatched",
      reason: "missing_candidate_name",
      candidateNameNormalized,
      officeNameNormalized,
    };
  }
  if (!officeScope || !officeCanonicalName || !isMaineFinanceEligibleOffice({ officeScope, officeCanonicalName })) {
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
    // OrgID is always populated in CFIS exports while "Committee Name" is
    // blank on a large share of candidate rows, so key committees on OrgID
    // alone and backfill the display name from whichever row carries one.
    const committeeId = row.OrgID.trim().replace(/\s+/g, " ").toUpperCase();
    const committeeName = row["Committee Name"].trim();
    if (!committeeId) {
      continue;
    }
    if (!isCandidateCommittee(row)) {
      continue;
    }
    if (!isElectionCycleContribution(row, electionYear)) {
      continue;
    }
    if (!rowMatchesCandidateName({ row, candidateName: input.candidateName, candidateNameKeys, expandNicknames })) {
      continue;
    }
    if (!rowMatchesOffice({ row, officeCanonicalName })) {
      continue;
    }
    if (isExpectedLegislativeOffice(officeScope, officeCanonicalName) && !rowMatchesDistrict({ row, expectedDistrict })) {
      continue;
    }

    const existing = rowsByCommittee.get(committeeId);
    if (existing) {
      existing.rows.push(row);
      if (!existing.committeeName && committeeName) {
        existing.committeeName = committeeName;
      }
      continue;
    }
    rowsByCommittee.set(committeeId, {
      committeeId,
      committeeName,
      fallbackCandidateName: row["Candidate Name"].trim(),
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

  const match = matches[0];
  if (!match) {
    return {
      status: "unmatched",
      reason: "no_candidate_committee_match",
      candidateNameNormalized,
      officeNameNormalized,
    };
  }
  return {
    status: "matched",
    ...match,
  };
}
