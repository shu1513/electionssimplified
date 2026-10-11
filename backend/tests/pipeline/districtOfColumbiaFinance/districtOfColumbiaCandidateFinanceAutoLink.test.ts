import { describe, expect, it, vi } from "vitest";

import {
  autoLinkDistrictOfColumbiaCandidateFinanceForCandidateElection,
  autoLinkMissingDistrictOfColumbiaCandidateFinanceLinks,
  listDistrictOfColumbiaCandidateElectionsMissingFinanceLinks,
} from "../../../src/pipeline/districtOfColumbiaFinance/districtOfColumbiaCandidateFinanceAutoLink.js";
import {
  resolveDistrictOfColumbiaCandidateCommittee,
  type DistrictOfColumbiaCandidateCommitteeResolution,
} from "../../../src/pipeline/districtOfColumbiaFinance/districtOfColumbiaCandidateCommitteeResolver.js";

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-06-01T00:00:00.000Z");
const SOURCE_URL = "https://efiling.ocf.dc.gov/DataDownload";

function createMockDb(rows: unknown[] = []) {
  return {
    query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }),
  };
}

function matchedResolution(
  overrides: Partial<Extract<DistrictOfColumbiaCandidateCommitteeResolution, { status: "matched" }>> = {}
) {
  return {
    status: "matched" as const,
    committeeKey: "COMMITTEE TO ELECT JANE DOE",
    committeeName: "Committee To Elect Jane Doe",
    confidence: "exact" as const,
    source: "ocf_export" as const,
    sourceUrl: SOURCE_URL,
    matchedContributionRowCount: 2,
    ...overrides,
  };
}

describe("districtOfColumbiaCandidateFinanceAutoLink", () => {
  it("keeps the Council Chairman race routable instead of dropping its seat (live: Phil Mendelson)", async () => {
    const db = createMockDb([
      {
        candidate_id: CANDIDATE_ID,
        election_id: ELECTION_ID,
        candidate_name: "Phil Mendelson",
        election_year: 2026,
        office_scope: "place",
        office_name: "City Council Member",
        seat_text: "Chairman of the Council of the District of Columbia Washington city, District of Columbia",
      },
    ]);
    const [row] = await listDistrictOfColumbiaCandidateElectionsMissingFinanceLinks(db, {
      now: NOW,
      maxCandidates: 25,
      electionLookbackDays: 1,
      electionLookaheadDays: 730,
    });
    expect(row?.seat).toBe("Chairman of the Council");

    const resolution = resolveDistrictOfColumbiaCandidateCommittee({
      candidateName: row!.candidateName,
      officeScope: row!.officeScope,
      officeName: row!.officeName,
      electionYear: 2026,
      seat: row!.seat,
      contributionRecords: [
        {
          candidateName: "Phil Mendelson",
          committeeName: "Mendelson for Chairman 2026",
          committeeKey: "MENDELSON CHAIRMAN 2026",
          amount: 100,
          date: "03/01/2026",
        },
      ],
    });
    expect(resolution).toMatchObject({ status: "matched", committeeName: "Mendelson for Chairman 2026" });
  });

  it("lists eligible D.C. candidate elections missing active finance links", async () => {
    const db = createMockDb([
      {
        candidate_id: CANDIDATE_ID,
        election_id: ELECTION_ID,
        candidate_name: "Jane Doe",
        election_year: 2026,
        office_scope: "place",
        office_name: "City Council Member",
        seat_text: "Councilmember Ward 4 District of Columbia Ward 4",
      },
      {
        candidate_id: "33333333-3333-4333-8333-333333333333",
        election_id: "44444444-4444-4444-8444-444444444444",
        candidate_name: "John Smith",
        election_year: 2026,
        office_scope: "place",
        office_name: "Mayor",
        seat_text: "Mayor District of Columbia",
      },
    ]);

    await expect(
      listDistrictOfColumbiaCandidateElectionsMissingFinanceLinks(db, {
        now: NOW,
        maxCandidates: 25,
        electionLookbackDays: 1,
        electionLookaheadDays: 730,
      })
    ).resolves.toEqual([
      {
        candidateId: CANDIDATE_ID,
        electionId: ELECTION_ID,
        candidateName: "Jane Doe",
        electionYear: 2026,
        officeScope: "place",
        officeName: "City Council Member",
        seat: "WARD 4",
      },
      {
        candidateId: "33333333-3333-4333-8333-333333333333",
        electionId: "44444444-4444-4444-8444-444444444444",
        candidateName: "John Smith",
        electionYear: 2026,
        officeScope: "place",
        officeName: "Mayor",
        seat: null,
      },
    ]);

    const sql = String(db.query.mock.calls[0]?.[0]);
    expect(sql).toContain("FROM public.candidate_elections AS candidate_election");
    expect(sql).toContain("district.state = 'DC'");
    expect(sql).toContain("election.race_type = 'office'");
    expect(sql).toContain("candidate_election.status NOT IN ('withdrawn', 'lost')");
    expect(sql).toContain("(office.scope || '::' || office.canonical_name) = ANY($5::text[])");
    expect(sql).toContain("FROM public.dc_candidate_finance_links AS link");
    expect(db.query.mock.calls[0]?.[1]).toEqual([
      "2026-06-01T00:00:00.000Z",
      25,
      1,
      730,
      expect.arrayContaining([
        "place::Mayor",
        "place::City Council Member",
        "statewide::Attorney General",
      ]),
    ]);
    expect(db.query.mock.calls[0]?.[1]?.[4]).not.toContain("statewide::State Board of Education Member");
    expect(db.query.mock.calls[0]?.[1]?.[4]).not.toContain("place::City Treasurer");
  });

  it("links a matched D.C. candidate election to the resolved OCF committee", async () => {
    const db = createMockDb([{ id: "link-1" }]);
    const resolveCandidateCommittee = vi.fn(async () => matchedResolution());

    await expect(
      autoLinkDistrictOfColumbiaCandidateFinanceForCandidateElection({
        db,
        now: NOW,
        resolveCandidateCommittee,
        candidateElection: {
          candidateId: CANDIDATE_ID,
          electionId: ELECTION_ID,
          candidateName: "Jane Doe",
          electionYear: 2026,
          officeScope: "place",
          officeName: "Mayor",
          seat: null,
        },
      })
    ).resolves.toEqual({
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      status: "linked",
      committeeKey: "COMMITTEE TO ELECT JANE DOE",
    });

    expect(resolveCandidateCommittee).toHaveBeenCalledWith(
      {
        candidateName: "Jane Doe",
        officeScope: "place",
        officeName: "Mayor",
        electionYear: 2026,
        seat: null,
      },
      undefined
    );
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(String(db.query.mock.calls[0]?.[0])).toContain("INSERT INTO public.dc_candidate_finance_links");
    expect(db.query.mock.calls[0]?.[1]).toEqual([
      CANDIDATE_ID,
      ELECTION_ID,
      2026,
      "JANE DOE",
      "Mayor",
      null,
      "COMMITTEE TO ELECT JANE DOE",
      "Committee To Elect Jane Doe",
      "active",
      "ocf_export",
      SOURCE_URL,
      "2026-06-01T00:00:00.000Z",
    ]);
  });

  it("does not write a link when committee resolution is ambiguous", async () => {
    const db = createMockDb();
    const resolveCandidateCommittee = vi.fn(async (): Promise<DistrictOfColumbiaCandidateCommitteeResolution> => ({
      status: "ambiguous",
      reason: "multiple_matching_committees",
      candidateNameNormalized: "JANE DOE",
      officeNameNormalized: "Mayor",
      matches: [
        matchedResolution(),
        matchedResolution({ committeeKey: "FRIENDS OF JANE DOE", committeeName: "Friends of Jane Doe" }),
      ],
    }));

    await expect(
      autoLinkDistrictOfColumbiaCandidateFinanceForCandidateElection({
        db,
        now: NOW,
        resolveCandidateCommittee,
        candidateElection: {
          candidateId: CANDIDATE_ID,
          electionId: ELECTION_ID,
          candidateName: "Jane Doe",
          electionYear: 2026,
          officeScope: "place",
          officeName: "Mayor",
          seat: null,
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

  it("uses provided candidate elections without querying when auto-linking a batch", async () => {
    const db = createMockDb([{ id: "link-1" }]);
    const resolveCandidateCommittee = vi.fn(async () => matchedResolution());

    await expect(
      autoLinkMissingDistrictOfColumbiaCandidateFinanceLinks({
        db,
        now: NOW,
        maxCandidates: 25,
        electionLookbackDays: 1,
        electionLookaheadDays: 730,
        candidateElections: [
          {
            candidateId: CANDIDATE_ID,
            electionId: ELECTION_ID,
            candidateName: "Jane Doe",
            electionYear: 2026,
            officeScope: "place",
            officeName: "Mayor",
            seat: null,
          },
        ],
        resolveCandidateCommittee,
      })
    ).resolves.toEqual([
      {
        candidateId: CANDIDATE_ID,
        electionId: ELECTION_ID,
        status: "linked",
        committeeKey: "COMMITTEE TO ELECT JANE DOE",
      },
    ]);

    expect(db.query).toHaveBeenCalledTimes(1);
    expect(String(db.query.mock.calls[0]?.[0])).toContain("INSERT INTO public.dc_candidate_finance_links");
  });

  it("continues auto-linking later candidates when one candidate write fails", async () => {
    const db = {
      query: vi
        .fn()
        .mockRejectedValueOnce(new Error("temporary write failure"))
        .mockResolvedValueOnce({ rows: [{ id: "link-2" }], rowCount: 1 }),
    };
    const resolveCandidateCommittee = vi.fn(async () => matchedResolution());
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(
        autoLinkMissingDistrictOfColumbiaCandidateFinanceLinks({
          db,
          now: NOW,
          maxCandidates: 25,
          electionLookbackDays: 1,
          electionLookaheadDays: 730,
          candidateElections: [
            {
              candidateId: CANDIDATE_ID,
              electionId: ELECTION_ID,
              candidateName: "Jane Doe",
              electionYear: 2026,
              officeScope: "place",
              officeName: "Mayor",
              seat: null,
            },
            {
              candidateId: "33333333-3333-4333-8333-333333333333",
              electionId: "44444444-4444-4444-8444-444444444444",
              candidateName: "Jane Doe",
              electionYear: 2026,
              officeScope: "place",
              officeName: "Mayor",
              seat: null,
            },
          ],
          resolveCandidateCommittee,
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
          committeeKey: "COMMITTEE TO ELECT JANE DOE",
        },
      ]);

      expect(warnSpy).toHaveBeenCalledWith(
        "D.C. finance auto-link failed for candidate election; continuing:",
        expect.objectContaining({
          candidateId: CANDIDATE_ID,
          electionId: ELECTION_ID,
          error: "temporary write failure",
        })
      );
    } finally {
      warnSpy.mockRestore();
    }

    expect(db.query).toHaveBeenCalledTimes(2);
  });
});
