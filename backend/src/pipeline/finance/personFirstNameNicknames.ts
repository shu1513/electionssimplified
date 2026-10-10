// Conservative equivalence groups for common American first-name nicknames.
// State finance sources file candidates under formal names ("Michael W
// Frerichs") while VoteApp often stores the campaign name ("Mike Frerichs"),
// so exact-key matching silently strands well-known incumbents.
//
// Resolvers must expand variants on the VoteApp side ONLY, keying
// source-side names literally. Expanding both sides would let two distinct
// formal names meet at a shared nickname key ("Patrick Smith" and "Patricia
// Smith" both produce "PAT SMITH") and attach the wrong person's data when
// only one of them exists in the source. With one-sided expansion a variant
// match still requires the same surname plus office/district/year agreement,
// and multi-candidate hits surface as ambiguous rather than linking.
//
// Keep this list to unambiguous, widely used American pairs. A nickname may
// appear in several groups ("PAT" → Patrick and Patricia); lookups return the
// union of its groups.
//
// Shared-nickname inputs are a deliberate tradeoff: a VoteApp "Pat Smith"
// expands to both PATRICK SMITH and PATRICIA SMITH, so if exactly one of
// those filed for the same office/district/year the resolver links it. That
// is intended — same surname, office, district, and election year already
// agree, both-families-present still resolves as ambiguous, and refusing all
// shared nicknames would strand live-verified correct links (Pat Curry,
// Sam Nestor → SAMANTHA, Steve Weir → STEPHEN) over a coincidence with no
// observed instances. Note also that some "families" sharing a nickname are
// spelling variants of one name (STEPHEN/STEVEN, JEFFREY/JEFFERY), where
// refusal would be pure loss.
const FIRST_NAME_NICKNAME_GROUPS: readonly (readonly string[])[] = [
  ["ABRAHAM", "ABE"],
  ["ALBERT", "AL"],
  ["ALEXANDER", "ALEX"],
  ["ALEXANDRA", "ALEX"],
  ["ALFRED", "AL"],
  ["AMANDA", "MANDY"],
  ["ANDREW", "ANDY", "DREW"],
  ["ANGELA", "ANGIE"],
  ["ANGELICA", "ANGIE"],
  ["ANTHONY", "TONY"],
  ["BARBARA", "BARB"],
  ["BENJAMIN", "BEN"],
  ["BERNARD", "BERNIE"],
  ["BRADLEY", "BRAD"],
  ["CALVIN", "CAL"],
  ["CHARLES", "CHARLIE", "CHUCK"],
  ["CHRISTINA", "CHRIS"],
  ["CHRISTINE", "CHRIS"],
  ["CHRISTOPHER", "CHRIS"],
  ["CYNTHIA", "CINDY"],
  ["DANIEL", "DAN", "DANNY"],
  ["DAVID", "DAVE"],
  ["DEBORAH", "DEB", "DEBBIE"],
  ["DENNIS", "DENNY"],
  ["DONALD", "DON"],
  ["DOUGLAS", "DOUG"],
  ["EDMUND", "ED", "EDDIE"],
  ["EDWARD", "ED", "EDDIE", "TED"],
  ["ELIZABETH", "BETH", "BETTY", "LIZ"],
  ["EUGENE", "GENE"],
  ["FRANCES", "FRAN"],
  ["FRANCIS", "FRANK"],
  ["FRANCISCO", "CISCO", "PACO"],
  ["FRANKLIN", "FRANK"],
  ["FREDERICK", "FRED"],
  ["GABRIELLA", "GABBY"],
  ["GABRIELLE", "GABBY"],
  ["GEOFFREY", "GEOFF"],
  ["GERALD", "JERRY"],
  ["GREGORY", "GREG"],
  ["HAROLD", "HARRY"],
  ["HENRY", "HANK", "HARRY"],
  ["HERBERT", "HERB"],
  ["JACOB", "JAKE"],
  ["JACQUELINE", "JACKIE"],
  ["JEDEDIAH", "JED"],
  ["JAMES", "JIM", "JIMMY", "JAMIE"],
  ["JEFFERY", "JEFF"],
  ["JEFFREY", "JEFF"],
  ["JENNIFER", "JEN", "JENNY"],
  ["JEROME", "JERRY"],
  ["JESSICA", "JESS"],
  ["JOHN", "JACK", "JOHNNY"],
  ["JONATHAN", "JON"],
  ["JOSEPH", "JOE", "JOEY"],
  ["JOSHUA", "JOSH"],
  ["KATHERINE", "KATE", "KATHY", "KATIE"],
  ["KATHLEEN", "KATE", "KATHY"],
  ["KENNETH", "KEN", "KENNY"],
  ["KIMBERLY", "KIM"],
  ["KRISTINA", "KRIS", "KRISTA"],
  ["KRISTEN", "KRIS"],
  ["LAWRENCE", "LARRY"],
  ["LEONARD", "LEN", "LENNY"],
  ["LOUIS", "LOU"],
  ["MARGARET", "MAGGIE", "MEG", "PEGGY"],
  ["MARTIN", "MARTY"],
  ["MATTHEW", "MATT"],
  ["MELINDA", "MINDY"],
  ["MELVIN", "MEL"],
  ["MICHAEL", "MIKE"],
  ["NATHAN", "NATE"],
  ["NATHANIEL", "NATE"],
  ["NICHOLAS", "NICK"],
  ["NORMAN", "NORM"],
  ["PAMELA", "PAM"],
  ["PATRICIA", "PAT", "PATTY", "TRICIA"],
  ["PATRICK", "PAT"],
  ["PETER", "PETE"],
  ["PHILIP", "PHIL"],
  ["PHILLIP", "PHIL"],
  ["RANDALL", "RANDY"],
  ["RANDOLPH", "RANDY"],
  ["RAYMOND", "RAY"],
  ["REBECCA", "BECKY"],
  ["RICHARD", "DICK", "RICH", "RICK", "RICKY"],
  ["ROBERT", "BOB", "BOBBY", "ROB"],
  ["RONALD", "RON"],
  ["RUSSELL", "RUSS", "RUSSEL"],
  ["SAMANTHA", "SAM"],
  ["SAMUEL", "SAM"],
  ["SANDRA", "SANDY"],
  ["STANLEY", "STAN"],
  ["STEPHEN", "STEVE"],
  ["STEVEN", "STEVE"],
  ["SUSAN", "SUE"],
  ["TERESA", "TESS"],
  ["THERESA", "TESS"],
  ["THEODORE", "TED", "TEDDY"],
  ["THOMAS", "TOM", "TOMMY"],
  ["TIMOTHY", "TIM"],
  ["VICTORIA", "VICKI", "VICKY"],
  ["VINCENT", "VINCE"],
  ["WALTER", "WALT"],
  ["WESLEY", "WES"],
  ["WESTLEY", "WES"],
  ["WILLIAM", "BILL", "BILLY", "WILL"],
  ["ZACHARY", "ZACH", "ZACK"],
];

// Formal spellings of the same name. These never bridge through expansion
// (one-sided rule above), but they must not be treated as evidence of two
// distinct people when a source spells one person both ways.
const SPELLING_EQUIVALENT_PAIRS: readonly (readonly [string, string])[] = [
  ["STEPHEN", "STEVEN"],
  ["JEFFREY", "JEFFERY"],
  ["PHILIP", "PHILLIP"],
];

const VARIANTS_BY_NAME = new Map<string, Set<string>>();
for (const group of FIRST_NAME_NICKNAME_GROUPS) {
  for (const name of group) {
    const variants = VARIANTS_BY_NAME.get(name) ?? new Set<string>();
    for (const other of group) {
      if (other !== name) {
        variants.add(other);
      }
    }
    VARIANTS_BY_NAME.set(name, variants);
  }
}

/**
 * Returns the alternate first names equivalent to an already-normalized
 * (uppercase) first-name token, or an empty array for names with no known
 * nickname relationship.
 */
export function firstNameVariants(normalizedFirstName: string): readonly string[] {
  const variants = VARIANTS_BY_NAME.get(normalizedFirstName);
  return variants ? [...variants] : [];
}

/**
 * Returns true when two already-normalized (uppercase) first-name tokens are
 * positive evidence of two distinct people: neither equals the other, neither
 * is a nickname variant of the other, and they are not formal spellings of
 * the same name (STEPHEN/STEVEN, JEFFREY/JEFFERY). Nickname-expanded matching
 * that observes conflicting tokens for one candidate should refuse rather
 * than pick a side, mirroring the resolver's both-families-filed rule.
 */
export function firstNamesConflict(normalizedA: string, normalizedB: string): boolean {
  if (normalizedA === normalizedB) {
    return false;
  }
  if (VARIANTS_BY_NAME.get(normalizedA)?.has(normalizedB) || VARIANTS_BY_NAME.get(normalizedB)?.has(normalizedA)) {
    return false;
  }
  return !SPELLING_EQUIVALENT_PAIRS.some(
    ([left, right]) =>
      (left === normalizedA && right === normalizedB) || (left === normalizedB && right === normalizedA)
  );
}
