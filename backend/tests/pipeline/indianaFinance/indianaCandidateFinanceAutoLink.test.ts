import { describe, expect, it, vi } from "vitest";

import {
  autoLinkIndianaCandidateFinanceForCandidateElection,
  autoLinkMissingIndianaCandidateFinanceLinks,
  buildIndianaCandidateNamePredicate,
  listIndianaCandidateElectionsMissingFinanceLinks,
} from "../../../src/pipeline/indianaFinance/indianaCandidateFinanceAutoLink.js";
import type { IndianaCampaignFinanceContributionRow } from "../../../src/pipeline/indianaFinance/indianaCampaignFinanceReader.js";

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-06-01T00:00:00.000Z");

function createMockDb(rows: unknown[] = []) {
  return {
    query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }),
  };
}

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

describe("indianaCandidateFinanceAutoLink", () => {
  it("lists eligible Indiana candidate elections missing active finance links", async () => {
    const db = createMockDb([
      {
        candidate_id: CANDIDATE_ID,
        election_id: ELECTION_ID,
        candidate_name: "Cesar Diego Morales",
        election_year: 2026,
        office_scope: "state_upper",
        office_name: "State Senator",
        district: "30",
      },
    ]);

    await expect(
      listIndianaCandidateElectionsMissingFinanceLinks(db, {
        now: NOW,
        maxCandidates: 25,
        electionLookbackDays: 1,
        electionLookaheadDays: 730,
      })
    ).resolves.toEqual([
      {
        candidateId: CANDIDATE_ID,
        electionId: ELECTION_ID,
        candidateName: "Cesar Diego Morales",
        electionYear: 2026,
        officeScope: "state_upper",
        officeName: "State Senator",
        district: "30",
      },
    ]);

    const sql = String(db.query.mock.calls[0]?.[0]);
    expect(sql).toContain("FROM public.candidate_elections AS candidate_election");
    expect(sql).toContain("district.state = 'IN'");
    expect(sql).toContain("election.race_type = 'office'");
    expect(sql).toContain("candidate_election.status NOT IN ('withdrawn', 'lost')");
    expect(sql).toContain("(office.scope || '::' || office.canonical_name) = ANY($5::text[])");
    expect(sql).toContain("FROM public.in_candidate_finance_links AS link");
    expect(sql).toContain("district.district_type IN ('state_upper', 'state_lower')");
    expect(db.query.mock.calls[0]?.[1]).toEqual([
      "2026-06-01T00:00:00.000Z",
      25,
      1,
      730,
      expect.arrayContaining(["statewide::Governor", "state_upper::State Senator", "state_lower::State Lower Chamber Legislator"]),
    ]);
  });

  it("links a matched candidate election to the resolved public bulk committee", async () => {
    const db = createMockDb([{ id: "link-1" }]);

    await expect(
      autoLinkIndianaCandidateFinanceForCandidateElection({
        db,
        now: NOW,
        sourceUrl: "https://campaignfinance.in.gov/PublicSite/Reporting/DataDownload.aspx",
        contributionRows: [contribution()],
        candidateElection: {
          candidateId: CANDIDATE_ID,
          electionId: ELECTION_ID,
          candidateName: "Cesar Diego Morales",
          electionYear: 2026,
          officeScope: "state_upper",
          officeName: "State Senator",
          district: "30",
        },
      })
    ).resolves.toEqual({
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      status: "linked",
      committeeId: "422",
    });

    expect(db.query).toHaveBeenCalledTimes(1);
    expect(String(db.query.mock.calls[0]?.[0])).toContain("INSERT INTO public.in_candidate_finance_links");
    expect(db.query.mock.calls[0]?.[1]).toEqual([
      CANDIDATE_ID,
      ELECTION_ID,
      2026,
      "CESAR DIEGO MORALES",
      "State Senator",
      "30",
      "422",
      "Diego for Indiana",
      "active",
      "public_bulk",
      "https://campaignfinance.in.gov/PublicSite/Reporting/DataDownload.aspx",
      "2026-06-01T00:00:00.000Z",
    ]);
  });

  it("does not write a link when committee resolution is ambiguous", async () => {
    const db = createMockDb();

    await expect(
      autoLinkIndianaCandidateFinanceForCandidateElection({
        db,
        now: NOW,
        sourceUrl: "https://campaignfinance.in.gov/PublicSite/Reporting/DataDownload.aspx",
        contributionRows: [
          contribution(),
          contribution({ FileNumber: "423", Committee: "Friends of Cesar Diego Morales" }),
        ],
        candidateElection: {
          candidateId: CANDIDATE_ID,
          electionId: ELECTION_ID,
          candidateName: "Cesar Diego Morales",
          electionYear: 2026,
          officeScope: "state_upper",
          officeName: "State Senator",
          district: "30",
        },
      })
    ).resolves.toEqual({
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      status: "ambiguous",
      reason: "multiple_matching_committees",
    });

    expect(db.query).not.toHaveBeenCalled();
  });

  it("continues auto-linking later candidates when one candidate write fails", async () => {
    const db = {
      query: vi
        .fn()
        .mockRejectedValueOnce(new Error("temporary write failure"))
        .mockResolvedValueOnce({ rows: [{ id: "link-2" }], rowCount: 1 }),
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(
        autoLinkMissingIndianaCandidateFinanceLinks({
          db,
          now: NOW,
          maxCandidates: 25,
          electionLookbackDays: 1,
          electionLookaheadDays: 730,
          candidateElections: [
            {
              candidateId: CANDIDATE_ID,
              electionId: ELECTION_ID,
              candidateName: "Cesar Diego Morales",
              electionYear: 2026,
              officeScope: "state_upper",
              officeName: "State Senator",
              district: "30",
            },
            {
              candidateId: "33333333-3333-4333-8333-333333333333",
              electionId: "44444444-4444-4444-8444-444444444444",
              candidateName: "Cesar Diego Morales",
              electionYear: 2026,
              officeScope: "state_upper",
              officeName: "State Senator",
              district: "30",
            },
          ],
          contributionRowsByYear: new Map([[2026, [contribution()]]]),
          sourceUrlByYear: new Map([[2026, "https://campaignfinance.in.gov/PublicSite/Reporting/DataDownload.aspx"]]),
        })
      ).resolves.toEqual([
        {
          candidateId: CANDIDATE_ID,
          electionId: ELECTION_ID,
          status: "error",
          reason: "auto_link_failed",
          error: "temporary write failure",
        },
        {
          candidateId: "33333333-3333-4333-8333-333333333333",
          electionId: "44444444-4444-4444-8444-444444444444",
          status: "linked",
          committeeId: "422",
        },
      ]);
    } finally {
      warnSpy.mockRestore();
    }

    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it("builds a candidate-name predicate for filtered contribution reads", () => {
    const predicate = buildIndianaCandidateNamePredicate([
      {
        candidateId: CANDIDATE_ID,
        electionId: ELECTION_ID,
        candidateName: "Cesar Diego Morales",
        electionYear: 2026,
        officeScope: "state_upper",
        officeName: "State Senator",
        district: "30",
      },
    ]);

    expect(predicate(contribution({ CandidateName: "MORALES, CESAR DIEGO" }))).toBe(true);
    expect(predicate(contribution({ CandidateName: "Other Person" }))).toBe(false);
  });

  it("admits formal-name rows for a VoteApp nickname in the pre-filter", () => {
    // Live: Greg Ballard's rows carry CandidateName "Gregory Alan Ballard".
    const predicate = buildIndianaCandidateNamePredicate([
      {
        candidateId: CANDIDATE_ID,
        electionId: ELECTION_ID,
        candidateName: "Greg Ballard",
        electionYear: 2026,
        officeScope: "statewide",
        officeName: "Secretary of State",
        district: null,
      },
    ]);

    expect(predicate(contribution({ CandidateName: "Gregory Alan Ballard" }))).toBe(true);
  });
});
