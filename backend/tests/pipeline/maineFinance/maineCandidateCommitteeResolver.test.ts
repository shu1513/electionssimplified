import { describe, expect, it } from "vitest";

import {
  normalizeMaineCandidateNameForStorage,
  normalizeMaineCandidateNameKeys,
  resolveMaineCandidateCommittee,
} from "../../../src/pipeline/maineFinance/maineCandidateCommitteeResolver.js";
import type { MaineCfisContributionRow } from "../../../src/pipeline/maineFinance/maineCfisArtifactReader.js";

function contribution(overrides: Partial<MaineCfisContributionRow> = {}): MaineCfisContributionRow {
  return {
    OrgID: "1001",
    LegacyID: "618",
    "Committee Name": "Paul for Maine",
    "Candidate Name": "Reagan LeeAnn Paul",
    "Receipt Amount": "250.0000",
    "Receipt Date": "03/11/2024",
    Office: "Representative",
    District: "37",
    "Last Name": "Voter",
    "First Name": "Pat",
    "Middle Name": "",
    Suffix: "",
    Address1: "100 Main St",
    Address2: "",
    City: "Augusta",
    State: "ME",
    Zip: "04330",
    Description: "",
    "Receipt ID": "R-1",
    "Filed Date": "03/15/2024",
    "Report Name": "2024 Pre-General",
    "Receipt Source Type": "Individual",
    "Receipt Type": "Monetary (Itemized)",
    "Committee Type": "Candidate Committee",
    Amended: "N",
    Employer: "LARGAY LAW OFFICES, P.A.",
    Occupation: "Attorney/Legal",
    "Occupation Comment": "",
    "Employment Information Requested": "N",
    "Forgiven Loan": "N",
    ElectionType: "General",
    ...overrides,
  };
}

describe("maineCandidateCommitteeResolver", () => {
  it("normalizes direct and comma-form candidate names without fuzzy matching", () => {
    expect([...normalizeMaineCandidateNameKeys("Paul, Reagan LeeAnn")]).toEqual([
      "PAUL REAGAN LEEANN",
      "REAGAN LEEANN PAUL",
    ]);
    expect([...normalizeMaineCandidateNameKeys("Reagan LeeAnn Paul")]).toEqual(["REAGAN LEEANN PAUL"]);
    expect(normalizeMaineCandidateNameForStorage("Paul, Reagan LeeAnn")).toBe("REAGAN LEEANN PAUL");
    expect(normalizeMaineCandidateNameForStorage("Reagan LeeAnn Paul")).toBe("REAGAN LEEANN PAUL");
  });

  it("matches exactly one Maine candidate committee by candidate, office, district, and cycle", () => {
    expect(
      resolveMaineCandidateCommittee({
        candidateName: "Reagan LeeAnn Paul",
        officeScope: "state_lower",
        officeName: "State Representative",
        district: "37",
        electionYear: 2024,
        sourceUrl: "https://mainecampaignfinance.com/",
        contributionRows: [
          contribution(),
          contribution({ OrgID: "999", "Candidate Name": "Other Candidate" }),
          contribution({ OrgID: "888", "Committee Type": "Political Action Committee" }),
          contribution({ OrgID: "777", "Receipt Date": "01/10/2022" }),
          contribution({ OrgID: "666", District: "38" }),
        ],
      })
    ).toEqual({
      status: "matched",
      committeeId: "1001",
      committeeName: "Paul for Maine",
      confidence: "exact",
      source: "cfis_bulk",
      sourceUrl: "https://mainecampaignfinance.com/",
      matchedContributionRowCount: 1,
    });
  });

  it("matches committees whose export rows leave Committee Name, Office, and District blank", () => {
    // Real CFIS exports omit "Committee Name" on ~16% of candidate rows
    // (e.g. Charlotte Nutt, OrgID 555695 in CON_2025); OrgID is always set.
    expect(
      resolveMaineCandidateCommittee({
        candidateName: "Charlotte Nutt",
        officeScope: "state_lower",
        officeName: "State Representative",
        district: "48",
        electionYear: 2026,
        contributionRows: [
          contribution({
            OrgID: "555695",
            "Committee Name": "",
            "Candidate Name": "Charlotte Nutt",
            "Receipt Date": "11/27/2025",
            Office: "",
            District: "",
            "Committee Type": "Candidate",
          }),
          contribution({
            OrgID: "555695",
            "Committee Name": "",
            "Candidate Name": "Charlotte Nutt",
            "Receipt Date": "12/01/2025",
            Office: "",
            District: "",
            "Committee Type": "Candidate",
          }),
        ],
      })
    ).toEqual({
      status: "matched",
      committeeId: "555695",
      committeeName: "Charlotte Nutt",
      confidence: "exact",
      source: "cfis_bulk",
      sourceUrl: null,
      matchedContributionRowCount: 2,
    });
  });

  it("backfills the committee name from any same-OrgID row that carries one", () => {
    expect(
      resolveMaineCandidateCommittee({
        candidateName: "Reagan LeeAnn Paul",
        officeScope: "state_lower",
        officeName: "State Representative",
        district: "37",
        electionYear: 2024,
        contributionRows: [
          contribution({ "Committee Name": "" }),
          contribution({ "Receipt ID": "R-2" }),
        ],
      })
    ).toMatchObject({
      status: "matched",
      committeeId: "1001",
      committeeName: "Paul for Maine",
      matchedContributionRowCount: 2,
    });
  });

  it("does not guess when multiple candidate committees match", () => {
    expect(
      resolveMaineCandidateCommittee({
        candidateName: "Reagan LeeAnn Paul",
        officeScope: "state_lower",
        officeName: "Representative",
        district: "37",
        electionYear: 2024,
        contributionRows: [
          contribution(),
          contribution({
            OrgID: "1002",
            "Committee Name": "Friends of Reagan Paul",
          }),
        ],
      })
    ).toEqual({
      status: "ambiguous",
      reason: "multiple_matching_committees",
      candidateNameNormalized: "REAGAN LEEANN PAUL",
      officeNameNormalized: "State Lower Chamber Legislator",
      matches: [
        {
          committeeId: "1001",
          committeeName: "Paul for Maine",
          confidence: "exact",
          source: "cfis_bulk",
          sourceUrl: null,
          matchedContributionRowCount: 1,
        },
        {
          committeeId: "1002",
          committeeName: "Friends of Reagan Paul",
          confidence: "exact",
          source: "cfis_bulk",
          sourceUrl: null,
          matchedContributionRowCount: 1,
        },
      ],
    });
  });

  it("matches a first+last alignment when the middle evidence does not contradict", () => {
    // Previously any first+last-only collision failed closed, which stranded
    // this real committee whenever the roster name dropped the middle. The
    // middle-evidence gate is the precise replacement: weak alignment
    // matches, contradiction refuses.
    expect(
      resolveMaineCandidateCommittee({
        candidateName: "Reagan Paul",
        officeScope: "state_lower",
        officeName: "Representative",
        district: "37",
        electionYear: 2024,
        contributionRows: [contribution({ "Candidate Name": "Reagan LeeAnn Paul" })],
      })
    ).toMatchObject({ status: "matched", committeeId: "1001" });
  });

  it("still refuses a committee whose candidate middle name contradicts", () => {
    expect(
      resolveMaineCandidateCommittee({
        candidateName: "Reagan Marie Paul",
        officeScope: "state_lower",
        officeName: "Representative",
        district: "37",
        electionYear: 2024,
        contributionRows: [contribution({ "Candidate Name": "Reagan LeeAnn Paul" })],
      })
    ).toEqual({
      status: "unmatched",
      reason: "no_candidate_committee_match",
      candidateNameNormalized: "REAGAN MARIE PAUL",
      officeNameNormalized: "State Lower Chamber Legislator",
    });
  });

  it("matches a formal first name through nicknames, VoteApp side only", () => {
    // VoteApp stores the campaign name "Mike Tipping" (Senate District 8);
    // a source row filed as the formal name must still link.
    const resolve = (candidateName: string, rowNames: string[]) =>
      resolveMaineCandidateCommittee({
        candidateName,
        officeScope: "state_upper",
        officeName: "State Senator",
        district: "8",
        electionYear: 2026,
        contributionRows: rowNames.map((rowName, index) =>
          contribution({
            OrgID: String(2001 + index),
            "Candidate Name": rowName,
            "Receipt Date": "05/01/2026",
            Office: "Senator",
            District: "8",
          })
        ),
      });

    expect(resolve("Mike Tipping", ["Michael Tipping"])).toMatchObject({ status: "matched", committeeId: "2001" });
    expect(resolve("Mike Tipping", ["Tipping, Michael D"])).toMatchObject({ status: "matched", committeeId: "2001" });
    // A different first name with the same surname never matches.
    expect(resolve("Mike Tipping", ["Mark Tipping"])).toMatchObject({
      status: "unmatched",
      reason: "no_candidate_committee_match",
    });
    // A literal match wins over a nickname match on another committee.
    expect(resolve("Mike Tipping", ["Michael Tipping", "Mike Tipping"])).toMatchObject({
      status: "matched",
      committeeId: "2002",
    });
    // A contradicting middle initial still refuses through the nickname path.
    expect(resolve("Mike A. Tipping", ["Tipping, Michael D"])).toMatchObject({
      status: "unmatched",
      reason: "no_candidate_committee_match",
    });
  });

  it("matches a ballot name with a middle initial to a row without one", () => {
    // VoteApp stores "David G. Haggan" (Senate District 10).
    expect(
      resolveMaineCandidateCommittee({
        candidateName: "David G. Haggan",
        officeScope: "state_upper",
        officeName: "State Senator",
        district: "10",
        electionYear: 2026,
        contributionRows: [
          contribution({
            OrgID: "3001",
            "Candidate Name": "David Haggan",
            "Receipt Date": "04/02/2026",
            Office: "Senator",
            District: "10",
          }),
        ],
      })
    ).toMatchObject({ status: "matched", committeeId: "3001" });
  });

  it("treats a bare trailing V as a middle initial, not a generational suffix", () => {
    // Bare "V" is a middle initial, not a suffix (shared GENERATIONAL_SUFFIX_RANK
    // policy in finance/personNameMiddleEvidence.ts), so it must survive
    // normalization as middle evidence on either side of the comparison.
    const resolve = (candidateName: string, rowName: string) =>
      resolveMaineCandidateCommittee({
        candidateName,
        officeScope: "state_lower",
        officeName: "Representative",
        district: "37",
        electionYear: 2024,
        contributionRows: [contribution({ "Candidate Name": rowName })],
      });

    expect(resolve("John V. Smith", "Smith, John B.")).toMatchObject({
      status: "unmatched",
      reason: "no_candidate_committee_match",
    });
    expect(resolve("John B. Smith", "Smith, John V")).toMatchObject({
      status: "unmatched",
      reason: "no_candidate_committee_match",
    });
    expect(resolve("John V. Smith", "Smith, John V")).toMatchObject({ status: "matched", committeeId: "1001" });
    expect(resolve("John Smith", "Smith, John V")).toMatchObject({ status: "matched", committeeId: "1001" });
  });

  it("returns unmatched for unsupported offices, missing names, missing districts, and nonmatches", () => {
    expect(
      resolveMaineCandidateCommittee({
        candidateName: "Reagan LeeAnn Paul",
        officeScope: "statewide",
        officeName: "Attorney General",
        electionYear: 2024,
        contributionRows: [contribution()],
      })
    ).toEqual({
      status: "unmatched",
      reason: "unsupported_office",
      candidateNameNormalized: "REAGAN LEEANN PAUL",
      officeNameNormalized: "ATTORNEY GENERAL",
    });

    expect(
      resolveMaineCandidateCommittee({
        candidateName: " ",
        officeScope: "state_lower",
        officeName: "Representative",
        district: "37",
        electionYear: 2024,
        contributionRows: [contribution()],
      })
    ).toMatchObject({ status: "unmatched", reason: "missing_candidate_name" });

    expect(
      resolveMaineCandidateCommittee({
        candidateName: "Reagan LeeAnn Paul",
        officeScope: "state_lower",
        officeName: "Representative",
        electionYear: 2024,
        contributionRows: [contribution()],
      })
    ).toMatchObject({ status: "unmatched", reason: "missing_legislative_district" });

    expect(
      resolveMaineCandidateCommittee({
        candidateName: "Reagan LeeAnn Paul",
        officeScope: "state_lower",
        officeName: "Representative",
        district: "37",
        electionYear: 2024,
        contributionRows: [contribution({ "Candidate Name": "Reagan Paula" })],
      })
    ).toMatchObject({ status: "unmatched", reason: "no_candidate_committee_match" });
  });

  it("rejects invalid election years", () => {
    expect(() =>
      resolveMaineCandidateCommittee({
        candidateName: "Reagan LeeAnn Paul",
        officeScope: "state_lower",
        officeName: "Representative",
        district: "37",
        electionYear: 1999,
        contributionRows: [],
      })
    ).toThrow("Invalid Maine candidate committee election year");
  });
});
