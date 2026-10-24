import { describe, expect, it, vi } from "vitest";

import {
  listDueWisconsinCandidateFinanceSyncRows,
  syncDueWisconsinCandidateFinance,
} from "../../../src/pipeline/wisconsinFinance/wisconsinCandidateFinanceBatchSync.js";
import type { WisconsinCandidateCommitteeResolution } from "../../../src/pipeline/wisconsinFinance/wisconsinCandidateCommitteeResolver.js";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const SOURCE_URL = "https://campaignfinance.wi.gov/browse-data/registrants/16621";
const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";

function dueRow(overrides: Record<string, unknown> = {}) {
  return {
    candidate_id: CANDIDATE_ID,
    election_id: ELECTION_ID,
    candidate_name: "Tom Tiffany",
    election_year: 2026,
    office_scope: "statewide",
    office_name: "Governor",
    district: null,
    entity_id: "16621",
    committee_id: "407",
    committee_name: "Tiffany for Wisconsin",
    assigned_committee_id: "0104212",
    source_url: SOURCE_URL,
    last_synced_at: null,
    total_due_rows: "1",
    ...overrides,
  };
}

function matchedResolution(): Extract<WisconsinCandidateCommitteeResolution, { status: "matched" }> {
  return {
    status: "matched",
    entityId: "16621",
    committeeId: "407",
    assignedCommitteeId: "0104212",
    committeeName: "Tiffany for Wisconsin",
    confidence: "exact",
    source: "sunshine_api",
    sourceUrl: SOURCE_URL,
    matchedCommitteeRowCount: 1,
  };
}

describe("wisconsinCandidateFinanceBatchSync", () => {
  it("runs targeted cash independently without any legacy DB selection or sync", async()=>{
    const db={query:vi.fn(),connect:vi.fn()},legacy=vi.fn(),cash=vi.fn(async()=>({due:1,selected:1,accepted:1,written:1,held:0,failures:[]}));
    const result=await syncDueWisconsinCandidateFinance({db,now:NOW,committeeCashOnly:true,candidateId:CANDIDATE_ID,electionYear:2026,syncDueWisconsinCommitteeCashFn:cash,syncWisconsinCandidateFinanceFn:legacy});
    expect(result.committeeCash?.written).toBe(1);expect(result.results).toEqual([]);expect(db.query).not.toHaveBeenCalled();expect(legacy).not.toHaveBeenCalled();
    expect(cash).toHaveBeenCalledWith(expect.objectContaining({candidateId:CANDIDATE_ID,electionYear:2026,allowNetwork:false}));
  });
  it("continues legacy selection when optional cash infrastructure fails",async()=>{
    const db={query:vi.fn(async()=>({rows:[],rowCount:0})),connect:vi.fn()};
    const result=await syncDueWisconsinCandidateFinance({db,now:NOW,autoLinkMissingLinks:false,refreshCommitteeCash:true,syncDueWisconsinCommitteeCashFn:vi.fn(async()=>{throw Error("unavailable")})});
    expect(result.committeeCash?.failures).toEqual(["component_unavailable"]);expect(db.query).toHaveBeenCalledTimes(1);
  });
  it("rejects targeting that could otherwise leave legacy work unscoped",async()=>{
    await expect(syncDueWisconsinCandidateFinance({db:{query:vi.fn(),connect:vi.fn()},candidateId:CANDIDATE_ID})).rejects.toThrow("requires committeeCashOnly");
  });
  it("lists active Wisconsin finance links that are due for sync", async () => {
    const db = {
      query: vi.fn(async () => ({
        rows: [
          dueRow({ total_due_rows: "2" }),
          dueRow({
            candidate_id: "33333333-3333-4333-8333-333333333333",
            election_id: "44444444-4444-4444-8444-444444444444",
            candidate_name: "Jane Doe",
            election_year: 2026,
            office_scope: "state_lower",
            office_name: "State Lower Chamber Legislator",
            district: "9",
            entity_id: "12345",
            committee_id: "999",
            committee_name: "Jane Doe",
            assigned_committee_id: null,
            source_url: null,
            last_synced_at: "2026-01-01 00:00:00+00",
            total_due_rows: "2",
          }),
        ],
        rowCount: 2,
      })),
    };

    await expect(
      listDueWisconsinCandidateFinanceSyncRows(db, {
        now: NOW,
        staleAfterDays: 7,
        maxCandidates: 25,
        electionLookbackDays: 1,
        electionLookaheadDays: 730,
      })
    ).resolves.toEqual({
      totalDueRows: 2,
      rows: [
        {
          candidateId: CANDIDATE_ID,
          electionId: ELECTION_ID,
          candidateName: "Tom Tiffany",
          electionYear: 2026,
          officeScope: "statewide",
          officeName: "Governor",
          district: null,
          entityId: "16621",
          committeeId: "407",
          committeeName: "Tiffany for Wisconsin",
          assignedCommitteeId: "0104212",
          sourceUrl: SOURCE_URL,
          lastSyncedAt: null,
        },
        {
          candidateId: "33333333-3333-4333-8333-333333333333",
          electionId: "44444444-4444-4444-8444-444444444444",
          candidateName: "Jane Doe",
          electionYear: 2026,
          officeScope: "state_lower",
          officeName: "State Lower Chamber Legislator",
          district: "9",
          entityId: "12345",
          committeeId: "999",
          committeeName: "Jane Doe",
          assignedCommitteeId: null,
          sourceUrl: null,
          lastSyncedAt: "2026-01-01 00:00:00+00",
        },
      ],
    });

    const sql = String(db.query.mock.calls[0]?.[0]);
    expect(sql).toContain("FROM public.wi_candidate_finance_links AS link");
    expect(sql).toContain("link.link_status = 'active'");
    expect(sql).toContain("district.state = 'WI'");
    expect(sql).toContain("election.race_type = 'office'");
    expect(sql).toContain("candidate_election.status NOT IN ('withdrawn', 'lost')");
    expect(sql).toContain("(office.scope || '::' || office.canonical_name) = ANY($6::text[])");
    expect(db.query.mock.calls[0]?.[1]).toEqual([
      "2026-06-01T00:00:00.000Z",
      7,
      25,
      1,
      730,
      expect.arrayContaining([
        "statewide::Governor",
        "state_upper::State Senator",
        "state_lower::State Lower Chamber Legislator",
      ]),
    ]);
  });

  it("uses one post-election grace day by default", async () => {
    const db = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })), connect: vi.fn() };
    const syncWisconsinCandidateFinanceFn = vi.fn();

    await syncDueWisconsinCandidateFinance({
      db,
      now: NOW,
      autoLinkMissingLinks: false,
      syncWisconsinCandidateFinanceFn: syncWisconsinCandidateFinanceFn as never,
    });

    expect(db.query.mock.calls[0]?.[1]).toEqual([
      "2026-06-01T00:00:00.000Z",
      7,
      25,
      1,
      730,
      expect.any(Array),
    ]);
    expect(syncWisconsinCandidateFinanceFn).not.toHaveBeenCalled();
  });

  it("syncs selected due candidates with trusted linked committees and continues after a candidate failure", async () => {
    const db = {
      query: vi.fn(async () => ({
        rows: [
          dueRow({ total_due_rows: "2" }),
          dueRow({
            candidate_id: "33333333-3333-4333-8333-333333333333",
            election_id: "44444444-4444-4444-8444-444444444444",
            candidate_name: "Jane Doe",
            entity_id: "12345",
            committee_id: "999",
            committee_name: "Jane Doe",
            assigned_committee_id: null,
            source_url: null,
            total_due_rows: "2",
          }),
        ],
        rowCount: 2,
      })),
      connect: vi.fn(),
    };
    const successfulSync = {
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      electionYear: 2026,
      dryRun: false,
      linkWritten: true,
      summaryWritten: true,
      directBreakdownsWritten: 1,
      outsideGroupsWritten: 0,
      outsideGroupBreakdownsWritten: 0,
      totalReceipts: null,
      directContributionTotal: 100,
      totalDisbursements: null,
      outsideSupportTotal: 0,
      outsideOpposeTotal: 0,
      directOccupationRowCount: 1,
      directContributionSizeRowCount: 0,
      outsideGroupCount: 0,
      outsideFunderRowCount: 0,
      skippedOutsideGroupFunderLookupCount: 0,
      resolution: matchedResolution(),
    };
    const syncWisconsinCandidateFinanceFn = vi
      .fn()
      .mockResolvedValueOnce(successfulSync)
      .mockRejectedValueOnce(new Error("Sunshine unavailable"));

    const result = await syncDueWisconsinCandidateFinance({
      db,
      now: NOW,
      maxCandidates: 2,
      staleAfterDays: 3,
      electionLookbackDays: 30,
      autoLinkMissingLinks: false,
      syncWisconsinCandidateFinanceFn: syncWisconsinCandidateFinanceFn as never,
    });

    expect(result).toMatchObject({
      dryRun: false,
      dueCandidateCount: 2,
      selectedCandidateCount: 2,
      syncedCandidateCount: 1,
      failedCandidateCount: 1,
      autoLinkAttemptedCount: 0,
      autoLinkLinkedCount: 0,
    });
    expect(result.results[0]).toMatchObject({ ok: true, result: successfulSync });
    expect(result.results[1]).toMatchObject({ ok: false, error: "Sunshine unavailable" });
    expect(syncWisconsinCandidateFinanceFn).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: CANDIDATE_ID,
        electionId: ELECTION_ID,
        candidateName: "Tom Tiffany",
        electionYear: 2026,
        officeScope: "statewide",
        officeName: "Governor",
        district: null,
        sourceUrl: SOURCE_URL,
        trustedCommittee: {
          entityId: "16621",
          committeeId: "407",
          committeeName: "Tiffany for Wisconsin",
          assignedCommitteeId: "0104212",
          sourceUrl: SOURCE_URL,
        },
        dryRun: false,
        now: NOW,
      })
    );
  });

  it("auto-links missing eligible candidate elections before selecting due links", async () => {
    const db = {
      query: vi.fn(async (sql: string) => {
        const text = String(sql);
        if (text.includes("INSERT INTO public.wi_candidate_finance_links")) {
          return { rows: [{ id: "link-1" }], rowCount: 1 };
        }
        if (text.includes("FROM public.candidate_elections AS candidate_election") && !text.includes("WITH due AS")) {
          return {
            rows: [
              {
                candidate_id: CANDIDATE_ID,
                election_id: ELECTION_ID,
                candidate_name: "Tom Tiffany",
                election_year: 2026,
                office_scope: "statewide",
                office_name: "Governor",
                district: null,
              },
            ],
            rowCount: 1,
          };
        }
        if (text.includes("FROM public.wi_candidate_finance_links AS link")) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      }),
      connect: vi.fn(),
    };
    const resolveCandidateCommittee = vi.fn(async () => matchedResolution());

    const result = await syncDueWisconsinCandidateFinance({
      db,
      now: NOW,
      maxCandidates: 5,
      resolveCandidateCommittee,
      syncWisconsinCandidateFinanceFn: vi.fn() as never,
    });

    expect(result).toMatchObject({
      dueCandidateCount: 0,
      selectedCandidateCount: 0,
      autoLinkAttemptedCount: 1,
      autoLinkLinkedCount: 1,
    });
    expect(resolveCandidateCommittee).toHaveBeenCalledWith(
      {
        candidateName: "Tom Tiffany",
        officeScope: "statewide",
        officeName: "Governor",
        electionYear: 2026,
        district: null,
      },
      undefined
    );
    expect(db.query.mock.calls.some((call) => String(call[0]).includes("INSERT INTO public.wi_candidate_finance_links"))).toBe(
      true
    );
  });
});
