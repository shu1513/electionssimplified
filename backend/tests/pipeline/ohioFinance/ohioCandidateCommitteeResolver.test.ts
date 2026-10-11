import { describe, expect, it } from "vitest";

import {
  normalizeOhioCandidateNameKeys,
  ohioPersonNamesMatch,
  resolveOhioCandidateCommittee,
} from "../../../src/pipeline/ohioFinance/ohioCandidateCommitteeResolver.js";
import type { OhioSosCandidateCommitteeListRow } from "../../../src/pipeline/ohioFinance/ohioSosBulkFiles.js";

function listRow(overrides: Partial<OhioSosCandidateCommitteeListRow> = {}): OhioSosCandidateCommitteeListRow {
  return {
    committeeName: "FRIENDS OF JANE DOE",
    masterKey: "12345",
    candidateFirstName: "JANE",
    candidateLastName: "DOE",
    office: "GOVERNOR",
    district: "0",
    party: "DEMOCRAT",
    ...overrides,
  };
}

describe("normalizeOhioCandidateNameKeys", () => {
  it("normalizes direct, comma-form, and parenthetical names without fuzzy matching", () => {
    expect([...normalizeOhioCandidateNameKeys("DOE, Jane L.")]).toEqual([
      "DOE JANE L",
      "JANE L DOE",
      "JANE DOE",
    ]);
    expect([...normalizeOhioCandidateNameKeys("William (Bill) Holtzinger")]).toContain("BILL HOLTZINGER");
    expect([...normalizeOhioCandidateNameKeys("Jane Doe Jr.")]).toContain("JANE DOE");
  });
});

describe("resolveOhioCandidateCommittee", () => {
  it("matches exactly one statewide committee by candidate name and office token", () => {
    expect(
      resolveOhioCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        district: null,
        sourceUrl: "https://www6.ohiosos.gov/ords/f?p=CFDISCLOSURE:73",
        candidateListRows: [
          listRow(),
          listRow({ masterKey: "222", committeeName: "OTHER PERSON COMMITTEE", candidateFirstName: "OTHER", candidateLastName: "PERSON" }),
          listRow({ masterKey: "333", office: "ATTORNEY GENERAL", committeeName: "DOE FOR AG" }),
        ],
      })
    ).toEqual({
      status: "matched",
      committeeId: "12345",
      committeeName: "FRIENDS OF JANE DOE",
      confidence: "exact",
      source: "sos_bulk_export",
      sourceUrl: "https://www6.ohiosos.gov/ords/f?p=CFDISCLOSURE:73",
      matchedCommitteeRowCount: 1,
    });
  });

  it("maps every eligible office onto the list's observed OFFICE vocabulary", () => {
    const cases: Array<{ officeScope: string; officeName: string; office: string; district?: string }> = [
      { officeScope: "statewide", officeName: "Governor", office: "GOVERNOR" },
      { officeScope: "statewide", officeName: "Attorney General", office: "ATTORNEY GENERAL" },
      { officeScope: "statewide", officeName: "Secretary of State", office: "SECRETARY OF STATE" },
      { officeScope: "statewide", officeName: "State Auditor", office: "AUDITOR" },
      { officeScope: "statewide", officeName: "State Treasurer", office: "TREASURER" },
      { officeScope: "state_upper", officeName: "State Senator", office: "SENATE", district: "27" },
      { officeScope: "state_lower", officeName: "State Lower Chamber Legislator", office: "HOUSE", district: "87" },
    ];
    for (const testCase of cases) {
      expect(
        resolveOhioCandidateCommittee({
          candidateName: "Jane Doe",
          officeScope: testCase.officeScope,
          officeName: testCase.officeName,
          electionYear: 2026,
          district: testCase.district ?? null,
          candidateListRows: [listRow({ office: testCase.office, district: testCase.district ?? "0" })],
        })
      ).toMatchObject({ status: "matched", committeeId: "12345" });
    }
  });

  it("requires and verifies the district for General Assembly seats", () => {
    const rows = [listRow({ office: "HOUSE", district: "87" })];

    expect(
      resolveOhioCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "state_lower",
        officeName: "State Lower Chamber Legislator",
        electionYear: 2026,
        district: null,
        candidateListRows: rows,
      })
    ).toMatchObject({ status: "unmatched", reason: "missing_legislative_district" });

    expect(
      resolveOhioCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "state_lower",
        officeName: "State Lower Chamber Legislator",
        electionYear: 2026,
        district: "88",
        candidateListRows: rows,
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });

    // Leading zeros normalize away on either side.
    expect(
      resolveOhioCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "state_lower",
        officeName: "State Lower Chamber Legislator",
        electionYear: 2026,
        district: "087",
        candidateListRows: rows,
      })
    ).toMatchObject({ status: "matched", committeeId: "12345" });
  });

  it("matches the list's formal first name through a VoteApp nickname", () => {
    // Live: "MATT HUFFMAN FOR OHIO" lists the candidate as MATTHEW HUFFMAN,
    // and "FRIENDS OF BILL DEMORA" lists BILL where VoteApp has William.
    expect(
      resolveOhioCandidateCommittee({
        candidateName: "Matt Huffman",
        officeScope: "state_lower",
        officeName: "State Lower Chamber Legislator",
        electionYear: 2026,
        district: "78",
        candidateListRows: [
          listRow({
            committeeName: "MATT HUFFMAN FOR OHIO",
            masterKey: "10592",
            candidateFirstName: "MATTHEW",
            candidateLastName: "HUFFMAN",
            office: "HOUSE",
            district: "78",
          }),
        ],
      })
    ).toMatchObject({ status: "matched", committeeId: "10592" });
    expect(
      resolveOhioCandidateCommittee({
        candidateName: "William DeMora",
        officeScope: "state_upper",
        officeName: "State Senator",
        electionYear: 2026,
        district: "25",
        candidateListRows: [
          listRow({
            committeeName: "FRIENDS OF BILL DEMORA",
            masterKey: "15716",
            candidateFirstName: "BILL",
            candidateLastName: "DEMORA",
            office: "SENATE",
            district: "25",
          }),
        ],
      })
    ).toMatchObject({ status: "matched", committeeId: "15716" });
    expect([...normalizeOhioCandidateNameKeys("Matt Huffman")]).toEqual(["MATT HUFFMAN"]);
  });

  it("ignores the junk district values statewide list rows carry", () => {
    expect(
      resolveOhioCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "statewide",
        officeName: "State Treasurer",
        electionYear: 2026,
        district: null,
        candidateListRows: [listRow({ office: "TREASURER", district: "100" })],
      })
    ).toMatchObject({ status: "matched", committeeId: "12345" });
  });

  it("rejects offices outside the eligible set, including judicial and board rows", () => {
    for (const officeName of ["Supreme Court Justice", "State Level Judge", "Lieutenant Governor"]) {
      expect(
        resolveOhioCandidateCommittee({
          candidateName: "Jane Doe",
          officeScope: "statewide",
          officeName,
          electionYear: 2026,
          district: null,
          candidateListRows: [listRow({ office: "SUPREME COURT JUSTICE" })],
        })
      ).toMatchObject({ status: "unmatched", reason: "unsupported_office" });
    }
  });

  it("skips rows with a non-numeric MASTER_KEY or a blank candidate name", () => {
    expect(
      resolveOhioCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        district: null,
        candidateListRows: [
          listRow({ masterKey: "12345X" }),
          listRow({ masterKey: "678", candidateFirstName: null, candidateLastName: null }),
        ],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });
  });

  it("reports ambiguity when two committees match instead of picking one", () => {
    const resolution = resolveOhioCandidateCommittee({
      candidateName: "Jane Doe",
      officeScope: "statewide",
      officeName: "Governor",
      electionYear: 2026,
      district: null,
      candidateListRows: [
        listRow(),
        listRow({ masterKey: "67890", committeeName: "JANE DOE FOR OHIO" }),
      ],
    });
    expect(resolution).toMatchObject({ status: "ambiguous", reason: "multiple_matching_committees" });
    if (resolution.status === "ambiguous") {
      expect(resolution.matches.map((match) => match.committeeId)).toEqual(["12345", "67890"]);
    }
  });

  it("collapses duplicate list rows for the same committee into one match", () => {
    expect(
      resolveOhioCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        district: null,
        candidateListRows: [listRow(), listRow()],
      })
    ).toMatchObject({ status: "matched", committeeId: "12345", matchedCommitteeRowCount: 2 });
  });

  it("matches comma-form and nickname name variants from either side", () => {
    expect(
      resolveOhioCandidateCommittee({
        candidateName: "Doe, Jane",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        district: null,
        candidateListRows: [listRow({ candidateFirstName: "JANE MARIE", candidateLastName: "DOE" })],
      })
    ).toMatchObject({ status: "matched", committeeId: "12345" });
  });

  it("rejects a shortened-name match when both sides state conflicting middle names", () => {
    expect(
      resolveOhioCandidateCommittee({
        candidateName: "Jane Ann Doe",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        district: null,
        candidateListRows: [listRow({ candidateFirstName: "JANE MARIE", candidateLastName: "DOE" })],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });
  });

  it("treats a middle initial as compatible with the full middle name", () => {
    expect(
      resolveOhioCandidateCommittee({
        candidateName: "Jane A. Doe",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        district: null,
        candidateListRows: [listRow({ candidateFirstName: "JANE ANN", candidateLastName: "DOE" })],
      })
    ).toMatchObject({ status: "matched", committeeId: "12345" });
  });

  it("treats a bare V as a middle initial, not a generational suffix", () => {
    // Bare "V" is a middle initial, not a suffix (the shared
    // GENERATIONAL_SUFFIX_RANK policy deliberately excludes it), so it must
    // stay as middle evidence on either side instead of being stripped. The
    // list rows above are assembled first+last, so the trailing form only
    // reaches the parser through ohioPersonNamesMatch (31-U target names and
    // comma-form VoteApp display names).
    expect(ohioPersonNamesMatch("Smith, John B.", "John V. Smith")).toBe(false);
    expect(ohioPersonNamesMatch("Smith, John V", "John B. Smith")).toBe(false);
    expect(ohioPersonNamesMatch("Smith, John V", "John V. Smith")).toBe(true);
    expect(ohioPersonNamesMatch("Smith, John V", "John Smith")).toBe(true);
    expect(ohioPersonNamesMatch("John Smith Jr.", "Smith Sr., John")).toBe(false);
  });

  it("detects a suffix conflict when the suffix arrives in comma form", () => {
    const senior = [listRow({ candidateFirstName: "JOHN", candidateLastName: "SMITH SR" })];
    for (const candidateName of ["Smith, John Jr.", "Smith Jr., John"]) {
      expect(
        resolveOhioCandidateCommittee({
          candidateName,
          officeScope: "statewide",
          officeName: "Governor",
          electionYear: 2026,
          district: null,
          candidateListRows: senior,
        })
      ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });
    }

    // Comma-form suffix against a row without one stays permissive.
    expect(
      resolveOhioCandidateCommittee({
        candidateName: "Smith, John Jr.",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        district: null,
        candidateListRows: [listRow({ candidateFirstName: "JOHN", candidateLastName: "SMITH" })],
      })
    ).toMatchObject({ status: "matched", committeeId: "12345" });
  });

  it("rejects a match when both sides state conflicting suffixes, but not when one lacks a suffix", () => {
    const senior = [listRow({ candidateFirstName: "JOHN", candidateLastName: "SMITH SR" })];
    expect(
      resolveOhioCandidateCommittee({
        candidateName: "John Smith Jr.",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        district: null,
        candidateListRows: senior,
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });

    expect(
      resolveOhioCandidateCommittee({
        candidateName: "John Smith Jr.",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        district: null,
        candidateListRows: [listRow({ candidateFirstName: "JOHN", candidateLastName: "SMITH" })],
      })
    ).toMatchObject({ status: "matched", committeeId: "12345" });
  });

  it("rejects a blank candidate name and an implausible election year", () => {
    expect(
      resolveOhioCandidateCommittee({
        candidateName: "  ",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        district: null,
        candidateListRows: [listRow()],
      })
    ).toMatchObject({ status: "unmatched", reason: "missing_candidate_name" });

    expect(() =>
      resolveOhioCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 1990,
        district: null,
        candidateListRows: [listRow()],
      })
    ).toThrow(/Invalid Ohio candidate committee election year/);
  });
});
