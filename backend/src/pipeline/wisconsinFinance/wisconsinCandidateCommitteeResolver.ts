import { firstNameVariants } from "../finance/personFirstNameNicknames.js";
import { hasMiddleNameConflict } from "../finance/personNameMiddleEvidence.js";
import {
  searchWisconsinSunshineCommittees,
  type WisconsinSunshineClientOptions,
  type WisconsinSunshineCommittee,
} from "./wisconsinSunshineClient.js";
import {
  normalizeWisconsinSunshineLegislativeDistrict,
  toWisconsinSunshineOfficeSearchInput,
} from "./wisconsinFinanceEligibleOffices.js";

export type WisconsinCandidateCommitteeResolverInput = {
  candidateName: string;
  officeScope: string;
  officeName: string;
  electionYear: number;
  district?: string | null;
  committees: readonly WisconsinSunshineCommittee[];
};

export type WisconsinCandidateCommitteeSearchInput = Omit<WisconsinCandidateCommitteeResolverInput, "committees">;

export type WisconsinCandidateCommitteeMatch = {
  entityId: string;
  committeeId: string;
  assignedCommitteeId?: string;
  committeeName: string;
  confidence: "exact";
  source: "sunshine_api";
  sourceUrl: string | null;
  matchedCommitteeRowCount: number;
};

export type WisconsinCandidateCommitteeResolution =
  | ({ status: "matched" } & WisconsinCandidateCommitteeMatch)
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
      matches: WisconsinCandidateCommitteeMatch[];
    };

type CandidateCommitteeAccumulator = {
  entityId: string;
  committeeId: string;
  assignedCommitteeId?: string;
  committeeName: string;
  sourceUrl: string | null;
  rows: WisconsinSunshineCommittee[];
};

function normalizeElectionYear(value: number): number {
  if (!Number.isInteger(value) || value < 2000 || value > 2100) {
    throw new Error(`Invalid Wisconsin candidate committee election year: ${value}`);
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
    .replace(/\b(THE|OF|FOR)\b/g, " ")
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
// variants ("Josh Kaul" → "JOSHUA KAUL"): Sunshine lists the candidate's
// formal name ("Joshua Kaul") while VoteApp stores the campaign name. Expand
// the VoteApp side only (personFirstNameNicknames.ts explains why).
export function normalizeWisconsinCandidateNameKeys(
  value: string,
  options: { expandNicknames?: boolean } = {}
): Set<string> {
  const trimmed = value.trim();
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

  addName(trimmed.replace(/\([^()]+\)/g, " "));
  for (const match of trimmed.matchAll(/\(([^()]+)\)/g)) {
    if (match[1]) {
      addName(match[1]);
    }
  }

  // Nickname keys go last so the first key (used for storage) is unchanged.
  for (const key of nicknameKeys) {
    keys.add(key);
  }
  return keys;
}

function candidateNameNormalized(value: string): string {
  return [...normalizeWisconsinCandidateNameKeys(value)][0] ?? normalizePersonName(value);
}

export function normalizeWisconsinCandidateNameForStorage(value: string): string {
  return candidateNameNormalized(value);
}

function committeeMatchesCandidateName(input: {
  committee: WisconsinSunshineCommittee;
  candidateName: string;
  candidateNameKeys: ReadonlySet<string>;
}): boolean {
  const names = [input.committee.committeeName, ...input.committee.candidateNames];
  let keyMatched = false;
  for (const name of names) {
    for (const key of normalizeWisconsinCandidateNameKeys(name)) {
      if (input.candidateNameKeys.has(key)) {
        keyMatched = true;
        break;
      }
    }
    if (keyMatched) {
      break;
    }
  }
  if (!keyMatched) {
    return false;
  }
  // Key overlap collapses names to first+last, so candidate connection
  // "Tiffany, Thomas J." would match candidate "Thomas P. Tiffany" as an
  // "exact" committee. A contradicting middle name rejects the committee, and
  // the veto reads every connection name because one committee row can carry
  // both a middle-bearing and a middle-less spelling of the same person.
  return !hasMiddleNameConflict({
    candidateName: input.candidateName,
    rowNames: names,
    normalizePersonName,
    firstNamesEquivalent: (candidateFirst, rowFirst) =>
      candidateFirst === rowFirst || firstNameVariants(candidateFirst).includes(rowFirst),
  });
}

// Sunshine office labels as they appear inside committee names ("Toney for
// Attorney General"). When several active committees belong to the same
// candidate (a current statewide committee and an older local one), the one
// whose name carries this race's office is the funded vehicle.
function committeeNameNamesOffice(committeeName: string, sunshineOffice: string): boolean {
  const name = ` ${normalizeTextKey(committeeName)} `;
  const office = normalizeTextKey(sunshineOffice);
  return office.length > 0 && name.includes(` ${office} `);
}

function statusText(value: string | undefined): string {
  return normalizeTextKey(value ?? "");
}

function isCommitteeUsable(committee: WisconsinSunshineCommittee): boolean {
  if (!committee.entityId.trim() || !committee.committeeId?.trim() || !committee.committeeName.trim()) {
    return false;
  }
  if (statusText(committee.committeeType) !== "STATE CANDIDATE") {
    return false;
  }
  const statusSlug = statusText(committee.committeeStatusSlug);
  const status = statusText(committee.committeeStatus);
  if (statusSlug && statusSlug !== "ACTIVE") {
    return false;
  }
  if (/\b(?:TERMINATED|INACTIVE|WITHDREW|WITHDRAWN|SUSPENDED)\b/.test(status)) {
    return false;
  }
  return true;
}

function toCommitteeMatch(accumulator: CandidateCommitteeAccumulator): WisconsinCandidateCommitteeMatch {
  return {
    entityId: accumulator.entityId,
    committeeId: accumulator.committeeId,
    ...(accumulator.assignedCommitteeId ? { assignedCommitteeId: accumulator.assignedCommitteeId } : {}),
    committeeName: accumulator.committeeName,
    confidence: "exact",
    source: "sunshine_api",
    sourceUrl: accumulator.sourceUrl,
    matchedCommitteeRowCount: accumulator.rows.length,
  };
}

export function resolveWisconsinCandidateCommittee(
  input: WisconsinCandidateCommitteeResolverInput
): WisconsinCandidateCommitteeResolution {
  normalizeElectionYear(input.electionYear);
  const candidateNameKeys = normalizeWisconsinCandidateNameKeys(input.candidateName, { expandNicknames: true });
  const candidateNameKey = candidateNameNormalized(input.candidateName);
  const officeSearchInput = toWisconsinSunshineOfficeSearchInput({
    officeScope: input.officeScope,
    officeCanonicalName: input.officeName,
    district: input.district,
  });
  const officeNameNormalized = officeSearchInput?.sunshineOffice ?? normalizeTextKey(input.officeName);

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
    const hasDistrict = normalizeWisconsinSunshineLegislativeDistrict(input.district) !== null;
    return {
      status: "unmatched",
      reason: isLegislativeOffice && !hasDistrict ? "missing_legislative_district" : "unsupported_office",
      candidateNameNormalized: candidateNameKey,
      officeNameNormalized,
    };
  }

  const rowsByCommittee = new Map<string, CandidateCommitteeAccumulator>();
  for (const committee of input.committees) {
    const entityId = committee.entityId.trim();
    const committeeId = committee.committeeId?.trim();
    const committeeName = committee.committeeName.trim();
    if (!entityId || !committeeId || !committeeName) {
      continue;
    }
    if (!isCommitteeUsable(committee)) {
      continue;
    }
    if (!committeeMatchesCandidateName({ committee, candidateName: input.candidateName, candidateNameKeys })) {
      continue;
    }

    const committeeKey = `${entityId}\u0000${committeeId}`;
    const accumulator = rowsByCommittee.get(committeeKey) ?? {
      entityId,
      committeeId,
      ...(committee.assignedCommitteeId ? { assignedCommitteeId: committee.assignedCommitteeId } : {}),
      committeeName,
      sourceUrl: committee.sourceUrl ?? null,
      rows: [],
    };
    accumulator.rows.push(committee);
    rowsByCommittee.set(committeeKey, accumulator);
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
    .sort((left, right) => left.entityId.localeCompare(right.entityId) || left.committeeId.localeCompare(right.committeeId));

  if (matches.length === 1) {
    return {
      status: "matched",
      ...matches[0],
    };
  }

  // Live: Eric Toney has "Toney for Attorney General" and his older
  // "Citizens for Eric Toney", both active. Exactly one names the race.
  const officeNamed = matches.filter((match) =>
    committeeNameNamesOffice(match.committeeName, officeSearchInput.sunshineOffice)
  );
  if (officeNamed.length === 1) {
    return {
      status: "matched",
      ...officeNamed[0],
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

export async function searchAndResolveWisconsinCandidateCommittee(
  input: WisconsinCandidateCommitteeSearchInput,
  options: WisconsinSunshineClientOptions = {}
): Promise<WisconsinCandidateCommitteeResolution> {
  const officeSearchInput = toWisconsinSunshineOfficeSearchInput({
    officeScope: input.officeScope,
    officeCanonicalName: input.officeName,
    district: input.district,
  });
  if (!officeSearchInput) {
    return resolveWisconsinCandidateCommittee({ ...input, committees: [] });
  }

  const committees = await searchWisconsinSunshineCommittees(
    {
      searchTerm: input.candidateName,
      limit: 50,
    },
    options
  );
  return resolveWisconsinCandidateCommittee({ ...input, committees });
}
