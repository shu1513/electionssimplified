import { firstNameVariants } from "../finance/personFirstNameNicknames.js";
import { isOhioFinanceEligibleOffice } from "./ohioFinanceEligibleOffices.js";
import type { OhioSosCandidateCommitteeListRow } from "./ohioSosBulkFiles.js";

// Resolves a VoteApp candidate election to exactly one Ohio SoS candidate
// committee (MASTER_KEY) using the active-candidate list (ACT_CAN_LIST.CSV),
// maryland resolver pattern. Matching is fail-closed: normalized-name
// equality plus an exact office-token match, and for General Assembly seats
// an exact district match — never fuzzy, never a guess. The active list is
// cumulative for the current registrations and carries no election year, so
// the year is validated for storage but is not a row filter.

export type OhioCandidateCommitteeResolverInput = {
  candidateName: string;
  officeScope: string;
  officeName: string;
  electionYear: number;
  district?: string | null;
  candidateListRows: readonly OhioSosCandidateCommitteeListRow[];
  sourceUrl?: string | null;
};

export type OhioCandidateCommitteeMatch = {
  committeeId: string;
  committeeName: string;
  confidence: "exact";
  source: "sos_bulk_export";
  sourceUrl: string | null;
  matchedCommitteeRowCount: number;
};

export type OhioCandidateCommitteeResolution =
  | ({ status: "matched" } & OhioCandidateCommitteeMatch)
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
      matches: OhioCandidateCommitteeMatch[];
    };

type CandidateCommitteeAccumulator = {
  committeeId: string;
  committeeName: string;
  rows: OhioSosCandidateCommitteeListRow[];
};

function normalizeElectionYear(value: number): number {
  if (!Number.isInteger(value) || value < 2000 || value > 2100) {
    throw new Error(`Invalid Ohio candidate committee election year: ${value}`);
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
// variants ("Matt Huffman" → "MATTHEW HUFFMAN"): the source files the formal name while VoteApp
// stores the campaign name. Expand the VoteApp side only
// (personFirstNameNicknames.ts explains why).
export function normalizeOhioCandidateNameKeys(
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
  // Nickname keys go last so the first key (used for storage) is unchanged.
  function withNicknameKeys(): Set<string> {
    for (const key of nicknameKeys) {
      keys.add(key);
    }
    return keys;
  }
  const trimmedWithoutParentheticals = trimmed.replace(/\([^()]+\)/g, " ");
  const baseParts = normalizePersonName(trimmedWithoutParentheticals).split(" ").filter(Boolean);
  const lastBaseToken = baseParts.length >= 2 ? baseParts[baseParts.length - 1] : null;

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
        addFirstLast(nickname ?? "", lastBaseToken ?? "");
      }
    }
  }

  return withNicknameKeys();
}

export function normalizeOhioCandidateNameForStorage(value: string): string {
  return [...normalizeOhioCandidateNameKeys(value)][0] ?? normalizePersonName(value);
}

function normalizeOfficeScope(value: string): "statewide" | "state_upper" | "state_lower" | null {
  const normalized = value.trim();
  return normalized === "statewide" || normalized === "state_upper" || normalized === "state_lower"
    ? normalized
    : null;
}

// VoteApp canonical office names (plus safe aliases) → canonical name. Kept
// to the seven eligible offices; anything else is unsupported.
function canonicalOfficeNameForInput(officeName: string): string | null {
  switch (normalizeTextKey(officeName)) {
    case "GOVERNOR":
      return "Governor";
    case "ATTORNEY GENERAL":
      return "Attorney General";
    case "SECRETARY OF STATE":
      return "Secretary of State";
    case "STATE AUDITOR":
    case "AUDITOR":
    case "AUDITOR OF STATE":
      return "State Auditor";
    case "STATE TREASURER":
    case "TREASURER":
    case "TREASURER OF STATE":
      return "State Treasurer";
    case "STATE SENATOR":
    case "STATE SENATE":
      return "State Senator";
    case "STATE REPRESENTATIVE":
    case "STATE HOUSE":
    case "HOUSE OF REPRESENTATIVES":
    case "STATE LOWER CHAMBER LEGISLATOR":
      return "State Lower Chamber Legislator";
    default:
      return null;
  }
}

// The active-candidate list's OFFICE vocabulary, observed on the real
// 2026-08-04 file (760 rows): HOUSE, SENATE, GOVERNOR, ATTORNEY GENERAL,
// SECRETARY OF STATE, AUDITOR, TREASURER, plus judicial / board / retirement
// offices that are all outside the eligible set (decision 2).
const LIST_OFFICE_TOKEN_BY_CANONICAL_NAME: Readonly<Record<string, string>> = {
  Governor: "GOVERNOR",
  "Attorney General": "ATTORNEY GENERAL",
  "Secretary of State": "SECRETARY OF STATE",
  "State Auditor": "AUDITOR",
  "State Treasurer": "TREASURER",
  "State Senator": "SENATE",
  "State Lower Chamber Legislator": "HOUSE",
};

function isLegislativeOffice(officeCanonicalName: string): boolean {
  return (
    officeCanonicalName === "State Senator" || officeCanonicalName === "State Lower Chamber Legislator"
  );
}

// Districts are plain numbers on both sides ("87"). Statewide list rows
// carry junk district values ("0", "100"), so the district is only consulted
// for General Assembly seats.
function normalizeDistrict(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return "";
  }
  const numeric = Number(trimmed);
  if (Number.isInteger(numeric) && numeric > 0) {
    return String(numeric);
  }
  return normalizeTextKey(trimmed);
}

function candidateNameFromListRow(row: OhioSosCandidateCommitteeListRow): string {
  return [row.candidateFirstName, row.candidateLastName]
    .map((value) => value?.trim() ?? "")
    .filter(Boolean)
    .join(" ");
}

type PersonNameParts = {
  first: string;
  middles: string[];
  last: string;
  suffix: string | null;
};

// Bare "V" is a middle initial, not a suffix (GENERATIONAL_SUFFIX_RANK in
// finance/personNameMiddleEvidence.ts): as a suffix token it left "Smith,
// John V" with no middle evidence against "John B. Smith".
const NAME_SUFFIX_TOKENS = new Set(["JR", "SR", "II", "III", "IV"]);

// Parses a name into first / middles / last / suffix on the same comma-flip
// and parenthetical rules the key generator uses, but WITHOUT discarding the
// middle and suffix evidence — that evidence gates the shortened-key match
// below.
function parseOhioPersonNameParts(raw: string): PersonNameParts {
  const withoutParentheticals = raw.replace(/\([^()]+\)/g, " ");
  let suffix: string | null = null;
  let tokens: string[];
  const commaParts = withoutParentheticals.includes(",")
    ? withoutParentheticals
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
    : [];
  if (commaParts.length >= 2) {
    // "Smith, John Jr." carries the suffix at the end of the GIVEN segment;
    // naive rearrangement would produce "John Jr Smith" and misfile JR as a
    // middle name, slipping past the suffix-conflict guard. Pull it off the
    // given segment before rearranging.
    const givenTokens = normalizeTextKey(commaParts.slice(1).join(" ")).split(" ").filter(Boolean);
    while (givenTokens.length > 0 && NAME_SUFFIX_TOKENS.has(givenTokens[givenTokens.length - 1]!)) {
      suffix = givenTokens.pop()!;
    }
    tokens = [...givenTokens, ...normalizeTextKey(commaParts[0]!).split(" ").filter(Boolean)];
  } else {
    tokens = normalizeTextKey(withoutParentheticals).split(" ").filter(Boolean);
  }
  // Trailing suffix on the assembled name ("John Smith Jr", "Smith Jr., John").
  while (tokens.length > 0 && NAME_SUFFIX_TOKENS.has(tokens[tokens.length - 1]!)) {
    suffix = tokens.pop()!;
  }
  if (tokens.length < 2) {
    return { first: tokens[0] ?? "", middles: [], last: "", suffix };
  }
  return {
    first: tokens[0]!,
    middles: tokens.slice(1, -1),
    last: tokens[tokens.length - 1]!,
    suffix,
  };
}

function middleTokensCompatible(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }
  // An initial is compatible with the full middle name it starts.
  return (left.length === 1 && right.startsWith(left)) || (right.length === 1 && left.startsWith(right));
}

// The shortened FIRST LAST key deliberately ignores middle names and
// suffixes so "Jane Doe" can match the list's "JANE MARIE DOE". That must
// not let two DIFFERENT people collapse: when both sides state a middle name
// or a suffix and they disagree ("Jane Ann Doe" vs "JANE MARIE DOE",
// "John Smith Jr" vs "JOHN SMITH SR"), the pair is rejected. Missing
// evidence on either side stays permissive — fail-closed only on explicit
// conflict.
function namesConflict(left: PersonNameParts, right: PersonNameParts): boolean {
  if (left.suffix && right.suffix && left.suffix !== right.suffix) {
    return true;
  }
  const pairCount = Math.min(left.middles.length, right.middles.length);
  for (let index = 0; index < pairCount; index += 1) {
    if (!middleTokensCompatible(left.middles[index]!, right.middles[index]!)) {
      return true;
    }
  }
  return false;
}

// Shared strict person-name match: some normalized key of each side must
// coincide AND the stated middle/suffix evidence must not conflict. The 31-U
// outside-spending aggregator uses this for its target-candidate matching
// (decision 5) so both matchers accept and reject exactly the same pairs.
export function ohioPersonNamesMatch(left: string, right: string): boolean {
  const leftKeys = normalizeOhioCandidateNameKeys(left);
  if (leftKeys.size === 0) {
    return false;
  }
  let keyMatched = false;
  for (const key of normalizeOhioCandidateNameKeys(right)) {
    if (leftKeys.has(key)) {
      keyMatched = true;
      break;
    }
  }
  if (!keyMatched) {
    return false;
  }
  return !namesConflict(parseOhioPersonNameParts(left), parseOhioPersonNameParts(right));
}

// The SoS office vocabulary token (active-candidate list and 31-U detail
// pages share it) for a VoteApp office name; null when the office is outside
// the supported set.
export function ohioSosOfficeTokenForOfficeName(officeName: string): string | null {
  const canonicalName = canonicalOfficeNameForInput(officeName);
  return canonicalName === null ? null : LIST_OFFICE_TOKEN_BY_CANONICAL_NAME[canonicalName] ?? null;
}

function rowMatchesCandidateName(input: {
  row: OhioSosCandidateCommitteeListRow;
  candidateName: string;
  candidateNameKeys: ReadonlySet<string>;
}): boolean {
  const rowName = candidateNameFromListRow(input.row);
  if (!rowName) {
    return false;
  }
  let keyMatched = false;
  for (const key of normalizeOhioCandidateNameKeys(rowName)) {
    if (input.candidateNameKeys.has(key)) {
      keyMatched = true;
      break;
    }
  }
  if (!keyMatched) {
    return false;
  }
  return !namesConflict(parseOhioPersonNameParts(input.candidateName), parseOhioPersonNameParts(rowName));
}

function toCommitteeMatch(input: {
  accumulator: CandidateCommitteeAccumulator;
  sourceUrl: string | null;
}): OhioCandidateCommitteeMatch {
  return {
    committeeId: input.accumulator.committeeId,
    committeeName: input.accumulator.committeeName,
    confidence: "exact",
    source: "sos_bulk_export",
    sourceUrl: input.sourceUrl,
    matchedCommitteeRowCount: input.accumulator.rows.length,
  };
}

// Literal first name first, nicknames only when nothing matched literally: a
// "Greg" candidate must not turn ambiguous because a different "Gregory" with
// the same surname also filed, and a candidate registered under both the
// nickname and the formal name keeps the literal committee (georgia pattern).
export function resolveOhioCandidateCommittee(
  input: OhioCandidateCommitteeResolverInput
): OhioCandidateCommitteeResolution {
  const literal = resolveOhioCandidateCommitteeByName(input, false);
  if (literal.status !== "unmatched" || literal.reason !== "no_candidate_committee_match") {
    return literal;
  }
  return resolveOhioCandidateCommitteeByName(input, true);
}

function resolveOhioCandidateCommitteeByName(
  input: OhioCandidateCommitteeResolverInput,
  expandNicknames: boolean
): OhioCandidateCommitteeResolution {
  normalizeElectionYear(input.electionYear);
  const officeScope = normalizeOfficeScope(input.officeScope);
  const officeCanonicalName = canonicalOfficeNameForInput(input.officeName);
  const officeNameNormalized = officeCanonicalName ?? normalizeTextKey(input.officeName);
  const candidateNameKeys = normalizeOhioCandidateNameKeys(input.candidateName, { expandNicknames });
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
    !isOhioFinanceEligibleOffice({ officeScope, officeCanonicalName })
  ) {
    return {
      status: "unmatched",
      reason: "unsupported_office",
      candidateNameNormalized,
      officeNameNormalized,
    };
  }
  if (isLegislativeOffice(officeCanonicalName) && !expectedDistrict) {
    return {
      status: "unmatched",
      reason: "missing_legislative_district",
      candidateNameNormalized,
      officeNameNormalized,
    };
  }

  const expectedOfficeToken = LIST_OFFICE_TOKEN_BY_CANONICAL_NAME[officeCanonicalName];
  const rowsByCommittee = new Map<string, CandidateCommitteeAccumulator>();
  for (const row of input.candidateListRows) {
    const committeeId = row.masterKey.trim();
    const committeeName = row.committeeName.trim();
    // MASTER_KEY is the permanent identity; a non-numeric one is upstream
    // damage and must not become a link.
    if (!/^[0-9]+$/.test(committeeId) || !committeeName) {
      continue;
    }
    if (normalizeTextKey(row.office) !== expectedOfficeToken) {
      continue;
    }
    if (
      isLegislativeOffice(officeCanonicalName) &&
      normalizeDistrict(row.district) !== expectedDistrict
    ) {
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
    ...matches[0]!,
  };
}
