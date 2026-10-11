import { firstNameVariants } from "../finance/personFirstNameNicknames.js";
import { hasMiddleNameConflict } from "../finance/personNameMiddleEvidence.js";
import type { OklahomaGuardianContributionRow } from "./oklahomaGuardianContributionReader.js";
import { isOklahomaFinanceEligibleOffice } from "./oklahomaFinanceEligibleOffices.js";

export type OklahomaCandidateCommitteeResolverInput = {
  candidateName: string;
  officeScope: string;
  officeName: string;
  electionYear: number;
  district?: string | null;
  contributionRows: readonly OklahomaGuardianContributionRow[];
  sourceUrl?: string | null;
};

export type OklahomaCandidateCommitteeMatch = {
  committeeId: string;
  committeeName: string;
  confidence: "exact";
  source: "guardian_bulk";
  sourceUrl: string | null;
  matchedContributionRowCount: number;
};

export type OklahomaCandidateCommitteeResolution =
  | ({ status: "matched" } & OklahomaCandidateCommitteeMatch)
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
      matches: OklahomaCandidateCommitteeMatch[];
    };

type CandidateCommitteeAccumulator = {
  committeeId: string;
  committeeName: string;
  rows: OklahomaGuardianContributionRow[];
};

function normalizeElectionYear(value: number): number {
  if (!Number.isInteger(value) || value < 2014 || value > 2100) {
    throw new Error(`Invalid Oklahoma candidate committee election year: ${value}`);
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
    // Guardian files some candidates with a title ("DR. MAX EUGENE BURCHETT JR").
    .replace(/^DR\s+/, "")
    // Bare "V" is a middle initial, not a suffix (GENERATIONAL_SUFFIX_RANK in
    // finance/personNameMiddleEvidence.ts): stripping it erased middle evidence.
    .replace(/\b(JR|SR|II|III|IV)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// expandNicknames adds first+last keys for the first name's nickname
// variants ("Josh Cantrell" → JOSHUA CANTRELL): the source files the formal name while VoteApp
// stores the campaign name. Expand the VoteApp side only
// (personFirstNameNicknames.ts explains why).
export function normalizeOklahomaCandidateNameKeys(
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

export function canonicalOklahomaCandidateOfficeName(officeName: string): string | null {
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
    case "STATE AUDITOR AND INSPECTOR":
    case "AUDITOR AND INSPECTOR":
    case "STATE AUDITOR INSPECTOR":
    case "AUDITOR INSPECTOR":
      return "State Auditor";
    case "SUPERINTENDENT PUBLIC INSTRUCTION":
    case "STATE SUPERINTENDENT":
    case "STATE SUPERINTENDENT PUBLIC INSTRUCTION":
      return "Superintendent of Public Instruction";
    case "COMMISSIONER INSURANCE":
    case "INSURANCE COMMISSIONER":
      return "Commissioner of Insurance";
    case "LABOR COMMISSIONER":
    case "COMMISSIONER LABOR":
      return "Labor Commissioner";
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

export function normalizeOklahomaCandidateDistrict(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return "";
  }
  const withoutLabel = trimmed.replace(/^DISTRICT\s+/i, "");
  const numeric = Number(withoutLabel);
  if (Number.isInteger(numeric) && numeric >= 0) {
    return String(numeric);
  }
  return normalizeTextKey(withoutLabel);
}

function parseOklahomaGuardianDateYear(raw: string): number | null {
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

function isElectionCycleContribution(row: OklahomaGuardianContributionRow, electionYear: number): boolean {
  const year = parseOklahomaGuardianDateYear(row["Receipt Date"]);
  return year !== null && year >= electionYear - 1 && year <= electionYear;
}

function isCandidateCommittee(row: OklahomaGuardianContributionRow): boolean {
  return normalizeTextKey(row["Committee Type"]).includes("CANDIDATE");
}

// Shared middle-name evidence gate: the key set collapses names to first+last,
// which would hand "John A. Smith" the committee of "SMITH, JOHN B." whenever
// the cycle and office agree. A contradicting middle name rejects the pair.
export function oklahomaCandidateNameMiddleConflict(candidateName: string, rowName: string): boolean {
  return hasMiddleNameConflict({
    candidateName,
    rowNames: [rowName],
    normalizePersonName,
    firstNamesEquivalent: (candidateFirst, rowFirst) =>
      candidateFirst === rowFirst || firstNameVariants(candidateFirst).includes(rowFirst),
  });
}

function rowMatchesCandidateName(input: {
  row: OklahomaGuardianContributionRow;
  candidateName: string;
  candidateNameKeys: ReadonlySet<string>;
}): boolean {
  const rowName = input.row["Candidate Name"];
  for (const key of normalizeOklahomaCandidateNameKeys(rowName)) {
    if (input.candidateNameKeys.has(key)) {
      return !oklahomaCandidateNameMiddleConflict(input.candidateName, rowName);
    }
  }
  return false;
}

function committeeNameFromRow(row: OklahomaGuardianContributionRow): string {
  return row["Committee Name"].trim() || row["Candidate Name"].trim();
}

function toCommitteeMatch(input: {
  accumulator: CandidateCommitteeAccumulator;
  sourceUrl: string | null;
}): OklahomaCandidateCommitteeMatch {
  return {
    committeeId: input.accumulator.committeeId,
    committeeName: input.accumulator.committeeName,
    confidence: "exact",
    source: "guardian_bulk",
    sourceUrl: input.sourceUrl,
    matchedContributionRowCount: input.accumulator.rows.length,
  };
}

// Literal first name first, nicknames only when nothing matched literally: a
// "Greg" candidate must not turn ambiguous because a different "Gregory" with
// the same surname also filed, and a candidate registered under both the
// nickname and the formal name keeps the literal committee (georgia pattern).
export function resolveOklahomaCandidateCommittee(
  input: OklahomaCandidateCommitteeResolverInput
): OklahomaCandidateCommitteeResolution {
  const literal = resolveOklahomaCandidateCommitteeByName(input, false);
  if (literal.status !== "unmatched" || literal.reason !== "no_candidate_committee_match") {
    return literal;
  }
  return resolveOklahomaCandidateCommitteeByName(input, true);
}

function resolveOklahomaCandidateCommitteeByName(
  input: OklahomaCandidateCommitteeResolverInput,
  expandNicknames: boolean
): OklahomaCandidateCommitteeResolution {
  const electionYear = normalizeElectionYear(input.electionYear);
  const officeScope = normalizeOfficeScope(input.officeScope);
  const officeCanonicalName = canonicalOklahomaCandidateOfficeName(input.officeName);
  const officeNameNormalized = officeCanonicalName ?? normalizeTextKey(input.officeName);
  const candidateNameKeys = normalizeOklahomaCandidateNameKeys(input.candidateName, { expandNicknames });
  const candidateNameNormalized = [...candidateNameKeys][0] ?? normalizePersonName(input.candidateName);
  const expectedDistrict = normalizeOklahomaCandidateDistrict(input.district);

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
    !isOklahomaFinanceEligibleOffice({ officeScope, officeCanonicalName })
  ) {
    return {
      status: "unmatched",
      reason: "unsupported_office",
      candidateNameNormalized,
      officeNameNormalized,
    };
  }
  if (isExpectedLegislativeOffice(officeScope, officeCanonicalName) && !expectedDistrict) {
    // Guardian contribution rows do not expose office/district, so legislative
    // auto-link inputs must at least be explicit on the app side.
    return {
      status: "unmatched",
      reason: "missing_legislative_district",
      candidateNameNormalized,
      officeNameNormalized,
    };
  }

  const rowsByCommittee = new Map<string, CandidateCommitteeAccumulator>();
  for (const row of input.contributionRows) {
    const committeeId = row["Org ID"].trim().toUpperCase();
    const committeeName = committeeNameFromRow(row);
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
