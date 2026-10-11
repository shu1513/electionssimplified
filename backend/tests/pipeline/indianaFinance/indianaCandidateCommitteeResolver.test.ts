import { describe, expect, it } from "vitest";

import {
  normalizeIndianaCandidateNameKeys,
  resolveIndianaCandidateCommittee,
} from "../../../src/pipeline/indianaFinance/indianaCandidateCommitteeResolver.js";
import type { IndianaCampaignFinanceContributionRow } from "../../../src/pipeline/indianaFinance/indianaCampaignFinanceReader.js";

function contribution(overrides: Partial<IndianaCampaignFinanceContributionRow> = {}): IndianaCampaignFinanceContributionRow {
  return {
    FileNumber: "422",
    CommitteeType: "Candidate",
    Committee: "Diego for Indiana",
    CandidateName: "Cesar Diego Morales",
    ContributorType: "Individual",
    Name: "Jane Doe",
    Address: "100 Main St",
    City: "Indianapolis",
    State: "IN",
    Zip: "46204",
    Occupation: "Attorney/Legal",
    Type: "Direct",
    Description: "",
    Amount: "250.0000",
    ContributionDate: "2026-02-17 00:00:00",
    Received_By: "Treasurer",
    Amended: "0",
    ...overrides,
  };
}

describe("indianaCandidateCommitteeResolver", () => {
  it("normalizes direct, comma-form, and initial-first candidate names", () => {
    expect([...normalizeIndianaCandidateNameKeys("MORALES, Cesar Diego")]).toEqual([
      "MORALES CESAR DIEGO",
      "CESAR DIEGO MORALES",
      "CESAR MORALES",
    ]);
    expect([...normalizeIndianaCandidateNameKeys("C. Diego Morales")]).toEqual([
      "C DIEGO MORALES",
      "C MORALES",
      "DIEGO MORALES",
    ]);
  });

  it("matches exactly one Indiana candidate committee by candidate and cycle", () => {
    expect(
      resolveIndianaCandidateCommittee({
        candidateName: "Cesar Diego Morales",
        officeScope: "state_upper",
        officeName: "State Senator",
        district: "30",
        electionYear: 2026,
        sourceUrl: "https://campaignfinance.in.gov/PublicSite/Reporting/DataDownload.aspx",
        contributionRows: [
          contribution(),
          contribution({ FileNumber: "999", CandidateName: "Other Candidate" }),
          contribution({ FileNumber: "888", CommitteeType: "Political Action" }),
          contribution({ FileNumber: "777", ContributionDate: "2024-01-10 00:00:00" }),
        ],
      })
    ).toEqual({
      status: "matched",
      committeeId: "422",
      committeeName: "Diego for Indiana",
      confidence: "exact",
      source: "public_bulk",
      sourceUrl: "https://campaignfinance.in.gov/PublicSite/Reporting/DataDownload.aspx",
      matchedContributionRowCount: 1,
    });
  });

  it("keeps the literal first-name match when a nickname variant also files", () => {
    // Nicknames only widen the search after the literal name found nothing, so
    // a different Gregory Ballard does not make Greg Ballard ambiguous.
    expect(
      resolveIndianaCandidateCommittee({
        candidateName: "Greg Ballard",
        officeScope: "statewide",
        officeName: "Secretary of State",
        electionYear: 2026,
        contributionRows: [
          contribution({ FileNumber: "8001", Committee: "Greg for Indiana", CandidateName: "Gregory Alan Ballard" }),
          contribution({ FileNumber: "8002", Committee: "Friends of Greg Ballard", CandidateName: "Greg Ballard" }),
        ],
      })
    ).toMatchObject({ status: "matched", committeeId: "8002" });
  });

  it("matches the filed formal first name through a VoteApp nickname", () => {
    // Live: "Greg for Indiana" rows carry CandidateName "Gregory Alan Ballard".
    expect(
      resolveIndianaCandidateCommittee({
        candidateName: "Greg Ballard",
        officeScope: "statewide",
        officeName: "Secretary of State",
        electionYear: 2026,
        contributionRows: [
          contribution({ FileNumber: "8001", Committee: "Greg for Indiana", CandidateName: "Gregory Alan Ballard" }),
        ],
      })
    ).toMatchObject({ status: "matched", committeeId: "8001" });
    expect([...normalizeIndianaCandidateNameKeys("Greg Ballard")]).toEqual(["GREG BALLARD"]);
    expect([...normalizeIndianaCandidateNameKeys("Greg Ballard", { expandNicknames: true })]).toEqual([
      "GREG BALLARD",
      "GREGORY BALLARD",
    ]);
  });

  it("accepts the Comptroller, Indiana's renamed Auditor of State", () => {
    expect(
      resolveIndianaCandidateCommittee({
        candidateName: "Elise Nieshalla",
        officeScope: "statewide",
        officeName: "Comptroller",
        electionYear: 2026,
        contributionRows: [
          contribution({ FileNumber: "8002", Committee: "Friends for Elise Nieshalla", CandidateName: "Elise Nieshalla" }),
        ],
      })
    ).toMatchObject({ status: "matched", committeeId: "8002" });
  });

  it("rejects a same-race row whose middle name contradicts the candidate", () => {
    // Same office, district, and cycle — only the middle evidence differs.
    // Without the middle gate this row linked as an "exact" match and attached
    // the other John Smith's contributions.
    expect(
      resolveIndianaCandidateCommittee({
        candidateName: "John A. Smith",
        officeScope: "state_upper",
        officeName: "State Senator",
        district: "30",
        electionYear: 2026,
        contributionRows: [contribution({ FileNumber: "500", CandidateName: "John B. Smith" })],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });
  });

  it("accepts an initial that corroborates the full middle name", () => {
    expect(
      resolveIndianaCandidateCommittee({
        candidateName: "John A. Smith",
        officeScope: "state_upper",
        officeName: "State Senator",
        district: "30",
        electionYear: 2026,
        contributionRows: [contribution({ FileNumber: "500", CandidateName: "Smith, John Andrew" })],
      })
    ).toMatchObject({ status: "matched", committeeId: "500" });
  });

  it("still falls back to first+last when a side lacks middle info", () => {
    expect(
      resolveIndianaCandidateCommittee({
        candidateName: "John Smith",
        officeScope: "state_upper",
        officeName: "State Senator",
        district: "30",
        electionYear: 2026,
        contributionRows: [contribution({ FileNumber: "500", CandidateName: "John B. Smith" })],
      })
    ).toMatchObject({ status: "matched", committeeId: "500" });
  });

  it("treats a bare trailing V as a middle initial, not a generational suffix", () => {
    // Bare "V" is a middle initial, not a suffix (shared GENERATIONAL_SUFFIX_RANK
    // policy in finance/personNameMiddleEvidence.ts), so it must survive
    // normalization as middle evidence on either side of the comparison.
    const resolve = (candidateName: string, rowName: string) =>
      resolveIndianaCandidateCommittee({
        candidateName,
        officeScope: "state_upper",
        officeName: "State Senator",
        district: "30",
        electionYear: 2026,
        contributionRows: [contribution({ FileNumber: "500", CandidateName: rowName })],
      });

    expect(resolve("John V. Smith", "John B. Smith")).toMatchObject({
      status: "unmatched",
      reason: "no_candidate_committee_match",
    });
    expect(resolve("John B. Smith", "Smith, John V")).toMatchObject({
      status: "unmatched",
      reason: "no_candidate_committee_match",
    });
    expect(resolve("John V. Smith", "Smith, John V")).toMatchObject({ status: "matched", committeeId: "500" });
    expect(resolve("John Smith", "Smith, John V")).toMatchObject({ status: "matched", committeeId: "500" });
  });

  it("requires districts for Indiana legislative offices because contribution rows do not prove district", () => {
    expect(
      resolveIndianaCandidateCommittee({
        candidateName: "Cesar Diego Morales",
        officeScope: "state_upper",
        officeName: "State Senator",
        electionYear: 2026,
        contributionRows: [contribution()],
      })
    ).toEqual({
      status: "unmatched",
      reason: "missing_legislative_district",
      candidateNameNormalized: "CESAR DIEGO MORALES",
      officeNameNormalized: "State Senator",
    });
  });

  it("does not guess when multiple candidate committees match", () => {
    expect(
      resolveIndianaCandidateCommittee({
        candidateName: "Cesar Diego Morales",
        officeScope: "state_upper",
        officeName: "State Senator",
        district: "30",
        electionYear: 2026,
        contributionRows: [
          contribution(),
          contribution({
            FileNumber: "423",
            Committee: "Friends of Cesar Diego Morales",
          }),
        ],
      })
    ).toEqual({
      status: "ambiguous",
      reason: "multiple_matching_committees",
      candidateNameNormalized: "CESAR DIEGO MORALES",
      officeNameNormalized: "State Senator",
      matches: [
        {
          committeeId: "422",
          committeeName: "Diego for Indiana",
          confidence: "exact",
          source: "public_bulk",
          sourceUrl: null,
          matchedContributionRowCount: 1,
        },
        {
          committeeId: "423",
          committeeName: "Friends of Cesar Diego Morales",
          confidence: "exact",
          source: "public_bulk",
          sourceUrl: null,
          matchedContributionRowCount: 1,
        },
      ],
    });
  });

  it("returns unmatched for unsupported offices or missing names", () => {
    expect(
      resolveIndianaCandidateCommittee({
        candidateName: "Jane Doe",
        officeScope: "county",
        officeName: "County Council",
        electionYear: 2026,
        contributionRows: [contribution({ CandidateName: "JANE DOE" })],
      })
    ).toEqual({
      status: "unmatched",
      reason: "unsupported_office",
      candidateNameNormalized: "JANE DOE",
      officeNameNormalized: "COUNTY COUNCIL",
    });

    expect(
      resolveIndianaCandidateCommittee({
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
});
