import { describe, expect, it } from "vitest";

import {
  resolveCaliforniaCandidateCommittee,
  type CalAccessCampaignCoverRow,
} from "../../../src/pipeline/californiaFinance/californiaCandidateCommitteeResolver.js";

function coverRow(overrides: Partial<CalAccessCampaignCoverRow> = {}): CalAccessCampaignCoverRow {
  return {
    FILING_ID: "1",
    FORM_TYPE: "F460",
    FILER_ID: "1456045",
    FILER_NAML: "Newsom for California Governor 2026",
    ELECT_DATE: "11/3/2026 12:00:00 AM",
    CMTTE_TYPE: "C",
    CONTROL_YN: "Y",
    CAND_NAML: "NEWSOM",
    CAND_NAMF: "GAVIN",
    CAND_NAMT: "",
    OFFICE_CD: "GOV",
    OFFIC_DSCR: "Governor",
    JURIS_CD: "STW",
    DIST_NO: "",
    SUP_OPP_CD: "",
    ...overrides,
  };
}

describe("californiaCandidateCommitteeResolver", () => {
  it("matches a candidate committee by exact candidate, office, and election year", () => {
    expect(
      resolveCaliforniaCandidateCommittee({
        candidateName: "Gavin Newsom",
        officeName: "Governor",
        electionYear: 2026,
        campaignCoverRows: [coverRow()],
        sourceUrl: "https://campaignfinance.cdn.sos.ca.gov/dbwebexport.zip",
      })
    ).toEqual({
      status: "matched",
      controlledCommitteeId: "1456045",
      controlledCommitteeName: "Newsom for California Governor 2026",
      confidence: "exact",
      source: "cal_access",
      sourceUrl: "https://campaignfinance.cdn.sos.ca.gov/dbwebexport.zip",
      matchedCoverRowCount: 1,
    });
  });

  it("tolerates last-first input and middle initials without fuzzy matching", () => {
    expect(
      resolveCaliforniaCandidateCommittee({
        candidateName: "Newsom, Gavin C.",
        officeName: "GOV",
        electionYear: 2026,
        campaignCoverRows: [coverRow()],
      })
    ).toMatchObject({
      status: "matched",
      controlledCommitteeId: "1456045",
    });
  });

  it("rejects a same-race cover row whose middle name contradicts the candidate", () => {
    // Same office and election date — only the middle evidence differs.
    // Without the middle gate this row linked as an "exact" match and attached
    // the other John Smith's committee.
    expect(
      resolveCaliforniaCandidateCommittee({
        candidateName: "John A. Smith",
        officeName: "Governor",
        electionYear: 2026,
        campaignCoverRows: [coverRow({ CAND_NAML: "SMITH", CAND_NAMF: "JOHN B." })],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_office_year_match" });
  });

  it("accepts an initial that corroborates the full middle name", () => {
    expect(
      resolveCaliforniaCandidateCommittee({
        candidateName: "John A. Smith",
        officeName: "Governor",
        electionYear: 2026,
        campaignCoverRows: [coverRow({ CAND_NAML: "SMITH", CAND_NAMF: "JOHN ANDREW" })],
      })
    ).toMatchObject({ status: "matched", controlledCommitteeId: "1456045" });
  });

  it("still falls back to first+last when a side lacks middle info", () => {
    expect(
      resolveCaliforniaCandidateCommittee({
        candidateName: "John Smith",
        officeName: "Governor",
        electionYear: 2026,
        campaignCoverRows: [coverRow({ CAND_NAML: "SMITH", CAND_NAMF: "JOHN B." })],
      })
    ).toMatchObject({ status: "matched", controlledCommitteeId: "1456045" });
  });

  it("reads a bare trailing V as a middle initial, not a generational suffix", () => {
    // GENERATIONAL_SUFFIX_RANK deliberately excludes "V": a trailing "V" is far
    // more often a middle initial than a fifth generation, so it must stay as
    // middle evidence on either side instead of being stripped as a suffix.
    expect(
      resolveCaliforniaCandidateCommittee({
        candidateName: "John V. Smith",
        officeName: "Governor",
        electionYear: 2026,
        campaignCoverRows: [coverRow({ CAND_NAML: "SMITH", CAND_NAMF: "JOHN B." })],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_office_year_match" });

    expect(
      resolveCaliforniaCandidateCommittee({
        candidateName: "John B. Smith",
        officeName: "Governor",
        electionYear: 2026,
        campaignCoverRows: [coverRow({ CAND_NAML: "SMITH", CAND_NAMF: "JOHN V" })],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_office_year_match" });

    expect(
      resolveCaliforniaCandidateCommittee({
        candidateName: "John V. Smith",
        officeName: "Governor",
        electionYear: 2026,
        campaignCoverRows: [coverRow({ CAND_NAML: "SMITH", CAND_NAMF: "JOHN V" })],
      })
    ).toMatchObject({ status: "matched", controlledCommitteeId: "1456045" });

    expect(
      resolveCaliforniaCandidateCommittee({
        candidateName: "John Smith",
        officeName: "Governor",
        electionYear: 2026,
        campaignCoverRows: [coverRow({ CAND_NAML: "SMITH", CAND_NAMF: "JOHN V" })],
      })
    ).toMatchObject({ status: "matched", controlledCommitteeId: "1456045" });
  });

  it("matches app canonical office names to California office labels", () => {
    expect(
      resolveCaliforniaCandidateCommittee({
        candidateName: "Gavin Newsom",
        officeName: "State Lower Chamber Legislator",
        electionYear: 2026,
        campaignCoverRows: [
          coverRow({
            OFFICE_CD: "ASM",
            OFFIC_DSCR: "State Assembly",
          }),
        ],
      })
    ).toMatchObject({ status: "matched", controlledCommitteeId: "1456045" });

    expect(
      resolveCaliforniaCandidateCommittee({
        candidateName: "Gavin Newsom",
        officeName: "State Board of Equalization Member",
        electionYear: 2026,
        campaignCoverRows: [
          coverRow({
            OFFICE_CD: "BOE",
            OFFIC_DSCR: "Board of Equalization",
          }),
        ],
      })
    ).toMatchObject({ status: "matched", controlledCommitteeId: "1456045" });

    expect(
      resolveCaliforniaCandidateCommittee({
        candidateName: "Gavin Newsom",
        officeName: "Commissioner of Insurance",
        electionYear: 2026,
        campaignCoverRows: [
          coverRow({
            OFFICE_CD: "INS",
            OFFIC_DSCR: "Insurance Commissioner",
          }),
        ],
      })
    ).toMatchObject({ status: "matched", controlledCommitteeId: "1456045" });
  });

  it("uses filer-name rows when the cover row committee name is missing", () => {
    expect(
      resolveCaliforniaCandidateCommittee({
        candidateName: "Gavin Newsom",
        officeName: "Governor",
        electionYear: 2026,
        campaignCoverRows: [coverRow({ FILER_NAML: "" })],
        filerNameRows: [
          {
            FILER_ID: "1456045",
            FILER_TYPE: "CTL",
            STATUS: "ACTIVE",
            NAML: "NEWSOM FOR GOVERNOR 2026",
            NAMF: "",
            CITY: "SACRAMENTO",
            ST: "CA",
          },
        ],
      })
    ).toMatchObject({
      status: "matched",
      controlledCommitteeName: "NEWSOM FOR GOVERNOR 2026",
    });
  });

  it("returns ambiguous instead of guessing when multiple committees match", () => {
    const result = resolveCaliforniaCandidateCommittee({
      candidateName: "Gavin Newsom",
      officeName: "Governor",
      electionYear: 2026,
      campaignCoverRows: [
        coverRow({ FILER_ID: "1456045", FILER_NAML: "Newsom for California Governor 2026" }),
        coverRow({ FILER_ID: "1999999", FILER_NAML: "Californians for Newsom 2026" }),
      ],
    });

    expect(result).toEqual({
      status: "ambiguous",
      reason: "multiple_matching_committees",
      candidateNameNormalized: "GAVIN NEWSOM",
      officeNameNormalized: "GOVERNOR",
      matches: [
        {
          controlledCommitteeId: "1456045",
          controlledCommitteeName: "Newsom for California Governor 2026",
          confidence: "exact",
          source: "cal_access",
          sourceUrl: null,
          matchedCoverRowCount: 1,
        },
        {
          controlledCommitteeId: "1999999",
          controlledCommitteeName: "Californians for Newsom 2026",
          confidence: "exact",
          source: "cal_access",
          sourceUrl: null,
          matchedCoverRowCount: 1,
        },
      ],
    });
  });

  it("prefers the controlled election committee over the candidate's ballot-measure committee", () => {
    expect(
      resolveCaliforniaCandidateCommittee({
        candidateName: "Gavin Newsom",
        officeName: "Governor",
        electionYear: 2026,
        campaignCoverRows: [
          coverRow(),
          coverRow({
            FILER_ID: "1999999",
            FILER_NAML: "Investing in California - Newsom Ballot Measure Committee",
            CONTROL_YN: "N",
          }),
        ],
      })
    ).toMatchObject({
      status: "matched",
      controlledCommitteeId: "1456045",
    });
  });

  it("ignores cover rows whose committee type is not a candidate committee", () => {
    expect(
      resolveCaliforniaCandidateCommittee({
        candidateName: "Gavin Newsom",
        officeName: "Governor",
        electionYear: 2026,
        campaignCoverRows: [
          coverRow(),
          coverRow({
            FILER_ID: "1999999",
            FILER_NAML: "Newsom Ballot Measure Committee",
            CMTTE_TYPE: "G",
            CONTROL_YN: "N",
          }),
        ],
      })
    ).toMatchObject({
      status: "matched",
      controlledCommitteeId: "1456045",
    });
  });

  it("never treats independent-expenditure reports as candidate-committee evidence", () => {
    const independentExpenditureRow = coverRow({
      FILER_ID: "1888888",
      FILER_NAML: "Third Party Action Votes",
      FORM_TYPE: "F496",
      CMTTE_TYPE: "",
      CONTROL_YN: "",
      SUP_OPP_CD: "S",
    });

    expect(
      resolveCaliforniaCandidateCommittee({
        candidateName: "Gavin Newsom",
        officeName: "Governor",
        electionYear: 2026,
        campaignCoverRows: [coverRow(), independentExpenditureRow],
      })
    ).toMatchObject({
      status: "matched",
      controlledCommitteeId: "1456045",
    });

    expect(
      resolveCaliforniaCandidateCommittee({
        candidateName: "Gavin Newsom",
        officeName: "Governor",
        electionYear: 2026,
        campaignCoverRows: [independentExpenditureRow],
      })
    ).toMatchObject({
      status: "unmatched",
      reason: "no_candidate_office_year_match",
    });
  });

  it("breaks a controlled-committee tie by the sole committee named for the election year", () => {
    expect(
      resolveCaliforniaCandidateCommittee({
        candidateName: "Gavin Newsom",
        officeName: "Governor",
        electionYear: 2026,
        campaignCoverRows: [
          coverRow({
            FILER_ID: "1456044",
            FILER_NAML: "Newsom for Governor 2022",
            ELECT_DATE: "11/3/2026 12:00:00 AM",
          }),
          coverRow({ FILER_ID: "1456045", FILER_NAML: "Newsom for California Governor 2026" }),
        ],
      })
    ).toMatchObject({
      status: "matched",
      controlledCommitteeId: "1456045",
      controlledCommitteeName: "Newsom for California Governor 2026",
    });
  });

  it("breaks an uncontrolled tie by the sole committee named for the election year", () => {
    expect(
      resolveCaliforniaCandidateCommittee({
        candidateName: "Gavin Newsom",
        officeName: "Governor",
        electionYear: 2026,
        campaignCoverRows: [
          coverRow({
            FILER_ID: "1459441",
            FILER_NAML: "CALIFORNIA ALLIANCE",
            CONTROL_YN: "N",
          }),
          coverRow({
            FILER_ID: "1489604",
            FILER_NAML: "NEWSOM FOR GOVERNOR 2026",
            CONTROL_YN: "N",
          }),
        ],
      })
    ).toMatchObject({
      status: "matched",
      controlledCommitteeId: "1489604",
    });
  });

  it("returns unmatched when candidate, office, or election year do not line up", () => {
    expect(
      resolveCaliforniaCandidateCommittee({
        candidateName: "Gavin Newsom",
        officeName: "Attorney General",
        electionYear: 2026,
        campaignCoverRows: [coverRow()],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_office_year_match" });

    expect(
      resolveCaliforniaCandidateCommittee({
        candidateName: "Gavin Newsom",
        officeName: "Governor",
        electionYear: 2030,
        campaignCoverRows: [coverRow()],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_office_year_match" });

    expect(
      resolveCaliforniaCandidateCommittee({
        candidateName: "Jennifer Newsom",
        officeName: "Governor",
        electionYear: 2026,
        campaignCoverRows: [coverRow()],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_office_year_match" });
  });

  it("does not fuzzy-match candidate typos", () => {
    expect(
      resolveCaliforniaCandidateCommittee({
        candidateName: "Gavin Newsome",
        officeName: "Governor",
        electionYear: 2026,
        campaignCoverRows: [coverRow()],
      })
    ).toEqual({
      status: "unmatched",
      reason: "no_candidate_office_year_match",
      candidateNameNormalized: "GAVIN NEWSOME",
      officeNameNormalized: "GOVERNOR",
    });
  });

  it("matches the ATT and SUP office codes Cal-Access files for Attorney General and Superintendent", () => {
    expect(
      resolveCaliforniaCandidateCommittee({
        candidateName: "Rob Bonta",
        officeName: "Attorney General",
        electionYear: 2026,
        campaignCoverRows: [
          coverRow({ FILER_ID: "1456428", FILER_NAML: "Rob Bonta for CA Attorney General 2026", CAND_NAML: "Bonta", CAND_NAMF: "Rob", OFFICE_CD: "ATT", OFFIC_DSCR: "" }),
        ],
      })
    ).toMatchObject({ status: "matched", controlledCommitteeId: "1456428" });

    expect(
      resolveCaliforniaCandidateCommittee({
        candidateName: "Sonja Shaw",
        officeName: "Superintendent of Public Instruction",
        electionYear: 2026,
        campaignCoverRows: [
          coverRow({ FILER_ID: "1479719", FILER_NAML: "Shaw for Superintendent of Public Instruction 2026", CAND_NAML: "Shaw", CAND_NAMF: "Sonja", OFFICE_CD: "SUP", OFFIC_DSCR: "" }),
        ],
      })
    ).toMatchObject({ status: "matched", controlledCommitteeId: "1479719" });
  });

  it("matches call names against the formal first name on the cover row", () => {
    expect(
      resolveCaliforniaCandidateCommittee({
        candidateName: "Steve Hilton",
        officeName: "Governor",
        electionYear: 2026,
        campaignCoverRows: [
          coverRow({ FILER_ID: "1480425", FILER_NAML: "Steve Hilton for Governor 2026", CAND_NAML: "Hilton", CAND_NAMF: "Stephen" }),
        ],
      })
    ).toMatchObject({ status: "matched", controlledCommitteeId: "1480425" });

    expect(
      resolveCaliforniaCandidateCommittee({
        candidateName: "Herb W Morgan",
        officeName: "Comptroller",
        electionYear: 2026,
        campaignCoverRows: [
          coverRow({ FILER_ID: "1480103", FILER_NAML: "Herb Morgan For State Controller 2026", CAND_NAML: "Morgan", CAND_NAMF: "Herbert", OFFICE_CD: "CON", OFFIC_DSCR: "" }),
        ],
      })
    ).toMatchObject({ status: "matched", controlledCommitteeId: "1480103" });

    expect(
      resolveCaliforniaCandidateCommittee({
        candidateName: "Donald P. (Don) Wagner",
        officeName: "Secretary of State",
        electionYear: 2026,
        campaignCoverRows: [
          coverRow({ FILER_ID: "1482695", FILER_NAML: "Wagner for Secretary Of State 2026", CAND_NAML: "Wagner", CAND_NAMF: "Don", OFFICE_CD: "SOS", OFFIC_DSCR: "" }),
        ],
      })
    ).toMatchObject({ status: "matched", controlledCommitteeId: "1482695" });
  });

  it("never links a candidate-controlled ballot measure committee", () => {
    expect(
      resolveCaliforniaCandidateCommittee({
        candidateName: 'Nicholas "Nick" Schultz',
        officeName: "State Lower Chamber Legislator",
        electionYear: 2026,
        campaignCoverRows: [
          coverRow({
            FILER_ID: "1489929",
            FILER_NAML: "Safe Communities, Strong Futures: A Nick Schultz Ballot Measure Committee",
            CAND_NAML: "Schultz",
            CAND_NAMF: "Nick",
            OFFICE_CD: "ASM",
            OFFIC_DSCR: "",
            CONTROL_YN: "N",
          }),
        ],
      })
    ).toMatchObject({ status: "unmatched" });
  });

  it("does not let a nickname bridge two different formal first names", () => {
    expect(
      resolveCaliforniaCandidateCommittee({
        candidateName: "Steven Hilton",
        officeName: "Governor",
        electionYear: 2026,
        campaignCoverRows: [coverRow({ CAND_NAML: "Hilton", CAND_NAMF: "Stephen" })],
      })
    ).toMatchObject({ status: "unmatched" });
  });

  it("validates required resolver inputs", () => {
    expect(() =>
      resolveCaliforniaCandidateCommittee({
        candidateName: " ",
        officeName: "Governor",
        electionYear: 2026,
        campaignCoverRows: [],
      })
    ).toThrow("candidateName is required");

    expect(() =>
      resolveCaliforniaCandidateCommittee({
        candidateName: "Gavin Newsom",
        officeName: "Governor",
        electionYear: 1899,
        campaignCoverRows: [],
      })
    ).toThrow("Invalid California committee resolver election year");
  });
});
