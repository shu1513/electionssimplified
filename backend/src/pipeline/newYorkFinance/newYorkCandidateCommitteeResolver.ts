import { hasMiddleNameConflict } from "../finance/personNameMiddleEvidence.js";
import {
  searchNewYorkActiveAuthorizedCommitteeFilers,
  searchNewYorkActiveCandidateFilers,
  NEW_YORK_SODA_FILERS_PAGE_URL,
  type NewYorkFilerRecord,
  type NewYorkSodaClientOptions,
} from "./newYorkSodaClient.js";
import { toNewYorkBoeOfficeSearchInput } from "./newYorkFinanceEligibleOffices.js";

// The NYSBOE filer registry has no candidate -> authorized-committee foreign
// key (verified in docs/plans/plan-new-york-finance.md), so committee resolution is
// name-based and deliberately conservative:
//   1. the candidate must appear in the registry as an ACTIVE State-level
//      CANDIDATE filer for the expected office and district, and
//   2. exactly one ACTIVE Authorized Single Candidate Committee's name must
//      contain the candidate's first and last name.
// Anything ambiguous is skipped rather than guessed; manual links
// (link_source = 'manual') are the escape hatch.

export type NewYorkCandidateCommitteeSearchInput = {
  candidateName: string;
  officeScope: string;
  officeName: string;
  electionYear: number;
  district?: string | null;
};

export type NewYorkCandidateCommitteeResolverInput = NewYorkCandidateCommitteeSearchInput & {
  candidateFilers: readonly NewYorkFilerRecord[];
  committeeFilers: readonly NewYorkFilerRecord[];
};

export type NewYorkCandidateCommitteeMatch = {
  filerId: string;
  filerName: string;
  candidateFilerId: string;
  confidence: "exact" | "surname_committee";
  source: "ny_soda_api";
  sourceUrl: string | null;
};

export type NewYorkCandidateCommitteeResolution =
  | ({ status: "matched" } & NewYorkCandidateCommitteeMatch)
  | {
      status: "unmatched";
      reason:
        | "missing_candidate_name"
        | "unsupported_office"
        | "missing_district"
        | "no_registered_candidate"
        | "no_candidate_committee_match";
      candidateNameNormalized: string;
      officeNameNormalized: string;
    }
  | {
      status: "ambiguous";
      reason: "multiple_registered_candidates" | "multiple_matching_committees";
      candidateNameNormalized: string;
      officeNameNormalized: string;
      matches: { filerId: string; filerName: string }[];
    };

function normalizeTextKey(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
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

export function normalizeNewYorkCandidateNameKeys(value: string): Set<string> {
  const trimmed = value.trim();
  const keys = new Set<string>();

  function addName(raw: string): void {
    const hasComma = raw.includes(",");
    const normalized = normalizePersonName(raw);
    if (normalized) {
      keys.add(normalized);
    }

    const parts = normalized.split(" ").filter(Boolean);
    if (!hasComma && parts.length >= 2) {
      keys.add(`${parts[0]} ${parts[parts.length - 1]}`);
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
          keys.add(`${flippedParts[0]} ${flippedParts[flippedParts.length - 1]}`);
        }
      }
    }
  }

  addName(trimmed.replace(/\([^()]+\)/g, " "));

  const parentheticalMatches = trimmed.matchAll(/\(([^()]+)\)/g);
  for (const match of parentheticalMatches) {
    if (match[1]) {
      addName(match[1]);
    }
  }

  return keys;
}

function candidateNameNormalized(value: string): string {
  return [...normalizeNewYorkCandidateNameKeys(value)][0] ?? normalizePersonName(value);
}

export function newYorkCandidateFirstLastName(value: string): { firstName: string; lastName: string } | null {
  // Prefer the "FIRST LAST" key the normalizer produces for multi-part names.
  const keys = [...normalizeNewYorkCandidateNameKeys(value)];
  for (const key of keys) {
    const parts = key.split(" ").filter(Boolean);
    if (parts.length === 2 && parts[0].length >= 2 && parts[1].length >= 2) {
      return { firstName: parts[0], lastName: parts[1] };
    }
  }
  const fallback = (keys[0] ?? "").split(" ").filter(Boolean);
  if (fallback.length >= 2) {
    const firstName = fallback[0];
    const lastName = fallback[fallback.length - 1];
    if (firstName.length >= 2 && lastName.length >= 2) {
      return { firstName, lastName };
    }
  }
  return null;
}

// Shared middle-name evidence gate: the key set collapses names to first+last,
// which would treat "Kathy C. Hochul" and "HOCHUL, KATHY B." as the same
// registered filer whenever office and district agree. A contradicting middle
// name rejects the pair.
export function newYorkCandidateNameMiddleConflict(candidateName: string, rowName: string): boolean {
  return hasMiddleNameConflict({ candidateName, rowNames: [rowName], normalizePersonName });
}

function filerNameMatchesCandidate(
  filerName: string,
  candidateName: string,
  candidateNameKeys: ReadonlySet<string>
): boolean {
  for (const key of normalizeNewYorkCandidateNameKeys(filerName)) {
    if (candidateNameKeys.has(key)) {
      return !newYorkCandidateNameMiddleConflict(candidateName, filerName);
    }
  }
  return false;
}

function committeeNameContainsCandidate(
  committeeName: string,
  name: { firstName: string; lastName: string }
): boolean {
  const tokens = new Set(normalizeTextKey(committeeName).split(" ").filter(Boolean));
  return tokens.has(name.firstName) && tokens.has(name.lastName);
}

// Statewide committees are often named by surname alone ("Blakeman for New
// York", "James for NY 2026"). For a statewide race with exactly one
// registered candidate filer, a committee whose name minus wrappers and
// office words is exactly the surname is admitted when no full-name
// committee exists; an office word in the name must name this race.
const STATEWIDE_OFFICE_WORDS: Record<string, readonly string[]> = {
  Governor: ["GOVERNOR", "GOV"],
  "Lieutenant Governor": ["LIEUTENANT", "LT", "GOVERNOR", "GOV"],
  "Attorney General": ["ATTORNEY", "AG"],
  "State Comptroller": ["COMPTROLLER"],
};
const ALL_OFFICE_WORDS = new Set([
  ...Object.values(STATEWIDE_OFFICE_WORDS).flat(),
  "ASSEMBLY", "SENATE", "SENATOR", "ASSEMBLYMAN", "ASSEMBLYWOMAN", "ASSEMBLYMEMBER",
  "CONGRESS", "MAYOR", "COUNCIL", "JUDGE", "JUSTICE", "COURT", "SUPERVISOR", "LEGISLATOR",
  "LEGISLATURE", "DISTRICT", "DA", "SHERIFF", "CLERK", "COMPTROLLER", "ATTORNEY",
]);
const COMMITTEE_WRAPPER_WORDS = new Set([
  "THE", "OF", "FOR", "TO", "ELECT", "RE", "REELECT", "VOTE", "COMMITTEE", "FRIENDS", "CITIZENS",
  "PEOPLE", "NEW", "YORK", "YORKERS", "NY", "NYS", "NYC", "CAMPAIGN", "INC", "AND", "A", "TEAM",
  "OUR", "ALL", "ONE", "KEEP", "WITH", "NEIGHBORS", "SUPPORTERS", "VICTORY", "FUND",
]);

function committeeNameIsSurnameOnly(input: {
  committeeName: string;
  lastName: string;
  officeCanonicalName: string;
}): boolean {
  const raceWords = new Set(STATEWIDE_OFFICE_WORDS[input.officeCanonicalName] ?? []);
  const nameTokens: string[] = [];
  for (const token of normalizeTextKey(input.committeeName).split(" ").filter(Boolean)) {
    if (COMMITTEE_WRAPPER_WORDS.has(token) || /^\d{2,4}$/.test(token)) {
      continue;
    }
    if (ALL_OFFICE_WORDS.has(token)) {
      if (!raceWords.has(token)) {
        return false;
      }
      continue;
    }
    nameTokens.push(token);
  }
  return nameTokens.length === 1 && nameTokens[0] === input.lastName;
}

export function resolveNewYorkCandidateCommittee(
  input: NewYorkCandidateCommitteeResolverInput
): NewYorkCandidateCommitteeResolution {
  const candidateNameKeys = normalizeNewYorkCandidateNameKeys(input.candidateName);
  const candidateNameKey = candidateNameNormalized(input.candidateName);
  const officeSearch = toNewYorkBoeOfficeSearchInput({
    officeScope: input.officeScope,
    officeCanonicalName: input.officeName,
    district: input.district,
  });
  const officeNameNormalized = officeSearch?.boeOfficeLabels[0] ?? normalizeTextKey(input.officeName);
  const firstLast = newYorkCandidateFirstLastName(input.candidateName);

  if (candidateNameKeys.size === 0 || !firstLast) {
    return {
      status: "unmatched",
      reason: "missing_candidate_name",
      candidateNameNormalized: candidateNameKey,
      officeNameNormalized,
    };
  }
  if (!officeSearch) {
    const isLegislativeOffice =
      (input.officeScope === "state_upper" && input.officeName.trim() === "State Senator") ||
      (input.officeScope === "state_lower" && input.officeName.trim() === "State Lower Chamber Legislator");
    return {
      status: "unmatched",
      reason: isLegislativeOffice ? "missing_district" : "unsupported_office",
      candidateNameNormalized: candidateNameKey,
      officeNameNormalized,
    };
  }

  const registeredCandidates = input.candidateFilers.filter((filer) =>
    filerNameMatchesCandidate(filer.filerName, input.candidateName, candidateNameKeys)
  );
  if (registeredCandidates.length === 0) {
    return {
      status: "unmatched",
      reason: "no_registered_candidate",
      candidateNameNormalized: candidateNameKey,
      officeNameNormalized,
    };
  }
  if (new Set(registeredCandidates.map((filer) => filer.filerId)).size > 1) {
    return {
      status: "ambiguous",
      reason: "multiple_registered_candidates",
      candidateNameNormalized: candidateNameKey,
      officeNameNormalized,
      matches: registeredCandidates.map((filer) => ({ filerId: filer.filerId, filerName: filer.filerName })),
    };
  }
  const candidateFilerId = registeredCandidates[0].filerId;

  const matchingCommittees = new Map<string, NewYorkFilerRecord>();
  for (const committee of input.committeeFilers) {
    if (committeeNameContainsCandidate(committee.filerName, firstLast)) {
      matchingCommittees.set(committee.filerId, committee);
    }
  }
  let confidence: NewYorkCandidateCommitteeMatch["confidence"] = "exact";
  if (matchingCommittees.size === 0 && input.officeScope === "statewide") {
    for (const committee of input.committeeFilers) {
      if (
        committeeNameIsSurnameOnly({
          committeeName: committee.filerName,
          lastName: firstLast.lastName,
          officeCanonicalName: input.officeName.trim(),
        })
      ) {
        matchingCommittees.set(committee.filerId, committee);
      }
    }
    confidence = "surname_committee";
  }
  if (matchingCommittees.size === 0) {
    return {
      status: "unmatched",
      reason: "no_candidate_committee_match",
      candidateNameNormalized: candidateNameKey,
      officeNameNormalized,
    };
  }
  if (matchingCommittees.size > 1) {
    return {
      status: "ambiguous",
      reason: "multiple_matching_committees",
      candidateNameNormalized: candidateNameKey,
      officeNameNormalized,
      matches: [...matchingCommittees.values()].map((filer) => ({ filerId: filer.filerId, filerName: filer.filerName })),
    };
  }

  const committee = [...matchingCommittees.values()][0];
  return {
    status: "matched",
    filerId: committee.filerId,
    filerName: committee.filerName,
    candidateFilerId,
    confidence,
    source: "ny_soda_api",
    sourceUrl: NEW_YORK_SODA_FILERS_PAGE_URL,
  };
}

export async function searchAndResolveNewYorkCandidateCommittee(
  input: NewYorkCandidateCommitteeSearchInput,
  options: NewYorkSodaClientOptions = {}
): Promise<NewYorkCandidateCommitteeResolution> {
  const officeSearch = toNewYorkBoeOfficeSearchInput({
    officeScope: input.officeScope,
    officeCanonicalName: input.officeName,
    district: input.district,
  });
  const firstLast = newYorkCandidateFirstLastName(input.candidateName);
  if (!officeSearch || !firstLast) {
    return resolveNewYorkCandidateCommittee({ ...input, candidateFilers: [], committeeFilers: [] });
  }

  const candidateFilers = await searchNewYorkActiveCandidateFilers(
    { boeOfficeLabels: officeSearch.boeOfficeLabels, district: officeSearch.district },
    options
  );
  const committeeFilers = await searchNewYorkActiveAuthorizedCommitteeFilers(
    { nameContains: firstLast.lastName },
    options
  );
  return resolveNewYorkCandidateCommittee({ ...input, candidateFilers, committeeFilers });
}
