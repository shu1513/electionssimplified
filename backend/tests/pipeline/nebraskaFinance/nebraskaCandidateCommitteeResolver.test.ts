import { describe, expect, it } from "vitest";

import {
  normalizeNebraskaCandidateNameKeys,
  resolveNebraskaCandidateCommittee,
} from "../../../src/pipeline/nebraskaFinance/nebraskaCandidateCommitteeResolver.js";
import type { NebraskaNadcContributionRow } from "../../../src/pipeline/nebraskaFinance/nebraskaNadcArtifactReader.js";

function contribution(overrides: Partial<NebraskaNadcContributionRow> = {}): NebraskaNadcContributionRow {
  return {
    "Receipt ID": "110654",
    "Org ID": "1001",
    "Filer Type": "Candidate Committee",
    "Filer Name": "VOTE VEST",
    "Candidate Name": "RICK VEST",
    "Receipt Transaction/Contribution Type": "Contribution",
    "Other Funds Type": "",
    "Receipt Date": "01/10/2026",
    "Receipt Amount": "250.00",
    Description: "",
    "Contributor or Transaction Source Type": "Individual",
    "Contributor or Source Name (Individual Last Name)": "Doe",
    "First Name": "Jane",
    "Middle Name": "",
    Suffix: "",
    "Address 1": "",
    "Address 2": "",
    City: "Lincoln",
    State: "NE",
    Zip: "68508",
    "Filed Date": "02/01/2026",
    Amended: "",
    Employer: "Acme",
    Occupation: "Engineer",
    ...overrides,
  };
}

describe("nebraskaCandidateCommitteeResolver", () => {
  it("normalizes direct and comma-form candidate names without fuzzy matching", () => {
    expect([...normalizeNebraskaCandidateNameKeys("VEST, Rick J.")]).toEqual([
      "VEST RICK J",
      "RICK J VEST",
      "RICK VEST",
    ]);
    expect([...normalizeNebraskaCandidateNameKeys("Rick J. Vest")]).toContain("RICK VEST");
  });

  it("matches exactly one Nebraska candidate committee by candidate and cycle", () => {
    expect(
      resolveNebraskaCandidateCommittee({
        candidateName: "Rick Vest",
        officeScope: "state_upper",
        officeName: "State Senator",
        district: "30",
        electionYear: 2026,
        sourceUrl: "https://nadc-e.nebraska.gov/PublicSite/DataDownload.aspx",
        contributionRows: [
          contribution({ "Candidate Name": "VEST, RICK" }),
          contribution({ "Org ID": "999", "Candidate Name": "Other Person" }),
          contribution({ "Org ID": "888", "Candidate Name": "Rick Vest", "Filer Type": "PAC-Independent" }),
          contribution({ "Org ID": "777", "Candidate Name": "Rick Vest", "Receipt Date": "01/10/2024" }),
        ],
      })
    ).toEqual({
      status: "matched",
      committeeId: "1001",
      committeeName: "VOTE VEST",
      confidence: "exact",
      source: "nadc_bulk",
      sourceUrl: "https://nadc-e.nebraska.gov/PublicSite/DataDownload.aspx",
      matchedContributionRowCount: 1,
    });
  });

  it("rejects a same-race row whose middle name contradicts the candidate", () => {
    // Same office, district, and cycle — only the middle evidence differs.
    // Without the middle gate this row linked as an "exact" match and attached
    // the other Vest's committee.
    expect(
      resolveNebraskaCandidateCommittee({
        candidateName: "Rick A. Vest",
        officeScope: "state_upper",
        officeName: "State Senator",
        district: "30",
        electionYear: 2026,
        contributionRows: [contribution({ "Candidate Name": "VEST, RICK J." })],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });
  });

  it("accepts an initial that corroborates the full middle name", () => {
    expect(
      resolveNebraskaCandidateCommittee({
        candidateName: "Rick A. Vest",
        officeScope: "state_upper",
        officeName: "State Senator",
        district: "30",
        electionYear: 2026,
        contributionRows: [contribution({ "Candidate Name": "VEST, RICK ALLEN" })],
      })
    ).toMatchObject({ status: "matched", committeeId: "1001" });
  });

  it("still falls back to first+last when a side lacks middle info", () => {
    expect(
      resolveNebraskaCandidateCommittee({
        candidateName: "Rick Vest",
        officeScope: "state_upper",
        officeName: "State Senator",
        district: "30",
        electionYear: 2026,
        contributionRows: [contribution({ "Candidate Name": "VEST, RICK J." })],
      })
    ).toMatchObject({ status: "matched", committeeId: "1001" });
  });

  it("reads a bare trailing V as a middle initial, not a generational suffix", () => {
    // GENERATIONAL_SUFFIX_RANK deliberately excludes "V": a trailing "V" is far
    // more often a middle initial than a fifth generation, so it has to survive
    // normalization as middle evidence on EITHER side of the comparison.
    const resolve = (candidateName: string, rowCandidateName: string) =>
      resolveNebraskaCandidateCommittee({
        candidateName,
        officeScope: "state_upper",
        officeName: "State Senator",
        district: "30",
        electionYear: 2026,
        contributionRows: [contribution({ "Candidate Name": rowCandidateName })],
      });

    expect(resolve("Rick V. Vest", "VEST, RICK J.")).toMatchObject({
      status: "unmatched",
      reason: "no_candidate_committee_match",
    });
    expect(resolve("Rick J. Vest", "VEST, RICK V")).toMatchObject({
      status: "unmatched",
      reason: "no_candidate_committee_match",
    });
    expect(resolve("Rick V. Vest", "VEST, RICK V")).toMatchObject({ status: "matched", committeeId: "1001" });
    expect(resolve("Rick Vest", "VEST, RICK V")).toMatchObject({ status: "matched", committeeId: "1001" });
  });

  it("matches NADC's formal first name through a VoteApp nickname", () => {
    // Live: "FRIENDS OF MIKE HILGERS" rows carry Candidate Name "MICHAEL HILGERS".
    expect(
      resolveNebraskaCandidateCommittee({
        candidateName: "Mike Hilgers",
        officeScope: "statewide",
        officeName: "Attorney General",
        electionYear: 2026,
        contributionRows: [
          contribution({ "Org ID": "7425", "Filer Name": "FRIENDS OF MIKE HILGERS", "Candidate Name": "MICHAEL HILGERS", "Receipt Date": "01/06/2025" }),
        ],
      })
    ).toMatchObject({ status: "matched", committeeId: "7425" });
    expect([...normalizeNebraskaCandidateNameKeys("Mike Hilgers")]).toEqual(["MIKE HILGERS"]);
    expect([...normalizeNebraskaCandidateNameKeys("Mike Hilgers", { expandNicknames: true })]).toEqual(["MIKE HILGERS", "MICHAEL HILGERS"]);
  });

  it("matches safe statewide offices", () => {
    expect(
      resolveNebraskaCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "statewide",
        officeName: "Auditor of Public Accounts",
        electionYear: 2026,
        contributionRows: [
          contribution({
            "Org ID": "2001",
            "Filer Name": "DOE FOR AUDITOR",
            "Candidate Name": "JANE DOE",
          }),
        ],
      })
    ).toMatchObject({
      status: "matched",
      committeeId: "2001",
      committeeName: "DOE FOR AUDITOR",
    });
  });

  it("returns unmatched for unsupported office names", () => {
    expect(
      resolveNebraskaCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "statewide",
        officeName: "Public Service Commissioner",
        electionYear: 2026,
        contributionRows: [contribution({ "Candidate Name": "JANE DOE" })],
      })
    ).toEqual({
      status: "unmatched",
      reason: "unsupported_office",
      candidateNameNormalized: "JANE DOE",
      officeNameNormalized: "PUBLIC SERVICE COMMISSIONER",
    });
  });

  it("requires district for Nebraska legislative offices", () => {
    expect(
      resolveNebraskaCandidateCommittee({
        candidateName: "Rick Vest",
        officeScope: "state_upper",
        officeName: "State Legislature",
        electionYear: 2026,
        contributionRows: [contribution()],
      })
    ).toEqual({
      status: "unmatched",
      reason: "missing_legislative_district",
      candidateNameNormalized: "RICK VEST",
      officeNameNormalized: "State Senator",
    });
  });

  it("does not guess when multiple candidate committees match", () => {
    expect(
      resolveNebraskaCandidateCommittee({
        candidateName: "Rick Vest",
        officeScope: "state_upper",
        officeName: "State Senator",
        district: "30",
        electionYear: 2026,
        contributionRows: [
          contribution(),
          contribution({
            "Org ID": "1002",
            "Filer Name": "FRIENDS OF RICK VEST",
          }),
        ],
      })
    ).toEqual({
      status: "ambiguous",
      reason: "multiple_matching_committees",
      candidateNameNormalized: "RICK VEST",
      officeNameNormalized: "State Senator",
      matches: [
        {
          committeeId: "1001",
          committeeName: "VOTE VEST",
          confidence: "exact",
          source: "nadc_bulk",
          sourceUrl: null,
          matchedContributionRowCount: 1,
        },
        {
          committeeId: "1002",
          committeeName: "FRIENDS OF RICK VEST",
          confidence: "exact",
          source: "nadc_bulk",
          sourceUrl: null,
          matchedContributionRowCount: 1,
        },
      ],
    });
  });

  it("returns unmatched when candidate, committee type, or cycle does not match", () => {
    expect(
      resolveNebraskaCandidateCommittee({
        candidateName: "Rick Vest",
        officeScope: "state_upper",
        officeName: "State Senator",
        district: "30",
        electionYear: 2026,
        contributionRows: [contribution({ "Candidate Name": "Other Person" })],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });

    expect(
      resolveNebraskaCandidateCommittee({
        candidateName: "Rick Vest",
        officeScope: "state_upper",
        officeName: "State Senator",
        district: "30",
        electionYear: 2026,
        contributionRows: [contribution({ "Filer Type": "PAC-Independent" })],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });

    expect(
      resolveNebraskaCandidateCommittee({
        candidateName: "Rick Vest",
        officeScope: "state_upper",
        officeName: "State Senator",
        district: "30",
        electionYear: 2026,
        contributionRows: [contribution({ "Receipt Date": "01/10/2024" })],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });

    expect(
      resolveNebraskaCandidateCommittee({
        candidateName: "Rick Vest",
        officeScope: "state_upper",
        officeName: "State Senator",
        district: "31",
        electionYear: 2026,
        contributionRows: [
          contribution({
            "Jurisdiction - Office - District or Ballot Description": "NEBRASKA - STATE LEGISLATURE - 30",
          } as Partial<NebraskaNadcContributionRow>),
        ],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });
  });

  it("does not fuzzy-match candidate typos", () => {
    expect(
      resolveNebraskaCandidateCommittee({
        candidateName: "Rick Vesst",
        officeScope: "state_upper",
        officeName: "State Senator",
        district: "30",
        electionYear: 2026,
        contributionRows: [contribution()],
      })
    ).toEqual({
      status: "unmatched",
      reason: "no_candidate_committee_match",
      candidateNameNormalized: "RICK VESST",
      officeNameNormalized: "State Senator",
    });
  });

  it("rejects invalid election years", () => {
    expect(() =>
      resolveNebraskaCandidateCommittee({
        candidateName: "Rick Vest",
        officeScope: "state_upper",
        officeName: "State Senator",
        district: "30",
        electionYear: 2020,
        contributionRows: [],
      })
    ).toThrow("Invalid Nebraska candidate committee election year");
  });
});
