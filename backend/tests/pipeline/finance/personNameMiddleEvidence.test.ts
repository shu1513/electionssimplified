import { describe, expect, it } from "vitest";

import {
  committeeNameMiddleEvidenceRowNames,
  generationalSuffix,
  hasMiddleNameConflict,
  middleNameEvidence,
  parsePersonNameCandidates,
  personNameParseVariants,
  personNamesMatchWithMiddleEvidence,
} from "../../../src/pipeline/finance/personNameMiddleEvidence.js";

// A representative state normalizer (the tennessee-pattern one): uppercase,
// strip punctuation and generational suffixes.
function normalizePersonName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\b(JR|SR|II|III|IV|V)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

describe("parsePersonNameCandidates", () => {
  it("parses comma form into a single unambiguous split", () => {
    expect(parsePersonNameCandidates("Carr, Christopher M.", normalizePersonName)).toEqual([
      { first: "CHRISTOPHER", middles: ["M"], last: "CARR", exact: true },
    ]);
  });

  it("emits every surname split for space forms", () => {
    expect(parsePersonNameCandidates("Mary Van Dyke", normalizePersonName)).toEqual([
      { first: "MARY", middles: [], last: "VAN DYKE", exact: false },
      { first: "MARY", middles: ["VAN"], last: "DYKE", exact: false },
    ]);
  });

  it("treats a single token as first and last", () => {
    expect(parsePersonNameCandidates("Cher", normalizePersonName)).toEqual([
      { first: "CHER", middles: [], last: "CHER", exact: true },
    ]);
  });

  it("marks a two-token name exact — its surname boundary is unambiguous", () => {
    expect(parsePersonNameCandidates("Bill Lee", normalizePersonName)).toEqual([
      { first: "BILL", middles: [], last: "LEE", exact: true },
    ]);
  });

  it("returns no parses for empty or comma-degenerate input", () => {
    expect(parsePersonNameCandidates("  ", normalizePersonName)).toEqual([]);
    expect(parsePersonNameCandidates("Smith,", normalizePersonName)).toEqual([]);
  });
});

describe("personNameParseVariants", () => {
  it("parses the outer name and each parenthetical alias", () => {
    const variants = personNameParseVariants("LEE, Bill (Bill Lee)", normalizePersonName);
    expect(variants).toContainEqual({ first: "BILL", middles: [], last: "LEE", exact: true });
    expect(variants.length).toBeGreaterThan(1);
  });

  it("expands a single-token alias as a first-name swap only, keeping the outer surname", () => {
    expect(personNameParseVariants("Robert (Bob) Smith", normalizePersonName)).toEqual([
      { first: "ROBERT", middles: [], last: "SMITH", exact: true },
      { first: "BOB", middles: [], last: "SMITH", exact: true },
    ]);
  });
});

describe("middleNameEvidence", () => {
  it("is weak when either side lacks middles", () => {
    expect(middleNameEvidence([], [])).toBe("weak");
    expect(middleNameEvidence(["A"], [])).toBe("weak");
    expect(middleNameEvidence([], ["ANDREW"])).toBe("weak");
  });

  it("is strong on equal middles or a corroborating initial", () => {
    expect(middleNameEvidence(["ANDREW"], ["ANDREW"])).toBe("strong");
    expect(middleNameEvidence(["A"], ["ANDREW"])).toBe("strong");
    expect(middleNameEvidence(["ANDREW"], ["A"])).toBe("strong");
  });

  it("is conflict on contradicting middles", () => {
    expect(middleNameEvidence(["A"], ["B"])).toBe("conflict");
    expect(middleNameEvidence(["ANDREW"], ["BERNARD"])).toBe("conflict");
    expect(middleNameEvidence(["ANDREW"], ["ANN"])).toBe("conflict");
  });

  it("compares every shared middle position, not just the first", () => {
    expect(middleNameEvidence(["MICHAEL", "ANDREW"], ["MICHAEL", "BERNARD"])).toBe("conflict");
    expect(middleNameEvidence(["A", "B"], ["A", "C"])).toBe("conflict");
    expect(middleNameEvidence(["A", "B"], ["ANDREW", "BERNARD"])).toBe("strong");
    // Tokens past the shorter side carry no evidence.
    expect(middleNameEvidence(["MICHAEL"], ["MICHAEL", "BERNARD"])).toBe("strong");
  });
});

describe("hasMiddleNameConflict", () => {
  function conflict(candidateName: string, rowNames: string[]): boolean {
    return hasMiddleNameConflict({ candidateName, rowNames, normalizePersonName });
  }

  it("vetoes conflicting middle initials even when first and last agree", () => {
    expect(conflict("John A. Smith", ["Smith, John B."])).toBe(true);
    expect(conflict("John Andrew Smith", ["Smith, John Bernard"])).toBe(true);
  });

  it("does not veto an initial that corroborates the full middle name", () => {
    expect(conflict("John A. Smith", ["Smith, John Andrew"])).toBe(false);
    expect(conflict("John Andrew Smith", ["Smith, John A."])).toBe(false);
  });

  it("does not veto the first+last fallback when a side lacks middle info", () => {
    expect(conflict("John Smith", ["Smith, John B."])).toBe(false);
    expect(conflict("John A. Smith", ["Smith, John"])).toBe(false);
  });

  it("lets a middle conflict veto a middle-less variant of the same row", () => {
    // One row name lacks the middle, but a sibling name carries a
    // contradicting one: the conflict wins over the weak fallback.
    expect(conflict("John A. Smith", ["John Smith", "Smith, John B."])).toBe(true);
  });

  it("lets corroboration on any row name clear a conflict on another", () => {
    expect(conflict("John A. Smith", ["Smith, John B.", "John Andrew Smith"])).toBe(false);
  });

  it("stays out of the way when no variant pair aligns on first+last", () => {
    expect(conflict("John A. Smith", ["Jones, Mary B."])).toBe(false);
    expect(conflict("John A. Smith", ["Friends Of Somebody Else"])).toBe(false);
    expect(conflict("John A. Smith", [])).toBe(false);
  });

  it("vetoes a contradiction hidden past a matching first middle", () => {
    expect(conflict("John Michael Andrew Smith", ["Smith, John Michael Bernard"])).toBe(true);
    expect(conflict("John A. B. Smith", ["Smith, John A. C."])).toBe(true);
  });

  it("treats a single-token parenthetical as a call name that keeps outer middle evidence", () => {
    // "Glenn A. (Mike) Prax" is one person: Mike substitutes the first name,
    // the A stays. A filer "Prax, Mike B" contradicts it.
    expect(conflict("Glenn A. (Mike) Prax", ["Prax, Mike B"])).toBe(true);
    expect(conflict("Robert A. (Bob) Smith", ["Smith, Bob B"])).toBe(true);
    // Weak fallback and corroboration behave as usual through the call name.
    expect(conflict("Robert (Bob) Smith", ["Smith, Bob B"])).toBe(false);
    expect(conflict("Robert A. (Bob) Smith", ["Smith, Bob Andrew"])).toBe(false);
  });

  it("does not read a single-letter parenthetical as a call name", () => {
    // "(D)" is a party marker, not a nickname.
    expect(conflict("Jane Doe (D)", ["Doe, Jane B"])).toBe(false);
  });

  it("keeps multi-word surnames aligned across name orders", () => {
    expect(conflict("Mary Van Dyke", ["Van Dyke, Mary"])).toBe(false);
    expect(conflict("Mary A. Van Dyke", ["Van Dyke, Mary B."])).toBe(true);
  });

  it("does not let a shorter surname split manufacture a conflict", () => {
    // The true alignment is "VAN DYKE" (weak: only the row carries a middle).
    // The alternate "DYKE" split would read VAN as a candidate middle and
    // manufacture VAN-vs-B; only the longest aligned surname carries evidence.
    expect(conflict("Mary Van Dyke", ["Mary B Van Dyke"])).toBe(false);
  });

  it("ignores generational suffixes stripped by the normalizer", () => {
    expect(conflict("John Smith Jr.", ["Smith, John"])).toBe(false);
  });

  it("never lets an ambiguous space-form split override a comma-form conflict", () => {
    // The comma form pins the surname, so its A-vs-B conflict is
    // authoritative; the space-form sibling row re-splitting as surname
    // "A SMITH" must not resurrect the match through the longest-surname
    // preference.
    expect(conflict("John A. Smith", ["Smith, John B. A.", "John B A Smith"])).toBe(true);
    // Without a pinned boundary the space-form row alone stays clear:
    // "A SMITH" is a legitimate compound-surname reading (apostrophe
    // stripping produces real ones — "MARIA C D ANGELO" for Maria
    // D'Angelo), and the longest alignment carries only weak evidence.
    expect(conflict("John A. Smith", ["John B A Smith"])).toBe(false);
  });

  it("lets strong corroboration survive a longer ambiguous alignment", () => {
    // Strong evidence is global, like an exact conflict: the "A SMITH"
    // split's longer weak alignment must not erase the exact "John A."
    // corroboration while the exact "John B." conflict stays counted —
    // any strong pair clears the veto (georgia aggregation).
    expect(
      conflict("John A. Smith", ["Smith, John B.", "Smith, John A.", "John B A Smith"])
    ).toBe(false);
  });

  it("agrees with personNamesMatchWithMiddleEvidence on every shared case", () => {
    // Wherever parses align, the veto and the full matcher are complements.
    const cases: Array<[string, string[]]> = [
      ["John A. Smith", ["Smith, John B."]],
      ["John A. Smith", ["Smith, John Andrew"]],
      ["John Smith", ["Smith, John B."]],
      ["John A. Smith", ["John Smith", "Smith, John B."]],
      ["Mary A. Van Dyke", ["Van Dyke, Mary B."]],
    ];
    for (const [candidateName, rowNames] of cases) {
      expect(personNamesMatchWithMiddleEvidence({ candidateName, rowNames, normalizePersonName })).toBe(
        !hasMiddleNameConflict({ candidateName, rowNames, normalizePersonName })
      );
    }
  });

  it("honors a caller-supplied first-name equivalence for nickname states", () => {
    const nicknameEquivalent = (candidateFirst: string, rowFirst: string) =>
      candidateFirst === rowFirst || (candidateFirst === "MIKE" && rowFirst === "MICHAEL");
    expect(
      hasMiddleNameConflict({
        candidateName: "Mike A. Smith",
        rowNames: ["SMITH, MICHAEL B"],
        normalizePersonName,
        firstNamesEquivalent: nicknameEquivalent,
      })
    ).toBe(true);
    // Without the equivalence the pair never aligns, so no veto.
    expect(conflict("Mike A. Smith", ["SMITH, MICHAEL B"])).toBe(false);
  });
});

describe("personNamesMatchWithMiddleEvidence", () => {
  function matches(candidateName: string, rowNames: string[]): boolean {
    return personNamesMatchWithMiddleEvidence({ candidateName, rowNames, normalizePersonName });
  }

  it("recovers first+last alignments the exact-key states miss", () => {
    // The colorado-pattern recall gap: full-string keys never overlap when
    // only one side carries a middle.
    expect(matches("John A. Smith", ["Smith, John"])).toBe(true);
    expect(matches("John Smith", ["Smith, John A."])).toBe(true);
    expect(matches("John Smith", ["John Smith"])).toBe(true);
  });

  it("matches on corroborating middles and rejects contradicting ones", () => {
    expect(matches("John A. Smith", ["Smith, John Andrew"])).toBe(true);
    expect(matches("John A. Smith", ["Smith, John B."])).toBe(false);
  });

  it("requires an actual first+last alignment", () => {
    expect(matches("John Smith", ["Jones, Mary"])).toBe(false);
    expect(matches("John Smith", [])).toBe(false);
    expect(matches("John Smith", ["Smithers, John"])).toBe(false);
  });

  it("lets a conflict on one row name veto a weak alignment on another", () => {
    expect(matches("John A. Smith", ["John Smith", "Smith, John B."])).toBe(false);
  });

  it("never lets a call-name alias stand in for the surname", () => {
    // A lone "(Bob)" used to parse as first AND last name, so it aligned with
    // a surname-less "Bob" row and, under nickname equivalence, with a
    // different person whose surname is Bob.
    expect(matches("Robert (Bob) Smith", ["Bob"])).toBe(false);
    expect(
      personNamesMatchWithMiddleEvidence({
        candidateName: "Robert (Bob) Smith",
        rowNames: ["Robert Bob"],
        normalizePersonName,
        firstNamesEquivalent: (candidateFirst, rowFirst) =>
          candidateFirst === rowFirst || (candidateFirst === "BOB" && rowFirst === "ROBERT"),
      })
    ).toBe(false);
    // The call name still matches through the outer surname.
    expect(matches("Robert (Bob) Smith", ["Smith, Bob"])).toBe(true);
  });

  it("rejects a contradiction hidden past a matching first middle", () => {
    expect(matches("John Michael Andrew Smith", ["Smith, John Michael Bernard"])).toBe(false);
  });

  it("recovers a compound-surname alignment despite the shorter-split parse", () => {
    expect(matches("Mary Van Dyke", ["Mary B Van Dyke"])).toBe(true);
  });

  it("rejects when a comma-form conflict coexists with a space-form sibling", () => {
    expect(matches("John A. Smith", ["Smith, John B. A.", "John B A Smith"])).toBe(false);
    // The space-form row alone is a genuine ambiguity and still matches.
    expect(matches("John A. Smith", ["John B A Smith"])).toBe(true);
  });

  it("matches when strong corroboration outweighs an exact conflict", () => {
    // Strong is global: neither the exact "John B." conflict nor the longer
    // ambiguous "A SMITH" alignment erases the exact "John A." agreement.
    expect(
      matches("John A. Smith", ["Smith, John B.", "Smith, John A.", "John B A Smith"])
    ).toBe(true);
  });
});

describe("committeeNameMiddleEvidenceRowNames", () => {
  it("expands year and for-delimited designator text around the person name", () => {
    expect(committeeNameMiddleEvidenceRowNames("Citizens for Jane B Doe for Governor")).toEqual(
      expect.arrayContaining(["Citizens for Jane B Doe for Governor", "Citizens", "Jane B Doe", "Governor"])
    );
    expect(committeeNameMiddleEvidenceRowNames("Jane B Doe 2026")).toContain("Jane B Doe");
    expect(committeeNameMiddleEvidenceRowNames("   ")).toEqual([]);
  });
});

// A parent/child pair shares first, middle and last name by construction, so
// middle evidence is structurally blind to it: middleNameEvidence downgrades
// to "weak" the moment either side omits a middle, and when both carry the
// SAME middle it reports "strong" — actively arguing they are one person. The
// generational suffix is the only discriminator, and every state normalizer
// strips it before the parse ever runs.
describe("generational suffix conflict", () => {
  function conflict(candidateName: string, rowNames: string[]): boolean {
    return hasMiddleNameConflict({ candidateName, rowNames, normalizePersonName });
  }
  function matches(candidateName: string, rowNames: string[]): boolean {
    return personNamesMatchWithMiddleEvidence({ candidateName, rowNames, normalizePersonName });
  }

  it("reads the trailing suffix off the raw name", () => {
    expect(generationalSuffix("Javier Bailey, II")).toBe("II");
    expect(generationalSuffix("Lester L. Wilks Jr.")).toBe("JR");
    expect(generationalSuffix("BAILEY, JAVIER SR")).toBe("SR");
    expect(generationalSuffix("Javier Bailey")).toBeNull();
  });

  it("finds the suffix under trailing parentheticals and in the surname segment", () => {
    // Party markers and call-name aliases trail the suffix in roster names;
    // surname-first files attach it to the surname segment instead.
    expect(generationalSuffix("John Smith Jr. (R)")).toBe("JR");
    expect(generationalSuffix("John Smith Jr. (Johnny Smith)")).toBe("JR");
    expect(generationalSuffix("SMITH JR, JOHN")).toBe("JR");
    expect(conflict("John Smith Sr.", ["SMITH JR, JOHN"])).toBe(true);
    expect(conflict("John Smith Jr. (R)", ["SMITH, JOHN SR"])).toBe(true);
    expect(conflict("John Smith Jr. (Johnny Smith)", ["SMITH, JOHN SR"])).toBe(true);
    // A bare parenthetical numeral is a marker, not a generation, and the
    // surname-segment rule must not read a lone pre-comma token as a suffix.
    expect(generationalSuffix("John Smith (II)")).toBeNull();
    expect(generationalSuffix("JR, JOHN")).toBeNull();
  });

  it("rejects a row naming a different generation", () => {
    expect(conflict("Javier Bailey, II", ["BAILEY, JAVIER SR"])).toBe(true);
    expect(conflict("Jerry Jones, Jr.", ["JONES, JERRY SR"])).toBe(true);
    expect(conflict("John Smith II", ["SMITH, JOHN III"])).toBe(true);
  });

  it("treats a missing suffix as missing information, not a contradiction", () => {
    // State files omit "Jr" constantly; vetoing here would reject real links.
    expect(conflict("Javier Bailey", ["BAILEY, JAVIER II"])).toBe(false);
    expect(conflict("Javier Bailey, II", ["BAILEY, JAVIER"])).toBe(false);
  });

  it("treats JR and II as the same generation", () => {
    // Different conventions for the same person; real filings conflate them.
    expect(conflict("Javier Bailey Jr", ["BAILEY, JAVIER II"])).toBe(false);
  });

  it("does not read a trailing middle initial as a fifth generation", () => {
    // "V" and "I" are excluded from the suffix set for exactly this reason.
    expect(conflict("Smith, John V", ["SMITH, JOHN"])).toBe(false);
    expect(conflict("John V Smith", ["SMITH, JOHN IV"])).toBe(false);
  });

  it("outranks strong middle corroboration", () => {
    // The father/son trap: the shared middle name is precisely what makes
    // middle evidence "strong", so the suffix veto must sit outside it.
    expect(conflict("Javier Michael Bailey II", ["BAILEY, JAVIER MICHAEL SR"])).toBe(true);
    expect(matches("Javier Michael Bailey II", ["BAILEY, JAVIER MICHAEL SR"])).toBe(false);
  });

  it("applies to the recall fallback too", () => {
    expect(matches("Javier Bailey, II", ["BAILEY, JAVIER SR"])).toBe(false);
    expect(matches("Javier Bailey II", ["BAILEY, JAVIER II"])).toBe(true);
  });

  it("survives the comma-before-suffix parse gap", () => {
    // "Javier Bailey, II" is a comma-SUFFIX form, not a comma-SURNAME form,
    // but parsePersonNameCandidates reads the comma as a surname boundary and
    // then finds nothing after it once the normalizer strips "II" — so the
    // name yields no parse variants and middle evidence can never align.
    // Pre-existing, and exactly the display_name shape rosters produce.
    expect(parsePersonNameCandidates("Javier Bailey, II", normalizePersonName)).toEqual([]);
    // The suffix veto is unaffected: it aligns on the suffix-STRIPPED base
    // ("Javier Bailey"), which parses fine once the trailing ", II" is gone.
    expect(conflict("Javier Bailey, II", ["BAILEY, JAVIER SR"])).toBe(true);
  });

  it("requires the suffix-stripped names to align as the same person", () => {
    // IL/DC pass raw committee names, whose trailing roman numerals are
    // seats, not generations. "WARD"-suffixed parses never align with SMITH,
    // so the positional numeral cannot veto the candidate's own committee...
    expect(conflict("John Smith Jr.", ["JOHN SMITH FOR WARD III"])).toBe(false);
    expect(
      conflict("John Smith Jr.", committeeNameMiddleEvidenceRowNames("John Smith for Ward III"))
    ).toBe(false);
    // ...while a genuine generational segment still aligns and rejects.
    expect(
      conflict(
        "John Smith Jr.",
        committeeNameMiddleEvidenceRowNames("Citizens for John Smith III for Governor")
      )
    ).toBe(true);
    // A different person entirely carries no alignment and no veto.
    expect(conflict("John Smith Jr.", ["DOE, JANE III"])).toBe(false);
  });

  it("honors the caller's nickname equivalence during alignment", () => {
    expect(
      hasMiddleNameConflict({
        candidateName: "Mike Smith Jr",
        rowNames: ["SMITH, MICHAEL III"],
        normalizePersonName,
        firstNamesEquivalent: (candidateFirst, rowFirst) =>
          candidateFirst === rowFirst || (candidateFirst === "MIKE" && rowFirst === "MICHAEL"),
      })
    ).toBe(true);
  });
});
