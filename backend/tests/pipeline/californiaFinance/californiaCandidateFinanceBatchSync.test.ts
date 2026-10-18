import { afterEach, describe, expect, it, vi } from "vitest";
import * as reportedCommitteeBatch from "../../../src/pipeline/californiaFinance/californiaReportedCommitteeBatchSync.js";
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});

import {
  createCalAccessReceiptRowsForCommitteesCache,
  listDueCaliforniaCandidateFinanceSyncRows,
  syncDueCaliforniaCandidateFinance,
} from "../../../src/pipeline/californiaFinance/californiaCandidateFinanceBatchSync.js";

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";

function createMockDb(rows: unknown[] = []) {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  };
}

describe("californiaCandidateFinanceBatchSync", () => {
  it("runs reported committees with no legacy due rows and isolates component failures",async()=>{
    const component=vi.spyOn(reportedCommitteeBatch,"syncDueCaliforniaCommitteeReceipts").mockResolvedValue({enabled:true,writtenCount:1} as never),db=createMockDb();
    const options={db,rawDataResolutionData:null,rawDataReceiptData:null,autoLinkMissingLinks:false};
    const result=await syncDueCaliforniaCandidateFinance(options);expect(result.selectedCandidateCount).toBe(0);expect(result.reportedCommittees).toEqual({enabled:true,writtenCount:1});expect(component).toHaveBeenCalledWith(expect.objectContaining({db,maxCandidates:25,electionLookbackDays:98,resolutionData:null}));
    component.mockRejectedValue(new Error("synthetic source failure"));const warn=vi.spyOn(console,"warn").mockImplementation(()=>{});expect((await syncDueCaliforniaCandidateFinance(options)).selectedCandidateCount).toBe(0);expect(warn).toHaveBeenCalledWith("California reported committee receipts unavailable; legacy sync continues");
  });
  it("lists due California finance sync rows from explicit active links", async () => {
    const db = createMockDb([
      {
        candidate_id: CANDIDATE_ID,
        election_id: ELECTION_ID,
        candidate_name: "Gavin Newsom",
        election_year: 2026,
        office_name: "Governor",
        controlled_committee_id: "1456045",
        controlled_committee_name: "Newsom for California Governor 2026",
        source_url: "https://powersearch.sos.ca.gov/",
        last_synced_at: null,
        total_due_rows: "2",
      },
      {
        candidate_id: "33333333-3333-4333-8333-333333333333",
        election_id: "44444444-4444-4444-8444-444444444444",
        candidate_name: "Rob Bonta",
        election_year: 2026,
        office_name: "Attorney General",
        controlled_committee_id: "9876543",
        controlled_committee_name: "Bonta for Attorney General 2026",
        source_url: null,
        last_synced_at: "2026-01-01 00:00:00+00",
        total_due_rows: "2",
      },
    ]);

    const result = await listDueCaliforniaCandidateFinanceSyncRows(db, {
      now: new Date("2026-06-01T00:00:00.000Z"),
      staleAfterDays: 7,
      maxCandidates: 25,
      electionLookbackDays: 30,
      electionLookaheadDays: 730,
    });

    expect(result).toEqual({
      totalDueRows: 2,
      rows: [
        {
          candidateId: CANDIDATE_ID,
          electionId: ELECTION_ID,
          candidateName: "Gavin Newsom",
          electionYear: 2026,
          officeName: "Governor",
          controlledCommitteeId: "1456045",
          controlledCommitteeName: "Newsom for California Governor 2026",
          sourceUrl: "https://powersearch.sos.ca.gov/",
          lastSyncedAt: null,
        },
        {
          candidateId: "33333333-3333-4333-8333-333333333333",
          electionId: "44444444-4444-4444-8444-444444444444",
          candidateName: "Rob Bonta",
          electionYear: 2026,
          officeName: "Attorney General",
          controlledCommitteeId: "9876543",
          controlledCommitteeName: "Bonta for Attorney General 2026",
          sourceUrl: null,
          lastSyncedAt: "2026-01-01 00:00:00+00",
        },
      ],
    });

    const sql = String(db.query.mock.calls[0]?.[0]);
    expect(sql).toContain("FROM public.ca_candidate_finance_links AS link");
    expect(sql).toContain("link.link_status = 'active'");
    expect(sql).toContain("district.state = 'CA'");
    expect(sql).toContain("election.race_type = 'office'");
    expect(sql).toContain("election.election_date >= (($1::timestamptz AT TIME ZONE 'UTC')::date - make_interval(days => $4::int))");
    expect(sql).toContain("candidate_election.status NOT IN ('withdrawn', 'lost')");
    expect(db.query.mock.calls[0]?.[1]).toEqual([
      "2026-06-01T00:00:00.000Z",
      7,
      25,
      30,
      730,
    ]);
  });

  it("uses a one-day post-election grace window by default for due selection", async () => {
    const db = createMockDb();

    await syncDueCaliforniaCandidateFinance({
      db,
      syncCaliforniaCandidateFinanceFn: vi.fn(),
      now: new Date("2026-06-01T00:00:00.000Z"),
    });

    expect(String(db.query.mock.calls[0]?.[0])).toContain(
      "election.election_date >= (($1::timestamptz AT TIME ZONE 'UTC')::date - make_interval(days => $4::int))"
    );
    expect(db.query.mock.calls[0]?.[1]).toEqual([
      "2026-06-01T00:00:00.000Z",
      7,
      25,
      1,
      730,
    ]);
  });

  it("syncs selected due links and continues after individual failures", async () => {
    const db = createMockDb([
      {
        candidate_id: CANDIDATE_ID,
        election_id: ELECTION_ID,
        candidate_name: "Gavin Newsom",
        election_year: 2026,
        office_name: "Governor",
        controlled_committee_id: "1456045",
        controlled_committee_name: "Newsom for California Governor 2026",
        source_url: "https://powersearch.sos.ca.gov/",
        last_synced_at: null,
        total_due_rows: "2",
      },
      {
        candidate_id: "33333333-3333-4333-8333-333333333333",
        election_id: "44444444-4444-4444-8444-444444444444",
        candidate_name: "Rob Bonta",
        election_year: 2026,
        office_name: "Attorney General",
        controlled_committee_id: "9876543",
        controlled_committee_name: "Bonta for Attorney General 2026",
        source_url: null,
        last_synced_at: null,
        total_due_rows: "2",
      },
    ]);
    const syncCaliforniaCandidateFinanceFn = vi
      .fn()
      .mockResolvedValueOnce({
        candidateId: CANDIDATE_ID,
        electionId: ELECTION_ID,
        electionYear: 2026,
        dryRun: false,
        outsideIncluded: true,
        linkWritten: true,
        summaryWritten: true,
        directBreakdownsWritten: 0,
        outsideGroupsWritten: 1,
        outsideGroupBreakdownsWritten: 0,
        outsideSupportTotal: 1000,
        outsideOpposeTotal: 0,
      })
      .mockRejectedValueOnce(new Error("Power Search unavailable"));

    const result = await syncDueCaliforniaCandidateFinance({
      db,
      syncCaliforniaCandidateFinanceFn,
      now: new Date("2026-06-01T00:00:00.000Z"),
      includeOutside: true,
      maxCandidates: 2,
      staleAfterDays: 3,
      electionLookbackDays: 30,
      powerSearchOptions: { timeoutMs: 1000 },
      rawDataResolutionData: null,
    });

    expect(result).toMatchObject({
      dryRun: false,
      includeOutside: true,
      now: "2026-06-01T00:00:00.000Z",
      staleAfterDays: 3,
      maxCandidates: 2,
      dueCandidateCount: 2,
      selectedCandidateCount: 2,
      syncedCandidateCount: 1,
      failedCandidateCount: 1,
    });
    expect(result.results[0]).toMatchObject({ ok: true, controlledCommitteeId: "1456045" });
    expect(result.results[1]).toMatchObject({
      ok: false,
      controlledCommitteeId: "9876543",
      error: "Power Search unavailable",
    });
    expect(syncCaliforniaCandidateFinanceFn).toHaveBeenCalledTimes(2);
    expect(syncCaliforniaCandidateFinanceFn).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: CANDIDATE_ID,
        electionId: ELECTION_ID,
        candidateName: "Gavin Newsom",
        electionYear: 2026,
        officeName: "Governor",
        controlledCommitteeId: "1456045",
        controlledCommitteeName: "Newsom for California Governor 2026",
        sourceUrl: "https://powersearch.sos.ca.gov/",
        includeOutside: true,
        powerSearchOptions: { timeoutMs: 1000 },
        directReceiptRows: undefined,
        controlledCommitteeFilingIds: undefined,
      })
    );
    expect(db.query.mock.calls[0]?.[1]).toEqual([
      "2026-06-01T00:00:00.000Z",
      3,
      2,
      30,
      730,
    ]);
  });

  it("auto-links missing California finance links and passes cached direct receipt rows into sync", async () => {
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              candidate_id: CANDIDATE_ID,
              election_id: ELECTION_ID,
              candidate_name: "Gavin Newsom",
              election_year: 2026,
              office_name: "Governor",
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ id: "55555555-5555-4555-8555-555555555555" }] })
        .mockResolvedValueOnce({
          rows: [
            {
              candidate_id: CANDIDATE_ID,
              election_id: ELECTION_ID,
              candidate_name: "Gavin Newsom",
              election_year: 2026,
              office_name: "Governor",
              controlled_committee_id: "1456045",
              controlled_committee_name: "Newsom for California Governor 2026",
              source_url: "https://campaignfinance.cdn.sos.ca.gov/dbwebexport.zip",
              last_synced_at: null,
              total_due_rows: "1",
            },
          ],
        }),
    };
    const syncCaliforniaCandidateFinanceFn = vi.fn().mockResolvedValue({
      candidateId: CANDIDATE_ID,
      electionId: ELECTION_ID,
      electionYear: 2026,
      dryRun: false,
      outsideIncluded: true,
      linkWritten: true,
      summaryWritten: true,
      directBreakdownsWritten: 3,
      outsideGroupsWritten: 0,
      outsideGroupBreakdownsWritten: 0,
      outsideSupportTotal: null,
      outsideOpposeTotal: null,
    });
    const financeIndustryClassifier = vi.fn();
    const receiptRow = { CMTE_ID: "1456045", FILING_ID: "F1", AMOUNT: "100.00" };

    await syncDueCaliforniaCandidateFinance({
      db,
      syncCaliforniaCandidateFinanceFn,
      now: new Date("2026-06-01T00:00:00.000Z"),
      financeIndustryClassifier,
      aiClassificationMinAmount: 100_000,
      rawDataResolutionData: {
        zipPath: "/tmp/dbwebexport.zip",
        sourceUrl: "https://campaignfinance.cdn.sos.ca.gov/dbwebexport.zip",
        campaignCoverRows: [
          {
            FILING_ID: "F1",
            FILER_ID: "1456045",
            FILER_NAML: "Newsom for California Governor 2026",
            ELECT_DATE: "11/3/2026 12:00:00 AM",
            CAND_NAML: "NEWSOM",
            CAND_NAMF: "GAVIN",
            OFFICE_CD: "GOV",
            OFFIC_DSCR: "Governor",
          },
        ],
        filerNameRows: [],
      },
      rawDataReceiptData: {
        zipPath: "/tmp/dbwebexport.zip",
        sourceUrl: "https://campaignfinance.cdn.sos.ca.gov/dbwebexport.zip",
        receiptRowsByCommitteeId: new Map([["1456045", [receiptRow]]]),
        controlledCommitteeFilingIdsByCommitteeId: new Map([["1456045", ["F1"]]]),
      },
    });

    expect(String(db.query.mock.calls[0]?.[0])).toContain("FROM public.candidate_elections AS candidate_election");
    expect(String(db.query.mock.calls[0]?.[0])).toContain(
      "(office.scope || '::' || office.canonical_name) = ANY($5::text[])"
    );
    expect(db.query.mock.calls[0]?.[1]).toEqual([
      "2026-06-01T00:00:00.000Z",
      25,
      1,
      730,
      expect.arrayContaining([
        "statewide::Governor",
        "statewide::State Board of Equalization Member",
        "state_upper::State Senator",
        "state_lower::State Lower Chamber Legislator",
      ]),
    ]);
    expect(db.query.mock.calls[0]?.[1]?.[4]).not.toContain("statewide::United States Senator");
    expect(String(db.query.mock.calls[1]?.[0])).toContain("INSERT INTO public.ca_candidate_finance_links");
    expect(String(db.query.mock.calls[2]?.[0])).toContain("FROM public.ca_candidate_finance_links AS link");
    expect(syncCaliforniaCandidateFinanceFn).toHaveBeenCalledWith(
      expect.objectContaining({
        directReceiptRows: [receiptRow],
        controlledCommitteeFilingIds: ["F1"],
        directSourceUrl: "https://campaignfinance.cdn.sos.ca.gov/dbwebexport.zip",
        loadOutsideReceiptRowsForCommittees: expect.any(Function),
        financeIndustryClassifier,
        aiClassificationMinAmount: 100_000,
      })
    );
  });

  it("never auto-links (no link writes) in dry-run mode", async () => {
    const db = createMockDb([]);
    const syncCaliforniaCandidateFinanceFn = vi.fn();

    await syncDueCaliforniaCandidateFinance({
      db,
      syncCaliforniaCandidateFinanceFn,
      now: new Date("2026-06-01T00:00:00.000Z"),
      dryRun: true,
      rawDataResolutionData: {
        zipPath: "/tmp/dbwebexport.zip",
        sourceUrl: "https://campaignfinance.cdn.sos.ca.gov/dbwebexport.zip",
        campaignCoverRows: [
          {
            FILING_ID: "F1",
            FILER_ID: "1456045",
            FILER_NAML: "Newsom for California Governor 2026",
            ELECT_DATE: "11/3/2026 12:00:00 AM",
            CAND_NAML: "NEWSOM",
            CAND_NAMF: "GAVIN",
            OFFICE_CD: "GOV",
            OFFIC_DSCR: "Governor",
          },
        ],
        filerNameRows: [],
      },
      rawDataReceiptData: {
        zipPath: "/tmp/dbwebexport.zip",
        sourceUrl: "https://campaignfinance.cdn.sos.ca.gov/dbwebexport.zip",
        receiptRowsByCommitteeId: new Map(),
        controlledCommitteeFilingIdsByCommitteeId: new Map(),
      },
    });

    for (const call of db.query.mock.calls) {
      expect(String(call[0])).not.toContain("FROM public.candidate_elections AS candidate_election");
      expect(String(call[0])).not.toContain("INSERT INTO public.ca_candidate_finance_links");
    }
  });

  it("caches CAL-ACCESS receipt loads across overlapping outside committee requests", async () => {
    const rowA = { CMTE_ID: "A1", FILING_ID: "FA", AMOUNT: "100.00" };
    const rowB = { CMTE_ID: "B2", FILING_ID: "FB", AMOUNT: "200.00" };
    const rowC = { CMTE_ID: "C3", FILING_ID: "FC", AMOUNT: "300.00" };
    const load = vi.fn(async (committeeIds: readonly string[]) => ({
      zipPath: "/tmp/dbwebexport.zip",
      sourceUrl: "https://campaignfinance.cdn.sos.ca.gov/dbwebexport.zip",
      receiptRowsByCommitteeId: new Map(
        committeeIds.flatMap((committeeId) => {
          if (committeeId === "A1") {
            return [[committeeId, [rowA]]];
          }
          if (committeeId === "B2") {
            return [[committeeId, [rowB]]];
          }
          if (committeeId === "C3") {
            return [[committeeId, [rowC]]];
          }
          return [];
        })
      ),
      controlledCommitteeFilingIdsByCommitteeId: new Map(
        committeeIds.flatMap((committeeId) => {
          if (committeeId === "A1") {
            return [[committeeId, ["FA"]]];
          }
          if (committeeId === "B2") {
            return [[committeeId, ["FB"]]];
          }
          if (committeeId === "C3") {
            return [[committeeId, ["FC"]]];
          }
          return [];
        })
      ),
    }));
    const cachedLoad = createCalAccessReceiptRowsForCommitteesCache({ load });

    const first = await cachedLoad([" a1 ", "B2"]);
    const second = await cachedLoad(["b2", "C3"]);
    const third = await cachedLoad(["D4"]);
    const fourth = await cachedLoad(["d4"]);

    expect(load).toHaveBeenCalledTimes(3);
    expect(load.mock.calls[0]?.[0]).toEqual(["A1", "B2"]);
    expect(load.mock.calls[1]?.[0]).toEqual(["C3"]);
    expect(load.mock.calls[2]?.[0]).toEqual(["D4"]);
    expect(first?.receiptRowsByCommitteeId.get("A1")).toEqual([rowA]);
    expect(first?.receiptRowsByCommitteeId.get("B2")).toEqual([rowB]);
    expect(second?.receiptRowsByCommitteeId.get("B2")).toEqual([rowB]);
    expect(second?.receiptRowsByCommitteeId.get("C3")).toEqual([rowC]);
    expect(third?.receiptRowsByCommitteeId.size).toBe(0);
    expect(fourth?.receiptRowsByCommitteeId.size).toBe(0);
  });

  it("rejects invalid batch options before querying", async () => {
    const db = createMockDb();

    await expect(
      syncDueCaliforniaCandidateFinance({
        db,
        maxCandidates: 0,
      })
    ).rejects.toThrow("Invalid California finance batch sync maxCandidates");
    expect(db.query).not.toHaveBeenCalled();
  });
});
