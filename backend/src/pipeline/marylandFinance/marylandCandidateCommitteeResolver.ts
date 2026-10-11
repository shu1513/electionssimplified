import { firstNameVariants } from "../finance/personFirstNameNicknames.js";
import { hasMiddleNameConflict } from "../finance/personNameMiddleEvidence.js";
import type { MarylandCfsCommitteeRow } from "./marylandCfsArtifactReader.js";
import { isMarylandFinanceEligibleOffice } from "./marylandFinanceEligibleOffices.js";

export type MarylandCandidateCommitteeResolverInput = {
  candidateName: string;
  officeScope: string;
  officeName: string;
  electionYear: number;
  district?: string | null;
  committeeRows: readonly MarylandCfsCommitteeRow[];
  sourceUrl?: string | null;
};

export type MarylandCandidateCommitteeMatch = {
  committeeId: string;
  committeeName: string;
  confidence: "exact";
  source: "cfs_public_export";
  sourceUrl: string | null;
  matchedCommitteeRowCount: number;
};

export type MarylandCandidateCommitteeResolution =
  | ({ status: "matched" } & MarylandCandidateCommitteeMatch)
  | {
      status: "unmatched";
      reason:
        | "missing_candidate_name"
        | "unsupported_office"
        | "missing_legislative_district"
        | "unverified_legislative_district"
        | "no_candidate_committee_match";
      candidateNameNormalized: string;
      officeNameNormalized: string;
    }
  | {
      status: "ambiguous";
      reason: "multiple_matching_committees";
      candidateNameNormalized: string;
      officeNameNormalized: string;
      matches: MarylandCandidateCommitteeMatch[];
    };

type CandidateCommitteeAccumulator = {
  committeeId: string;
  committeeName: string;
  rows: MarylandCfsCommitteeRow[];
};

function normalizeElectionYear(value: number): number {
  if (!Number.isInteger(value) || value < 2000 || value > 2100) {
    throw new Error(`Invalid Maryland candidate committee election year: ${value}`);
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

// expandNicknames adds first+last keys for the first name's nickname
// variants ("James B. Rutledge, III" → "JIM RUTLEDGE" for "Friends of Jim
// Rutledge"). Expand the VoteApp side only (personFirstNameNicknames.ts
// explains why); rows are keyed literally.
export function normalizeMarylandCandidateNameKeys(
  value: string,
  options: { expandNicknames?: boolean } = {}
): Set<string> {
  const trimmed = value.trim();
  const keys = new Set<string>();
  const nicknameKeys = new Set<string>();
  const trimmedWithoutParentheticals = trimmed.replace(/\([^()]+\)/g, " ");
  const baseParts = normalizePersonName(trimmedWithoutParentheticals).split(" ").filter(Boolean);
  const lastBaseToken = baseParts.length >= 2 ? baseParts[baseParts.length - 1] : null;

  function addFirstLast(first: string, last: string): void {
    keys.add(`${first} ${last}`);
    if (options.expandNicknames) {
      for (const variant of firstNameVariants(first)) {
        nicknameKeys.add(`${variant} ${last}`);
      }
    }
  }

  function addName(raw: string): void {
    const hasComma = raw.includes(",");
    const normalized = normalizePersonName(raw);
    if (normalized) {
      keys.add(normalized);
    }

    const parts = normalized.split(" ").filter(Boolean);
    if (!hasComma && parts.length >= 2) {
      addFirstLast(parts[0] ?? "", parts[parts.length - 1] ?? "");
    }

    const commaParts = raw
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
    }
  }

  addName(trimmedWithoutParentheticals);
  for (const match of trimmed.matchAll(/\(([^()]+)\)/g)) {
    if (match[1]) {
      addName(match[1]);
      const nickname = normalizePersonName(match[1]);
      if (nickname && lastBaseToken) {
        keys.add(`${nickname} ${lastBaseToken}`);
      }
    }
  }

  // Nickname keys go last so the first key (used for storage) is unchanged.
  for (const key of nicknameKeys) {
    keys.add(key);
  }
  return keys;
}

export function normalizeMarylandCandidateNameForStorage(value: string): string {
  return [...normalizeMarylandCandidateNameKeys(value)][0] ?? normalizePersonName(value);
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
    case "LT GOVERNOR":
      return "Lieutenant Governor";
    case "ATTORNEY GENERAL":
      return "Attorney General";
    case "COMPTROLLER":
    case "STATE COMPTROLLER":
      return "Comptroller";
    case "STATE SENATOR":
    case "STATE SENATE":
      return "State Senator";
    case "STATE DELEGATE":
    case "HOUSE DELEGATES":
    case "MEMBER HOUSE DELEGATES":
    case "STATE REPRESENTATIVE":
    case "STATE HOUSE":
    case "STATE LOWER CHAMBER LEGISLATOR":
      return "State Lower Chamber Legislator";
    default:
      return null;
  }
}

function sourceOfficeCanonicalName(row: MarylandCfsCommitteeRow): string | null {
  switch (normalizeTextKey(row["Office Sought"])) {
    case "GOVERNOR LIEUTENANT GOVERNOR":
      return "Governor";
    case "GOVERNOR":
      return "Governor";
    case "LIEUTENANT GOVERNOR":
    case "LT GOVERNOR":
      return "Lieutenant Governor";
    case "ATTORNEY GENERAL":
      return "Attorney General";
    case "COMPTROLLER":
    case "STATE COMPTROLLER":
      return "Comptroller";
    case "STATE SENATOR":
    case "STATE SENATE":
      return "State Senator";
    case "HOUSE DELEGATES":
    case "HOUSE DELEGATE":
    case "STATE DELEGATE":
    case "STATE REPRESENTATIVE":
      return "State Lower Chamber Legislator";
    default:
      return null;
  }
}

function rowMatchesOffice(input: {
  row: MarylandCfsCommitteeRow;
  officeCanonicalName: string;
}): boolean {
  const rowOffice = sourceOfficeCanonicalName(input.row);
  if (input.officeCanonicalName === "Lieutenant Governor") {
    return rowOffice === "Lieutenant Governor" || normalizeTextKey(input.row["Office Sought"]) === "GOVERNOR LIEUTENANT GOVERNOR";
  }
  return rowOffice === input.officeCanonicalName;
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

function isCandidateCommitteeRow(row: MarylandCfsCommitteeRow): boolean {
  const committeeType = normalizeTextKey(row["Committee Type"]);
  return committeeType === "CANDIDATE" || committeeType === "PUBLIC FINANCING";
}

function committeeElectionYears(row: MarylandCfsCommitteeRow): Set<number> {
  const years = new Set<number>();
  const electionYear = Number.parseInt(row["Election Year"].trim(), 10);
  if (Number.isInteger(electionYear)) {
    years.add(electionYear);
  }
  for (const match of row.Election.matchAll(/\b(20\d{2})\b/g)) {
    if (match[1]) {
      years.add(Number.parseInt(match[1], 10));
    }
  }
  return years;
}

function rowMatchesElectionYear(row: MarylandCfsCommitteeRow, electionYear: number): boolean {
  return committeeElectionYears(row).has(electionYear);
}

function candidateNameFromCommitteeRow(row: MarylandCfsCommitteeRow): string {
  return [
    row["Candidate First Name"],
    row["Candidate Middle Name"],
    row["Candidate LastName"],
    row["Candidate Suffix"],
  ]
    .map((value) => value.trim())
    .filter(Boolean)
    .join(" ");
}

function rowKeyMatchesCandidateName(input: {
  row: MarylandCfsCommitteeRow;
  candidateNameKeys: ReadonlySet<string>;
}): boolean {
  for (const key of normalizeMarylandCandidateNameKeys(candidateNameFromCommitteeRow(input.row))) {
    if (input.candidateNameKeys.has(key)) {
      return true;
    }
  }
  const committeeNameKey = normalizeTextKey(input.row["Committee Name"]);
  if (!committeeNameKey) {
    return false;
  }
  const committeeNameTokens = new Set(committeeNameKey.split(" ").filter(Boolean));
  for (const key of input.candidateNameKeys) {
    const tokens = key.split(" ").filter(Boolean);
    if (tokens.length >= 2 && tokens.every((token) => committeeNameTokens.has(token))) {
      return true;
    }
  }
  return false;
}

function rowMatchesCandidateName(input: {
  row: MarylandCfsCommitteeRow;
  candidateName: string;
  candidateNameKeys: ReadonlySet<string>;
}): boolean {
  if (!rowKeyMatchesCandidateName(input)) {
    return false;
  }
  // Key overlap collapses names to first+last, which would link
  // "John A. Smith" to a committee whose candidate fields say "John B. Smith"
  // as an "exact" match whenever the office and election year agree. The row's
  // own candidate name settles it even when the committee-name fallback is
  // what matched.
  return !hasMiddleNameConflict({
    candidateName: input.candidateName,
    rowNames: [candidateNameFromCommitteeRow(input.row)],
    normalizePersonName,
    firstNamesEquivalent: (candidateFirst, rowFirst) =>
      candidateFirst === rowFirst || firstNameVariants(candidateFirst).includes(rowFirst),
  });
}

function sourceJurisdictionIsStateLevel(row: MarylandCfsCommitteeRow): boolean {
  const jurisdiction = normalizeTextKey(row.Jurisdiction);
  return jurisdiction === "" || jurisdiction === "MARYLAND STATE";
}

function toCommitteeMatch(input: {
  accumulator: CandidateCommitteeAccumulator;
  sourceUrl: string | null;
}): MarylandCandidateCommitteeMatch {
  return {
    committeeId: input.accumulator.committeeId,
    committeeName: input.accumulator.committeeName,
    confidence: "exact",
    source: "cfs_public_export",
    sourceUrl: input.sourceUrl,
    matchedCommitteeRowCount: input.accumulator.rows.length,
  };
}

export function resolveMarylandCandidateCommittee(
  input: MarylandCandidateCommitteeResolverInput
): MarylandCandidateCommitteeResolution {
  const electionYear = normalizeElectionYear(input.electionYear);
  const officeScope = normalizeOfficeScope(input.officeScope);
  const officeCanonicalName = canonicalOfficeNameForInput(input.officeName);
  const officeNameNormalized = officeCanonicalName ?? normalizeTextKey(input.officeName);
  const candidateNameKeys = normalizeMarylandCandidateNameKeys(input.candidateName, { expandNicknames: true });
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
    !isMarylandFinanceEligibleOffice({ officeScope, officeCanonicalName })
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
  if (isExpectedLegislativeOffice(officeScope, officeCanonicalName)) {
    return {
      status: "unmatched",
      reason: "unverified_legislative_district",
      candidateNameNormalized,
      officeNameNormalized,
    };
  }

  const rowsByCommittee = new Map<string, CandidateCommitteeAccumulator>();
  for (const row of input.committeeRows) {
    const committeeId = row["Filing Entity Id"].trim().replace(/\s+/g, " ");
    const committeeName = row["Committee Name"].trim();
    if (!committeeId || !committeeName) {
      continue;
    }
    if (!isCandidateCommitteeRow(row)) {
      continue;
    }
    if (!rowMatchesElectionYear(row, electionYear)) {
      continue;
    }
    if (!sourceJurisdictionIsStateLevel(row)) {
      continue;
    }
    if (!rowMatchesOffice({ row, officeCanonicalName })) {
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
