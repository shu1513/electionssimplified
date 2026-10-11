import { describe, expect, it } from "vitest";

import {
  normalizeNewMexicoCandidateNameKeys,
  resolveNewMexicoCandidateCommittee,
} from "../../../src/pipeline/newMexicoFinance/newMexicoCandidateCommitteeResolver.js";
import type { NewMexicoCfisContributionRow } from "../../../src/pipeline/newMexicoFinance/newMexicoCfisArtifactReader.js";

function contribution(overrides: Partial<NewMexicoCfisContributionRow> = {}): NewMexicoCfisContributionRow {
  return {
    OrgID: "1001",
    "Transaction Amount": "250.00",
    "Transaction Date": "01/10/2026",
    "Last Name": "Doe",
    "First Name": "Jane",
    "Middle Name": "",
    Prefix: "",
    Suffix: "",
    "Contributor Address Line 1": "",
    "Contributor Address Line 2": "",
    "Contributor City": "Santa Fe",
    "Contributor State": "NM",
    "Contributor Zip Code": "87501",
    Description: "",
    "Check Number": "",
    "Transaction ID": "T1",
    "Filed Date": "02/01/2026",
    Election: "2026 General",
    "Report Name": "First Report",
    "Start of Period": "01/01/2026",
    "End of Period": "01/31/2026",
    "Contributor Code": "Individual",
    "Contribution Type": "Contributions - Monetary",
    "Report Entity Type": "Candidate",
    "Committee Name": "Doe, Jane for Governor",
    "Candidate Last Name": "Doe",
    "Candidate First Name": "Jane",
    "Candidate Middle Name": "",
    "Candidate Prefix": "",
    "Candidate Suffix": "",
    Amended: "",
    "Contributor Employer": "Acme",
    "Contributor Occupation": "Engineer",
    "Occupation Comment": "",
    "Employment Information Requested": "",
    ...overrides,
  };
}

describe("newMexicoCandidateCommitteeResolver", () => {
  it("normalizes direct and comma-form candidate names without fuzzy matching", () => {
    expect([...normalizeNewMexicoCandidateNameKeys("DOE, Jane Q.")]).toEqual([
      "DOE JANE Q",
      "JANE Q DOE",
      "JANE DOE",
    ]);
    expect([...normalizeNewMexicoCandidateNameKeys("Jane Q. Doe")]).toContain("JANE DOE");
  });

  it("matches exactly one New Mexico candidate committee by candidate and cycle", () => {
    expect(
      resolveNewMexicoCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        sourceUrl: "https://login.cfis.sos.state.nm.us/",
        contributionRows: [
          contribution({ "Candidate Last Name": "Doe", "Candidate First Name": "Jane" }),
          contribution({ OrgID: "999", "Candidate Last Name": "Other", "Candidate First Name": "Person" }),
          contribution({ OrgID: "888", "Report Entity Type": "PAC - Independent Expenditure" }),
          contribution({ OrgID: "777", "Transaction Date": "01/10/2024" }),
        ],
      })
    ).toEqual({
      status: "matched",
      committeeId: "1001",
      committeeName: "Doe, Jane for Governor",
      confidence: "exact",
      source: "cfis_bulk",
      sourceUrl: "https://login.cfis.sos.state.nm.us/",
      matchedContributionRowCount: 1,
    });
  });

  it("matches CFIS's formal first name through a VoteApp nickname", () => {
    // Live: "SAM KANE FOR NM ATTORNEY GENERAL" rows carry Candidate First
    // Name "SAMUEL"; Gregg Hull files as "Greggory".
    expect(
      resolveNewMexicoCandidateCommittee({
        candidateName: "Sam Kane",
        officeScope: "statewide",
        officeName: "Attorney General",
        electionYear: 2026,
        contributionRows: [
          contribution({
            OrgID: "1035447",
            "Committee Name": "SAM KANE FOR NM ATTORNEY GENERAL",
            "Candidate Last Name": "KANE",
            "Candidate First Name": "SAMUEL",
            "Candidate Middle Name": "ISAIAH",
          }),
        ],
      })
    ).toMatchObject({ status: "matched", committeeId: "1035447" });
    expect(
      resolveNewMexicoCandidateCommittee({
        candidateName: "Gregg Hull",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        contributionRows: [
          contribution({ OrgID: "564296", "Candidate Last Name": "Hull", "Candidate First Name": "Greggory" }),
        ],
      })
    ).toMatchObject({ status: "matched", committeeId: "564296" });
    expect([...normalizeNewMexicoCandidateNameKeys("Sam Kane")]).toEqual(["SAM KANE"]);
    expect([...normalizeNewMexicoCandidateNameKeys("Sam Kane", { expandNicknames: true })]).toContain("SAMUEL KANE");
  });

  it("accepts safe New Mexico canonical and source-like office names", () => {
    expect(
      resolveNewMexicoCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "statewide",
        officeName: "Commissioner of Public Lands",
        electionYear: 2026,
        contributionRows: [contribution()],
      })
    ).toMatchObject({
      status: "matched",
      committeeId: "1001",
      committeeName: "Doe, Jane for Governor",
    });
  });

  it("requires districts for legislative offices because CFIS contribution rows do not prove district", () => {
    expect(
      resolveNewMexicoCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "state_lower",
        officeName: "State Representative",
        electionYear: 2026,
        contributionRows: [contribution()],
      })
    ).toEqual({
      status: "unmatched",
      reason: "missing_legislative_district",
      candidateNameNormalized: "JANE DOE",
      officeNameNormalized: "State Lower Chamber Legislator",
    });
  });

  it("does not guess when multiple candidate committees match", () => {
    expect(
      resolveNewMexicoCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        contributionRows: [
          contribution(),
          contribution({
            OrgID: "1002",
            "Committee Name": "Friends of Jane Doe",
          }),
        ],
      })
    ).toEqual({
      status: "ambiguous",
      reason: "multiple_matching_committees",
      candidateNameNormalized: "JANE DOE",
      officeNameNormalized: "Governor",
      matches: [
        {
          committeeId: "1001",
          committeeName: "Doe, Jane for Governor",
          confidence: "exact",
          source: "cfis_bulk",
          sourceUrl: null,
          matchedContributionRowCount: 1,
        },
        {
          committeeId: "1002",
          committeeName: "Friends of Jane Doe",
          confidence: "exact",
          source: "cfis_bulk",
          sourceUrl: null,
          matchedContributionRowCount: 1,
        },
      ],
    });
  });

  it("returns unmatched for unsupported offices or missing names", () => {
    expect(
      resolveNewMexicoCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "statewide",
        officeName: "Public Service Commissioner",
        electionYear: 2026,
        contributionRows: [contribution()],
      })
    ).toEqual({
      status: "unmatched",
      reason: "unsupported_office",
      candidateNameNormalized: "JANE DOE",
      officeNameNormalized: "PUBLIC SERVICE COMMISSIONER",
    });

    expect(
      resolveNewMexicoCandidateCommittee({
        candidateName: "   ",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        contributionRows: [contribution()],
      })
    ).toEqual({
      status: "unmatched",
      reason: "missing_candidate_name",
      candidateNameNormalized: "",
      officeNameNormalized: "Governor",
    });
  });

  it("returns unmatched when candidate, entity type, or cycle does not match", () => {
    expect(
      resolveNewMexicoCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        contributionRows: [contribution({ "Candidate First Name": "Janet" })],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });

    expect(
      resolveNewMexicoCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        contributionRows: [contribution({ "Report Entity Type": "PAC - Independent Expenditure" })],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });

    expect(
      resolveNewMexicoCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        contributionRows: [contribution({ "Transaction Date": "01/10/2024" })],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });
  });

  it("does not fuzzy-match candidate typos", () => {
    expect(
      resolveNewMexicoCandidateCommittee({
        candidateName: "Jane Doee",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        contributionRows: [contribution()],
      })
    ).toEqual({
      status: "unmatched",
      reason: "no_candidate_committee_match",
      candidateNameNormalized: "JANE DOEE",
      officeNameNormalized: "Governor",
    });
  });

  it("rejects a same-race row whose middle name contradicts the candidate", () => {
    // Same office and cycle — only the middle evidence differs. Without the
    // middle gate this row linked as an "exact" match and attached the other
    // Jane Doe's committee.
    expect(
      resolveNewMexicoCandidateCommittee({
        candidateName: "Jane A. Doe",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        contributionRows: [contribution({ "Candidate Middle Name": "B" })],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });
  });

  it("accepts an initial that corroborates the full middle name", () => {
    expect(
      resolveNewMexicoCandidateCommittee({
        candidateName: "Jane A. Doe",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        contributionRows: [contribution({ "Candidate Middle Name": "Ann" })],
      })
    ).toMatchObject({ status: "matched", committeeId: "1001" });
  });

  it("still falls back to first+last when a side lacks middle info", () => {
    expect(
      resolveNewMexicoCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        contributionRows: [contribution({ "Candidate Middle Name": "B" })],
      })
    ).toMatchObject({ status: "matched", committeeId: "1001" });
  });

  it("reads a bare trailing V as a middle initial, not a generational suffix", () => {
    // GENERATIONAL_SUFFIX_RANK deliberately excludes "V": a trailing "V" is far
    // more often a middle initial than a fifth generation, so it has to survive
    // normalization as middle evidence on EITHER side of the comparison.
    const resolve = (candidateName: string, rowMiddleName: string) =>
      resolveNewMexicoCandidateCommittee({
        candidateName,
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        contributionRows: [contribution({ "Candidate Middle Name": rowMiddleName })],
      });

    expect(resolve("Jane V. Doe", "B")).toMatchObject({
      status: "unmatched",
      reason: "no_candidate_committee_match",
    });
    expect(resolve("Jane B. Doe", "V")).toMatchObject({
      status: "unmatched",
      reason: "no_candidate_committee_match",
    });
    expect(resolve("Jane V. Doe", "V")).toMatchObject({ status: "matched", committeeId: "1001" });
    expect(resolve("Jane Doe", "V")).toMatchObject({ status: "matched", committeeId: "1001" });
  });

  it("rejects invalid election years", () => {
    expect(() =>
      resolveNewMexicoCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2019,
        contributionRows: [],
      })
    ).toThrow("Invalid New Mexico candidate committee election year");
  });
});
