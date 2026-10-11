import { firstNameVariants } from "../finance/personFirstNameNicknames.js";
import { isNorthCarolinaFinanceEligibleOffice } from "./northCarolinaFinanceEligibleOffices.js";
import {
  isNcsbeLegalExpenseFundSboeId,
  NORTH_CAROLINA_SBOEID_PATTERN,
  type NcsbeCommitteeSearchRow,
} from "./northCarolinaNcsbeParsers.js";

// Resolves a VoteApp candidate election to exactly one NCSBE candidate
// committee (SBoEID) from committee-search result rows, ohio/maryland
// resolver pattern. Matching is fail-closed (docs/plans/north_carolina_plan.md decision
// 5): strict normalized-name equality against the structured `CandName`
// field, restricted to active non-exempt state-board-filed committees —
// never fuzzy, never OrgName token matching, never a guess. The search rows
// carry no office or district, so unlike Ohio the office gates only the
// VoteApp side; any residual same-name collision quarantines as ambiguous.

export type NorthCarolinaCandidateCommitteeResolverInput = {
  candidateName: string;
  officeScope: string;
  officeName: string;
  electionYear: number;
  district?: string | null;
  searchRows: readonly NcsbeCommitteeSearchRow[];
  sourceUrl?: string | null;
};

export type NorthCarolinaCandidateCommitteeMatch = {
  // The SBoEID — the canonical committee_id (plan "Verdict").
  committeeId: string;
  committeeName: string;
  // Every inventory fetch needs OGID alongside SID; carried so the sync can
  // acquire artifacts straight from a resolution without a second search.
  orgGroupId: number;
  confidence: "exact";
  source: "ncsbe_portal";
  sourceUrl: string | null;
  matchedCommitteeRowCount: number;
};

export type NorthCarolinaCandidateCommitteeResolution =
  | ({ status: "matched" } & NorthCarolinaCandidateCommitteeMatch)
  | {
      status: "unmatched";
      reason: "missing_candidate_name" | "unsupported_office" | "no_candidate_committee_match";
      candidateNameNormalized: string;
      officeNameNormalized: string;
    }
  | {
      status: "ambiguous";
      reason: "multiple_matching_committees";
      candidateNameNormalized: string;
      officeNameNormalized: string;
      matches: NorthCarolinaCandidateCommitteeMatch[];
    };

type CandidateCommitteeAccumulator = {
  committeeId: string;
  committeeName: string;
  orgGroupId: number;
  rows: NcsbeCommitteeSearchRow[];
};

function normalizeElectionYear(value: number): number {
  if (!Number.isInteger(value) || value < 2000 || value > 2100) {
    throw new Error(`Invalid North Carolina candidate committee election year: ${value}`);
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

// The portal renders roman suffixes as bare digits ("SIDNEY RALPH PIERCE 3"
// for Sidney Ralph Pierce III — real committee-search row), so the digit
// forms are suffix tokens too, canonicalized for the conflict guard below.
const NAME_SUFFIX_CANONICAL: Readonly<Record<string, string>> = {
  JR: "JR",
  SR: "SR",
  II: "II",
  III: "III",
  IV: "IV",
  // No textual V: a bare trailing "V" is a middle initial, not a suffix
  // (GENERATIONAL_SUFFIX_RANK in finance/personNameMiddleEvidence.ts). The
  // digit "5" stays — a bare digit is never an initial.
  "2": "II",
  "3": "III",
  "4": "IV",
  "5": "V",
};

const NAME_SUFFIX_PATTERN = /\b(JR|SR|II|III|IV|[2-5])\b/g;

function normalizePersonName(value: string | null | undefined): string {
  return normalizeTextKey(value).replace(NAME_SUFFIX_PATTERN, " ").replace(/\s+/g, " ").trim();
}

// expandNicknames adds first+last keys for the first name's nickname
// variants ("Tim Longest" -> "TIMOTHY LONGEST"): NCSBE CandName carries the
// formal name while VoteApp stores the campaign name. Expand the VoteApp side
// only (personFirstNameNicknames.ts explains why).
export function normalizeNorthCarolinaCandidateNameKeys(
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
  const trimmedWithoutParentheticals = trimmed.replace(/\([^()]+\)/g, " ");
  const baseParts = normalizePersonName(trimmedWithoutParentheticals).split(" ").filter(Boolean);
  const lastBaseToken = baseParts.length >= 2 ? baseParts[baseParts.length - 1] : null;

  function addName(raw: string): void {
    // A comma before a bare suffix ("Kenneth W. Bentley, Jr.") is not a
    // "Last, First" boundary; only count commas that split two name parts.
    const hasComma = raw.split(",").filter((part) => normalizePersonName(part)).length >= 2;
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

export function normalizeNorthCarolinaCandidateNameForStorage(value: string): string {
  return [...normalizeNorthCarolinaCandidateNameKeys(value)][0] ?? normalizePersonName(value);
}

function normalizeOfficeScope(value: string): "statewide" | "state_upper" | "state_lower" | null {
  const normalized = value.trim();
  return normalized === "statewide" || normalized === "state_upper" || normalized === "state_lower"
    ? normalized
    : null;
}

// VoteApp canonical office names (plus safe aliases) → canonical name. Kept
// to the two eligible General Assembly offices; Council of State aliases join
// when a cycle with real statewide rows enters scope (decision 2).
function canonicalOfficeNameForInput(officeName: string): string | null {
  switch (normalizeTextKey(officeName)) {
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

type PersonNameParts = {
  first: string;
  middles: string[];
  last: string;
  suffix: string | null;
};

// Parses a name into first / middles / last / suffix on the same comma-flip
// and parenthetical rules the key generator uses, but WITHOUT discarding the
// middle and suffix evidence — that evidence gates the shortened-key match
// below.
function parseNorthCarolinaPersonNameParts(raw: string): PersonNameParts {
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
    while (givenTokens.length > 0 && NAME_SUFFIX_CANONICAL[givenTokens[givenTokens.length - 1]!]) {
      suffix = NAME_SUFFIX_CANONICAL[givenTokens.pop()!]!;
    }
    tokens = [...givenTokens, ...normalizeTextKey(commaParts[0]!).split(" ").filter(Boolean)];
  } else {
    tokens = normalizeTextKey(withoutParentheticals).split(" ").filter(Boolean);
  }
  // Trailing suffix on the assembled name ("John Smith Jr", "Smith Jr., John").
  while (tokens.length > 0 && NAME_SUFFIX_CANONICAL[tokens[tokens.length - 1]!]) {
    suffix = NAME_SUFFIX_CANONICAL[tokens.pop()!]!;
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
// suffixes so "Jane Doe" can match the portal's "JANE MARIE DOE". That must
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
// coincide AND the stated middle/suffix evidence must not conflict. Exported
// for the same-order name comparisons in later NC matching work; note the
// IE-target matcher (decision 5) additionally needs token-order-insensitive
// keys, which is a widening layered at PR 6, not a change here.
export function northCarolinaPersonNamesMatch(left: string, right: string): boolean {
  const leftKeys = normalizeNorthCarolinaCandidateNameKeys(left);
  if (leftKeys.size === 0) {
    return false;
  }
  let keyMatched = false;
  for (const key of normalizeNorthCarolinaCandidateNameKeys(right)) {
    if (leftKeys.has(key)) {
      keyMatched = true;
      break;
    }
  }
  if (!keyMatched) {
    return false;
  }
  return !namesConflict(
    parseNorthCarolinaPersonNameParts(left),
    parseNorthCarolinaPersonNameParts(right)
  );
}

// State-board-filed committees carry the STA prefix; county alpha/numeric
// prefixes (WAY-, DAR-, 090-, ...) are county/municipal filers — out of
// scope (decision 2) and a live mislink hazard: an active county candidate
// can share a state candidate's exact name (fixture: "ELECT JIMMY PIERCE
// SHERIFF", ACTIVE). Requiring STA fails closed: a hypothetical county-filed
// legislative committee would go unmatched (→ manual link), never mislinked.
function isStateBoardCandidateCommitteeSboeId(sboeId: string): boolean {
  return (
    NORTH_CAROLINA_SBOEID_PATTERN.test(sboeId) &&
    sboeId.startsWith("STA-") &&
    !isNcsbeLegalExpenseFundSboeId(sboeId)
  );
}

// "ACTIVE (NON-EXEMPT)" — the only status that names a currently-filing
// committee (decision 5). CLOSED / CLOSED (PENDING) / CONDITIONALLY CLOSED /
// INACTIVE rows are prior committees; including them would make every
// long-time filer ambiguous (one fixture person carries three closed
// committees). Any unknown status stays excluded — fail closed.
function isActiveNonExemptStatus(statusDesc: string): boolean {
  return normalizeTextKey(statusDesc) === "ACTIVE NON EXEMPT";
}

function rowMatchesCandidateName(input: {
  row: NcsbeCommitteeSearchRow;
  candidateName: string;
  candidateNameKeys: ReadonlySet<string>;
}): boolean {
  const rowName = input.row.candName;
  if (!rowName) {
    return false;
  }
  let keyMatched = false;
  for (const key of normalizeNorthCarolinaCandidateNameKeys(rowName)) {
    if (input.candidateNameKeys.has(key)) {
      keyMatched = true;
      break;
    }
  }
  if (!keyMatched) {
    return false;
  }
  return !namesConflict(
    parseNorthCarolinaPersonNameParts(input.candidateName),
    parseNorthCarolinaPersonNameParts(rowName)
  );
}

function toCommitteeMatch(input: {
  accumulator: CandidateCommitteeAccumulator;
  sourceUrl: string | null;
}): NorthCarolinaCandidateCommitteeMatch {
  return {
    committeeId: input.accumulator.committeeId,
    committeeName: input.accumulator.committeeName,
    orgGroupId: input.accumulator.orgGroupId,
    confidence: "exact",
    source: "ncsbe_portal",
    sourceUrl: input.sourceUrl,
    matchedCommitteeRowCount: input.accumulator.rows.length,
  };
}

// Literal names first; nickname keys only when nothing matches literally, so
// a candidate whose search also returns a formal-name committee of another
// person keeps the literal one instead of turning ambiguous.
export function resolveNorthCarolinaCandidateCommittee(
  input: NorthCarolinaCandidateCommitteeResolverInput
): NorthCarolinaCandidateCommitteeResolution {
  const literal = resolveNorthCarolinaCandidateCommitteeByName(input, false);
  if (literal.status !== "unmatched" || literal.reason !== "no_candidate_committee_match") {
    return literal;
  }
  return resolveNorthCarolinaCandidateCommitteeByName(input, true);
}

function resolveNorthCarolinaCandidateCommitteeByName(
  input: NorthCarolinaCandidateCommitteeResolverInput,
  expandNicknames: boolean
): NorthCarolinaCandidateCommitteeResolution {
  normalizeElectionYear(input.electionYear);
  const officeScope = normalizeOfficeScope(input.officeScope);
  const officeCanonicalName = canonicalOfficeNameForInput(input.officeName);
  const officeNameNormalized = officeCanonicalName ?? normalizeTextKey(input.officeName);
  const candidateNameKeys = normalizeNorthCarolinaCandidateNameKeys(input.candidateName, { expandNicknames });
  const candidateNameNormalized = [...candidateNameKeys][0] ?? normalizePersonName(input.candidateName);

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
    !isNorthCarolinaFinanceEligibleOffice({ officeScope, officeCanonicalName })
  ) {
    return {
      status: "unmatched",
      reason: "unsupported_office",
      candidateNameNormalized,
      officeNameNormalized,
    };
  }

  const rowsByCommittee = new Map<string, CandidateCommitteeAccumulator>();
  for (const row of input.searchRows) {
    const committeeId = row.sboeId;
    const committeeName = row.orgName.trim();
    if (!committeeId || !committeeName) {
      continue;
    }
    if (!isStateBoardCandidateCommitteeSboeId(committeeId)) {
      continue;
    }
    if (!isActiveNonExemptStatus(row.statusDesc)) {
      continue;
    }
    // OGID pairs with the SBoEID on every inventory route; a non-positive one
    // is upstream damage and must not become a link.
    if (!Number.isInteger(row.orgGroupId) || row.orgGroupId <= 0) {
      continue;
    }
    if (!rowMatchesCandidateName({ row, candidateName: input.candidateName, candidateNameKeys })) {
      continue;
    }

    const existing = rowsByCommittee.get(committeeId);
    if (existing) {
      if (existing.orgGroupId !== row.orgGroupId) {
        throw new Error(
          `NCSBE committee search repeats ${committeeId} with conflicting OrgGroupIDs ` +
            `(${existing.orgGroupId} vs ${row.orgGroupId})`
        );
      }
      existing.rows.push(row);
      continue;
    }
    rowsByCommittee.set(committeeId, {
      committeeId,
      committeeName,
      orgGroupId: row.orgGroupId,
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
