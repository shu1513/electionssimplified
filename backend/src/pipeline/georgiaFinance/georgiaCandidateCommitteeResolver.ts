import { firstNameVariants } from "../finance/personFirstNameNicknames.js";
import {
  fetchGeorgiaCandidateIndexRows,
  GEORGIA_ETHICS_RECORDS_SEARCH_URL,
  type GeorgiaCandidateIndexRow,
  type GeorgiaEthicsTransport,
} from "./georgiaEthicsClient.js";

// Resolves an app candidate election to its PeachFile candidate registration
// (docs/plans/georgia_plan.md D2/D7: link identity is the PeachFile filerEntityId, so
// resolution runs against the PeachFile candidate index only — F3). Exact
// single-registration matches only; anything else fails closed (tennessee
// pattern). The archive side of the identity chain is discovered later, at
// map-building time, not at link time.

export type GeorgiaCandidateCommitteeResolverInput = {
  candidateName: string;
  officeScope: string;
  officeName: string;
  electionYear: number;
  district?: string | null;
  candidateIndexRows: readonly GeorgiaCandidateIndexRow[];
};

export type GeorgiaCandidateCommitteeSearchInput = Omit<
  GeorgiaCandidateCommitteeResolverInput,
  "candidateIndexRows"
>;

export type GeorgiaCandidateCommitteeMatch = {
  filerEntityId: string;
  registrationGuid: string;
  committeeName: string;
  filerName: string;
  office: string | null;
  districtName: string | null;
  filerStatusCode: string | null;
  // "exact": the person-name evidence gate matched. "committee_title": the
  // committee-name evidence fallback matched (legal-vs-campaign first name);
  // auto-link accepts both, but the record says which evidence carried it.
  confidence: "exact" | "committee_title";
  source: "peachfile_candidate_index";
  sourceUrl: string;
  matchedRowCount: number;
};

export type GeorgiaCandidateCommitteeResolution =
  | ({ status: "matched" } & GeorgiaCandidateCommitteeMatch)
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
      reason: "multiple_matching_registrations";
      candidateNameNormalized: string;
      officeNameNormalized: string;
      matches: GeorgiaCandidateCommitteeMatch[];
    };

// PeachFile office labels for the eligible offices (docs/plans/georgia_plan.md D9).
// Labels marked "observed" are pinned from spike bytes — 1,100+ IE target
// rows plus report inventories. Agriculture and Labor never appeared in the
// probed sample, so both plausible orderings are listed; a wrong alias can
// only produce unmatched (fail closed), never a wrong link, because the
// candidate-name and cycle gates still apply.
const PEACHFILE_OFFICE_LABELS_BY_OFFICE_KEY: Readonly<Record<string, readonly string[]>> = {
  "statewide::Governor": ["Governor"], // observed
  "statewide::Lieutenant Governor": ["Lieutenant Governor"], // observed
  "statewide::Secretary of State": ["Secretary of State"], // observed
  "statewide::Attorney General": ["Attorney General"], // observed
  "statewide::Commissioner of Agriculture": ["Commissioner of Agriculture", "Agriculture Commissioner"],
  "statewide::Commissioner of Insurance": ["Commissioner of Insurance"], // observed
  "statewide::Labor Commissioner": ["Commissioner of Labor", "Labor Commissioner"],
  "statewide::Superintendent of Public Instruction": [
    "State School Superintendent", // observed
    "Superintendent of Public Instruction",
  ],
  "statewide::Public Service Commissioner": ["Public Service Commissioner"], // observed
  "state_upper::State Senator": ["State Senator"], // observed
  "state_lower::State Lower Chamber Legislator": ["State Representative"], // observed
};

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

// Builds the set of comparable keys for a person name: the normalized full
// name, first+last, and — for "Last, First" comma forms — the flipped
// variants. PeachFile index rows render the person as "Carr, Christopher M."
// while app candidates are "Christopher Carr", so both sides expand to keys
// and match on any intersection.
export function normalizeGeorgiaCandidateNameKeys(value: string): Set<string> {
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

export function normalizeGeorgiaCandidateNameForStorage(value: string): string {
  const keys = normalizeGeorgiaCandidateNameKeys(value);
  return [...keys][0] ?? value.trim().replace(/\s+/g, " ").toUpperCase();
}

function candidateNameNormalized(value: string): string {
  return normalizeGeorgiaCandidateNameForStorage(value);
}

// Last-name search token: PeachFile's candidate-index filerName filter is a
// case-insensitive substring over the person display name (A3), so the last
// name alone recalls every relevant row without middle-name misses.
export function georgiaLastNameSearchToken(candidateName: string): string {
  const trimmed = candidateName.replace(/\([^()]+\)/g, " ").trim();
  if (trimmed.includes(",")) {
    const commaFirst = normalizePersonName(trimmed.split(",", 1)[0]);
    if (commaFirst) {
      return commaFirst;
    }
  }
  const normalized = normalizePersonName(trimmed);
  return normalized.split(/\s+/).filter(Boolean).at(-1) ?? trimmed;
}

function normalizeGeorgiaDistrict(value: string | null | undefined): string | null {
  const digits = (value ?? "").replace(/\D+/g, "").replace(/^0+/, "");
  return digits || null;
}

// First-name token of a display name (comma forms flip: "Washburn, Dale" ->
// DALE). Used only by the committee-name evidence fallback below.
function georgiaFirstNameSearchToken(candidateName: string): string {
  const trimmed = candidateName.replace(/\([^()]+\)/g, " ").trim();
  const commaIndex = trimmed.indexOf(",");
  const source = commaIndex > 0 ? trimmed.slice(commaIndex + 1) : trimmed;
  return normalizePersonName(source).split(/\s+/).filter(Boolean)[0] ?? "";
}

// Committee-name evidence fallback (live-derived 2026-08-09): the PeachFile
// index registers LEGAL person names ("Washburn, Roy D.") while Georgians
// campaign — and appear on our rosters — under everyday names ("Dale
// Washburn"), so the person-name gate alone strands real incumbents. The
// self-chosen COMMITTEE name routinely carries the campaign name ("Dale
// Washburn for State House", "Billy Hickman for State Senate, Inc.",
// "Friends for Fitz PSC"), which is Georgia's own evidence of the everyday
// name — no nickname inference involved. Requirements: the row's structured
// surname equals the roster surname, and the roster FIRST-name token appears
// as a whole word in the committee name. Applied only when the row's first
// name DIFFERS from the roster's (the nickname shape): when first names
// agree, the person-name gate already had its say — including the
// middle-evidence veto, which this fallback must never override. Office,
// district, and cycle gates still apply and ambiguity still fails closed.
// NOTE the honest risk shape: sync reconciliation is committee-INTERNAL
// (the linked committee's own totals vs its own rows), so it cannot detect
// wrong ownership — the safety argument is evidential, not arithmetic. The
// index fetch serves candidate ("RC") filers only, so within the same
// seat+cycle a committee title naming a first name that differs from its
// registrant's is overwhelmingly the campaign identity of the person it
// names (including treasurer/family registrations, which still route that
// campaign's money); an adversarial title ("Defeat X") would be a
// non-candidate committee and never appears in this index.
function rowMatchesCommitteeNameEvidence(row: GeorgiaCandidateIndexRow, candidateName: string): boolean {
  const committeeKey = normalizeTextKey(row.committeeName);
  if (!committeeKey) {
    return false;
  }
  const firstToken = georgiaFirstNameSearchToken(candidateName);
  // One- and two-letter tokens (initials) match far too loosely.
  if (firstToken.length < 3) {
    return false;
  }
  const surnameToken = georgiaLastNameSearchToken(candidateName);
  const rowSurname = normalizePersonName(row.candidateLastName);
  // Word-boundary suffix, not bare equality: space-form parsing reduces a
  // compound roster surname to its last token ("Mary Van Dyke" -> DYKE),
  // and ballots routinely drop particles, so the registered "VAN DYKE" must
  // still count as the same surname family. A suffix without the boundary
  // ("SMITHSON" vs SON) stays excluded.
  if (!surnameToken || !rowSurname || (rowSurname !== surnameToken && !rowSurname.endsWith(" " + surnameToken))) {
    return false;
  }
  const rowFirst = normalizePersonName(row.candidateFirstName).split(/\s+/).filter(Boolean)[0] ?? "";
  if (rowFirst === firstToken) {
    return false;
  }
  return committeeKey.split(" ").includes(firstToken);
}

// `exact` marks parses whose surname boundary is explicit (comma form,
// single token) rather than guessed from a space-form split.
type GeorgiaParsedPersonName = { first: string; middles: string[]; last: string; exact: boolean };

// Parses a raw display name into (first, middles, last). Comma forms
// ("Carr, Christopher M.") are unambiguous and yield one parse. Space forms
// are ambiguous about where the surname starts ("Mary Van Dyke"), so every
// split is emitted and the pair comparison tries them all — a wrong split can
// only fail to match, never manufacture agreement.
function parseGeorgiaPersonName(raw: string): GeorgiaParsedPersonName[] {
  const commaIndex = raw.indexOf(",");
  if (commaIndex > 0) {
    const last = normalizePersonName(raw.slice(0, commaIndex));
    const restTokens = normalizePersonName(raw.slice(commaIndex + 1)).split(" ").filter(Boolean);
    if (!last || restTokens.length === 0) {
      return [];
    }
    return [{ first: restTokens[0]!, middles: restTokens.slice(1), last, exact: true }];
  }
  const tokens = normalizePersonName(raw).split(" ").filter(Boolean);
  if (tokens.length === 0) {
    return [];
  }
  if (tokens.length === 1) {
    return [{ first: tokens[0]!, middles: [], last: tokens[0]!, exact: true }];
  }
  const parses: GeorgiaParsedPersonName[] = [];
  for (let lastStart = 1; lastStart < tokens.length; lastStart += 1) {
    parses.push({
      first: tokens[0]!,
      middles: tokens.slice(1, lastStart),
      last: tokens.slice(lastStart).join(" "),
      exact: tokens.length === 2,
    });
  }
  return parses;
}

function georgiaPersonNameVariants(value: string): GeorgiaParsedPersonName[] {
  const variants: GeorgiaParsedPersonName[] = [];
  variants.push(...parseGeorgiaPersonName(value.replace(/\([^()]+\)/g, " ")));
  for (const match of value.matchAll(/\(([^()]+)\)/g)) {
    if (match[1]) {
      variants.push(...parseGeorgiaPersonName(match[1]));
    }
  }
  return variants;
}

function georgiaMiddleTokensCorroborate(tokenA: string, tokenB: string): boolean {
  if (tokenA === tokenB) {
    return true;
  }
  if (tokenA.length === 1 && tokenB.startsWith(tokenA)) {
    return true;
  }
  return tokenB.length === 1 && tokenA.startsWith(tokenB);
}

// Middle-name evidence between two parses whose first and last already agree:
// "strong" when every shared-position middle corroborates (equal, or an
// initial matching the full form), "conflict" when any shared position
// disagrees ("MICHAEL ANDREW" vs "MICHAEL BERNARD" conflicts on the second
// middle even though the first agrees), "weak" when at least one side has no
// middle information. Tokens past the shorter side's length are one-sided
// and carry no evidence.
function georgiaMiddleNameEvidence(a: string[], b: string[]): "strong" | "weak" | "conflict" {
  if (a.length === 0 || b.length === 0) {
    return "weak";
  }
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) {
    if (!georgiaMiddleTokensCorroborate(a[index]!, b[index]!)) {
      return "conflict";
    }
  }
  return "strong";
}

// Name matching preserves middle-name evidence instead of collapsing every
// name to a first+last key: "John A. Smith" must NOT match "Smith, John B."
// even when office, district, and cycle agree — that would attach another
// person's money. Aggregation rule across all variant pairs: any strong pair
// matches. A conflict on an EXACT pair — one whose surname boundary is
// explicit (comma form) rather than guessed, which pins the aligned parse on
// the other side too — is authoritative and rejects outright: an ambiguous
// space-form split elsewhere must never override it ("Smith, John B. A."
// conflicts with "John A. Smith" no matter how "John B A Smith" re-splits).
// Purely ambiguous weak/conflict evidence is judged only at the LONGEST
// aligned surname — a compound surname emits bogus shorter splits ("Mary Van
// Dyke" vs "MARY B VAN DYKE" aligns correctly on "VAN DYKE" but the
// "DYKE"-surname split reads VAN-vs-B as a middle conflict), and the longest
// alignment is the real one. At that length, any conflict rejects; otherwise
// a first+last agreement with middle information missing on a side matches.
// expandNicknames: the app first name also matches its nickname variants
// ("Chuck Efstration" vs "Efstration, Charles Paul"). One-sided — the row
// name is read literally (personFirstNameNicknames.ts).
export function georgiaCandidateNameMatchesRowNames(
  candidateName: string,
  rowNames: readonly string[],
  options: { expandNicknames?: boolean } = {}
): boolean {
  const appVariants = georgiaPersonNameVariants(candidateName);
  const firstNamesEquivalent = (appFirst: string, rowFirst: string): boolean =>
    appFirst === rowFirst || (options.expandNicknames === true && firstNameVariants(appFirst).includes(rowFirst));
  const evidenceBySurnameLength = new Map<number, { weak: boolean; conflict: boolean }>();
  let sawStrong = false;
  let sawExactConflict = false;
  for (const rowName of rowNames) {
    for (const rowVariant of georgiaPersonNameVariants(rowName)) {
      for (const appVariant of appVariants) {
        if (!firstNamesEquivalent(appVariant.first, rowVariant.first) || appVariant.last !== rowVariant.last) {
          continue;
        }
        const evidence = georgiaMiddleNameEvidence(appVariant.middles, rowVariant.middles);
        if (evidence === "strong") {
          sawStrong = true;
          continue;
        }
        if (evidence === "conflict" && (appVariant.exact || rowVariant.exact)) {
          sawExactConflict = true;
          continue;
        }
        const surnameLength = appVariant.last.split(" ").length;
        const bucket = evidenceBySurnameLength.get(surnameLength) ?? { weak: false, conflict: false };
        bucket[evidence] = true;
        evidenceBySurnameLength.set(surnameLength, bucket);
      }
    }
  }
  if (sawStrong) {
    return true;
  }
  if (sawExactConflict) {
    return false;
  }
  if (evidenceBySurnameLength.size === 0) {
    return false;
  }
  const longest = Math.max(...evidenceBySurnameLength.keys());
  const decisive = evidenceBySurnameLength.get(longest)!;
  return decisive.weak && !decisive.conflict;
}

function rowMatchesCandidateName(
  row: GeorgiaCandidateIndexRow,
  candidateName: string,
  expandNicknames: boolean
): boolean {
  // The structured name fields carry the FULL middle name where filerName
  // only shows an initial — include them so middle evidence is as rich as
  // the index provides. Rendered in comma form so the parser keeps the
  // surname boundary the index already states, instead of re-guessing it
  // from a flattened space-form string.
  const structuredName =
    row.candidateFirstName && row.candidateLastName
      ? `${row.candidateLastName}, ${[row.candidateFirstName, row.candidateMiddleName].filter(Boolean).join(" ")}`
      : null;
  const names = [row.filerName, row.ballotFullName, structuredName].filter(
    (name): name is string => Boolean(name && name.trim())
  );
  return georgiaCandidateNameMatchesRowNames(candidateName, names, { expandNicknames });
}

// A PeachFile registration belongs to the requested election cycle when
// either cycle label leads with the election year ("2026 Candidate/Committee
// Filing Cycle", "2026 Georgia State Election").
function rowMatchesElectionYear(row: GeorgiaCandidateIndexRow, electionYear: number): boolean {
  const yearPrefix = `${electionYear} `;
  return [row.electionCycleName, row.filingCycleName].some(
    (name) => typeof name === "string" && name.startsWith(yearPrefix)
  );
}

type RegistrationAccumulator = {
  row: GeorgiaCandidateIndexRow;
  rowCount: number;
  // True when ANY row of this registration passed the person-name gate —
  // committee-title evidence only carries the match when every row needed it.
  personNameMatch: boolean;
};

// Literal names first; nickname equivalence only when nothing matched, so a
// candidate with both a "Mike" and a "Michael" registration keeps the
// literal one instead of turning ambiguous.
export function resolveGeorgiaCandidateCommittee(
  input: GeorgiaCandidateCommitteeResolverInput
): GeorgiaCandidateCommitteeResolution {
  const literal = resolveGeorgiaCandidateCommitteeByName(input, false);
  if (literal.status !== "unmatched" || literal.reason !== "no_candidate_committee_match") {
    return literal;
  }
  return resolveGeorgiaCandidateCommitteeByName(input, true);
}

function resolveGeorgiaCandidateCommitteeByName(
  input: GeorgiaCandidateCommitteeResolverInput,
  expandNicknames: boolean
): GeorgiaCandidateCommitteeResolution {
  if (!Number.isInteger(input.electionYear) || input.electionYear < 2000 || input.electionYear > 2100) {
    throw new Error(`Invalid Georgia candidate committee election year: ${input.electionYear}`);
  }
  const candidateNameKeys = normalizeGeorgiaCandidateNameKeys(input.candidateName);
  const candidateNameKey = candidateNameNormalized(input.candidateName);
  const officeKey = `${input.officeScope.trim()}::${input.officeName.trim()}`;
  const officeLabels = PEACHFILE_OFFICE_LABELS_BY_OFFICE_KEY[officeKey];
  const officeNameNormalized = normalizeTextKey(input.officeName);
  const isLegislativeOffice = input.officeScope === "state_upper" || input.officeScope === "state_lower";
  const expectedDistrict = isLegislativeOffice ? normalizeGeorgiaDistrict(input.district) : null;

  if (candidateNameKeys.size === 0) {
    return {
      status: "unmatched",
      reason: "missing_candidate_name",
      candidateNameNormalized: candidateNameKey,
      officeNameNormalized,
    };
  }
  if (!officeLabels) {
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

  const officeLabelKeys = new Set(officeLabels.map((label) => normalizeTextKey(label)));
  const matchesByRegistration = new Map<string, RegistrationAccumulator>();
  for (const row of input.candidateIndexRows) {
    if (!rowMatchesElectionYear(row, input.electionYear)) {
      continue;
    }
    if (!officeLabelKeys.has(normalizeTextKey(row.office))) {
      continue;
    }
    if (expectedDistrict !== null && normalizeGeorgiaDistrict(row.districtName) !== expectedDistrict) {
      continue;
    }
    const personNameMatch = rowMatchesCandidateName(row, input.candidateName, expandNicknames);
    if (!personNameMatch && !rowMatchesCommitteeNameEvidence(row, input.candidateName)) {
      continue;
    }
    const registrationGuid = row.guid.trim().toLowerCase();
    const existing = matchesByRegistration.get(registrationGuid);
    if (existing) {
      existing.rowCount += 1;
      existing.personNameMatch = existing.personNameMatch || personNameMatch;
    } else {
      matchesByRegistration.set(registrationGuid, { row, rowCount: 1, personNameMatch });
    }
  }

  if (matchesByRegistration.size === 0) {
    return {
      status: "unmatched",
      reason: "no_candidate_committee_match",
      candidateNameNormalized: candidateNameKey,
      officeNameNormalized,
    };
  }

  const matches = [...matchesByRegistration.entries()].map(([registrationGuid, accumulator]) => ({
    filerEntityId: String(accumulator.row.filerEntityId),
    registrationGuid,
    committeeName: accumulator.row.committeeName?.trim() || accumulator.row.filerName,
    filerName: accumulator.row.filerName,
    office: accumulator.row.office,
    districtName: accumulator.row.districtName,
    filerStatusCode: accumulator.row.filerStatusCode,
    confidence: accumulator.personNameMatch ? ("exact" as const) : ("committee_title" as const),
    source: "peachfile_candidate_index" as const,
    sourceUrl: GEORGIA_ETHICS_RECORDS_SEARCH_URL,
    matchedRowCount: accumulator.rowCount,
  }));

  if (matches.length > 1) {
    return {
      status: "ambiguous",
      reason: "multiple_matching_registrations",
      candidateNameNormalized: candidateNameKey,
      officeNameNormalized,
      matches,
    };
  }
  return { status: "matched", ...matches[0]! };
}

export async function searchAndResolveGeorgiaCandidateCommittee(
  input: GeorgiaCandidateCommitteeSearchInput,
  transport: GeorgiaEthicsTransport
): Promise<GeorgiaCandidateCommitteeResolution> {
  const officeKey = `${input.officeScope.trim()}::${input.officeName.trim()}`;
  if (!PEACHFILE_OFFICE_LABELS_BY_OFFICE_KEY[officeKey]) {
    // Skip the network round-trip for offices the module does not cover.
    return resolveGeorgiaCandidateCommittee({ ...input, candidateIndexRows: [] });
  }
  const candidateIndexRows = await fetchGeorgiaCandidateIndexRows(transport, "peachfile", {
    filerName: georgiaLastNameSearchToken(input.candidateName),
  });
  return resolveGeorgiaCandidateCommittee({ ...input, candidateIndexRows });
}
