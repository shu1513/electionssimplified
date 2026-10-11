import { firstNameVariants } from "../finance/personFirstNameNicknames.js";
import { hasMiddleNameConflict, personNameParseVariants } from "../finance/personNameMiddleEvidence.js";
import {
  searchTennesseeCampCandidates,
  type TennesseeCampCandidateRecord,
  type TennesseeCampClientOptions,
} from "./tennesseeCampClient.js";
import {
  normalizeTennesseeCampDistrict,
  tennesseeCampOfficeLabelForAppOffice,
  toTennesseeCampOfficeSearchInput,
} from "./tennesseeFinanceEligibleOffices.js";

export type TennesseeCandidateCommitteeResolverInput = {
  candidateName: string;
  officeScope: string;
  officeName: string;
  electionYear: number;
  district?: string | null;
  candidateRecords: readonly TennesseeCampCandidateRecord[];
};

export type TennesseeCandidateCommitteeSearchInput = Omit<
  TennesseeCandidateCommitteeResolverInput,
  "candidateRecords"
>;

export type TennesseeCandidateCommitteeMatch = {
  campCandidateId: string;
  ownerName: string;
  candidateName: string;
  officeSought: string | null;
  district: string | null;
  confidence: "exact";
  source: "tncamp_search";
  sourceUrl: string | null;
  reportListUrl: string | null;
  matchedRowCount: number;
};

export type TennesseeCandidateCommitteeResolution =
  | ({ status: "matched" } & TennesseeCandidateCommitteeMatch)
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
      matches: TennesseeCandidateCommitteeMatch[];
    };

type CandidateAccumulator = {
  campCandidateId: string;
  ownerName: string;
  candidateName: string;
  officeSought: string | null;
  district: string | null;
  sourceUrl: string | null;
  reportListUrl: string | null;
  rows: TennesseeCampCandidateRecord[];
};

function normalizeElectionYear(value: number): number {
  if (!Number.isInteger(value) || value < 2000 || value > 2100) {
    throw new Error(`Invalid Tennessee candidate committee election year: ${value}`);
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
    .replace(/\b(THE|OF|FOR|COMMITTEE|FRIENDS)\b/g, " ")
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

export function normalizeTennesseeCandidateNameKeys(value: string): Set<string> {
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
  for (const match of trimmed.matchAll(/\(([^()]+)\)/g)) {
    if (match[1]) {
      addName(match[1]);
    }
  }
  return keys;
}

function candidateNameNormalized(value: string): string {
  return [...normalizeTennesseeCandidateNameKeys(value)][0] ?? normalizePersonName(value);
}

// Quoted call names ('Dewey "Rusty" Crowe') read like the parenthetical form
// the shared parser already understands ("Dewey (Rusty) Crowe").
function quotedAliasToParenthetical(value: string): string {
  return value.replace(
    /(^|\s)["\u201c]([A-Za-z][A-Za-z .-]{1,40})["\u201d](?=\s|$)/g,
    (_match, prefix: string, alias: string) => `${prefix}(${alias})`
  );
}

function normalizeSearchToken(value: string): string {
  return value
    .replace(/\b(JR|SR|II|III|IV)\.?(?=\s|,|$)/gi, " ")
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

// CAMP's candidate search is a last-name PREFIX search on the filed name, so
// the token keeps hyphens and apostrophes ("PIERRE-GRIFFIN", "D'APOLITO"):
// normalized to "GRIFFIN" or "APOLITO" it finds nothing. A three-word
// VoteApp name may hide an unhyphenated compound surname ("Esther Helton
// Haynes" files as HELTON-HAYNES), so the word before the last is a second
// search token, tried only when the first finds no match.
export function tennesseeCampLastNameSearchTokens(candidateName: string): string[] {
  // A trailing ", Jr." is a suffix, not a "Last, First" comma.
  const trimmed = quotedAliasToParenthetical(candidateName)
    .replace(/\([^()]+\)/g, " ")
    .trim()
    .replace(/,?\s*\b(JR|SR|II|III|IV)\.?$/i, "")
    .trim();
  if (trimmed.includes(",")) {
    const commaFirst = normalizeSearchToken(trimmed.split(",", 1)[0] ?? "");
    if (commaFirst) {
      return [commaFirst];
    }
  }
  const words = normalizeSearchToken(trimmed).split(/\s+/).filter(Boolean);
  const tokens = [words.at(-1) ?? trimmed.toUpperCase()];
  const beforeLast = words.length >= 3 ? words.at(-2) : undefined;
  if (beforeLast && beforeLast.replace(/[^A-Z]/g, "").length > 1) {
    tokens.push(beforeLast);
  }
  return tokens;
}

// How far a name may stray from the literal first+last key. Tried in order,
// each only when the previous tier matched nothing:
//   literal  - first+last keys, including one-word call names given in
//              parentheses or quotes ("BULSO, EUGENE N. (GINO)" -> GINO BULSO);
//   nickname - the VoteApp first name expands to its nickname variants
//              ("Mike Sparks" -> MICHAEL SPARKS); the CAMP name is read
//              literally (personFirstNameNicknames.ts);
//   middle   - the candidate goes by a middle name: VoteApp "Brian Stewart"
//              is filed as "STEWART, CHRISTOPHER BRIAN", and "R. Jason
//              Goodman" as "GOODMAN, RALPH JASON".
// Office, district, and year already agree before names are compared.
type NameMatchTier = "literal" | "nickname" | "middle";

function parseVariants(value: string) {
  return personNameParseVariants(quotedAliasToParenthetical(value), normalizePersonName);
}

function candidateTierKeys(candidateName: string, tier: NameMatchTier): Set<string> {
  const keys = normalizeTennesseeCandidateNameKeys(candidateName);
  for (const variant of parseVariants(candidateName)) {
    keys.add(`${variant.first} ${variant.last}`);
    if (tier === "nickname") {
      for (const nickname of firstNameVariants(variant.first)) {
        keys.add(`${nickname} ${variant.last}`);
      }
    }
    const firstMiddle = variant.middles[0];
    if (tier === "middle" && variant.first.length === 1 && firstMiddle && firstMiddle.length > 1) {
      keys.add(`${firstMiddle} ${variant.last}`);
    }
  }
  return keys;
}

function rowTierKeys(rowName: string, tier: NameMatchTier): Set<string> {
  const keys = normalizeTennesseeCandidateNameKeys(rowName);
  for (const variant of parseVariants(rowName)) {
    keys.add(`${variant.first} ${variant.last}`);
    if (tier === "middle") {
      for (const middle of variant.middles) {
        if (middle.length > 1) {
          keys.add(`${middle} ${variant.last}`);
        }
      }
    }
  }
  return keys;
}

function nicknameFirstNamesEquivalent(candidateFirst: string, rowFirst: string): boolean {
  return candidateFirst === rowFirst || firstNameVariants(candidateFirst).includes(rowFirst);
}

function recordMatchesCandidateName(input: {
  record: TennesseeCampCandidateRecord;
  candidateName: string;
  candidateNameKeys: ReadonlySet<string>;
  tier: NameMatchTier;
}): boolean {
  const names = [input.record.name, input.record.ownerName].filter(Boolean);
  let keyMatched = false;
  for (const name of names) {
    for (const key of rowTierKeys(name, input.tier)) {
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
  // The middle tier matched the candidate's middle name. When the candidate's
  // first name is an initial ("R. Jason Goodman"), a row whose first name is a
  // different given name has to start with that initial: "GOODMAN, RALPH
  // JASON" does, "GOODMAN, MATTHEW JASON" is someone else. The shared middle
  // gate cannot see this because "R" and "MATTHEW" never align as first names.
  if (input.tier === "middle") {
    const candidateVariants = parseVariants(input.candidateName);
    const initials = candidateVariants.map((variant) => variant.first).filter((first) => first.length === 1);
    const candidateSurnames = new Set(candidateVariants.map((variant) => variant.last));
    const candidateGivenNames = new Set(candidateVariants.flatMap((variant) => [variant.first, ...variant.middles]));
    const contradicted =
      initials.length > 0 &&
      names.some((name) =>
        parseVariants(name).some(
          (variant) =>
            candidateSurnames.has(variant.last) &&
            variant.first.length > 1 &&
            !candidateGivenNames.has(variant.first) &&
            !initials.some((initial) => variant.first.startsWith(initial))
        )
      );
    if (contradicted) {
      return false;
    }
  }
  // Key overlap collapses names to first+last, which would link
  // "John A. Smith" to "SMITH, JOHN B." as an "exact" match whenever office,
  // district, and year agree. A contradicting middle name rejects the row
  // (georgia pattern).
  return !hasMiddleNameConflict({
    candidateName: input.candidateName,
    rowNames: names,
    normalizePersonName,
    firstNamesEquivalent: input.tier === "nickname" ? nicknameFirstNamesEquivalent : undefined,
  });
}

function toCommitteeMatch(accumulator: CandidateAccumulator): TennesseeCandidateCommitteeMatch {
  return {
    campCandidateId: accumulator.campCandidateId,
    ownerName: accumulator.ownerName,
    candidateName: accumulator.candidateName,
    officeSought: accumulator.officeSought,
    district: accumulator.district,
    confidence: "exact",
    source: "tncamp_search",
    sourceUrl: accumulator.sourceUrl,
    reportListUrl: accumulator.reportListUrl,
    matchedRowCount: accumulator.rows.length,
  };
}

function recordMatchesDistrict(input: {
  record: TennesseeCampCandidateRecord;
  expectedDistrict: string | null;
}): boolean {
  if (input.expectedDistrict === null) {
    return true;
  }
  return normalizeTennesseeCampDistrict(input.record.district) === input.expectedDistrict;
}

export function resolveTennesseeCandidateCommittee(
  input: TennesseeCandidateCommitteeResolverInput
): TennesseeCandidateCommitteeResolution {
  let resolution = resolveTennesseeCandidateCommitteeByName(input, "literal");
  for (const tier of ["nickname", "middle"] as const) {
    if (resolution.status !== "unmatched" || resolution.reason !== "no_candidate_committee_match") {
      break;
    }
    resolution = resolveTennesseeCandidateCommitteeByName(input, tier);
  }
  return resolution;
}

function resolveTennesseeCandidateCommitteeByName(
  input: TennesseeCandidateCommitteeResolverInput,
  tier: NameMatchTier
): TennesseeCandidateCommitteeResolution {
  const electionYear = normalizeElectionYear(input.electionYear);
  const candidateNameKeys = candidateTierKeys(input.candidateName, tier);
  const candidateNameKey = candidateNameNormalized(input.candidateName);
  const officeSearch = toTennesseeCampOfficeSearchInput({
    officeScope: input.officeScope,
    officeCanonicalName: input.officeName,
  });
  const expectedOfficeLabel = tennesseeCampOfficeLabelForAppOffice({
    officeScope: input.officeScope,
    officeCanonicalName: input.officeName,
  });
  const officeNameNormalized = expectedOfficeLabel ?? normalizeTextKey(input.officeName);
  const isLegislativeOffice = input.officeScope === "state_upper" || input.officeScope === "state_lower";
  const expectedDistrict = isLegislativeOffice ? normalizeTennesseeCampDistrict(input.district) : null;

  if (candidateNameKeys.size === 0) {
    return {
      status: "unmatched",
      reason: "missing_candidate_name",
      candidateNameNormalized: candidateNameKey,
      officeNameNormalized,
    };
  }
  if (!officeSearch || !expectedOfficeLabel) {
    return {
      status: "unmatched",
      reason: "unsupported_office",
      candidateNameNormalized: candidateNameKey,
      officeNameNormalized,
    };
  }
  if (isLegislativeOffice && !expectedDistrict) {
    return {
      status: "unmatched",
      reason: "missing_legislative_district",
      candidateNameNormalized: candidateNameKey,
      officeNameNormalized,
    };
  }

  const matches = new Map<string, CandidateAccumulator>();
  for (const record of input.candidateRecords) {
    const campCandidateId = record.campCandidateId.trim();
    const ownerName = record.ownerName.trim();
    if (!campCandidateId || !ownerName) {
      continue;
    }
    if (record.electionYear !== electionYear) {
      continue;
    }
    if (normalizeTextKey(record.officeSought) !== normalizeTextKey(expectedOfficeLabel)) {
      continue;
    }
    if (!recordMatchesDistrict({ record, expectedDistrict })) {
      continue;
    }
    if (!recordMatchesCandidateName({ record, candidateName: input.candidateName, candidateNameKeys, tier })) {
      continue;
    }
    const accumulator = matches.get(campCandidateId) ?? {
      campCandidateId,
      ownerName,
      candidateName: record.name.trim() || ownerName,
      officeSought: record.officeSought,
      district: record.district,
      sourceUrl: record.sourceUrl,
      reportListUrl: record.reportListUrl,
      rows: [],
    };
    accumulator.rows.push(record);
    matches.set(campCandidateId, accumulator);
  }

  if (matches.size === 0) {
    return {
      status: "unmatched",
      reason: "no_candidate_committee_match",
      candidateNameNormalized: candidateNameKey,
      officeNameNormalized,
    };
  }
  const resolvedMatches = [...matches.values()].map(toCommitteeMatch);
  if (resolvedMatches.length > 1) {
    return {
      status: "ambiguous",
      reason: "multiple_matching_committees",
      candidateNameNormalized: candidateNameKey,
      officeNameNormalized,
      matches: resolvedMatches,
    };
  }
  return { status: "matched", ...resolvedMatches[0]! };
}

export async function searchAndResolveTennesseeCandidateCommittee(
  input: TennesseeCandidateCommitteeSearchInput,
  options?: TennesseeCampClientOptions
): Promise<TennesseeCandidateCommitteeResolution> {
  const officeSearch = toTennesseeCampOfficeSearchInput({
    officeScope: input.officeScope,
    officeCanonicalName: input.officeName,
  });
  if (!officeSearch) {
    return resolveTennesseeCandidateCommittee({ ...input, candidateRecords: [] });
  }
  let resolution: TennesseeCandidateCommitteeResolution | null = null;
  for (const token of tennesseeCampLastNameSearchTokens(input.candidateName)) {
    const candidateRecords = await searchTennesseeCampCandidates(
      {
        candidateName: token,
        electionYear: input.electionYear,
        officeSelection: officeSearch.officeSelection,
      },
      options
    );
    resolution = resolveTennesseeCandidateCommittee({ ...input, candidateRecords });
    if (resolution.status !== "unmatched" || resolution.reason !== "no_candidate_committee_match") {
      return resolution;
    }
  }
  return resolution ?? resolveTennesseeCandidateCommittee({ ...input, candidateRecords: [] });
}
