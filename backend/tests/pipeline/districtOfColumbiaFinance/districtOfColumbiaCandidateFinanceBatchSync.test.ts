import { describe, expect, it, vi } from "vitest";

import {
  listDueDistrictOfColumbiaCandidateFinanceSyncRows,
  syncDueDistrictOfColumbiaCandidateFinance,
  type DistrictOfColumbiaOcfDataForYear,
} from "../../../src/pipeline/districtOfColumbiaFinance/districtOfColumbiaCandidateFinanceBatchSync.js";
import type { DistrictOfColumbiaCandidateFinanceSyncResult } from "../../../src/pipeline/districtOfColumbiaFinance/districtOfColumbiaCandidateFinanceSync.js";
import type {
  DistrictOfColumbiaOcfContributionRecord,
  DistrictOfColumbiaOcfExpenditureRecord,
} from "../../../src/pipeline/districtOfColumbiaFinance/districtOfColumbiaOcfClient.js";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const SOURCE_URL = "https://efiling.ocf.dc.gov/DataDownload";
const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";

function dueRow(overrides: Record<string, unknown> = {}) {
  return {
    candidate_id: CANDIDATE_ID,
    election_id: ELECTION_ID,
    candidate_name: "Jane Doe",
    election_year: 2026,
    office_scope: "place",
    office_name: "Mayor",
    district: null,
    committee_key: "COMMITTEE TO ELECT JANE DOE",
    committee_name: "Committee To Elect Jane Doe",
    source_url: SOURCE_URL,
    last_synced_at: null,
    total_due_rows: "1",
    ...overrides,
  };
}

function contribution(overrides: Partial<DistrictOfColumbiaOcfContributionRecord> = {}): DistrictOfColumbiaOcfContributionRecord {
  return {
    committeeName: "Committee To Elect Jane Doe",
    committeeKey: "COMMITTEE TO ELECT JANE DOE",
    candidateName: "Jane Doe",
    contributorName: "Pat Person",
    contributorType: "Individual",
    occupation: "Attorney",
    amount: 100,
    date: "02/01/2026",
    ...overrides,
  };
}

function expenditure(overrides: Partial<DistrictOfColumbiaOcfExpenditureRecord> = {}): DistrictOfColumbiaOcfExpenditureRecord {
  return {
    committeeName: "DCCSA IEC",
    committeeKey: "DCCSA IEC",
    purpose: "Independent Expenditures",
    furtherExplanation: "Digital ads supporting Jane Doe",
    amount: 500,
    date: "05/01/2026",
    ...overrides,
  };
}

function ocfDataForYear(overrides: Partial<DistrictOfColumbiaOcfDataForYear> = {}): DistrictOfColumbiaOcfDataForYear {
  return {
    year: 2026,
    sourceUrl: SOURCE_URL,
    principalContributionRecords: [contribution()],
    independentExpenditureRecords: [expenditure()],
    independentExpenditureContributionRecords: [
      contribution({
        committeeName: "DCCSA IEC",
        committeeKey: "DCCSA IEC",
        contributorName: "Guzman Construction Solutions LLC",
        contributorType: "Business Entity",
        amount: 35_000,
      }),
    ],
    ...overrides,
  };
}

function successfulSync(overrides: Partial<DistrictOfColumbiaCandidateFinanceSyncResult> = {}): DistrictOfColumbiaCandidateFinanceSyncResult {
  return {
    candidateId: CANDIDATE_ID,
    electionId: ELECTION_ID,
    electionYear: 2026,
    dryRun: false,
    resolution: {
      status: "matched",
      committeeKey: "COMMITTEE TO ELECT JANE DOE",
      committeeName: "Committee To Elect Jane Doe",
      confidence: "exact",
      source: "ocf_export",
      sourceUrl: SOURCE_URL,
      matchedContributionRowCount: 1,
    },
    linkWritten: true,
    summaryWritten: true,
    directBreakdownsWritten: 2,
    outsideGroupsWritten: 1,
    outsideGroupBreakdownsWritten: 2,
    totalReceipts: 100,
    directContributionTotal: 100,
    totalDisbursements: null,
    outsideSupportTotal: 500,
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
    ...overrides,
  };
}

describe("districtOfColumbiaCandidateFinanceBatchSync", () => {
  it("lists active D.C. finance links that are due for sync", async () => {
    const db = {
      query: vi.fn(async () => ({
        rows: [
          dueRow({ total_due_rows: "2" }),
          dueRow({
            candidate_id: "33333333-3333-4333-8333-333333333333",
            election_id: "44444444-4444-4444-8444-444444444444",
            candidate_name: "John Smith",
            election_year: 2026,
            office_scope: "place",
            office_name: "City Council Member",
            district: "WARD 4",
            committee_key: "JOHN SMITH FOR WARD 4",
            committee_name: "John Smith for Ward 4",
            source_url: null,
            last_synced_at: "2026-01-01 00:00:00+00",
            total_due_rows: "2",
          }),
        ],
        rowCount: 2,
      })),
    };

    await expect(
      listDueDistrictOfColumbiaCandidateFinanceSyncRows(db, {
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
          candidateName: "Jane Doe",
          electionYear: 2026,
          officeScope: "place",
          officeName: "Mayor",
          district: null,
          committeeKey: "COMMITTEE TO ELECT JANE DOE",
          committeeName: "Committee To Elect Jane Doe",
          sourceUrl: SOURCE_URL,
          lastSyncedAt: null,
        },
        {
          candidateId: "33333333-3333-4333-8333-333333333333",
          electionId: "44444444-4444-4444-8444-444444444444",
          candidateName: "John Smith",
          electionYear: 2026,
          officeScope: "place",
          officeName: "City Council Member",
          district: "WARD 4",
          committeeKey: "JOHN SMITH FOR WARD 4",
          committeeName: "John Smith for Ward 4",
          sourceUrl: null,
          lastSyncedAt: "2026-01-01 00:00:00+00",
        },
      ],
    });

    const sql = String(db.query.mock.calls[0]?.[0]);
    expect(sql).toContain("FROM public.dc_candidate_finance_links AS link");
    expect(sql).toContain("link.link_status = 'active'");
    expect(sql).toContain("district.state = 'DC'");
    expect(sql).toContain("election.race_type = 'office'");
    expect(sql).toContain("candidate_election.status NOT IN ('withdrawn', 'lost')");
    expect(sql).toContain("(office.scope || '::' || office.canonical_name) = ANY($6::text[])");
    expect(db.query.mock.calls[0]?.[1]).toEqual([
      "2026-06-01T00:00:00.000Z",
      7,
      25,
      1,
      730,
      expect.arrayContaining(["place::Mayor", "place::City Council Member", "statewide::Attorney General"]),
    ]);
  });

  it("uses one post-election grace day by default", async () => {
    const db = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })), connect: vi.fn() };
    const syncDistrictOfColumbiaCandidateFinanceFn = vi.fn();

    await syncDueDistrictOfColumbiaCandidateFinance({
      db,
      now: NOW,
      autoLinkMissingLinks: false,
      syncDistrictOfColumbiaCandidateFinanceFn: syncDistrictOfColumbiaCandidateFinanceFn as never,
    });

    expect(db.query.mock.calls[0]?.[1]).toEqual([
      "2026-06-01T00:00:00.000Z",
      7,
      25,
      1,
      730,
      expect.any(Array),
    ]);
    expect(syncDistrictOfColumbiaCandidateFinanceFn).not.toHaveBeenCalled();
  });

  it("syncs selected due candidates with trusted linked committees and continues after a candidate failure", async () => {
    const db = {
      query: vi.fn(async () => ({
        rows: [
          dueRow({ total_due_rows: "2" }),
          dueRow({
            candidate_id: "33333333-3333-4333-8333-333333333333",
            election_id: "44444444-4444-4444-8444-444444444444",
            candidate_name: "John Smith",
            committee_key: "JOHN SMITH FOR MAYOR",
            committee_name: "John Smith for Mayor",
            source_url: null,
            total_due_rows: "2",
          }),
        ],
        rowCount: 2,
      })),
      connect: vi.fn(),
    };
    const syncDistrictOfColumbiaCandidateFinanceFn = vi
      .fn()
      .mockResolvedValueOnce(successfulSync())
      .mockRejectedValueOnce(new Error("OCF parse failed"));
    const data = ocfDataForYear();

    const result = await syncDueDistrictOfColumbiaCandidateFinance({
      db,
      now: NOW,
      maxCandidates: 2,
      staleAfterDays: 3,
      electionLookbackDays: 30,
      autoLinkMissingLinks: false,
      syncDistrictOfColumbiaCandidateFinanceFn: syncDistrictOfColumbiaCandidateFinanceFn as never,
      ocfDataByYear: new Map([[2026, data]]),
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
    expect(result.results[0]).toMatchObject({ ok: true, result: successfulSync() });
    expect(result.results[1]).toMatchObject({ ok: false, error: "OCF parse failed" });
    expect(syncDistrictOfColumbiaCandidateFinanceFn).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: CANDIDATE_ID,
        electionId: ELECTION_ID,
        candidateName: "Jane Doe",
        electionYear: 2026,
        officeScope: "place",
        officeName: "Mayor",
        district: null,
        sourceUrl: SOURCE_URL,
        contributionRecords: data.principalContributionRecords,
        expenditureRecords: data.independentExpenditureRecords,
        outsideContributionRecords: data.independentExpenditureContributionRecords,
        trustedCommittee: {
          committeeKey: "COMMITTEE TO ELECT JANE DOE",
          committeeName: "Committee To Elect Jane Doe",
          sourceUrl: SOURCE_URL,
        },
        dryRun: false,
        now: NOW,
      })
    );
  });

  it("auto-links missing eligible candidate elections from preloaded OCF rows before selecting due links", async () => {
    const db = {
      query: vi.fn(async (sql: string) => {
        const text = String(sql);
        if (text.includes("FROM public.candidate_elections AS candidate_election") && !text.includes("WITH due AS")) {
          return {
            rows: [
              {
                candidate_id: CANDIDATE_ID,
                election_id: ELECTION_ID,
                candidate_name: "Jane Doe",
                election_year: 2026,
                office_scope: "place",
                office_name: "Mayor",
                seat_text: "Mayor District of Columbia",
              },
            ],
            rowCount: 1,
          };
        }
        if (text.includes("INSERT INTO public.dc_candidate_finance_links")) {
          return { rows: [{ id: "link-1" }], rowCount: 1 };
        }
        if (text.includes("FROM public.dc_candidate_finance_links AS link")) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      }),
      connect: vi.fn(),
    };

    const result = await syncDueDistrictOfColumbiaCandidateFinance({
      db,
      now: NOW,
      maxCandidates: 5,
      syncDistrictOfColumbiaCandidateFinanceFn: vi.fn() as never,
      ocfDataByYear: new Map([[2026, ocfDataForYear()]]),
    });

    expect(result).toMatchObject({
      dueCandidateCount: 0,
      selectedCandidateCount: 0,
      autoLinkAttemptedCount: 1,
      autoLinkLinkedCount: 1,
    });
    expect(db.query.mock.calls.some((call) => String(call[0]).includes("INSERT INTO public.dc_candidate_finance_links"))).toBe(
      true
    );
    expect(db.query.mock.calls.find((call) => String(call[0]).includes("INSERT INTO public.dc_candidate_finance_links"))?.[1]).toEqual([
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

  it("does not warn for expected unmatched auto-link results", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = {
      query: vi.fn(async (sql: string) => {
        const text = String(sql);
        if (text.includes("FROM public.candidate_elections AS candidate_election") && !text.includes("WITH due AS")) {
          return {
            rows: [
              {
                candidate_id: CANDIDATE_ID,
                election_id: ELECTION_ID,
                candidate_name: "Jane Doe",
                election_year: 2026,
                office_scope: "place",
                office_name: "Mayor",
                seat_text: "Mayor District of Columbia",
              },
            ],
            rowCount: 1,
          };
        }
        if (text.includes("FROM public.dc_candidate_finance_links AS link")) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      }),
      connect: vi.fn(),
    };

    const result = await syncDueDistrictOfColumbiaCandidateFinance({
      db,
      now: NOW,
      maxCandidates: 5,
      syncDistrictOfColumbiaCandidateFinanceFn: vi.fn() as never,
      resolveCandidateCommittee: async () => ({
        status: "unmatched",
        reason: "no_candidate_committee_match",
        candidateNameNormalized: "JANE DOE",
        officeNameNormalized: "Mayor",
      }),
    });

    expect(result).toMatchObject({
      autoLinkAttemptedCount: 1,
      autoLinkLinkedCount: 0,
    });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("adds Fair Elections rows to the sync and fails only Fair Elections links when that source is down", async () => {
    const db = {
      query: vi.fn(async () => ({
        rows: [
          dueRow({ total_due_rows: "2" }),
          dueRow({
            candidate_id: "33333333-3333-4333-8333-333333333333",
            election_id: "44444444-4444-4444-8444-444444444444",
            candidate_name: "Brian Schwalb",
            office_scope: "statewide",
            office_name: "Attorney General",
            committee_key: "DC FAIR ELECTIONS 159",
            committee_name: "Brian for DC 2026",
            source_url: "https://fairelections.ocf.dc.gov/public/Contributions",
            total_due_rows: "2",
          }),
        ],
        rowCount: 2,
      })),
      connect: vi.fn(),
    };
    const fairElectionsRecord = contribution({
      committeeName: "Brian for DC 2026",
      committeeKey: "DC FAIR ELECTIONS 159",
      candidateName: "Brian L. Schwalb",
      receiptKind: "public_funds",
      amount: 3000,
    });
    const fairElectionsExpenditure = { committeeKey: "DC FAIR ELECTIONS 159", committeeName: "Brian for DC 2026", amount: 10 };
    const syncFn = vi.fn().mockResolvedValue(successfulSync());

    const healthy = await syncDueDistrictOfColumbiaCandidateFinance({
      db,
      now: NOW,
      maxCandidates: 2,
      autoLinkMissingLinks: false,
      syncDistrictOfColumbiaCandidateFinanceFn: syncFn as never,
      ocfDataByYear: new Map([
        [
          2026,
          ocfDataForYear({
            fairElectionsContributionRecords: [fairElectionsRecord],
            fairElectionsExpenditureRecords: [fairElectionsExpenditure],
          }),
        ],
      ]),
    });
    expect(healthy.syncedCandidateCount).toBe(2);
    expect(syncFn).toHaveBeenCalledWith(
      expect.objectContaining({
        contributionRecords: [contribution(), fairElectionsRecord],
        committeeExpenditureRecords: [fairElectionsExpenditure],
      })
    );

    syncFn.mockClear();
    const down = await syncDueDistrictOfColumbiaCandidateFinance({
      db,
      now: NOW,
      maxCandidates: 2,
      autoLinkMissingLinks: false,
      syncDistrictOfColumbiaCandidateFinanceFn: syncFn as never,
      ocfDataByYear: new Map([[2026, ocfDataForYear({ fairElectionsLoadError: "Fair Elections 503" })]]),
    });
    expect(down).toMatchObject({ syncedCandidateCount: 1, failedCandidateCount: 1 });
    expect(down.results[1]).toMatchObject({ committeeKey: "DC FAIR ELECTIONS 159", ok: false, error: "Fair Elections 503" });
    expect(syncFn).toHaveBeenCalledTimes(1);
  });

  it("validates batch options", async () => {
    const db = { query: vi.fn(), connect: vi.fn() };

    await expect(
      syncDueDistrictOfColumbiaCandidateFinance({
        db,
        maxCandidates: 0,
      })
    ).rejects.toThrow("Invalid D.C. finance batch sync maxCandidates");

    expect(db.query).not.toHaveBeenCalled();
  });
});
