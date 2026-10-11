// Candidate → ethics-filer resolution for South Carolina campaign finance.
//
// Identity evidence is name + election-cycle filings ONLY. The filer-search
// row's office fields are never consulted: the live API serves the office of a
// filer's PRIOR registration (Alan Wilson's search row says "Attorney General"
// while he runs for governor) and the 2026-cycle statewide label is the
// literal string "4". Office fit is the caller's job via the eligibility
// predicate and the roster row being resolved.
//
// Pure functions — the Phase 5 auto-link fetches search rows and per-filer
// report indexes, then calls these.

import {
  parsePersonNameCandidates,
  personNamesMatchWithMiddleEvidence,
} from "../finance/personNameMiddleEvidence.js";
import { firstNameVariants } from "../finance/personFirstNameNicknames.js";
import {
  SOUTH_CAROLINA_ETHICS_PUBLIC_REPORTING_URL,
  type SouthCarolinaCandidateReportRow,
  type SouthCarolinaFilerSearchRow,
} from "./southCarolinaEthicsClient.js";

export type SouthCarolinaFilerReportSet = {
  filer: SouthCarolinaFilerSearchRow;
  reports: readonly SouthCarolinaCandidateReportRow[];
};

export type SouthCarolinaCandidateFilerMatch = {
  candidateFilerId: number;
  filerName: string;
  // Distinct report electionDates (M/D/YYYY) in the linked election's year —
  // the cycle evidence the match rests on.
  matchedElectionDates: string[];
  cycleReportCount: number;
  confidence: "exact";
  source: "ethics_filer_search";
  sourceUrl: string;
};

export type SouthCarolinaCandidateFilerResolution =
  | ({ status: "matched" } & SouthCarolinaCandidateFilerMatch)
  | {
      // Surname and cycle filings line up but the given names do not
      // (Alan Wilson files as "Wilson, Michael A"). Never auto-link;
      // a human confirms and stores the link with the evidence URL.
      status: "manual_confirm_required";
      candidates: SouthCarolinaCandidateFilerMatch[];
    }
  | {
      status: "ambiguous";
      reason: "multiple_matching_filers";
      matches: SouthCarolinaCandidateFilerMatch[];
    }
  | {
      status: "unmatched";
      reason: "missing_candidate_name" | "no_matching_filer" | "no_cycle_filings";
    };

const GENERATIONAL_SUFFIXES = new Set(["JR", "SR", "II", "III", "IV"]);

function normalizePersonName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\b(JR|SR|II|III|IV)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// The search text the auto-link sends to the filer-name endpoint: the final
// surname word. Matching is contains/fuzzy server-side, so the final word of a
// compound or hyphenated surname still hits the full stored name; results are
// then narrowed locally with filterSouthCarolinaFilersByExactSurname.
export function southCarolinaFilerSearchTerm(candidateName: string): string | null {
  const withoutParens = candidateName.replace(/\([^()]*\)/g, " ");
  const commaIndex = withoutParens.indexOf(",");
  const surnameSegment = commaIndex > 0 ? withoutParens.slice(0, commaIndex) : withoutParens;
  const tokens = surnameSegment
    .split(/\s+/)
    .map((token) => token.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9.'-]+$/g, ""))
    .filter(Boolean);
  while (tokens.length > 0) {
    const last = tokens[tokens.length - 1]!;
    if (!GENERATIONAL_SUFFIXES.has(last.replace(/\./g, "").toUpperCase())) {
      break;
    }
    tokens.pop();
  }
  const term = tokens[tokens.length - 1]?.replace(/\.+$/, "") ?? "";
  return term.length >= 2 ? term : null;
}

// The roster name's surname, read from its EXPLICIT boundary: the pre-comma
// segment of a comma form, else the final whitespace token (a hyphenated token
// stays one unit and normalizes to a multi-word key, so "Mary Johnson-Wilson"
// is JOHNSON WILSON, never bare WILSON). Ambiguous space-form splits are
// deliberately not enumerated here — a wrong split would surname-match another
// person's filer. An unhyphenated compound surname can miss and stay unlinked,
// which is the conservative direction.
function rosterSurnameKey(candidateName: string): string {
  // Strip a trailing generational suffix BEFORE comma detection: rosters carry
  // "Julius Walker, Jr." / "Donnie Davis, II", whose comma marks the suffix,
  // not a Last, First boundary.
  const withoutParens = candidateName
    .replace(/\([^()]*\)/g, " ")
    .replace(/,?\s+(?:JR|SR|II|III|IV)\.?\s*$/i, "");
  const commaIndex = withoutParens.indexOf(",");
  if (commaIndex > 0) {
    return normalizePersonName(withoutParens.slice(0, commaIndex));
  }
  const tokens = withoutParens.trim().split(/\s+/);
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const key = normalizePersonName(tokens[index]!);
    if (key) {
      return key;
    }
  }
  return "";
}

// Local exact-surname filter over the fuzzy/contains server results
// ("Wilson" also returns "Johnson-Wilson"). SEI-only rows (candidateFilerId
// 0) have no candidate account and no reports, so they can never carry cycle
// evidence — dropped here.
export function filterSouthCarolinaFilersByExactSurname(
  candidateName: string,
  rows: readonly SouthCarolinaFilerSearchRow[]
): SouthCarolinaFilerSearchRow[] {
  const surnameKey = rosterSurnameKey(candidateName);
  if (!surnameKey) {
    return [];
  }
  return rows.filter((row) => {
    if (row.candidateFilerId <= 0) {
      return false;
    }
    return parsePersonNameCandidates(row.candidate, normalizePersonName).some(
      (parse) => parse.last === surnameKey
    );
  });
}

// The exact full-name test the resolver's auto-link tier uses, exported so
// callers can ask "could this filer have been a full match?" for a filer
// whose reports could not be fetched.
export function southCarolinaFilerNameFullyMatchesCandidate(
  candidateName: string,
  filerName: string
): boolean {
  return (
    filerNameMatchesCandidate(candidateName, filerName, false) ||
    filerNameMatchesCandidate(candidateName, filerName, true)
  );
}

// Filer search rows carry the formal first name ("Burkhold, Michael") while
// VoteApp stores the campaign name ("Mike Burkhold"). The equivalence is
// one-sided: the VoteApp first name expands to its nickname variants, the
// filer name is read literally (personFirstNameNicknames.ts).
function nicknameFirstNamesEquivalent(candidateFirst: string, rowFirst: string): boolean {
  return candidateFirst === rowFirst || firstNameVariants(candidateFirst).includes(rowFirst);
}

// The filer-search API cuts the display name at 18 characters and appends
// "..." ("Cobb-Hunter, Gild...", "Spann-Wilder, Tif..."), so the given name
// reaches us as a fragment and never matched literally. When the fragment
// (3+ letters) is the start of the VoteApp given-name token at the same
// position — or, in the nickname pass, of one of its variants — complete it
// from that token; otherwise keep it as is. A cut inside a suffix segment
// ("Smith, Peter S. ,...") drops the partial suffix. The surname is never
// touched, so surname, cycle, and uniqueness gates still decide the match.
const SOUTH_CAROLINA_TRUNCATED_NAME_SUFFIX = /\.\.\.\s*$/;

function completeTruncatedFilerName(candidateName: string, filerName: string, expandNicknames: boolean): string {
  if (!SOUTH_CAROLINA_TRUNCATED_NAME_SUFFIX.test(filerName)) {
    return filerName;
  }
  const stripped = filerName.replace(SOUTH_CAROLINA_TRUNCATED_NAME_SUFFIX, "");
  const commaIndex = stripped.indexOf(",");
  if (commaIndex <= 0) {
    return stripped;
  }
  const surname = stripped.slice(0, commaIndex);
  const givenRaw = stripped.slice(commaIndex + 1);
  if (givenRaw.includes(",")) {
    return `${surname},${givenRaw.slice(0, givenRaw.indexOf(","))}`;
  }
  const givenTokens = givenRaw.trim().split(/\s+/).filter(Boolean);
  // "Wallace, Michael ..." — the cut fell on a space; every token is whole.
  if (/\s$/.test(givenRaw) || givenTokens.length === 0) {
    return `${surname}, ${givenTokens.join(" ")}`;
  }
  const fragment = normalizePersonName(givenTokens[givenTokens.length - 1]!);
  const appTokens = normalizePersonName(candidateName.replace(/\([^()]*\)/g, " ")).split(" ").filter(Boolean);
  const appToken = appTokens.slice(0, -1)[givenTokens.length - 1];
  if (fragment.length >= 3 && appToken) {
    const options = expandNicknames ? [appToken, ...firstNameVariants(appToken)] : [appToken];
    const completed = options.find((option) => option.startsWith(fragment));
    if (completed) {
      givenTokens[givenTokens.length - 1] = completed;
    }
  }
  return `${surname}, ${givenTokens.join(" ")}`;
}

function filerNameMatchesCandidate(candidateName: string, filerName: string, expandNicknames: boolean): boolean {
  return personNamesMatchWithMiddleEvidence({
    candidateName,
    rowNames: [completeTruncatedFilerName(candidateName, filerName, expandNicknames)],
    normalizePersonName,
    firstNamesEquivalent: expandNicknames ? nicknameFirstNamesEquivalent : undefined,
  });
}

function reportElectionYear(electionDate: string): number {
  // Client-validated M/D/YYYY.
  return Number.parseInt(electionDate.slice(-4), 10);
}

function toMatch(input: {
  filer: SouthCarolinaFilerSearchRow;
  cycleReports: readonly SouthCarolinaCandidateReportRow[];
}): SouthCarolinaCandidateFilerMatch {
  const matchedElectionDates = [...new Set(input.cycleReports.map((row) => row.electionDate))].sort();
  return {
    candidateFilerId: input.filer.candidateFilerId,
    filerName: input.filer.candidate,
    matchedElectionDates,
    cycleReportCount: input.cycleReports.length,
    confidence: "exact",
    source: "ethics_filer_search",
    sourceUrl: SOUTH_CAROLINA_ETHICS_PUBLIC_REPORTING_URL,
  };
}

export function resolveSouthCarolinaCandidateFiler(input: {
  candidateName: string;
  // ISO YYYY-MM-DD from the linked election row.
  electionDate: string;
  filerReportSets: readonly SouthCarolinaFilerReportSet[];
}): SouthCarolinaCandidateFilerResolution {
  const candidateName = input.candidateName.trim();
  if (!candidateName) {
    return { status: "unmatched", reason: "missing_candidate_name" };
  }
  const electionYear = Number.parseInt(input.electionDate.slice(0, 4), 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.electionDate) || !Number.isInteger(electionYear)) {
    throw new Error(`Invalid South Carolina resolver election date: ${input.electionDate}`);
  }

  const surnameKey = rosterSurnameKey(candidateName);
  const literalMatches: SouthCarolinaCandidateFilerMatch[] = [];
  const nicknameMatches: SouthCarolinaCandidateFilerMatch[] = [];
  const surnameOnlyMatches: SouthCarolinaCandidateFilerMatch[] = [];
  const seenFilerIds = new Set<number>();
  let sawNameCandidate = false;

  // One set per filer id is the input contract (the auto-link fetches each
  // filer's report index once); a repeated id keeps the first set.
  for (const set of input.filerReportSets) {
    const filerId = set.filer.candidateFilerId;
    if (filerId <= 0 || seenFilerIds.has(filerId)) {
      continue;
    }
    const parses = parsePersonNameCandidates(set.filer.candidate, normalizePersonName);
    if (!surnameKey || !parses.some((parse) => parse.last === surnameKey)) {
      continue;
    }
    seenFilerIds.add(filerId);
    sawNameCandidate = true;

    const cycleReports = set.reports.filter(
      (row) => reportElectionYear(row.electionDate) === electionYear
    );
    if (cycleReports.length === 0) {
      continue;
    }
    const match = toMatch({ filer: set.filer, cycleReports });
    if (filerNameMatchesCandidate(candidateName, set.filer.candidate, false)) {
      literalMatches.push(match);
    } else if (filerNameMatchesCandidate(candidateName, set.filer.candidate, true)) {
      nicknameMatches.push(match);
    } else {
      surnameOnlyMatches.push(match);
    }
  }

  // Literal names first; nickname matches count only when nothing matched
  // literally, so a candidate with both a "Mike" and a "Michael" filer keeps
  // the literal one instead of turning ambiguous.
  const fullMatches = literalMatches.length > 0 ? literalMatches : nicknameMatches;

  if (fullMatches.length === 1) {
    return { status: "matched", ...fullMatches[0]! };
  }
  if (fullMatches.length > 1) {
    return {
      status: "ambiguous",
      reason: "multiple_matching_filers",
      matches: fullMatches.sort((left, right) => left.candidateFilerId - right.candidateFilerId),
    };
  }
  if (surnameOnlyMatches.length > 0) {
    return {
      status: "manual_confirm_required",
      candidates: surnameOnlyMatches.sort((left, right) => left.candidateFilerId - right.candidateFilerId),
    };
  }
  return {
    status: "unmatched",
    reason: sawNameCandidate ? "no_cycle_filings" : "no_matching_filer",
  };
}
