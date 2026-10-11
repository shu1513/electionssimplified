import { firstNameVariants } from "../finance/personFirstNameNicknames.js";
import { hasMiddleNameConflict } from "../finance/personNameMiddleEvidence.js";
import type { NebraskaNadcContributionRow } from "./nebraskaNadcArtifactReader.js";
import {
  isNebraskaFinanceEligibleOffice,
  mapNebraskaNadcJurisdictionOffice,
  normalizeNebraskaNadcOfficeLabel,
  type NebraskaFinanceOfficeScope,
} from "./nebraskaFinanceEligibleOffices.js";

export type NebraskaCandidateCommitteeResolverInput = {
  candidateName: string;
  officeScope: string;
  officeName: string;
  electionYear: number;
  district?: string | null;
  contributionRows: readonly NebraskaNadcContributionRow[];
  sourceUrl?: string | null;
};

export type NebraskaCandidateCommitteeMatch = {
  committeeId: string;
  committeeName: string;
  confidence: "exact";
  source: "nadc_bulk";
  sourceUrl: string | null;
  matchedContributionRowCount: number;
};

export type NebraskaCandidateCommitteeResolution =
  | ({ status: "matched" } & NebraskaCandidateCommitteeMatch)
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
      matches: NebraskaCandidateCommitteeMatch[];
    };

type CandidateCommitteeAccumulator = {
  committeeId: string;
  committeeName: string;
  rows: NebraskaNadcContributionRow[];
};

const NADC_JURISDICTION_OFFICE_FIELD = "Jurisdiction - Office - District or Ballot Description";

function normalizeElectionYear(value: number): number {
  if (!Number.isInteger(value) || value < 2021 || value > 2100) {
    throw new Error(`Invalid Nebraska candidate committee election year: ${value}`);
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
// variants ("Mike Hilgers" → "MICHAEL HILGERS"): NADC lists the formal name
// while VoteApp stores the campaign name. Expand the VoteApp side only
// (personFirstNameNicknames.ts explains why); rows are keyed literally.
export function normalizeNebraskaCandidateNameKeys(
  value: string,
  options: { expandNicknames?: boolean } = {}
): Set<string> {
  const trimmed = value.trim();
  const normalized = normalizePersonName(trimmed);
  const keys = new Set<string>();
  const nicknameKeys = new Set<string>();
  const addFirstLast = (first: string, last: string): void => {
    keys.add(`${first} ${last}`);
    if (options.expandNicknames) {
      for (const variant of firstNameVariants(first)) {
        nicknameKeys.add(`${variant} ${last}`);
      }
    }
  };
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
    }
    for (const key of nicknameKeys) {
      keys.add(key);
    }
    return keys;
  }

  const parts = normalized.split(" ").filter(Boolean);
  if (parts.length >= 2) {
    addFirstLast(parts[0] ?? "", parts[parts.length - 1] ?? "");
  }

  // Nickname keys go last so the first key (used for storage) is unchanged.
  for (const key of nicknameKeys) {
    keys.add(key);
  }
  return keys;
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

function canonicalOfficeNameForInput(officeName: string): string | null {
  const normalized = normalizeNebraskaNadcOfficeLabel(officeName);
  switch (normalized) {
    case "GOVERNOR":
      return "Governor";
    case "SECRETARY OF STATE":
      return "Secretary of State";
    case "ATTORNEY GENERAL":
      return "Attorney General";
    case "STATE TREASURER":
      return "State Treasurer";
    case "AUDITOR OF PUBLIC ACCOUNTS":
    case "STATE AUDITOR":
      return "State Auditor";
    case "STATE LEGISLATURE":
    case "STATE SENATOR":
      return "State Senator";
    default:
      return null;
  }
}

function normalizeOfficeScope(value: string): NebraskaFinanceOfficeScope | null {
  const normalized = value.trim();
  return normalized === "statewide" || normalized === "state_upper" ? normalized : null;
}

function isExpectedLegislativeOffice(officeScope: string | null, officeCanonicalName: string | null): boolean {
  return officeScope === "state_upper" && officeCanonicalName === "State Senator";
}

function parseNebraskaNadcDateYear(raw: string): number | null {
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

function isElectionCycleContribution(row: NebraskaNadcContributionRow, electionYear: number): boolean {
  const year = parseNebraskaNadcDateYear(row["Receipt Date"]);
  return year !== null && year >= electionYear - 1 && year <= electionYear;
}

function isCandidateCommittee(row: NebraskaNadcContributionRow): boolean {
  return normalizeTextKey(row["Filer Type"]) === "CANDIDATE COMMITTEE";
}

function rowMatchesCandidateName(input: {
  row: NebraskaNadcContributionRow;
  candidateName: string;
  candidateNameKeys: ReadonlySet<string>;
}): boolean {
  const rowCandidateName = input.row["Candidate Name"];
  let keyMatched = false;
  for (const key of normalizeNebraskaCandidateNameKeys(rowCandidateName)) {
    if (input.candidateNameKeys.has(key)) {
      keyMatched = true;
      break;
    }
  }
  if (!keyMatched) {
    return false;
  }
  // Key overlap collapses names to first+last, which would attach
  // "VEST, RICK J."'s committee to a "Rick T. Vest" in the same race. A
  // contradicting middle name rejects the row (georgia pattern).
  return !hasMiddleNameConflict({
    candidateName: input.candidateName,
    rowNames: [rowCandidateName],
    normalizePersonName,
    firstNamesEquivalent: (candidateFirst, rowFirst) =>
      candidateFirst === rowFirst || firstNameVariants(candidateFirst).includes(rowFirst),
  });
}

function rowMatchesExpectedOfficeDistrict(input: {
  row: NebraskaNadcContributionRow;
  officeScope: NebraskaFinanceOfficeScope;
  officeCanonicalName: string;
  expectedDistrict: string;
}): boolean {
  const rawJurisdiction = (input.row as Record<string, string | undefined>)[NADC_JURISDICTION_OFFICE_FIELD]?.trim();
  if (!rawJurisdiction) {
    return true;
  }

  const mapping = mapNebraskaNadcJurisdictionOffice({ jurisdictionOfficeDistrict: rawJurisdiction });
  if (!mapping) {
    return false;
  }
  if (mapping.officeScope !== input.officeScope || mapping.officeCanonicalName !== input.officeCanonicalName) {
    return false;
  }
  if (isExpectedLegislativeOffice(input.officeScope, input.officeCanonicalName)) {
    return mapping.district === input.expectedDistrict;
  }
  return true;
}

function toCommitteeMatch(input: {
  accumulator: CandidateCommitteeAccumulator;
  sourceUrl: string | null;
}): NebraskaCandidateCommitteeMatch {
  return {
    committeeId: input.accumulator.committeeId,
    committeeName: input.accumulator.committeeName,
    confidence: "exact",
    source: "nadc_bulk",
    sourceUrl: input.sourceUrl,
    matchedContributionRowCount: input.accumulator.rows.length,
  };
}

export function resolveNebraskaCandidateCommittee(
  input: NebraskaCandidateCommitteeResolverInput
): NebraskaCandidateCommitteeResolution {
  const electionYear = normalizeElectionYear(input.electionYear);
  const officeScope = normalizeOfficeScope(input.officeScope);
  const officeCanonicalName = canonicalOfficeNameForInput(input.officeName);
  const officeNameNormalized = officeCanonicalName ?? normalizeTextKey(input.officeName);
  const candidateNameKeys = normalizeNebraskaCandidateNameKeys(input.candidateName, { expandNicknames: true });
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
    !isNebraskaFinanceEligibleOffice({ officeScope, officeCanonicalName })
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
    const committeeId = row["Org ID"].trim().toUpperCase();
    const committeeName = row["Filer Name"].trim();
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
    if (
      !rowMatchesExpectedOfficeDistrict({
        row,
        officeScope,
        officeCanonicalName,
        expectedDistrict,
      })
    ) {
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

  const matches = [...rowsByCommittee.values()].map((accumulator) =>
    toCommitteeMatch({ accumulator, sourceUrl: input.sourceUrl ?? null })
  );

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
