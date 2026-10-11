import { describe, expect, it, vi } from "vitest";

import {
  autoLinkMissingMaineCandidateFinanceLinks,
  buildMaineCandidateNamePredicate,
  listMaineCandidateElectionsMissingFinanceLinks,
} from "../../../src/pipeline/maineFinance/maineCandidateFinanceAutoLink.js";
import type { MaineCfisContributionRow } from "../../../src/pipeline/maineFinance/maineCfisArtifactReader.js";

function contribution(overrides: Partial<MaineCfisContributionRow> = {}): MaineCfisContributionRow {
  return {
    OrgID: "1001",
    LegacyID: "618",
    "Committee Name": "Paul for Maine",
    "Candidate Name": "Reagan LeeAnn Paul",
    "Receipt Amount": "100.0000",
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

describe("maineCandidateFinanceAutoLink", () => {
  it("builds a candidate-name predicate for Maine contribution rows", () => {
    const predicate = buildMaineCandidateNamePredicate([
      {
        candidateId: "candidate-1",
        electionId: "election-1",
        candidateName: "Reagan LeeAnn Paul",
        electionYear: 2024,
        officeScope: "state_lower",
        officeName: "Representative",
        district: "37",
      },
    ]);

    expect(predicate(contribution({ "Candidate Name": "Paul, Reagan LeeAnn" }))).toBe(true);
    expect(predicate(contribution({ "Candidate Name": "Other Candidate" }))).toBe(false);
  });

  it("admits rows that differ only by a middle initial or a formal first name", () => {
    const candidate = (candidateName: string, district: string) => ({
      candidateId: `candidate-${candidateName}`,
      electionId: "election-1",
      candidateName,
      electionYear: 2026,
      officeScope: "state_upper",
      officeName: "State Senator",
      district,
    });
    // VoteApp stores the ballot name with a middle initial (David G. Haggan)
    // or the campaign name (Mike Tipping); the full-name keys alone dropped
    // every source row for both before the resolver ran.
    const predicate = buildMaineCandidateNamePredicate([
      candidate("David G. Haggan", "10"),
      candidate("Mike Tipping", "8"),
    ]);

    expect(predicate(contribution({ "Candidate Name": "David Haggan" }))).toBe(true);
    expect(predicate(contribution({ "Candidate Name": "Haggan, David G" }))).toBe(true);
    expect(predicate(contribution({ "Candidate Name": "Michael Tipping" }))).toBe(true);
    expect(predicate(contribution({ "Candidate Name": "Tipping, Michael" }))).toBe(true);
    expect(predicate(contribution({ "Candidate Name": "Daniel Haggan" }))).toBe(false);
    expect(predicate(contribution({ "Candidate Name": "Mike Tippett" }))).toBe(false);
  });

  it("queries missing Maine candidate elections", async () => {
    const db = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            candidate_id: "candidate-1",
            election_id: "election-1",
            candidate_name: "Reagan LeeAnn Paul",
            election_year: 2024,
            office_scope: "state_lower",
            office_name: "State Lower Chamber Legislator",
            district: "37",
          },
        ],
      }),
    };

    await expect(
      listMaineCandidateElectionsMissingFinanceLinks(db, {
        now: new Date("2026-06-25T12:00:00.000Z"),
        maxCandidates: 10,
        electionLookbackDays: 1,
        electionLookaheadDays: 730,
      })
    ).resolves.toEqual([
      {
        candidateId: "candidate-1",
        electionId: "election-1",
        candidateName: "Reagan LeeAnn Paul",
        electionYear: 2024,
        officeScope: "state_lower",
        officeName: "State Lower Chamber Legislator",
        district: "37",
      },
    ]);
    const sql = String(db.query.mock.calls[0]?.[0]);
    expect(sql).toContain("district.state = 'ME'");
    expect(sql).toContain("FROM public.me_candidate_finance_links AS link");
  });

  it("auto-links exactly matched Maine candidate committees", async () => {
    const db = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: "link-1" }], rowCount: 1 }),
    };

    const results = await autoLinkMissingMaineCandidateFinanceLinks({
      db,
      now: new Date("2026-06-25T12:00:00.000Z"),
      maxCandidates: 10,
      electionLookbackDays: 1,
      electionLookaheadDays: 730,
      contributionRowsByYear: new Map([[2024, [contribution()]]]),
      sourceUrlByYear: new Map([[2024, "https://mainecampaignfinance.com/"]]),
      candidateElections: [
        {
          candidateId: "11111111-1111-1111-1111-111111111111",
          electionId: "22222222-2222-2222-2222-222222222222",
          candidateName: "Reagan LeeAnn Paul",
          electionYear: 2024,
          officeScope: "state_lower",
          officeName: "Representative",
          district: "37",
        },
      ],
    });

    expect(results).toEqual([
      {
        candidateId: "11111111-1111-1111-1111-111111111111",
        electionId: "22222222-2222-2222-2222-222222222222",
        status: "linked",
        committeeId: "1001",
      },
    ]);
    expect(String(db.query.mock.calls[0]?.[0])).toContain("INSERT INTO public.me_candidate_finance_links");
    expect(db.query.mock.calls[0]?.[1]).toEqual([
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
      2024,
      "REAGAN LEEANN PAUL",
      "Representative",
      "37",
      "1001",
      "Paul for Maine",
      "active",
      "cfis_bulk",
      "https://mainecampaignfinance.com/",
      "2026-06-25T12:00:00.000Z",
    ]);
  });
});
