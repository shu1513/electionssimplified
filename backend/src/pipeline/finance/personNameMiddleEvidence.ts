// Middle-name evidence gate for state finance candidate-name matching.
//
// Every state resolver historically collapsed person names to a first+last
// key and accepted any key overlap, so "John A. Smith" linked to
// "Smith, John B." as an "exact" match whenever office, district, and
// election year agreed — attaching another candidate's finance records.
// Georgia fixed this first (georgiaCandidateCommitteeResolver.ts, commit
// 59e24a0d); this module is the shared port of that fix, shaped as a VETO so
// each state keeps its own recall behavior (nickname expansion, committee-name
// keys, search tokens) and only the middle-conflict false positive is removed:
//
//   match = <state's existing key-overlap match> && !hasMiddleNameConflict(...)
//
// Evidence rules, per Georgia: conflicting middles reject, an initial that
// corroborates the full middle matches, and the first+last fallback is only
// trusted when no aligned pair carried contradicting middle evidence.

export type ParsedPersonName = {
  first: string;
  middles: string[];
  last: string;
  // Marks parses whose surname boundary is explicit (comma form, single
  // token, two tokens) rather than guessed from a space-form split. A middle
  // conflict on a pair with an exact side is authoritative — see
  // collectMiddleEvidence.
  exact: boolean;
};

// States pass their own person-name normalizer so per-state stop-word and
// suffix stripping is preserved. Must return an uppercase, space-separated
// token string ("" when the input carries no name content).
export type NormalizePersonName = (value: string) => string;

// Parses a raw display name into (first, middles, last). Comma forms
// ("Carr, Christopher M.") are unambiguous and yield one parse. Space forms
// are ambiguous about where the surname starts ("Mary Van Dyke"), so every
// split is emitted and the pair comparison tries them all — a wrong split can
// only fail to align, never manufacture evidence.
export function parsePersonNameCandidates(
  raw: string,
  normalizePersonName: NormalizePersonName
): ParsedPersonName[] {
  const commaIndex = raw.indexOf(",");
  if (commaIndex > 0) {
    const last = normalizePersonName(raw.slice(0, commaIndex));
    const restTokens = normalizePersonName(raw.slice(commaIndex + 1))
      .split(" ")
      .filter(Boolean);
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
  const parses: ParsedPersonName[] = [];
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

// Expands a display name into parse variants: the name outside parentheses
// plus each parenthetical alias ("LEE, Bill (Bill Lee)") parsed on its own.
// A single-token parenthetical is a call name substituting the FIRST name
// ("Glenn A. (Mike) Prax", "Robert (Bob) Smith"), not a standalone person, so
// it yields ONLY the outer parses with the first token swapped — keeping the
// outer middles and surname so their evidence survives ("Mike A Prax" still
// contradicts "Prax, Mike B"). It is never parsed on its own: a lone token
// reads as first AND last name, which let "(Bob)" align with a surname-less
// "Bob" row or a different person surnamed Bob. Single characters are
// excluded: a lone letter in parentheses is a party or ballot marker, not a
// call name.
export function personNameParseVariants(
  value: string,
  normalizePersonName: NormalizePersonName
): ParsedPersonName[] {
  const variants: ParsedPersonName[] = [];
  const outerParses = parsePersonNameCandidates(value.replace(/\([^()]+\)/g, " "), normalizePersonName);
  variants.push(...outerParses);
  for (const match of value.matchAll(/\(([^()]+)\)/g)) {
    if (!match[1]) {
      continue;
    }
    const aliasTokens = normalizePersonName(match[1]).split(" ").filter(Boolean);
    if (aliasTokens.length !== 1) {
      variants.push(...parsePersonNameCandidates(match[1], normalizePersonName));
      continue;
    }
    const callName = aliasTokens[0]!;
    if (callName.length < 2) {
      continue;
    }
    for (const outer of outerParses) {
      if (callName !== outer.first) {
        variants.push({ first: callName, middles: outer.middles, last: outer.last, exact: outer.exact });
      }
    }
  }
  return variants;
}

function middleTokensCorroborate(tokenA: string, tokenB: string): boolean {
  if (tokenA === tokenB) {
    return true;
  }
  if (tokenA.length === 1 && tokenB.startsWith(tokenA)) {
    return true;
  }
  return tokenB.length === 1 && tokenA.startsWith(tokenB);
}

// Middle-name evidence between two parses whose first and last already agree:
// "strong" when the middles corroborate position by position (equal, or an
// initial matching the full form), "conflict" when any shared position
// disagrees ("John A. B. Smith" vs "Smith, John A. C." conflicts on the
// second middle), "weak" when at least one side has no middle information.
// Tokens past the shorter side's length are one-sided and carry no evidence.
export function middleNameEvidence(a: string[], b: string[]): "strong" | "weak" | "conflict" {
  if (a.length === 0 || b.length === 0) {
    return "weak";
  }
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) {
    if (!middleTokensCorroborate(a[index]!, b[index]!)) {
      return "conflict";
    }
  }
  return "strong";
}

// Committee names bury the person name inside designator text ("Citizens for
// Jane B Doe for Governor", "Jane B Doe 2026"). The trailing tokens block
// first+last alignment, so a contradicting middle would produce no evidence
// and slip through a committee-name match. Callers vetoing against a
// committee name expand it into candidate row-name strings first: the raw
// name, the name with 4-digit years removed, and each "for"-delimited
// segment — the person-name segment then aligns cleanly. Extra segments can
// only add aligned evidence, never block alignment that already existed.
export function committeeNameMiddleEvidenceRowNames(raw: string): string[] {
  const names = new Set<string>();
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }
  names.add(trimmed);
  const withoutYears = trimmed
    .replace(/\b(?:19|20)\d{2}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (withoutYears) {
    names.add(withoutYears);
    for (const segment of withoutYears.split(/\bfor\b/i)) {
      const trimmedSegment = segment.trim();
      if (trimmedSegment) {
        names.add(trimmedSegment);
      }
    }
  }
  return [...names];
}

export type MiddleNameConflictInput = {
  candidateName: string;
  rowNames: readonly string[];
  normalizePersonName: NormalizePersonName;
  // Nickname-aware states (alaska/connecticut/illinois/texas pattern) pass
  // their one-sided candidate→row first-name equivalence here so a middle
  // conflict on "Mike A. Smith" vs "SMITH, MICHAEL B" still registers.
  // Defaults to strict equality.
  firstNamesEquivalent?: (candidateFirst: string, rowFirst: string) => boolean;
};

// Aggregated middle evidence across aligned candidate/row variant pairs.
// Strong corroboration and exact-pair conflicts are both collected GLOBALLY,
// outside the longest-surname preference (the georgia aggregation order:
// any strong pair wins, then an exact conflict rejects, then the ambiguous
// remainder is arbitrated). An EXACT pair is one whose surname boundary is
// explicit (comma form) rather than guessed, which pins the aligned parse
// on the other side too — its conflict is authoritative, and an ambiguous
// space-form split elsewhere must never override it ("Smith, John B. A."
// conflicts with "John A. Smith" no matter how a sibling "John B A Smith"
// row re-splits). Only ambiguous weak/conflict evidence is judged at the
// LONGEST matching surname interpretation: a shorter split misreads part of
// a compound surname as a middle name and can manufacture a conflict
// ("Mary [VAN] DYKE" vs "Mary [B VAN] DYKE" conflicts, while the true
// "VAN DYKE" alignment is a clean weak fallback). The wrong split still can
// never manufacture AGREEMENT — first and last must align token-for-token —
// so preferring the most-specific alignment only discards manufactured
// contradictions.
function collectMiddleEvidence(input: MiddleNameConflictInput): {
  sawStrong: boolean;
  sawWeak: boolean;
  sawConflict: boolean;
  sawExactConflict: boolean;
} {
  const firstNamesEquivalent =
    input.firstNamesEquivalent ?? ((candidateFirst: string, rowFirst: string) => candidateFirst === rowFirst);
  const candidateVariants = personNameParseVariants(input.candidateName, input.normalizePersonName);
  let surnameTokenCount = 0;
  let sawStrong = false;
  let sawWeak = false;
  let sawConflict = false;
  let sawExactConflict = false;
  for (const rowName of input.rowNames) {
    for (const rowVariant of personNameParseVariants(rowName, input.normalizePersonName)) {
      for (const candidateVariant of candidateVariants) {
        if (candidateVariant.last !== rowVariant.last) {
          continue;
        }
        if (!firstNamesEquivalent(candidateVariant.first, rowVariant.first)) {
          continue;
        }
        const evidence = middleNameEvidence(candidateVariant.middles, rowVariant.middles);
        if (evidence === "strong") {
          sawStrong = true;
          continue;
        }
        if (evidence === "conflict" && (candidateVariant.exact || rowVariant.exact)) {
          sawExactConflict = true;
          continue;
        }
        const pairSurnameTokenCount = rowVariant.last.split(" ").length;
        if (pairSurnameTokenCount < surnameTokenCount) {
          continue;
        }
        if (pairSurnameTokenCount > surnameTokenCount) {
          surnameTokenCount = pairSurnameTokenCount;
          sawWeak = false;
          sawConflict = false;
        }
        if (evidence === "conflict") {
          sawConflict = true;
        } else {
          sawWeak = true;
        }
      }
    }
  }
  return { sawStrong, sawWeak, sawConflict, sawExactConflict };
}

// Generational suffixes, ranked by generation. A parent/child pair shares
// first, middle AND last name by construction, so middle evidence can never
// separate them (middleNameEvidence returns "weak" the moment either side
// omits a middle) — the suffix is the only discriminator there is.
//
// Ranked rather than compared as strings because JR and II are conventions
// for the SAME generation and real filings conflate them; treating that pair
// as a contradiction would reject genuine links. Only a true generation gap
// (SR vs II, SR vs JR, II vs III) is evidence of two different people.
// A distinct "John Smith II" who is not "John Smith Jr." does exist as a
// naming convention (a namesake who is not the son), but a cross-link needs
// both of them ALIVE AND RUNNING for the same office, district, and year —
// the caller gates on those before this veto runs — while Jr/II styling
// variance for one person across a roster and a state file is routine.
// Equating them trades a near-nonexistent collision for the common case.
//
// Bare "V" and "I" are deliberately absent: as a trailing token they are far
// more often a middle initial ("Smith, John V") than a fifth generation, and
// a false suffix conflict rejects a real committee.
const GENERATIONAL_SUFFIX_RANK = new Map<string, number>([
  ["SR", 1],
  ["JR", 2],
  ["II", 2],
  ["III", 3],
  ["IV", 4],
]);

// The trailing generational suffix of a plain string (no parentheticals),
// split off from its remainder. { suffix: null } when the final token is not
// a suffix or nothing would remain — a bare "II" is not a person name
// carrying a suffix.
function splitTrailingSuffix(value: string): { suffix: string | null; base: string } {
  const trimmed = value.replace(/[^A-Za-z0-9]+$/, "");
  const match = /(?:^|[^A-Za-z0-9])([A-Za-z0-9]+)$/.exec(trimmed);
  const lastToken = match?.[1]?.toUpperCase();
  if (!match || !lastToken || !GENERATIONAL_SUFFIX_RANK.has(lastToken)) {
    return { suffix: null, base: value };
  }
  const base = trimmed
    .slice(0, trimmed.length - match[1]!.length)
    .replace(/[^A-Za-z0-9]+$/, "");
  if (!base) {
    return { suffix: null, base: value };
  }
  return { suffix: lastToken, base };
}

// A raw name split into its generational suffix (or null) and the remainder
// with the suffix and its separators removed. Read from the RAW string on
// purpose: every state's normalizePersonName strips suffixes before the parse
// functions above ever see them, so by the time middle evidence is collected
// this information is already gone.
//
// A suffix rides in one of two positions, mirroring where real files put it:
// the end of the string ("Lester L. Wilks Jr.", "Bailey, Javier II") or the
// end of the surname segment in a comma form ("SMITH JR, JOHN"). The same
// token anywhere else belongs to the name itself and must not be read as a
// generation. Parenthetical metadata is dropped first — a party marker or
// call-name alias ("John Smith Jr. (R)", "John Smith Jr. (Johnny Smith)")
// would otherwise hide a genuinely trailing suffix — matching how
// personNameParseVariants treats parentheticals for parsing.
//
// The base is returned because the comma-suffix form ("Javier Bailey, II")
// parses to NOTHING as written — the comma reads as a surname boundary whose
// remainder is empty once the normalizer strips "II" — so the alignment check
// below must run on the suffix-stripped base, not the raw string.
function splitGenerationalSuffix(raw: string): { suffix: string | null; base: string } {
  const withoutParens = raw.replace(/\([^()]*\)/g, " ").replace(/\s+/g, " ").trim();
  const trailing = splitTrailingSuffix(withoutParens);
  if (trailing.suffix) {
    return trailing;
  }
  const commaIndex = withoutParens.indexOf(",");
  if (commaIndex > 0) {
    const head = splitTrailingSuffix(withoutParens.slice(0, commaIndex));
    if (head.suffix) {
      return { suffix: head.suffix, base: head.base + withoutParens.slice(commaIndex) };
    }
  }
  return { suffix: null, base: raw };
}

// The generational suffix carried by a raw name, or null.
export function generationalSuffix(raw: string): string | null {
  return splitGenerationalSuffix(raw).suffix;
}

// True when the candidate and a row name BOTH carry a generational suffix,
// those suffixes name different generations, and the suffix-stripped names
// align on first+last — i.e. the row is the same name, one generation over.
//
// The alignment requirement is load-bearing, not decoration. IL and DC pass
// raw COMMITTEE names through committeeNameMiddleEvidenceRowNames, and
// committee names can end in positional roman numerals ("Smith for Judge
// Division III", "Friends of John Doe Ward II") that are seats, not
// generations. Without alignment, "John Smith Jr." would veto his own
// "John Smith for Ward III" committee. With it, that string's parses
// ("SMITH WARD" / "WARD" surnames) never align with SMITH, so no veto —
// while a genuine "Citizens for John Smith III" segment aligns and still
// rejects. A wrong split can fail to align but never manufacture alignment
// (the module invariant), and any aligned pair is decisive here because the
// suffix came from the raw string, unaffected by how the base was split.
//
// One side lacking a suffix is MISSING INFORMATION, not a contradiction —
// state files omit "Jr" constantly — so it stays weak, the same rule
// middleNameEvidence applies to absent middles.
export function hasGenerationalSuffixConflict(input: MiddleNameConflictInput): boolean {
  const candidate = splitGenerationalSuffix(input.candidateName);
  if (!candidate.suffix) {
    return false;
  }
  const candidateRank = GENERATIONAL_SUFFIX_RANK.get(candidate.suffix)!;
  const firstNamesEquivalent =
    input.firstNamesEquivalent ?? ((candidateFirst: string, rowFirst: string) => candidateFirst === rowFirst);
  const candidateVariants = personNameParseVariants(candidate.base, input.normalizePersonName);
  return input.rowNames.some((rowName) => {
    const row = splitGenerationalSuffix(rowName);
    if (!row.suffix || GENERATIONAL_SUFFIX_RANK.get(row.suffix)! === candidateRank) {
      return false;
    }
    for (const rowVariant of personNameParseVariants(row.base, input.normalizePersonName)) {
      for (const candidateVariant of candidateVariants) {
        if (
          candidateVariant.last === rowVariant.last &&
          firstNamesEquivalent(candidateVariant.first, rowVariant.first)
        ) {
          return true;
        }
      }
    }
    return false;
  });
}

// True when the candidate and row names align on first+last, at least one
// aligned pair carries contradicting middle names, and no aligned pair
// corroborates the middle — or when the two names name different generations.
// Callers apply this AFTER their existing key-overlap match, as a rejection
// gate:
//
//   "John A. Smith" vs "Smith, John B."  -> true  (reject the row)
//   "John A. Smith" vs "Smith, John Andrew" -> false (initial corroborates)
//   "John Smith"    vs "Smith, John B."  -> false (a side lacks middle info)
//   "Javier Bailey, II" vs "BAILEY, JAVIER SR" -> true (different generations)
//   "Javier Bailey" vs "BAILEY, JAVIER II" -> false (a side lacks a suffix)
//
// The suffix veto sits OUTSIDE the sawStrong guard on purpose. Strong middle
// corroboration is exactly what a father/son pair produces — they share the
// middle name — so letting it override the suffix would re-open the one case
// the suffix exists to catch.
//
// When no variant pair aligns at all (committee-name keys, nickname keys the
// caller did not surface here) there is no middle evidence either way and the
// state's key-overlap verdict stands.
export function hasMiddleNameConflict(input: MiddleNameConflictInput): boolean {
  if (hasGenerationalSuffixConflict(input)) {
    return true;
  }
  const evidence = collectMiddleEvidence(input);
  return !evidence.sawStrong && (evidence.sawConflict || evidence.sawExactConflict);
}

// Full match verdict (the georgia aggregation), for states whose key sets
// carry NO first+last collapse (colorado pattern: full-string and comma-flip
// keys only). Those states have the opposite problem — "John A. Smith" never
// matches "Smith, John" at all — so they call this as a RECALL fallback after
// their exact-key match misses: any strong pair matches; otherwise any middle
// conflict rejects; otherwise a first+last alignment with middle information
// missing on a side matches. No alignment at all is no match — this function
// never widens beyond first+last agreement.
export function personNamesMatchWithMiddleEvidence(input: MiddleNameConflictInput): boolean {
  // Checked first, and ahead of sawStrong, for the same reason the veto in
  // hasMiddleNameConflict is: a father/son pair corroborates on the middle,
  // so only the generational suffix separates them.
  if (hasGenerationalSuffixConflict(input)) {
    return false;
  }
  const evidence = collectMiddleEvidence(input);
  return (
    evidence.sawStrong ||
    (evidence.sawWeak && !evidence.sawConflict && !evidence.sawExactConflict)
  );
}
