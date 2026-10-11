import {
  hasMiddleNameConflict,
  personNamesMatchWithMiddleEvidence,
} from "../finance/personNameMiddleEvidence.js";
import { firstNameVariants } from "../finance/personFirstNameNicknames.js";
import type { NewHampshireFilingEntityRow } from "./newHampshireCfsClient.js";
import { normalizeNewHampshireCandidateAlias } from "./newHampshireOutsideSpendingAggregator.js";

export type NewHampshireCandidateFilerResolverInput = {
  candidateName: string;
  officeScope: string;
  officeName: string;
  district?: string | null;
  electionCycleId: number;
  filingEntityRows: readonly NewHampshireFilingEntityRow[];
  sourceUrl?: string | null;
};

export type NewHampshireCandidateFilerMatch = {
  filingEntityId: number;
  filerName: string;
  candidateAliases: string[];
  officeName: string;
  district: string | null;
  /**
   * `exact` = the registration carries the candidate's office and district.
   * `unique_name` = the registration omits the district (common for State
   * Senate committees) and the name matches exactly one filer of that office
   * in the cycle; the district on the match is VoteApp's.
   */
  confidence: "exact" | "unique_name";
  source: "cfs_registration";
  sourceUrl: string | null;
  matchedRegistrationRowCount: number;
};

export type NewHampshireCandidateFilerResolution =
  | ({ status: "matched" } & NewHampshireCandidateFilerMatch)
  | {
      status: "unmatched";
      reason:
        | "missing_candidate_name"
        | "unsupported_office"
        | "missing_required_district"
        | "no_candidate_filer_match";
      candidateNameNormalized: string;
      officeNameNormalized: string;
    }
  | {
      status: "ambiguous";
      reason: "multiple_matching_filers";
      candidateNameNormalized: string;
      officeNameNormalized: string;
      matches: NewHampshireCandidateFilerMatch[];
    };

type NewHampshireCanonicalOfficeName =
  | "Governor"
  | "Executive Council"
  | "State Senate"
  | "State Representative"
  | "County Commissioner"
  | "County Attorney"
  | "County Treasurer"
  | "Sheriff"
  | "Register of Deeds"
  | "Register of Probate";

type CandidateFilerAccumulator = {
  filingEntityId: number;
  filerNames: Set<string>;
  candidateAliases: Map<string, string>;
  rows: NewHampshireFilingEntityRow[];
  /** The district the match reports: VoteApp's for exact and district-blank rows, the registration's otherwise. */
  district: NewHampshireDistrictEvidence | null;
};

type NewHampshireDistrictEvidence = {
  key: string;
  label: string;
};

const NEW_HAMPSHIRE_COUNTIES = [
  "Belknap",
  "Carroll",
  "Cheshire",
  "Coos",
  "Grafton",
  "Hillsborough",
  "Merrimack",
  "Rockingham",
  "Strafford",
  "Sullivan",
] as const;

function normalizeElectionCycleId(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid New Hampshire candidate filer election-cycle ID: ${value}`);
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
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePersonName(value: string): string {
  return normalizeTextKey(value)
    .replace(/\b(JR|SR|II|III|IV)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeNewHampshireCandidateNameKeys(value: string): Set<string> {
  const trimmed = value.trim();
  const keys = new Set<string>();
  const normalized = normalizePersonName(trimmed);
  if (normalized) keys.add(normalized);

  const commaParts = trimmed
    .split(",")
    .map(normalizePersonName)
    .filter(Boolean);
  if (commaParts.length >= 2) {
    const lastName = commaParts[0] ?? "";
    const givenNames = commaParts.slice(1).join(" ");
    const flipped = normalizePersonName(`${givenNames} ${lastName}`);
    if (flipped) keys.add(flipped);
  }
  return keys;
}

export function normalizeNewHampshireCandidateNameForStorage(value: string): string {
  const trimmed = value.trim();
  const commaParts = trimmed
    .split(",")
    .map(normalizePersonName)
    .filter(Boolean);
  if (commaParts.length >= 2) {
    return normalizePersonName(`${commaParts.slice(1).join(" ")} ${commaParts[0] ?? ""}`);
  }
  return normalizePersonName(trimmed);
}

// CFS registrations carry the formal first name ("Thomas Ploszaj") while
// VoteApp stores the campaign name ("Tom Ploszaj"). The equivalence is
// one-sided: the VoteApp first name expands to its nickname variants, the
// registration name is read literally (personFirstNameNicknames.ts).
function nicknameFirstNamesEquivalent(candidateFirst: string, rowFirst: string): boolean {
  return candidateFirst === rowFirst || firstNameVariants(candidateFirst).includes(rowFirst);
}

function candidateNamesMatch(
  candidateName: string,
  officialNames: readonly string[],
  expandNicknames: boolean
): boolean {
  const firstNamesEquivalent = expandNicknames ? nicknameFirstNamesEquivalent : undefined;
  const candidateKeys = normalizeNewHampshireCandidateNameKeys(candidateName);
  for (const officialName of officialNames) {
    const rowKeys = normalizeNewHampshireCandidateNameKeys(officialName);
    for (const key of rowKeys) {
      if (
        candidateKeys.has(key) &&
        !hasMiddleNameConflict({
          candidateName,
          rowNames: [officialName],
          normalizePersonName,
          firstNamesEquivalent,
        })
      ) {
        return true;
      }
    }
    if (
      personNamesMatchWithMiddleEvidence({
        candidateName,
        rowNames: [officialName],
        normalizePersonName,
        firstNamesEquivalent,
      })
    ) {
      return true;
    }
  }
  return false;
}

function canonicalOfficeName(value: string): NewHampshireCanonicalOfficeName | null {
  const key = normalizeTextKey(value)
    .replace(/\bNEW HAMPSHIRE\b/g, " ")
    .replace(/\bNH\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  switch (key) {
    case "GOVERNOR":
      return "Governor";
    case "EXECUTIVE COUNCIL":
    case "EXECUTIVE COUNCILOR":
      return "Executive Council";
    case "STATE SENATE":
    case "STATE SENATOR":
    case "STATE UPPER CHAMBER LEGISLATOR":
      return "State Senate";
    case "STATE REPRESENTATIVE":
    case "STATE HOUSE":
    case "HOUSE REPRESENTATIVE":
    case "HOUSE OF REPRESENTATIVES":
    case "STATE LOWER CHAMBER LEGISLATOR":
      return "State Representative";
    case "COUNTY COMMISSIONER":
      return "County Commissioner";
    case "COUNTY ATTORNEY":
    case "DISTRICT ATTORNEY":
      return "County Attorney";
    case "COUNTY TREASURER":
      return "County Treasurer";
    case "SHERIFF":
      return "Sheriff";
    case "REGISTER OF DEEDS":
    case "COUNTY RECORDER":
      return "Register of Deeds";
    case "REGISTER OF PROBATE":
    case "CLERK OF COURT":
      return "Register of Probate";
    default:
      return null;
  }
}

function scopeMatchesOffice(officeScope: string, officeName: NewHampshireCanonicalOfficeName): boolean {
  const scope = officeScope.trim().toLowerCase();
  if (scope === "state_upper") return officeName === "State Senate";
  if (scope === "state_lower") return officeName === "State Representative";
  if (scope === "county") {
    return (
      officeName === "County Commissioner" ||
      officeName === "County Attorney" ||
      officeName === "County Treasurer" ||
      officeName === "Sheriff" ||
      officeName === "Register of Deeds" ||
      officeName === "Register of Probate"
    );
  }
  if (scope === "statewide") {
    return officeName === "Governor" || officeName === "Executive Council";
  }
  return false;
}

function officeRequiresDistrict(officeName: NewHampshireCanonicalOfficeName): boolean {
  return officeName !== "Governor";
}

/**
 * State Senate committees often register without a district (2026 cycle: 22
 * of the Active ones). Senate districts are unique statewide, so a
 * district-blank Senate registration can stand in for the district when the
 * name matches exactly one filer of that office in the cycle. House and
 * commissioner district numbers repeat by county, so a blank district there
 * stays a miss.
 */
function officeAllowsDistrictBlankFallback(officeName: NewHampshireCanonicalOfficeName): boolean {
  return officeName === "State Senate";
}

function districtNumber(value: string | null | undefined): string {
  const key = normalizeTextKey(value ?? "")
    .replace(/\bNEW HAMPSHIRE\b/g, " ")
    .replace(/\bNH\b/g, " ")
    .replace(/\b(?:19|20)\d{2}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const match = /(?:^| )0*(\d+)$/.exec(key);
  return match?.[1] ?? "";
}

function districtCounty(
  district: string | null | undefined,
  officialCounty?: string | null
): string {
  const key = normalizeTextKey([officialCounty, district].filter(Boolean).join(" "));
  return NEW_HAMPSHIRE_COUNTIES.find((county) => key.includes(county.toUpperCase())) ?? "";
}

function normalizeDistrictEvidence(
  officeName: NewHampshireCanonicalOfficeName,
  district: string | null | undefined,
  officialCounty?: string | null
): NewHampshireDistrictEvidence | null {
  const isCountyOffice =
    officeName === "County Commissioner" ||
    officeName === "County Attorney" ||
    officeName === "County Treasurer" ||
    officeName === "Sheriff" ||
    officeName === "Register of Deeds" ||
    officeName === "Register of Probate";
  const county = districtCounty(district, officialCounty);
  if (isCountyOffice && officeName !== "County Commissioner") {
    return county ? { key: county.toUpperCase(), label: county } : null;
  }

  const number = districtNumber(district);
  if (!number) return null;
  if (officeName === "State Representative" || officeName === "County Commissioner") {
    // These district numbers repeat by county. The CFS response calls its
    // county field `town`; VoteApp includes the county in the district name.
    return county
      ? { key: `${county.toUpperCase()}:${number}`, label: `${county} ${number}` }
      : null;
  }
  return { key: number, label: number };
}

function isCandidateRegistration(row: NewHampshireFilingEntityRow): boolean {
  return (
    row.filerTypeCode === "CAN" ||
    row.filerTypeCode === "CC" ||
    row.filerSubTypeCode === "PACCC"
  );
}

function officialCandidateNames(row: NewHampshireFilingEntityRow): string[] {
  const candidateName = row.candidateName?.trim();
  if (candidateName) return [candidateName];

  const structured = [row.firstName, row.lastName].filter(Boolean).join(" ").trim();
  return structured ? [structured] : [];
}

function registrationRaceTargetKey(row: NewHampshireFilingEntityRow): string | null {
  const officeName = canonicalOfficeName(row.officeName ?? "");
  if (!officeName) return null;
  const district = normalizeDistrictEvidence(officeName, row.district, row.county);
  if (officeRequiresDistrict(officeName) && !district) return null;
  return `${officeName}\u0000${district?.key ?? ""}`;
}

/**
 * Only a genuinely empty district field is "blank". A non-empty value the
 * parser cannot read ("District 3 - Nashua") is conflicting evidence, not
 * missing evidence, and never qualifies for the fallback.
 */
function isDistrictBlank(row: NewHampshireFilingEntityRow): boolean {
  return !row.district?.trim();
}

/** Race target of a district-blank registration, for offices where the blank is matchable. */
function districtBlankRaceTargetKey(row: NewHampshireFilingEntityRow): string | null {
  const officeName = canonicalOfficeName(row.officeName ?? "");
  if (!officeName || !officeAllowsDistrictBlankFallback(officeName)) return null;
  if (!isDistrictBlank(row)) return null;
  return `${officeName} `;
}

/** CFS registration status the auto-link links on and the sync prefers. */
export const NEW_HAMPSHIRE_CFS_ACTIVE_REGISTRATION_STATUS = "Active";

export function isActiveNewHampshireRegistration(row: NewHampshireFilingEntityRow): boolean {
  return row.status.trim().toLowerCase() === NEW_HAMPSHIRE_CFS_ACTIVE_REGISTRATION_STATUS.toLowerCase();
}

// An alias is kept only when every registration matching it points at one
// race. Targets are counted per filing entity: a filer with both a
// district-specific and a district-blank row is one race, not two, while a
// district-blank Senate filer and a same-named House filer are two.
function retainUnambiguousCandidateAliases(input: {
  aliases: readonly string[];
  filingEntityRows: readonly NewHampshireFilingEntityRow[];
  electionCycleId: number;
}): string[] {
  return input.aliases.filter((alias) => {
    const explicitTargetsByFiler = new Map<number, Set<string>>();
    const blankTargetByFiler = new Map<number, string>();
    for (const row of input.filingEntityRows) {
      if (!isCandidateRegistration(row) || row.electionCycleId !== input.electionCycleId) {
        continue;
      }
      const explicitTarget = registrationRaceTargetKey(row);
      const blankTarget = explicitTarget ? null : districtBlankRaceTargetKey(row);
      if (!explicitTarget && !blankTarget) continue;
      const names = officialCandidateNames(row);
      if (names.length === 0 || !candidateNamesMatch(alias, names, false)) continue;
      if (explicitTarget) {
        const targets = explicitTargetsByFiler.get(row.filingEntityId) ?? new Set<string>();
        targets.add(explicitTarget);
        explicitTargetsByFiler.set(row.filingEntityId, targets);
      } else if (blankTarget) {
        blankTargetByFiler.set(row.filingEntityId, blankTarget);
      }
    }
    const raceTargets = new Set<string>();
    for (const targets of explicitTargetsByFiler.values()) {
      for (const target of targets) raceTargets.add(target);
    }
    for (const [filingEntityId, target] of blankTargetByFiler) {
      if (!explicitTargetsByFiler.has(filingEntityId)) raceTargets.add(target);
    }
    return raceTargets.size <= 1;
  });
}

function rememberCandidateAlias(accumulator: CandidateFilerAccumulator, value: string): void {
  const alias = value.trim();
  const key = normalizeNewHampshireCandidateAlias(alias);
  if (key && !accumulator.candidateAliases.has(key)) {
    accumulator.candidateAliases.set(key, alias);
  }
}

function toMatch(input: {
  accumulator: CandidateFilerAccumulator;
  officeName: NewHampshireCanonicalOfficeName;
  confidence: NewHampshireCandidateFilerMatch["confidence"];
  sourceUrl: string | null;
}): NewHampshireCandidateFilerMatch {
  const filerName = [...input.accumulator.filerNames].sort((left, right) =>
    left.localeCompare(right)
  )[0];
  if (!filerName) {
    throw new Error(`Missing New Hampshire filer name for entity ${input.accumulator.filingEntityId}`);
  }
  return {
    filingEntityId: input.accumulator.filingEntityId,
    filerName,
    candidateAliases: [...input.accumulator.candidateAliases.values()].sort((left, right) =>
      left.localeCompare(right)
    ),
    officeName: input.officeName,
    district: input.accumulator.district?.label ?? null,
    confidence: input.confidence,
    source: "cfs_registration",
    sourceUrl: input.sourceUrl,
    matchedRegistrationRowCount: input.accumulator.rows.length,
  };
}

function accumulateRow(input: {
  bucket: Map<number, CandidateFilerAccumulator>;
  row: NewHampshireFilingEntityRow;
  candidateName: string;
  officialNames: readonly string[];
  district: NewHampshireDistrictEvidence | null;
}): void {
  const accumulator = input.bucket.get(input.row.filingEntityId) ?? {
    filingEntityId: input.row.filingEntityId,
    filerNames: new Set<string>(),
    candidateAliases: new Map<string, string>(),
    rows: [],
    district: input.district,
  };
  accumulator.rows.push(input.row);
  accumulator.filerNames.add(input.row.filerName);
  rememberCandidateAlias(accumulator, input.candidateName);
  for (const name of input.officialNames) rememberCandidateAlias(accumulator, name);
  input.bucket.set(input.row.filingEntityId, accumulator);
}

// Literal names first; nickname equivalence only when nothing matches
// literally. A candidate with both a "Jim" and a "James" registration keeps
// the literal one instead of turning ambiguous (live: Jim Maggiore).
export function resolveNewHampshireCandidateFiler(
  input: NewHampshireCandidateFilerResolverInput
): NewHampshireCandidateFilerResolution {
  const literal = resolveNewHampshireCandidateFilerByName(input, false);
  if (literal.status !== "unmatched" || literal.reason !== "no_candidate_filer_match") {
    return literal;
  }
  return resolveNewHampshireCandidateFilerByName(input, true);
}

function resolveNewHampshireCandidateFilerByName(
  input: NewHampshireCandidateFilerResolverInput,
  expandNicknames: boolean
): NewHampshireCandidateFilerResolution {
  const electionCycleId = normalizeElectionCycleId(input.electionCycleId);
  const candidateNameNormalized = normalizeNewHampshireCandidateNameForStorage(input.candidateName);
  const canonicalOffice = canonicalOfficeName(input.officeName);
  const officeNameNormalized = canonicalOffice ?? normalizeTextKey(input.officeName);
  if (!candidateNameNormalized) {
    return {
      status: "unmatched",
      reason: "missing_candidate_name",
      candidateNameNormalized,
      officeNameNormalized,
    };
  }
  if (!canonicalOffice || !scopeMatchesOffice(input.officeScope, canonicalOffice)) {
    return {
      status: "unmatched",
      reason: "unsupported_office",
      candidateNameNormalized,
      officeNameNormalized,
    };
  }

  const district = normalizeDistrictEvidence(canonicalOffice, input.district);
  if (officeRequiresDistrict(canonicalOffice) && !district) {
    return {
      status: "unmatched",
      reason: "missing_required_district",
      candidateNameNormalized,
      officeNameNormalized,
    };
  }

  // Three buckets of name-matching registrations for the office and cycle:
  // exact (office + district), district-blank, and other-district. Exact
  // matches always win. With no exact match, one district-blank filer is
  // accepted only when it is the ONLY name-matching filer of the office —
  // a same-named filer in another district or a second district-blank filer
  // makes the name non-unique, and both are reported as ambiguous so an
  // operator can link by hand.
  const exactByFiler = new Map<number, CandidateFilerAccumulator>();
  const blankByFiler = new Map<number, CandidateFilerAccumulator>();
  const otherDistrictByFiler = new Map<number, CandidateFilerAccumulator>();
  const blankFallback = officeRequiresDistrict(canonicalOffice) && officeAllowsDistrictBlankFallback(canonicalOffice);
  for (const row of input.filingEntityRows) {
    if (!isCandidateRegistration(row) || row.electionCycleId !== electionCycleId) continue;
    if (canonicalOfficeName(row.officeName ?? "") !== canonicalOffice) continue;
    const rowDistrict = normalizeDistrictEvidence(canonicalOffice, row.district, row.county);
    let bucket: Map<number, CandidateFilerAccumulator>;
    let matchDistrict: NewHampshireDistrictEvidence | null;
    if (!officeRequiresDistrict(canonicalOffice) || rowDistrict?.key === district?.key) {
      bucket = exactByFiler;
      matchDistrict = district;
    } else if (!blankFallback) {
      continue;
    } else if (isDistrictBlank(row)) {
      bucket = blankByFiler;
      matchDistrict = district;
    } else if (rowDistrict !== null) {
      bucket = otherDistrictByFiler;
      matchDistrict = rowDistrict;
    } else {
      // Non-empty but unreadable district: conflicting evidence, skip.
      continue;
    }

    const names = officialCandidateNames(row);
    if (names.length === 0 || !candidateNamesMatch(input.candidateName, names, expandNicknames)) continue;
    accumulateRow({ bucket, row, candidateName: input.candidateName, officialNames: names, district: matchDistrict });
  }

  let matched: CandidateFilerAccumulator[] = [...exactByFiler.values()];
  let confidence: NewHampshireCandidateFilerMatch["confidence"] = "exact";
  if (matched.length === 0 && blankByFiler.size > 0) {
    confidence = "unique_name";
    matched =
      blankByFiler.size === 1 && otherDistrictByFiler.size === 0
        ? [...blankByFiler.values()]
        : [...blankByFiler.values(), ...otherDistrictByFiler.values()];
  }

  const matches = matched
    .map((accumulator) =>
      toMatch({
        accumulator,
        officeName: canonicalOffice,
        confidence,
        sourceUrl: input.sourceUrl ?? null,
      })
    )
    .map((match) => ({
      ...match,
      candidateAliases: retainUnambiguousCandidateAliases({
        aliases: match.candidateAliases,
        filingEntityRows: input.filingEntityRows,
        electionCycleId,
      }),
    }))
    .sort((left, right) => left.filingEntityId - right.filingEntityId);

  if (matches.length === 0) {
    return {
      status: "unmatched",
      reason: "no_candidate_filer_match",
      candidateNameNormalized,
      officeNameNormalized,
    };
  }
  if (matches.length > 1) {
    return {
      status: "ambiguous",
      reason: "multiple_matching_filers",
      candidateNameNormalized,
      officeNameNormalized,
      matches,
    };
  }
  return { status: "matched", ...matches[0]! };
}

/**
 * The filer-selection rule shared by the auto-link and the sync: resolve
 * against Active registrations first, and only when that finds nothing fall
 * back to every status (so a manually linked Closed filer still syncs). An
 * Active district-blank committee therefore beats a Closed exact-district one
 * on both paths, and a link the auto-link writes is a link the sync accepts.
 */
export function resolveNewHampshireCandidateFilerPreferringActive(
  input: NewHampshireCandidateFilerResolverInput
): NewHampshireCandidateFilerResolution {
  const activeRows = input.filingEntityRows.filter(isActiveNewHampshireRegistration);
  const active = resolveNewHampshireCandidateFiler({ ...input, filingEntityRows: activeRows });
  if (active.status !== "unmatched" || activeRows.length === input.filingEntityRows.length) {
    return active;
  }
  return resolveNewHampshireCandidateFiler(input);
}
