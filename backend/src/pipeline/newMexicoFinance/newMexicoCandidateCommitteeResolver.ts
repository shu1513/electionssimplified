import { firstNameVariants } from "../finance/personFirstNameNicknames.js";
import { hasMiddleNameConflict } from "../finance/personNameMiddleEvidence.js";
import type { NewMexicoCfisContributionRow } from "./newMexicoCfisArtifactReader.js";
import { isNewMexicoFinanceEligibleOffice } from "./newMexicoFinanceEligibleOffices.js";

export type NewMexicoCandidateCommitteeResolverInput = {
  candidateName: string;
  officeScope: string;
  officeName: string;
  electionYear: number;
  district?: string | null;
  contributionRows: readonly NewMexicoCfisContributionRow[];
  sourceUrl?: string | null;
};

export type NewMexicoCandidateCommitteeMatch = {
  committeeId: string;
  committeeName: string;
  confidence: "exact";
  source: "cfis_bulk";
  sourceUrl: string | null;
  matchedContributionRowCount: number;
};

export type NewMexicoCandidateCommitteeResolution =
  | ({ status: "matched" } & NewMexicoCandidateCommitteeMatch)
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
      matches: NewMexicoCandidateCommitteeMatch[];
    };

type CandidateCommitteeAccumulator = {
  committeeId: string;
  committeeName: string;
  rows: NewMexicoCfisContributionRow[];
};

function normalizeElectionYear(value: number): number {
  if (!Number.isInteger(value) || value < 2020 || value > 2100) {
    throw new Error(`Invalid New Mexico candidate committee election year: ${value}`);
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
// variants ("Sam Kane" → "SAMUEL KANE"): CFIS rows carry the formal name
// while VoteApp stores the campaign name. Expand the VoteApp side only
// (personFirstNameNicknames.ts explains why).
export function normalizeNewMexicoCandidateNameKeys(
  value: string,
  options: { expandNicknames?: boolean } = {}
): Set<string> {
  const trimmed = value.trim();
  const normalized = normalizePersonName(trimmed);
  const keys = new Set<string>();
  if (normalized) {
    keys.add(normalized);
  }
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
    }
    return withNicknameKeys();
  }

  const parts = normalized.split(" ").filter(Boolean);
  if (parts.length >= 2) {
    addFirstLast(parts[0] ?? "", parts[parts.length - 1] ?? "");
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
    case "LAND COMMISSIONER":
    case "COMMISSIONER PUBLIC LANDS":
    case "COMMISSIONER STATE LANDS":
      return "Land Commissioner";
    case "STATE SENATOR":
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

function parseNewMexicoCfisDateYear(raw: string): number | null {
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

function isElectionCycleContribution(row: NewMexicoCfisContributionRow, electionYear: number): boolean {
  const year = parseNewMexicoCfisDateYear(row["Transaction Date"]);
  return year !== null && year >= electionYear - 1 && year <= electionYear;
}

function isCandidateCommittee(row: NewMexicoCfisContributionRow): boolean {
  return normalizeTextKey(row["Report Entity Type"]) === "CANDIDATE";
}

function candidateNameFromContributionRow(row: NewMexicoCfisContributionRow): string {
  return [
    row["Candidate First Name"],
    row["Candidate Middle Name"],
    row["Candidate Last Name"],
  ]
    .map((value) => value.trim())
    .filter(Boolean)
    .join(" ");
}

// Shared middle-name evidence gate: the key set collapses names to first+last,
// which would hand "John A. Smith" the committee of "John B. Smith" whenever
// the cycle and office agree. A contradicting middle name rejects the pair.
export function newMexicoCandidateNameMiddleConflict(candidateName: string, rowName: string): boolean {
  return hasMiddleNameConflict({
    candidateName,
    rowNames: [rowName],
    normalizePersonName,
    firstNamesEquivalent: (candidateFirst, rowFirst) =>
      candidateFirst === rowFirst || firstNameVariants(candidateFirst).includes(rowFirst),
  });
}

function rowMatchesCandidateName(input: {
  row: NewMexicoCfisContributionRow;
  candidateName: string;
  candidateNameKeys: ReadonlySet<string>;
}): boolean {
  const rowName = candidateNameFromContributionRow(input.row);
  let keyMatched = false;
  for (const key of normalizeNewMexicoCandidateNameKeys(rowName)) {
    if (input.candidateNameKeys.has(key)) {
      keyMatched = true;
      break;
    }
  }
  if (!keyMatched) {
    return false;
  }
  return !newMexicoCandidateNameMiddleConflict(input.candidateName, rowName);
}

function toCommitteeMatch(input: {
  accumulator: CandidateCommitteeAccumulator;
  sourceUrl: string | null;
}): NewMexicoCandidateCommitteeMatch {
  return {
    committeeId: input.accumulator.committeeId,
    committeeName: input.accumulator.committeeName,
    confidence: "exact",
    source: "cfis_bulk",
    sourceUrl: input.sourceUrl,
    matchedContributionRowCount: input.accumulator.rows.length,
  };
}

export function resolveNewMexicoCandidateCommittee(
  input: NewMexicoCandidateCommitteeResolverInput
): NewMexicoCandidateCommitteeResolution {
  const electionYear = normalizeElectionYear(input.electionYear);
  const officeScope = normalizeOfficeScope(input.officeScope);
  const officeCanonicalName = canonicalOfficeNameForInput(input.officeName);
  const officeNameNormalized = officeCanonicalName ?? normalizeTextKey(input.officeName);
  const candidateNameKeys = normalizeNewMexicoCandidateNameKeys(input.candidateName, { expandNicknames: true });
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
    !isNewMexicoFinanceEligibleOffice({ officeScope, officeCanonicalName })
  ) {
    return {
      status: "unmatched",
      reason: "unsupported_office",
      candidateNameNormalized,
      officeNameNormalized,
    };
  }
  if (isExpectedLegislativeOffice(officeScope, officeCanonicalName) && !expectedDistrict) {
    // CFIS contribution rows do not expose office/district. Requiring the app-side
    // district keeps legislative auto-link inputs explicit, but matching remains
    // name/candidate-committee/cycle based and must not guess through ambiguity.
    return {
      status: "unmatched",
      reason: "missing_legislative_district",
      candidateNameNormalized,
      officeNameNormalized,
    };
  }

  const rowsByCommittee = new Map<string, CandidateCommitteeAccumulator>();
  for (const row of input.contributionRows) {
    const committeeId = row.OrgID.trim().toUpperCase();
    const committeeName = row["Committee Name"].trim();
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
