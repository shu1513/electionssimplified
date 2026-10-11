import { describe, expect, it, vi } from "vitest";

import {
  listDueTennesseeCandidateFinanceSyncRows,
  syncDueTennesseeCandidateFinance,
} from "../../../src/pipeline/tennesseeFinance/tennesseeCandidateFinanceBatchSync.js";
import * as verifiedLoaderModule from "../../../src/pipeline/tennesseeFinance/tennesseeVerifiedFinanceLoader.js";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";
const SOURCE_URL = "https://apps.tn.gov/tncamp/public/cpsearch.htm";
const REPORT_LIST_URL = "https://apps.tn.gov/tncamp/public/replist.htm?id=6496&owner=LEE,%20BILL";

function dueRow(overrides: Record<string, unknown> = {}) {
  return {
    candidate_id: CANDIDATE_ID,
    election_id: ELECTION_ID,
    candidate_name: "Bill Lee",
    election_year: 2022,
    office_scope: "statewide",
    office_name: "Governor",
    district: null,
    camp_candidate_id: "6496",
    owner_name: "LEE, BILL",
    committee_name: "LEE, BILL",
    link_source: "tncamp_search",
    source_url: SOURCE_URL,
    report_list_url: REPORT_LIST_URL,
    last_synced_at: null,
    total_due_rows: "1",
    ...overrides,
  };
}

function createMockDb(rows: unknown[] = []) {
  return {
    query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }),
  };
}

describe("tennesseeCandidateFinanceBatchSync", () => {
  it("prepares the normal verified batch with prior authority before any sync writes", async () => {
    const rows=[dueRow({election_year:2026}),dueRow({candidate_id:"33333333-3333-4333-8333-333333333333",camp_candidate_id:"7000",election_year:2026})];
    const db=createMockDb(rows);
    db.query.mockResolvedValueOnce({rows,rowCount:2}).mockResolvedValueOnce({rows:[{
      candidate_id:CANDIDATE_ID,election_id:ELECTION_ID,camp_candidate_id:"6496",
      pac_source_provenance:{saved:"PAC"},outside_report_provenance:{saved:"outside"},
    }],rowCount:1});
    const order:string[]=[];
    const loadBatch=vi.fn(async requests => {
      order.push("prepare complete");
      return requests.map(request=>({link:request.link,diagnostics:[],coverage:{},summary:{directContributionTotal:10}}));
    });
    const factory=vi.spyOn(verifiedLoaderModule,"createTennesseeVerifiedFinanceLoader").mockReturnValue({loadBatch} as never);
    const sync=vi.fn(async()=>{order.push("write");return {summaryWritten:true};});
    await syncDueTennesseeCandidateFinance({db,now:NOW,maxCandidates:2,autoLinkMissingLinks:false,syncTennesseeCandidateFinanceFn:sync as never});
    expect(factory).toHaveBeenCalledOnce();
    expect(order).toEqual(["prepare complete","write","write"]);
    expect(loadBatch.mock.calls[0][0][0]).toMatchObject({priorPacProvenance:{saved:"PAC"},priorOutsideReportProvenance:{saved:"outside"}});
    expect(sync.mock.calls[0][0]).toHaveProperty("verifiedFinance.summary.directContributionTotal",10);
    expect(sync.mock.calls[0][0]).not.toHaveProperty("contributions");
    expect(sync.mock.calls[0][0].verifiedFinance.summary).not.toHaveProperty("outsideSupportTotal");
    factory.mockRestore();
  });

  it("filters scoped due rows before limiting and skips unrelated auto-link acquisition", async () => {
    const rows=[dueRow({candidate_id:"33333333-3333-4333-8333-333333333333",total_due_rows:"2",election_year:2026}),
      dueRow({total_due_rows:"2",election_year:2026})];
    const db=createMockDb(rows);
    const loadBatch=vi.fn(async requests=>requests.map(request=>({link:request.link,diagnostics:[],coverage:{}})));
    const sync=vi.fn(async()=>({summaryWritten:false}));
    const result=await syncDueTennesseeCandidateFinance({db,now:NOW,maxCandidates:1,candidateId:CANDIDATE_ID,electionYear:2026,
      verifiedFinanceLoader:{loadBatch} as never,syncTennesseeCandidateFinanceFn:sync as never});
    expect(db.query.mock.calls[0][1][2]).toBe(10_000);
    expect(loadBatch.mock.calls[0][0]).toHaveLength(1);
    expect(loadBatch.mock.calls[0][0][0].link.candidateId).toBe(CANDIDATE_ID);
    expect(result).toMatchObject({selectedCandidateCount:1,dueCandidateCount:1,autoLinkAttemptedCount:0});
  });

  it("rejects mismatched prepared links before any sync", async () => {
    const db=createMockDb([dueRow()]);
    const sync=vi.fn();
    await expect(syncDueTennesseeCandidateFinance({db,now:NOW,autoLinkMissingLinks:false,syncTennesseeCandidateFinanceFn:sync as never,
      verifiedFinanceLoader:{loadBatch:async()=>[{link:{candidateId:"wrong"}}]} as never})).rejects.toThrow("does not match selected links");
    expect(sync).not.toHaveBeenCalled();
  });

  it("fails a truncated scoped due list before source or writes", async () => {
    const db=createMockDb([dueRow({total_due_rows:"10001"})]);
    const loadBatch=vi.fn();
    await expect(syncDueTennesseeCandidateFinance({db,now:NOW,candidateId:CANDIDATE_ID,verifiedFinanceLoader:{loadBatch} as never})).rejects.toThrow("exceeds acquisition bound");
    expect(loadBatch).not.toHaveBeenCalled();
  });
  it("lists active Tennessee finance links that are due for sync", async () => {
    const db = createMockDb([dueRow()]);

    const result = await listDueTennesseeCandidateFinanceSyncRows(db, {
      now: NOW,
      staleAfterDays: 7,
      maxCandidates: 25,
      electionLookbackDays: 1,
      electionLookaheadDays: 730,
    });

    expect(result).toEqual({
      totalDueRows: 1,
      rows: [
        {
          candidateId: CANDIDATE_ID,
          electionId: ELECTION_ID,
          candidateName: "Bill Lee",
          electionYear: 2022,
          officeScope: "statewide",
          officeName: "Governor",
          district: null,
          campCandidateId: "6496",
          ownerName: "LEE, BILL",
          committeeName: "LEE, BILL",
          linkSource: "tncamp_search",
          sourceUrl: SOURCE_URL,
          reportListUrl: REPORT_LIST_URL,
          lastSyncedAt: null,
        },
      ],
    });

    const sql = String(db.query.mock.calls[0]?.[0]);
    expect(sql).toContain("FROM public.tn_candidate_finance_links AS link");
    expect(sql).toContain("link.link_status = 'active'");
    expect(sql).toContain("district.state = 'TN'");
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
    const db = createMockDb();
    const syncTennesseeCandidateFinanceFn = vi.fn();

    await syncDueTennesseeCandidateFinance({
      db,
      now: NOW,
      autoLinkMissingLinks: false,
      syncTennesseeCandidateFinanceFn: syncTennesseeCandidateFinanceFn as never,
    });

    expect(db.query.mock.calls[0]?.[1]).toEqual([
      "2026-06-01T00:00:00.000Z",
      7,
      25,
      1,
      730,
      expect.any(Array),
    ]);
    expect(syncTennesseeCandidateFinanceFn).not.toHaveBeenCalled();
  });

  it("syncs selected due links with loaded CAMP rows and continues after a candidate failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = createMockDb([
      dueRow({ total_due_rows: "2" }),
      dueRow({
        candidate_id: "33333333-3333-4333-8333-333333333333",
        election_id: "44444444-4444-4444-8444-444444444444",
        candidate_name: "Jane Doe",
        camp_candidate_id: "7000",
        owner_name: "DOE, JANE",
        committee_name: null,
        source_url: null,
        report_list_url: null,
        total_due_rows: "2",
      }),
    ]);
    const contributionData = {
      sourceUrl: "https://apps.tn.gov/tncamp/public/ceresults.htm?direct=1",
      contributions: [
        {
          type: "Monetary",
          adjustment: "N",
          amount: 250,
          date: "02/18/2022",
          electionYear: 2022,
          reportName: "1st Quarter",
          recipientName: "LEE, BILL",
          contributorName: "DOE, JANE",
          contributorOccupation: "Attorney",
          contributorEmployer: "Acme",
        },
      ],
      expenditureSourceUrl: "https://apps.tn.gov/tncamp/public/ceresults.htm?expenditures=1",
      expenditures: [
        {
          type: "Independent",
          adjustment: "N",
          amount: 533,
          date: "10/01/2022",
          electionYear: 2022,
          reportName: "Pre-General",
          candidatePacName: "RIGHT TENNESSEE",
          vendorName: "Vendor",
          purpose: "Mail",
          candidateFor: "LEE, BILL",
          supportOpposeCode: "S",
        },
      ],
      outsideContributionSourceUrl: "https://apps.tn.gov/tncamp/public/ceresults.htm?outside=1",
      outsideGroupContributionRecords: [
        {
          type: "Monetary",
          adjustment: "N",
          amount: 50000,
          date: "09/01/2022",
          electionYear: 2022,
          reportName: "Pre-General",
          recipientName: "RIGHT TENNESSEE",
          contributorName: "TENNESSEE BANK PAC",
          contributorOccupation: null,
          contributorEmployer: null,
        },
      ],
    };
    const successfulSync = {
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      electionYear: 2022,
      dryRun: false,
      linkWritten: true,
      summaryWritten: true,
      directBreakdownsWritten: 2,
      outsideGroupsWritten: 1,
      outsideGroupBreakdownsWritten: 2,
      totalReceipts: 250,
      directContributionTotal: 250,
      outsideSupportTotal: 533,
      outsideOpposeTotal: 0,
      matchedContributionRowCount: 1,
      includedContributionRowCount: 1,
      skippedContributionRowCount: 0,
      matchedExpenditureRowCount: 1,
      includedExpenditureRowCount: 1,
      skippedExpenditureRowCount: 0,
      matchedOutsideContributionRowCount: 1,
      includedOutsideContributionRowCount: 1,
      skippedOutsideContributionRowCount: 0,
      outsideGroupCount: 1,
    };
    const loadContributionDataForCandidate = vi.fn().mockResolvedValue(contributionData);
    const syncTennesseeCandidateFinanceFn = vi
      .fn()
      .mockResolvedValueOnce(successfulSync)
      .mockRejectedValueOnce(new Error("CAMP unavailable"));
    const classifier = vi.fn();

    const result = await syncDueTennesseeCandidateFinance({
      db,
      now: NOW,
      maxCandidates: 2,
      staleAfterDays: 3,
      electionLookbackDays: 30,
      autoLinkMissingLinks: false,
      loadContributionDataForCandidate,
      syncTennesseeCandidateFinanceFn: syncTennesseeCandidateFinanceFn as never,
      financeIndustryClassifier: classifier,
      aiClassificationMinAmount: 25000,
    });

    expect(result).toMatchObject({
      dryRun: false,
      now: "2026-06-01T00:00:00.000Z",
      staleAfterDays: 3,
      maxCandidates: 2,
      dueCandidateCount: 2,
      selectedCandidateCount: 2,
      syncedCandidateCount: 1,
      failedCandidateCount: 1,
      autoLinkAttemptedCount: 0,
      autoLinkLinkedCount: 0,
    });
    expect(result.results[0]).toMatchObject({ ok: true, campCandidateId: "6496", result: successfulSync });
    expect(result.results[1]).toMatchObject({ ok: false, campCandidateId: "7000", error: "CAMP unavailable" });
    expect(warn).toHaveBeenCalledWith(
      "Tennessee finance sync failed for candidate; continuing:",
      expect.objectContaining({ campCandidateId: "7000", error: "CAMP unavailable" })
    );
    expect(loadContributionDataForCandidate).toHaveBeenCalledWith({
      candidateName: "Bill Lee",
      ownerName: "LEE, BILL",
      electionYear: 2022,
      clientOptions: undefined,
    });
    expect(syncTennesseeCandidateFinanceFn).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: CANDIDATE_ID,
        electionId: ELECTION_ID,
        candidateName: "Bill Lee",
        electionYear: 2022,
        officeName: "Governor",
        district: null,
        campCandidateId: "6496",
        ownerName: "LEE, BILL",
        committeeName: "LEE, BILL",
        linkSource: "tncamp_search",
        sourceUrl: SOURCE_URL,
        reportListUrl: REPORT_LIST_URL,
        contributions: contributionData.contributions,
        contributionSourceUrl: contributionData.sourceUrl,
        expenditures: contributionData.expenditures,
        expenditureSourceUrl: contributionData.expenditureSourceUrl,
        outsideGroupContributionRecords: contributionData.outsideGroupContributionRecords,
        outsideContributionSourceUrl: contributionData.outsideContributionSourceUrl,
        financeIndustryClassifier: classifier,
        aiClassificationMinAmount: 25000,
        dryRun: false,
        now: NOW,
      })
    );
  });
});
