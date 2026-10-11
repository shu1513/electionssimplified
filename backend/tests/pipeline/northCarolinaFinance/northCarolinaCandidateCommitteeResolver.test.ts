import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  normalizeNorthCarolinaCandidateNameForStorage,
  normalizeNorthCarolinaCandidateNameKeys,
  northCarolinaPersonNamesMatch,
  resolveNorthCarolinaCandidateCommittee,
} from "../../../src/pipeline/northCarolinaFinance/northCarolinaCandidateCommitteeResolver.js";
import {
  parseNcsbeCommitteeSearchPage,
  type NcsbeCommitteeSearchRow,
} from "../../../src/pipeline/northCarolinaFinance/northCarolinaNcsbeParsers.js";

const SOURCE_URL = "https://cf.ncsbe.gov/CFOrgLkup/CommitteeGeneralResult/?name=pierce";

function fixtureRows(name: string): NcsbeCommitteeSearchRow[] {
  return parseNcsbeCommitteeSearchPage(
    readFileSync(
      fileURLToPath(new URL(`../../fixtures/northCarolinaFinance/${name}`, import.meta.url)),
      "utf8"
    )
  );
}

function searchRow(overrides: Partial<NcsbeCommitteeSearchRow> = {}): NcsbeCommitteeSearchRow {
  return {
    orgName: "COMMITTEE TO ELECT JANE DOE",
    sboeId: "STA-AB12CD-C-001",
    oldId: null,
    candName: "JANE DOE",
    statusDesc: "ACTIVE (NON-EXEMPT)",
    orgGroupId: 12345,
    ...overrides,
  };
}

const BASE_INPUT = {
  officeScope: "state_lower",
  officeName: "State Lower Chamber Legislator",
  electionYear: 2026,
  district: "27",
  sourceUrl: SOURCE_URL,
};

describe("resolveNorthCarolinaCandidateCommittee", () => {
  it("matches the formal CandName through a VoteApp nickname, literal first", () => {
    // Live: VoteApp "Tim Longest", NCSBE CandName "TIMOTHY WORTH LONGEST JR".
    const timothy = searchRow({
      orgName: "TIM LONGEST FOR NORTH CAROLINA (LONGEST, TIMOTHY WORTH, JR.)",
      sboeId: "STA-P80279-C-001",
      candName: "TIMOTHY WORTH LONGEST JR",
      orgGroupId: 49685,
    });
    expect(
      resolveNorthCarolinaCandidateCommittee({ ...BASE_INPUT, candidateName: "Tim Longest", searchRows: [timothy] })
    ).toMatchObject({ status: "matched", committeeId: "STA-P80279-C-001" });
    // A literal "Tim" committee wins over the nickname one instead of
    // turning ambiguous.
    const tim = searchRow({ sboeId: "STA-AAAAAA-C-001", candName: "TIM LONGEST", orgGroupId: 1 });
    expect(
      resolveNorthCarolinaCandidateCommittee({
        ...BASE_INPUT,
        candidateName: "Tim Longest",
        searchRows: [timothy, tim],
      })
    ).toMatchObject({ status: "matched", committeeId: "STA-AAAAAA-C-001" });
    expect([...normalizeNorthCarolinaCandidateNameKeys("Tim Longest")]).not.toContain("TIMOTHY LONGEST");
  });

  it("reads a comma before a bare suffix as part of a first-last name", () => {
    // Live: VoteApp "Kenneth W. Bentley, Jr.", CandName "KENNETH WALTER BENTLEY JR".
    expect(
      resolveNorthCarolinaCandidateCommittee({
        ...BASE_INPUT,
        candidateName: "Kenneth W. Bentley, Jr.",
        searchRows: [searchRow({ candName: "KENNETH WALTER BENTLEY JR" })],
      })
    ).toMatchObject({ status: "matched" });
  });

  it("resolves Gadson from the real committee-search fixture", () => {
    const resolution = resolveNorthCarolinaCandidateCommittee({
      ...BASE_INPUT,
      candidateName: "Marcus Gadson",
      searchRows: fixtureRows("committee-search-gadson.html"),
    });
    expect(resolution).toEqual({
      status: "matched",
      committeeId: "STA-JV516O-C-001",
      committeeName: "GADSON FOR NORTH CAROLINA (GADSON, MARCUS)",
      orgGroupId: 57190,
      confidence: "exact",
      source: "ncsbe_portal",
      sourceUrl: SOURCE_URL,
      matchedCommitteeRowCount: 1,
    });
  });

  it("resolves Rodney Pierce uniquely from the 21-row pierce fixture", () => {
    // The fixture holds six ACTIVE (NON-EXEMPT) committees named Pierce
    // (mostly county-prefixed) plus a legal-expense fund; only the STA
    // candidate committee with a matching CandName survives.
    const resolution = resolveNorthCarolinaCandidateCommittee({
      ...BASE_INPUT,
      candidateName: "Rodney Pierce",
      searchRows: fixtureRows("committee-search-pierce.html"),
    });
    expect(resolution).toMatchObject({
      status: "matched",
      committeeId: "STA-I5073S-C-001",
      committeeName: "COMMITTEE TO ELECT RODNEY D. PIERCE (PIERCE, RODNEY DONTE)",
      orgGroupId: 52812,
    });
  });

  it("never links a county-filed committee — an active county sheriff of the same name stays unmatched", () => {
    // "ELECT JIMMY PIERCE SHERIFF" (DAR-376LF0-C-001) is ACTIVE (NON-EXEMPT)
    // in the fixture; the STA gate is what stands between it and a mislink.
    const resolution = resolveNorthCarolinaCandidateCommittee({
      ...BASE_INPUT,
      candidateName: "Jimmy Pierce",
      searchRows: fixtureRows("committee-search-pierce.html"),
    });
    expect(resolution).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });
  });

  it("excludes closed and inactive committees", () => {
    // Pierce Freelon has two committees in the fixture (CLOSED + INACTIVE).
    const resolution = resolveNorthCarolinaCandidateCommittee({
      ...BASE_INPUT,
      candidateName: "Pierce Freelon",
      searchRows: fixtureRows("committee-search-pierce.html"),
    });
    expect(resolution).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });
  });

  it("excludes legal-expense funds and rows without a candidate name", () => {
    const resolution = resolveNorthCarolinaCandidateCommittee({
      ...BASE_INPUT,
      candidateName: "Ronald Pierce",
      searchRows: fixtureRows("committee-search-pierce.html"),
    });
    // His legal fund (STA-0S1QL6-F-001, CandName &nbsp;) and INACTIVE
    // campaign committee both fall out.
    expect(resolution).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });
  });

  it("does not match a middle name against a last name", () => {
    // "BRADLEY PIERCE POTTS" (ACTIVE, ROW-…; also STA-gated) must never
    // satisfy a search for Bradley Pierce.
    const resolution = resolveNorthCarolinaCandidateCommittee({
      ...BASE_INPUT,
      candidateName: "Bradley Pierce",
      searchRows: [
        searchRow({
          orgName: "POTTS FOR SHERIFF (POTTS, BRADLEY (ROWAN))",
          sboeId: "STA-8I1Y91-C-001",
          candName: "BRADLEY PIERCE POTTS",
        }),
      ],
    });
    expect(resolution).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });
  });

  it("quarantines multiple plausible matches as ambiguous", () => {
    const resolution = resolveNorthCarolinaCandidateCommittee({
      ...BASE_INPUT,
      candidateName: "Jane Doe",
      searchRows: [
        searchRow(),
        searchRow({ orgName: "JANE DOE FOR NC", sboeId: "STA-ZZ99XX-C-001", orgGroupId: 54321 }),
      ],
    });
    expect(resolution).toMatchObject({
      status: "ambiguous",
      reason: "multiple_matching_committees",
    });
    if (resolution.status === "ambiguous") {
      expect(resolution.matches.map((match) => match.committeeId)).toEqual([
        "STA-AB12CD-C-001",
        "STA-ZZ99XX-C-001",
      ]);
    }
  });

  it("rejects a middle-name conflict on the shortened key", () => {
    const resolution = resolveNorthCarolinaCandidateCommittee({
      ...BASE_INPUT,
      candidateName: "Rodney Blake Pierce",
      searchRows: [searchRow({ candName: "RODNEY DONTE PIERCE" })],
    });
    expect(resolution).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });
  });

  it("skips rows with junk OrgGroupIDs and fails loudly on conflicting ones", () => {
    expect(
      resolveNorthCarolinaCandidateCommittee({
        ...BASE_INPUT,
        candidateName: "Jane Doe",
        searchRows: [searchRow({ orgGroupId: 0 })],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });

    expect(() =>
      resolveNorthCarolinaCandidateCommittee({
        ...BASE_INPUT,
        candidateName: "Jane Doe",
        searchRows: [searchRow(), searchRow({ orgGroupId: 99999 })],
      })
    ).toThrow(/conflicting OrgGroupIDs/);
  });

  it("returns unsupported_office for offices outside the eligible set", () => {
    const resolution = resolveNorthCarolinaCandidateCommittee({
      ...BASE_INPUT,
      officeScope: "statewide",
      officeName: "Governor",
      candidateName: "Jane Doe",
      searchRows: [searchRow()],
    });
    expect(resolution).toMatchObject({ status: "unmatched", reason: "unsupported_office" });
  });

  it("returns missing_candidate_name for blank names and validates the election year", () => {
    expect(
      resolveNorthCarolinaCandidateCommittee({
        ...BASE_INPUT,
        candidateName: "   ",
        searchRows: [searchRow()],
      })
    ).toMatchObject({ status: "unmatched", reason: "missing_candidate_name" });

    expect(() =>
      resolveNorthCarolinaCandidateCommittee({
        ...BASE_INPUT,
        electionYear: 1990,
        candidateName: "Jane Doe",
        searchRows: [],
      })
    ).toThrow(/Invalid North Carolina candidate committee election year/);
  });
});

describe("northCarolinaPersonNamesMatch", () => {
  it("treats the portal's bare-digit suffix as its roman numeral", () => {
    // Real fixture row: OrgName "(PIERCE, SIDNEY RALPH III)" with CandName
    // "SIDNEY RALPH PIERCE 3".
    expect(northCarolinaPersonNamesMatch("Sidney Ralph Pierce III", "SIDNEY RALPH PIERCE 3")).toBe(true);
    expect(northCarolinaPersonNamesMatch("Sidney Ralph Pierce Jr", "SIDNEY RALPH PIERCE 3")).toBe(false);
  });

  it("matches parenthetical nicknames and comma-flipped forms", () => {
    expect(northCarolinaPersonNamesMatch("Jimmy Hill", "JAMES PIERCE HILL JR (JIMMY)")).toBe(true);
    expect(northCarolinaPersonNamesMatch("James Hill", "HILL, JAMES P (JIMMY)")).toBe(true);
  });

  it("matches hyphenated given names through a missing middle token", () => {
    expect(northCarolinaPersonNamesMatch("Jeremiah-Frank Pierce", "JEREMIAH-FRANK LEE PIERCE")).toBe(true);
  });

  it("rejects explicit middle-name conflicts but accepts compatible initials", () => {
    expect(northCarolinaPersonNamesMatch("Garland E. Pierce", "GARLAND EDWARD PIERCE")).toBe(true);
    expect(northCarolinaPersonNamesMatch("Garland O. Pierce", "GARLAND EDWARD PIERCE")).toBe(false);
  });

  it("treats a bare trailing V as a middle initial, not a generational suffix", () => {
    // Bare "V" is a middle initial, not a suffix (GENERATIONAL_SUFFIX_RANK in
    // finance/personNameMiddleEvidence.ts): only the portal digit "5" is a
    // fifth-generation marker, so "V" stays as middle evidence on either side.
    expect(northCarolinaPersonNamesMatch("John B. Smith", "SMITH, JOHN V")).toBe(false);
    expect(northCarolinaPersonNamesMatch("John V. Smith", "SMITH, JOHN B")).toBe(false);
    expect(northCarolinaPersonNamesMatch("John V. Smith", "SMITH, JOHN V")).toBe(true);
    expect(northCarolinaPersonNamesMatch("John Smith", "SMITH, JOHN V")).toBe(true);
    expect(northCarolinaPersonNamesMatch("John Smith Jr", "JOHN SMITH 5")).toBe(false);
  });
});

describe("normalizeNorthCarolinaCandidateNameForStorage", () => {
  it("strips suffixes, punctuation, and case", () => {
    expect(normalizeNorthCarolinaCandidateNameForStorage("Sidney Ralph Pierce III")).toBe(
      "SIDNEY RALPH PIERCE"
    );
    expect(normalizeNorthCarolinaCandidateNameForStorage("Garland E. Pierce")).toBe("GARLAND E PIERCE");
  });

  it("does not mint a garbage FIRST LAST key from a digit suffix", () => {
    // Without digit-suffix stripping, "SIDNEY 3" would become a key.
    expect(normalizeNorthCarolinaCandidateNameKeys("SIDNEY RALPH PIERCE 3")).toEqual(
      new Set(["SIDNEY RALPH PIERCE", "SIDNEY PIERCE"])
    );
  });
});
