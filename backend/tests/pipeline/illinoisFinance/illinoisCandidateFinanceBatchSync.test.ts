import { describe, expect, it, vi } from "vitest";

import {
  type IllinoisCandidateFinanceData,
  listDueIllinoisCandidateFinanceSyncRows,
  loadIllinoisFinanceDataForDueRow,
  syncDueIllinoisCandidateFinance,
} from "../../../src/pipeline/illinoisFinance/illinoisCandidateFinanceBatchSync.js";
import {
  createIllinoisSbeArtifactCandidateCommitteeResolver,
  loadIllinoisFinanceDataForDueRowFromArtifacts,
} from "../../../src/pipeline/illinoisFinance/illinoisSbeArtifactDataSource.js";
import type { IllinoisCandidateFinanceSyncInput, IllinoisCandidateFinanceSyncResult } from "../../../src/pipeline/illinoisFinance/syncIllinoisCandidateFinance.js";
import type { IllinoisSbeContributionRecord } from "../../../src/pipeline/illinoisFinance/illinoisSbeClient.js";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";
const SOURCE_URL = "https://www.elections.il.gov/CampaignDisclosure/ContributionSearchByCommittees.aspx";

function dueRow(overrides: Record<string, unknown> = {}) {
  return {
    candidate_id: CANDIDATE_ID,
    election_id: ELECTION_ID,
    candidate_name: "Jane Doe",
    election_year: 2026,
    office_scope: "statewide",
    office_name: "Governor",
    district: null,
    sbe_candidate_id: null,
    sbe_district_type: null,
    sbe_office: null,
    is_at_large: null,
    committee_key: "FRIENDS OF JANE DOE",
    committee_name: "Friends of Jane Doe",
    source_url: SOURCE_URL,
    last_synced_at: null,
    total_due_rows: "1",
    ...overrides,
  };
}

function contribution(overrides: Partial<IllinoisSbeContributionRecord> = {}): IllinoisSbeContributionRecord {
  return {
    contributorName: "Pat Person",
    contributorAddress: "1 Main St",
    occupation: "Attorney",
    employer: "Law LLP",
    amount: 250,
    receivedDate: "3/1/2026",
    reportReceivedDate: null,
    contributionType: "Individual Contributions",
    recipientCommitteeName: "Friends of Jane Doe",
    description: null,
    vendorName: null,
    vendorAddress: null,
    sourceUrl: SOURCE_URL,
    ...overrides,
  };
}

function successfulSync(overrides: Partial<IllinoisCandidateFinanceSyncResult> = {}): IllinoisCandidateFinanceSyncResult {
  return {
    candidateId: CANDIDATE_ID,
    electionId: ELECTION_ID,
    electionYear: 2026,
    dryRun: false,
    linkWritten: true,
    summaryWritten: true,
    directBreakdownsWritten: 2,
    outsideGroupsWritten: 0,
    outsideGroupBreakdownsWritten: 0,
    totalReceipts: 250,
    directContributionTotal: 250,
    totalDisbursements: null,
    cashOnHand: null,
    debtsOwed: null,
    outsideExpenditureDataAvailable: true,
    outsideGroupContributionDataAvailable: true,
    outsideSupportTotal: 0,
    outsideOpposeTotal: 0,
    matchedContributionRowCount: 1,
    includedContributionRowCount: 1,
    skippedContributionRowCount: 0,
    matchedOutsideExpenditureRowCount: 0,
    includedOutsideExpenditureRowCount: 0,
    skippedOutsideExpenditureRowCount: 0,
    matchedOutsideContributionRowCount: 0,
    includedOutsideContributionRowCount: 0,
    skippedOutsideContributionRowCount: 0,
    ...overrides,
  };
}

describe("illinoisCandidateFinanceBatchSync", () => {
  it("lists active Illinois finance links that are due for sync", async () => {
    const db = {
      query: vi.fn(async () => ({
        rows: [
          dueRow({ total_due_rows: "2" }),
          dueRow({
            candidate_id: "33333333-3333-4333-8333-333333333333",
            election_id: "44444444-4444-4444-8444-444444444444",
            candidate_name: "John Smith",
            office_scope: "state_lower",
            office_name: "State Lower Chamber Legislator",
            district: "44",
            committee_key: "FRIENDS OF JOHN SMITH",
            committee_name: "Friends of John Smith",
            source_url: null,
            last_synced_at: "2026-01-01 00:00:00+00",
            total_due_rows: "2",
          }),
        ],
        rowCount: 2,
      })),
    };

    await expect(
      listDueIllinoisCandidateFinanceSyncRows(db, {
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
          officeScope: "statewide",
          officeName: "Governor",
          district: null,
          sbeCandidateId: null,
          sbeDistrictType: null,
          sbeOffice: null,
          isAtLarge: null,
          committeeKey: "FRIENDS OF JANE DOE",
          committeeName: "Friends of Jane Doe",
          sourceUrl: SOURCE_URL,
          lastSyncedAt: null,
        },
        {
          candidateId: "33333333-3333-4333-8333-333333333333",
          electionId: "44444444-4444-4444-8444-444444444444",
          candidateName: "John Smith",
          electionYear: 2026,
          officeScope: "state_lower",
          officeName: "State Lower Chamber Legislator",
          district: "44",
          sbeCandidateId: null,
          sbeDistrictType: null,
          sbeOffice: null,
          isAtLarge: null,
          committeeKey: "FRIENDS OF JOHN SMITH",
          committeeName: "Friends of John Smith",
          sourceUrl: null,
          lastSyncedAt: "2026-01-01 00:00:00+00",
        },
      ],
    });

    const sql = String(db.query.mock.calls[0]?.[0]);
    expect(sql).toContain("FROM public.il_candidate_finance_links AS link");
    expect(sql).toContain("link.link_status = 'active'");
    expect(sql).toContain("district.state = 'IL'");
    expect(sql).toContain("(office.scope || '::' || office.canonical_name) = ANY($6::text[])");
    expect(db.query.mock.calls[0]?.[1]).toEqual([
      "2026-06-01T00:00:00.000Z",
      7,
      25,
      1,
      730,
      expect.arrayContaining(["statewide::Governor", "state_lower::State Lower Chamber Legislator"]),
    ]);
  });

  it("uses one post-election grace day by default", async () => {
    const db = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })), connect: vi.fn() };
    const syncIllinoisCandidateFinanceFn = vi.fn();

    await syncDueIllinoisCandidateFinance({
      db,
      now: NOW,
      autoLinkMissingLinks: false,
      syncIllinoisCandidateFinanceFn: syncIllinoisCandidateFinanceFn as never,
    });

    expect(db.query.mock.calls[0]?.[1]).toEqual([
      "2026-06-01T00:00:00.000Z",
      7,
      25,
      1,
      730,
      expect.any(Array),
    ]);
    expect(syncIllinoisCandidateFinanceFn).not.toHaveBeenCalled();
  });

  it("fails closed when a due row cannot be mapped to an SBE office search", async () => {
    await expect(
      loadIllinoisFinanceDataForDueRow({
        candidateId: CANDIDATE_ID,
        electionId: ELECTION_ID,
        candidateName: "Jane Doe",
        electionYear: 2026,
        officeScope: "state_upper",
        officeName: "State Senator",
        district: "HD 07",
        committeeKey: "FRIENDS OF JANE DOE",
        committeeName: "Friends of Jane Doe",
        sourceUrl: SOURCE_URL,
        lastSyncedAt: null,
      })
    ).rejects.toThrow("Illinois finance due row cannot be mapped to an SBE office search");
  });

  it("syncs selected due candidates and continues after a candidate failure", async () => {
    const db = {
      query: vi.fn(async () => ({
        rows: [
          dueRow({ total_due_rows: "2" }),
          dueRow({
            candidate_id: "33333333-3333-4333-8333-333333333333",
            election_id: "44444444-4444-4444-8444-444444444444",
            committee_key: "FRIENDS OF JOHN SMITH",
            committee_name: "Friends of John Smith",
            total_due_rows: "2",
          }),
        ],
        rowCount: 2,
      })),
      connect: vi.fn(),
    };
    const loadIllinoisFinanceDataFn = vi.fn(async () => ({
      directContributionRecords: [contribution()],
      outsideExpenditureRecords: [],
      outsideGroupContributionRecords: [],
      directContributionSourceUrl: SOURCE_URL,
    }));
    const syncIllinoisCandidateFinanceFn = vi
      .fn()
      .mockResolvedValueOnce(successfulSync())
      .mockRejectedValueOnce(new Error("SBE parse failed"));

    const result = await syncDueIllinoisCandidateFinance({
      db,
      now: NOW,
      maxCandidates: 2,
      staleAfterDays: 3,
      electionLookbackDays: 30,
      autoLinkMissingLinks: false,
      loadIllinoisFinanceDataFn,
      syncIllinoisCandidateFinanceFn: syncIllinoisCandidateFinanceFn as never,
    });

    expect(result).toMatchObject({
      dryRun: false,
      staleAfterDays: 3,
      maxCandidates: 2,
      dueCandidateCount: 2,
      selectedCandidateCount: 2,
      syncedCandidateCount: 1,
      failedCandidateCount: 1,
      autoLinkAttemptedCount: 0,
      autoLinkLinkedCount: 0,
    });
    expect(loadIllinoisFinanceDataFn).toHaveBeenCalledTimes(2);
    expect(syncIllinoisCandidateFinanceFn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        candidateId: CANDIDATE_ID,
        committeeKey: "FRIENDS OF JANE DOE",
        committeeName: "Friends of Jane Doe",
        directContributionRecords: [contribution()],
        dryRun: false,
      })
    );
    expect(result.results[1]).toMatchObject({
      candidateId: "33333333-3333-4333-8333-333333333333",
      ok: false,
      error: "SBE parse failed",
    });
  });

  it("auto-links missing candidates before listing due rows when enabled", async () => {
    const txQuery = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: "link-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const txClient = { query: txQuery, release: vi.fn() };
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              candidate_id: CANDIDATE_ID,
              election_id: ELECTION_ID,
              candidate_name: "Jane Doe",
              election_year: 2026,
              office_scope: "statewide",
              office_name: "Governor",
              district: null,
            },
          ],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }),
      connect: vi.fn(async () => txClient as never),
    };

    const result = await syncDueIllinoisCandidateFinance({
      db,
      now: NOW,
      maxCandidates: 1,
      resolveCandidateCommittee: vi.fn(async () => ({
        status: "matched",
        matches: [
          {
            committeeKey: "FRIENDS OF JANE DOE",
            committeeName: "Friends of Jane Doe",
            confidence: "name_fallback",
            source: "illinois_sbe",
            sourceUrl: SOURCE_URL,
            matchedContributionRowCount: 1,
            sbeCandidateId: null,
            sbeCommitteeId: null,
            sbeDistrictType: null,
            sbeOffice: null,
            district: null,
            isAtLarge: null,
          },
        ],
      })),
      loadIllinoisFinanceDataFn: vi.fn(),
      syncIllinoisCandidateFinanceFn: vi.fn() as never,
    });

    expect(result).toMatchObject({
      dueCandidateCount: 0,
      selectedCandidateCount: 0,
      autoLinkAttemptedCount: 1,
      autoLinkLinkedCount: 1,
    });
    expect(String(db.query.mock.calls[0]?.[0])).toContain("FROM public.candidate_elections AS candidate_election");
    expect(String(db.query.mock.calls[1]?.[0])).toContain("FROM public.il_candidate_finance_links AS link");
    expect(txQuery.mock.calls[0]?.[0]).toBe("BEGIN");
    expect(String(txQuery.mock.calls[1]?.[0])).toContain("INSERT INTO public.il_candidate_finance_links");
    expect(String(txQuery.mock.calls[2]?.[0])).toContain("NOT (committee_key = ANY($4::text[]))");
    expect(txQuery.mock.calls[3]?.[0]).toBe("COMMIT");
    expect(txClient.release).toHaveBeenCalledTimes(1);
  });

  it("can auto-link and sync due candidates from artifact contribution records", async () => {
    const artifactContribution = contribution({
      contributorName: "Artifact Donor",
      amount: 1000,
      receivedDate: "3/1/2026",
    });
    const artifacts = {
      contributionRecords: [artifactContribution],
      contributionCsvsLoaded: true,
      contributionSourceUrl: SOURCE_URL,
    };
    const txQuery = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: "link-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const txClient = { query: txQuery, release: vi.fn() };
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              candidate_id: CANDIDATE_ID,
              election_id: ELECTION_ID,
              candidate_name: "Jane Doe",
              election_year: 2026,
              office_scope: "statewide",
              office_name: "Governor",
              district: null,
            },
          ],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [dueRow()], rowCount: 1 }),
      connect: vi.fn(async () => txClient as never),
    };
    const syncIllinoisCandidateFinanceFn = vi.fn(async () => successfulSync({ totalReceipts: 1000 }));

    const result = await syncDueIllinoisCandidateFinance({
      db,
      now: NOW,
      maxCandidates: 1,
      resolveCandidateCommittee: createIllinoisSbeArtifactCandidateCommitteeResolver(artifacts),
      loadIllinoisFinanceDataFn: async (row) => loadIllinoisFinanceDataForDueRowFromArtifacts({ row, artifacts }),
      syncIllinoisCandidateFinanceFn: syncIllinoisCandidateFinanceFn as never,
    });

    expect(result).toMatchObject({
      dueCandidateCount: 1,
      selectedCandidateCount: 1,
      syncedCandidateCount: 1,
      failedCandidateCount: 0,
      autoLinkAttemptedCount: 1,
      autoLinkLinkedCount: 1,
    });
    expect(String(txQuery.mock.calls[1]?.[0])).toContain("INSERT INTO public.il_candidate_finance_links");
    expect(syncIllinoisCandidateFinanceFn).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: CANDIDATE_ID,
        electionId: ELECTION_ID,
        committeeKey: "FRIENDS OF JANE DOE",
        directContributionRecords: [artifactContribution],
        directContributionSourceUrl: SOURCE_URL,
      })
    );
  });
});


function verifiedBatchData(totalAmount = 1000): IllinoisCandidateFinanceData {
  return {
    verifiedQuarterly: true,
    pacDonors: [{ committeeId: "1028", committeeName: "Community BANCPAC", committeeType: "Political Action",
      totalAmount, contributionCount: 1, sourceUrl: SOURCE_URL }],
    outsideReportEvidence: [{ committeeId: "615", filedDocId: "1023410", periodStart: "2026-07-01", periodEnd: "2026-09-30",
      receivedAt: "2026-10-07 15:46:19.163000000", fingerprint: "a".repeat(64) }],
    outsideExpenditureRecords: [{ payeeName: "Printer", payeeAddress: null, amount: 66.5,
      expendedDate: "9/9/2026", reportReceivedDate: "10/7/2026", expenditureType: "Independent Expenditure",
      expendingCommitteeName: "Kane County Republican Central Cmte", purpose: "Printing", candidateName: "Bailey for Illinois",
      officeDistrict: "Illinois Governor", supportOppose: "support", sourceUrl: SOURCE_URL, committeeId: "615",
      documentName: "Quarterly", sourceDocumentId: "1023410", reportingPeriodStart: "7/1/2026", reportingPeriodEnd: "9/30/2026" }],
    directContributionRecords: [contribution({ committeeId: "34092", documentName: "Quarterly", sourceDocumentId: "1023500" })],
    d2ReportSummaries: [{ reportId: "1023500", committeeId: "34092", periodStart: "2026-07-01", periodEnd: "2026-09-30",
      filedAt: "2026-10-07T12:00:00Z", totalReceipts: 5000, totalDisbursements: 2000, cashOnHand: 3000,
      debtsOwed: 0, sourceUrl: SOURCE_URL }],
  };
}

function linkedBatchDb(rows: ReturnType<typeof dueRow>[]) {
  return { query: vi.fn(async () => ({ rows, rowCount: rows.length })), connect: vi.fn() };
}

describe("verified Quarterly batch component forwarding", () => {
  it("writes candidate-wide outside once while forwarding each receiving link's cash and PAC component", async () => {
    const db = linkedBatchDb([
      dueRow({ committee_key: "SBE:34092", total_due_rows: "3" }),
      dueRow({ committee_key: "SBE:34093", total_due_rows: "3" }),
      dueRow({ candidate_id: "44444444-4444-4444-8444-444444444444", committee_key: "SBE:34094", total_due_rows: "3" }),
    ]);
    const data = [verifiedBatchData(1000), verifiedBatchData(2000), verifiedBatchData(3000)];
    let next = 0;
    const load = vi.fn(async () => data[next++]!);
    const sync = vi.fn(async (input: IllinoisCandidateFinanceSyncInput) => successfulSync({
      outsideGroupsWritten: input.outsideExpenditureRecords ? 1 : 0, outsidePreserved: false, pacDonorsWritten: 1,
    }));
    const result = await syncDueIllinoisCandidateFinance({ db: db as never, now: NOW, autoLinkMissingLinks: false,
      loadIllinoisFinanceDataFn: load, syncIllinoisCandidateFinanceFn: sync });
    expect(result).toMatchObject({ selectedCandidateCount: 3, syncedCandidateCount: 3, failedCandidateCount: 0 });
    const inputs = sync.mock.calls.map(([input]) => input);
    expect(inputs[0]).toMatchObject({ sbeCommitteeId: "34092", verifiedQuarterly: true,
      outsideReportEvidence: data[0]!.outsideReportEvidence, outsideExpenditureRecords: data[0]!.outsideExpenditureRecords });
    expect(inputs[1]!.outsideReportEvidence).toBeUndefined();
    expect(inputs[1]!.outsideExpenditureRecords).toBeUndefined();
    expect(inputs[2]!.outsideReportEvidence).toEqual(data[2]!.outsideReportEvidence);
    expect(inputs.map((input) => input.pacDonors?.[0]?.totalAmount)).toEqual([1000, 2000, 3000]);
    expect(inputs.map((input) => input.directContributionRecords)).toEqual(data.map((item) => item.directContributionRecords));
    expect(inputs.map((input) => input.d2ReportSummaries)).toEqual(data.map((item) => item.d2ReportSummaries));
    expect(result.results.filter((row) => row.result?.outsideGroupsWritten === 1)).toHaveLength(2);
    expect(db.connect).not.toHaveBeenCalled();
  });

  it.each(["preserved", "failed"] as const)("lets another receiving link retry outside after the first attempt was %s", async (firstOutcome) => {
    const db = linkedBatchDb([dueRow({ committee_key: "SBE:34092", total_due_rows: "2" }),
      dueRow({ committee_key: "SBE:34093", total_due_rows: "2" })]);
    const data = verifiedBatchData();
    let next = 0;
    const sync = vi.fn(async (_input: IllinoisCandidateFinanceSyncInput) => {
      if (next++ === 0) {
        if (firstOutcome === "failed") throw new Error("rollback: source report missing");
        return successfulSync({ outsideGroupsWritten: 0, outsidePreserved: true });
      }
      return successfulSync({ outsideGroupsWritten: 1, outsidePreserved: false });
    });
    const result = await syncDueIllinoisCandidateFinance({ db: db as never, now: NOW, autoLinkMissingLinks: false,
      loadIllinoisFinanceDataFn: async () => data, syncIllinoisCandidateFinanceFn: sync });
    expect(sync).toHaveBeenCalledTimes(2);
    expect(sync.mock.calls[1]![0].outsideReportEvidence).toEqual(data.outsideReportEvidence);
    expect(sync.mock.calls[1]![0].outsideExpenditureRecords).toEqual(data.outsideExpenditureRecords);
    expect(result.failedCandidateCount).toBe(firstOutcome === "failed" ? 1 : 0);
    expect(result.results[1]).toMatchObject({ ok: true, result: { outsideGroupsWritten: 1, outsidePreserved: false } });
  });

  it("does not invoke a writer when all verified components are unknown, but still processes a later PAC-only component", async () => {
    const db = linkedBatchDb([dueRow({ committee_key: "SBE:34092", total_due_rows: "2" }),
      dueRow({ committee_key: "SBE:34093", total_due_rows: "2" })]);
    const donors = verifiedBatchData().pacDonors;
    let next = 0;
    const sync = vi.fn(async (_input: IllinoisCandidateFinanceSyncInput) => successfulSync({
      totalReceipts: null, outsideSupportTotal: null, outsideOpposeTotal: null, pacDonorsWritten: 1,
    }));
    const result = await syncDueIllinoisCandidateFinance({ db: db as never, now: NOW, autoLinkMissingLinks: false,
      loadIllinoisFinanceDataFn: async () => next++ === 0 ? { verifiedQuarterly: true } : { verifiedQuarterly: true, pacDonors: donors },
      syncIllinoisCandidateFinanceFn: sync });
    expect(result).toMatchObject({ syncedCandidateCount: 1, failedCandidateCount: 1 });
    expect(result.results[0]?.error).toContain("No accepted current Quarterly component");
    expect(sync).toHaveBeenCalledOnce();
    expect(sync.mock.calls[0]![0]).toMatchObject({ committeeKey: "SBE:34093", pacDonors: donors });
    expect(sync.mock.calls[0]![0].outsideExpenditureRecords).toBeUndefined();
    expect(sync.mock.calls[0]![0].d2ReportSummaries).toBeUndefined();
  });

  it("forwards unverified modern artifact metadata intact so sync can preserve rather than interpret it as legacy", async () => {
    const db = linkedBatchDb([dueRow()]);
    const modern = contribution({ documentName: "Quarterly", committeeId: "34092", sourceDocumentId: undefined });
    const sync = vi.fn(async (_input: IllinoisCandidateFinanceSyncInput) => successfulSync({ directBreakdownsWritten: 0,
      totalReceipts: null, directContributionTotal: null }));
    await syncDueIllinoisCandidateFinance({ db: db as never, now: NOW, autoLinkMissingLinks: false,
      loadIllinoisFinanceDataFn: async () => ({ directContributionRecords: [modern] }), syncIllinoisCandidateFinanceFn: sync });
    expect(sync.mock.calls[0]![0].directContributionRecords).toEqual([modern]);
    expect(sync.mock.calls[0]![0].verifiedQuarterly).toBeUndefined();
    expect(sync.mock.calls[0]![0].outsideReportEvidence).toBeUndefined();
    expect(sync.mock.calls[0]![0].pacDonors).toBeUndefined();
  });
});


describe("modern CSV artifact preservation through the real batch and sync", () => {
  it("preserves stored finance when every unverified modern row is removed by the artifact target filter", async () => {
    const linkId = "33333333-3333-4333-8333-333333333333";
    const clientQuery = vi.fn(async (sql: string, _params?: readonly unknown[]) => ({
      rows: sql.includes("INSERT INTO public.il_candidate_finance_links") ? [{ id: linkId }] : [], rowCount: 1,
    }));
    const client = { query: clientQuery, release: vi.fn() };
    const db = {
      query: vi.fn(async (sql: string) => ({
        rows: sql.includes("FROM public.il_candidate_finance_links AS link") ? [dueRow({ committee_key: "SBE:34092" })] : [], rowCount: 1,
      })), connect: vi.fn(async () => client),
    };
    const artifacts = {
      contributionCsvsLoaded: true, contributionSourceUrl: SOURCE_URL,
      contributionRecords: [contribution({ committeeId: "777", documentName: "Quarterly",
        recipientCommitteeName: "Another receiving committee", amount: 9000 })],
      expenditureRecords: verifiedBatchData().outsideExpenditureRecords!,
      expenditureSourceUrl: SOURCE_URL,
    };
    // IE labels Bailey's committee, whereas this due row is Jane Doe. Modern
    // source fields exist before filtering even though the candidate subset is [].
    const result = await syncDueIllinoisCandidateFinance({ db: db as never, now: NOW, autoLinkMissingLinks: false,
      loadIllinoisFinanceDataFn: async (row) => loadIllinoisFinanceDataForDueRowFromArtifacts({ row, artifacts }) });
    expect(result.results[0]).toMatchObject({ ok: true, result: { totalReceipts: null,
      directContributionTotal: null, outsideSupportTotal: null, outsideOpposeTotal: null,
      directBreakdownsWritten: 0, outsideGroupsWritten: 0 } });
    expect(clientQuery.mock.calls.some(([sql]) => /DELETE FROM public\.il_candidate_finance_(?:direct_breakdowns|outside_)/.test(sql))).toBe(false);
    const summary = clientQuery.mock.calls.find(([sql]) => sql.includes("INSERT INTO public.il_candidate_finance_summaries"));
    expect(summary?.[1]?.slice(2, 9)).toEqual([null, null, null, null, null, null, null]);
    expect(clientQuery.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });
});
