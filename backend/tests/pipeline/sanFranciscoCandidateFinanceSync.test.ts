import { getSanFranciscoCommitteePublicFunds } from "../../src/pipeline/sanFranciscoFinance/sanFranciscoCommitteePublicFundsClient.js";
import { acquireSanFranciscoCommitteeCash } from "../../src/pipeline/sanFranciscoFinance/sanFranciscoCommitteeCashAcquisition.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkSanFranciscoSourceFreshness,
  syncSanFranciscoCandidateFinance,
  SAN_FRANCISCO_FINANCE_METHODOLOGY_VERSION,
} from "../../src/pipeline/sanFranciscoFinance/sanFranciscoCandidateFinanceSync.js";
import {
  getSanFranciscoCommitteeCurrentForm460Filings,
  getSanFranciscoCommitteeItemizedTransactions,
  getSanFranciscoCommitteeSummaryRows,
  getSanFranciscoDatasetFreshness,
  getSanFranciscoPublicFundsApproved,
  type SanFranciscoItemizedTransactionRow,
  type SanFranciscoSummaryRow,
} from "../../src/pipeline/sanFranciscoFinance/sanFranciscoOpenDataClient.js";
import { getSanFranciscoContestManifest } from "../../src/pipeline/sanFranciscoFinance/sanFranciscoDashboardManifestClient.js";
import type { SanFranciscoContestManifest } from "../../src/pipeline/sanFranciscoFinance/sanFranciscoDashboardManifestClient.js";
import { replaceSanFranciscoCandidateFinanceSnapshot } from "../../src/pipeline/sanFranciscoFinance/sanFranciscoFinanceWriter.js";
import { resolveFinanceIndustryClassifications } from "../../src/pipeline/finance/financeIndustryClassificationService.js";

vi.mock(
  "../../src/pipeline/sanFranciscoFinance/sanFranciscoOpenDataClient.js",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    getSanFranciscoCommitteeCurrentForm460Filings: vi.fn(),
    getSanFranciscoCommitteeItemizedTransactions: vi.fn(),
    getSanFranciscoCommitteeSummaryRows: vi.fn(),
    getSanFranciscoDatasetFreshness: vi.fn(),
    getSanFranciscoPublicFundsApproved: vi.fn(),
  }),
);
vi.mock(
  "../../src/pipeline/sanFranciscoFinance/sanFranciscoDashboardManifestClient.js",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    getSanFranciscoContestManifest: vi.fn(),
  }),
);
vi.mock(
  "../../src/pipeline/sanFranciscoFinance/sanFranciscoFinanceWriter.js",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    replaceSanFranciscoCandidateFinanceSnapshot: vi
      .fn()
      .mockResolvedValue({ linkId: "link-1" }),
  }),
);
vi.mock(
  "../../src/pipeline/finance/financeIndustryClassificationService.js",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    resolveFinanceIndustryClassifications: vi.fn().mockResolvedValue(undefined),
  }),
);

vi.mock(
  "../../src/pipeline/sanFranciscoFinance/sanFranciscoCommitteePublicFundsClient.js",
  () => ({ getSanFranciscoCommitteePublicFunds: vi.fn() }),
);
vi.mock(
  "../../src/pipeline/sanFranciscoFinance/sanFranciscoCommitteeCashAcquisition.js",
  () => ({ acquireSanFranciscoCommitteeCash: vi.fn() }),
);

const NOW = new Date("2026-08-09T12:00:00.000Z");

const MANIFEST: SanFranciscoContestManifest = {
  electionDate: "2026-11-03",
  contestCode: "bos04",
  title: "Board of Supervisors, District 4",
  candidates: [
    {
      filerNid: "200001",
      fppcId: "1490199",
      committeeName: "Friends of Jane Test for Supervisor 2026",
      candidateName: "JANE TEST",
      fundsCents: 150_000_00,
      expensesCents: 90_000_00,
    },
  ],
  outsideRelations: [
    {
      candidateName: "JANE TEST",
      candidateFppcId: "1490199",
      position: "support",
      spenderFppcId: "1350000",
      spenderName: "Growth PAC",
      amountCents: 40_000_00,
    },
    {
      candidateName: "JANE TEST",
      candidateFppcId: "1490199",
      position: "oppose",
      spenderFppcId: null,
      spenderName: "Neighbors United",
      amountCents: 5_000_00,
    },
  ],
  sourceUrl: "https://raw.example/bos04.md",
  schemaFingerprint: "top:candidates",
};

const SUMMARY_ROWS: SanFranciscoSummaryRow[] = [
  {
    filingNid: "f1",
    filingIdNumber: "101",
    filingType: "FiledOriginal",
    formType: "FPPC460",
    periodStart: "2026-01-01T00:00:00.000",
    periodEnd: "2026-06-30T00:00:00.000",
    monetaryContributionsCents: 60_000_00,
    line2Cents: 0,
    contributionsCents: 60_000_00,
    expendituresCents: 30_000_00,
    endingCashCents: 5_000_00,
    outstandingDebtsCents: 100_00,
    loansReceivedCents: 0,
    syncFlag: true,
  },
  {
    filingNid: "f2",
    filingIdNumber: "102",
    filingType: "FiledOriginal",
    formType: "FPPC460",
    periodStart: "2026-07-01T00:00:00.000",
    periodEnd: "2026-09-30T00:00:00.000",
    monetaryContributionsCents: 40_000_00,
    line2Cents: 0,
    contributionsCents: 40_000_00,
    expendituresCents: 60_000_00,
    endingCashCents: 8_000_00,
    outstandingDebtsCents: 0,
    loansReceivedCents: 20_000_00,
    syncFlag: true,
  },
];

const INDEX_ROWS = [
  { filingNid: "f1", filingDate: "2026-07-31T00:00:00.000" },
  { filingNid: "f2", filingDate: "2026-10-05T00:00:00.000" },
];

const PUBLIC_FUNDS_ROWS = [
  {
    candidateName: "Test, Jane",
    district: "4",
    pendingCompleted: null,
    fundsApprovedCents: 25_000_00,
  },
];

const transactionRow = (
  overrides: Partial<SanFranciscoItemizedTransactionRow>,
): SanFranciscoItemizedTransactionRow => ({
  filingNid: "f1",
  transactionId: "INC1",
  formType: "A",
  transactionDate: "2026-03-01T00:00:00.000",
  contributorFirstName: "Amy",
  contributorLastName: "Donor",
  occupation: "Attorney",
  employer: "Example LLP",
  city: "San Francisco",
  state: "CA",
  zip: "94110",
  entityCode: "IND",
  calculatedAmountCents: 50_000_00,
  transactionAmount1Cents: 50_000_00,
  memoCode: null,
  isItemized: true,
  crossReferenceMatch: null,
  crossReferenceSchedule: null,
  supportOpposeCode: null,
  transactionCode: null,
  ...overrides,
});

const TRANSACTION_ROWS = [
  transactionRow({}),
  transactionRow({ transactionId: "INC2", calculatedAmountCents: 50_000_00 }),
  transactionRow({
    transactionId: null,
    formType: "F460ALine2",
    calculatedAmountCents: 500_00,
    entityCode: null,
    occupation: null,
    employer: null,
  }),
];

const HEALTHY_FRESHNESS = {
  summary: {
    dataAsOf: "2026-08-08T00:00:00.000",
    dataLoadedAt: "2026-08-09T00:00:00.000",
  },
  transactions: {
    dataAsOf: "2026-08-08T00:00:00.000",
    dataLoadedAt: "2026-08-09T00:00:00.000",
  },
};

function fakeDb(storedSummaryRows: unknown[] = []) {
  const query = vi.fn(async () => ({ rows: storedSummaryRows }));
  return { query, connect: vi.fn() };
}

function baseInput(db: ReturnType<typeof fakeDb>) {
  return {
    db,
    candidateId: "cand-1",
    electionId: "elec-1",
    electionYear: 2026,
    electionDate: "2026-11-03",
    contestCode: "bos04",
    fppcId: "1490199",
    manifest: MANIFEST,
    sourceFreshness: HEALTHY_FRESHNESS,
    now: NOW,
  };
}

beforeEach(() => {
  vi.mocked(acquireSanFranciscoCommitteeCash)
    .mockReset()
    .mockRejectedValue(new Error("source unavailable"));
  vi.mocked(getSanFranciscoCommitteePublicFunds).mockReset();
  vi.mocked(getSanFranciscoCommitteeSummaryRows).mockResolvedValue(
    SUMMARY_ROWS.map((row) => ({ ...row })),
  );
  vi.mocked(getSanFranciscoCommitteeCurrentForm460Filings).mockResolvedValue(
    INDEX_ROWS.map((row) => ({ ...row })),
  );
  vi.mocked(getSanFranciscoPublicFundsApproved).mockResolvedValue(
    PUBLIC_FUNDS_ROWS.map((row) => ({ ...row })),
  );
  vi.mocked(getSanFranciscoCommitteeItemizedTransactions).mockResolvedValue(
    TRANSACTION_ROWS.map((row) => ({ ...row })),
  );
  vi.mocked(getSanFranciscoContestManifest).mockResolvedValue(MANIFEST);
  vi.mocked(replaceSanFranciscoCandidateFinanceSnapshot).mockClear();
  vi.mocked(replaceSanFranciscoCandidateFinanceSnapshot).mockResolvedValue({
    linkId: "link-1",
  });
  vi.mocked(resolveFinanceIndustryClassifications).mockClear();
  // Reset so a test's queued once-values can never leak into the next one.
  vi.mocked(getSanFranciscoDatasetFreshness).mockReset();
});

describe("syncSanFranciscoCandidateFinance", () => {
  it("accepts qualified named cash without adding it to Raised", async () => {
    vi.mocked(acquireSanFranciscoCommitteeCash).mockResolvedValue({
      positions: [
        {
          committeeId: "reported:COM:EXAMPLE",
          committeeName: "Example",
          sourceReportedClass: "COM",
          amountCents: 30000,
          contributionCount: 1,
          giftOccurrenceIds: ["1"],
          returnOccurrenceIds: [],
          reportedCommitteeIds: ["1234567"],
        },
      ],
      totalAmountCents: 30000,
      windowEnd: "2026-09-30",
    } as never);
    const result = await syncSanFranciscoCandidateFinance(baseInput(fakeDb()));
    expect(result).toMatchObject({
      directContributionCents: 12500000,
      committeeCashStatus: "qualified",
      committeeCashPositionCount: 1,
      committeeCashTotalCents: 30000,
    });
    const snapshot = vi.mocked(replaceSanFranciscoCandidateFinanceSnapshot).mock
      .calls[0]![0];
    expect(snapshot.committeeCash).toMatchObject({
      reportedThrough: "2026-09-30",
      positions: [{ amountCents: 30000 }],
    });
    expect(snapshot.summary.directContributionCents).toBe(12500000);
  });

  it("preserves named cash on qualification failure while still writing independent IE", async () => {
    const result = await syncSanFranciscoCandidateFinance(baseInput(fakeDb()));
    expect(result).toMatchObject({
      committeeCashStatus: "unavailable",
      committeeCashTotalCents: null,
      committeeCashError: "source unavailable",
      outsideGroupCount: 2,
    });
    const snapshot = vi.mocked(replaceSanFranciscoCandidateFinanceSnapshot).mock
      .calls[0]![0];
    expect(snapshot).not.toHaveProperty("committeeCash");
    expect(snapshot.outsideGroups).toHaveLength(2);
    expect(snapshot.summary.outsideSupportCents).toBe(4000000);
  });

  it("writes a full snapshot with manifest headline and donor-only direct total", async () => {
    const db = fakeDb();
    const result = await syncSanFranciscoCandidateFinance(baseInput(db));
    expect(result).toMatchObject({
      linkWritten: true,
      totalRaisedCents: 150_000_00,
      directContributionCents: 125_000_00,
      publicFundsStatus: "matched",
      publicFundsCents: 25_000_00,
      form460Filings: 2,
      reportedThrough: "2026-09-30",
      outsideGroupCount: 2,
    });
    // funds - (itemized 100k + unitemized 500 + line2 0 + public 25k)
    expect(result.reconciliationDifferenceCents).toBe(24_500_00);
    const snapshot = vi.mocked(replaceSanFranciscoCandidateFinanceSnapshot).mock
      .calls[0]![0];
    expect(snapshot.summary).toEqual({
      totalRaisedCents: 150_000_00,
      directContributionCents: 125_000_00,
      totalSpentCents: 90_000_00,
      cashOnHandCents: 8_000_00,
      debtsOwedCents: 0,
      loansReceivedCents: 20_000_00,
      publicFundsReceivedCents: 25_000_00,
      outsideSupportCents: 40_000_00,
      outsideOpposeCents: 5_000_00,
      methodologyVersion: SAN_FRANCISCO_FINANCE_METHODOLOGY_VERSION,
      sourceUrl: MANIFEST.sourceUrl,
      reportedThrough: "2026-09-30",
    });
    expect(snapshot.link).toMatchObject({
      candidateId: "cand-1",
      fppcId: "1490199",
      filerNid: "200001",
      contestCode: "bos04",
      linkStatus: "active",
      linkSource: "sfec_dashboard",
      lastVerifiedAt: NOW,
    });
    expect(snapshot.outsideGroups).toEqual([
      {
        spenderFppcId: "1350000",
        spenderName: "Growth PAC",
        supportOppose: "support",
        amountCents: 40_000_00,
        sourceUrl: MANIFEST.sourceUrl,
      },
      {
        spenderFppcId: expect.stringMatching(/^name:/),
        spenderName: "Neighbors United",
        supportOppose: "oppose",
        amountCents: 5_000_00,
        sourceUrl: MANIFEST.sourceUrl,
      },
    ]);
    const categoryTypes = new Set(
      snapshot.directBreakdowns.map((row) => row.categoryType),
    );
    expect(categoryTypes).toContain("occupation");
    expect(categoryTypes).toContain("employer");
    expect(categoryTypes).toContain("contribution_size");
    // Never any AI classifier: the service is invoked without one.
    expect(
      vi.mocked(resolveFinanceIndustryClassifications).mock.calls[0]![0]
        .classifier,
    ).toBeUndefined();
  });

  it("fetches the manifest itself when none is passed", async () => {
    const db = fakeDb();
    const input = { ...baseInput(db) };
    delete (input as { manifest?: unknown }).manifest;
    await syncSanFranciscoCandidateFinance(input);
    expect(getSanFranciscoContestManifest).toHaveBeenCalledWith(
      { electionDate: "2026-11-03", contestCode: "bos04" },
      undefined,
    );
  });

  it("fails when the linked committee left the manifest", async () => {
    const db = fakeDb();
    await expect(
      syncSanFranciscoCandidateFinance({
        ...baseInput(db),
        fppcId: "9999999",
      }),
    ).rejects.toThrow(/missing from the bos04 manifest/);
    expect(replaceSanFranciscoCandidateFinanceSnapshot).not.toHaveBeenCalled();
  });

  it("fails closed on an unsynced summary filing", async () => {
    vi.mocked(getSanFranciscoCommitteeSummaryRows).mockResolvedValue([
      { ...SUMMARY_ROWS[0]!, syncFlag: null },
      { ...SUMMARY_ROWS[1]! },
    ]);
    await expect(
      syncSanFranciscoCandidateFinance(baseInput(fakeDb())),
    ).rejects.toThrow(/not transaction-synced \(sync_flag\): 101/);
    expect(replaceSanFranciscoCandidateFinanceSnapshot).not.toHaveBeenCalled();
  });

  it("fails closed when the filings index shows an uncovered old filing", async () => {
    vi.mocked(getSanFranciscoCommitteeCurrentForm460Filings).mockResolvedValue([
      ...INDEX_ROWS,
      { filingNid: "f3", filingDate: "2026-07-01T00:00:00.000" },
    ]);
    await expect(
      syncSanFranciscoCandidateFinance(baseInput(fakeDb())),
    ).rejects.toThrow(/missing current Form 460 filings .*: f3/);
  });

  it("fails closed on an uncovered filing with no filing date", async () => {
    vi.mocked(getSanFranciscoCommitteeCurrentForm460Filings).mockResolvedValue([
      ...INDEX_ROWS,
      { filingNid: "f3", filingDate: null },
    ]);
    await expect(
      syncSanFranciscoCandidateFinance(baseInput(fakeDb())),
    ).rejects.toThrow(/missing current Form 460 filings .*: f3/);
  });

  it("tolerates an uncovered filing inside the nightly-lag grace window", async () => {
    vi.mocked(getSanFranciscoCommitteeCurrentForm460Filings).mockResolvedValue([
      ...INDEX_ROWS,
      // Filed two days before NOW: nightly extract may not carry it yet.
      { filingNid: "f3", filingDate: "2026-08-07T00:00:00.000" },
    ]);
    const result = await syncSanFranciscoCandidateFinance(baseInput(fakeDb()));
    expect(result.linkWritten).toBe(true);
  });

  it("fails closed on an ambiguous public-funds match", async () => {
    vi.mocked(getSanFranciscoPublicFundsApproved).mockResolvedValue([
      ...PUBLIC_FUNDS_ROWS,
      {
        candidateName: "Test, Jane A.",
        district: "4",
        pendingCompleted: null,
        fundsApprovedCents: 1_000_00,
      },
    ]);
    await expect(
      syncSanFranciscoCandidateFinance(baseInput(fakeDb())),
    ).rejects.toThrow(/public-funds match is ambiguous/);
  });

  it("writes null public funds for a contest outside the program", async () => {
    const db = fakeDb();
    const result = await syncSanFranciscoCandidateFinance({
      ...baseInput(db),
      contestCode: "asr",
      manifest: { ...MANIFEST, contestCode: "asr" },
    });
    expect(getSanFranciscoPublicFundsApproved).not.toHaveBeenCalled();
    expect(result.publicFundsStatus).toBe("no_program");
    expect(result.publicFundsCents).toBeNull();
    expect(result.directContributionCents).toBe(150_000_00);
    const snapshot = vi.mocked(replaceSanFranciscoCandidateFinanceSnapshot).mock
      .calls[0]![0];
    expect(snapshot.summary.publicFundsReceivedCents).toBeNull();
  });

  it("aborts when the direct total collapses on an unchanged filing set", async () => {
    const db = fakeDb([
      {
        direct_contribution_total: "1300000.00",
        reported_through: "2026-09-30",
      },
    ]);
    await expect(
      syncSanFranciscoCandidateFinance(baseInput(db)),
    ).rejects.toThrow(/collapsed on an unchanged filing set/);
    expect(replaceSanFranciscoCandidateFinanceSnapshot).not.toHaveBeenCalled();
    // The baseline is scoped to THIS committee's active link — summaries
    // left behind by a deactivated earlier link must not feed the bound.
    const [anomalySql, anomalyParams] = db.query.mock.calls[0]!;
    expect(anomalySql).toContain("link.link_status='active'");
    expect(anomalySql).toContain("link.fppc_id=$4");
    expect(anomalyParams).toEqual(["cand-1", "elec-1", 2026, "1490199"]);
    const bypassDb = fakeDb([
      {
        direct_contribution_total: "1300000.00",
        reported_through: "2026-09-30",
      },
    ]);
    const result = await syncSanFranciscoCandidateFinance({
      ...baseInput(bypassDb),
      bypassAnomalyCheck: true,
    });
    expect(result.linkWritten).toBe(true);
  });

  it("allows a large drop when a newer filing explains it", async () => {
    const db = fakeDb([
      {
        direct_contribution_total: "1300000.00",
        reported_through: "2026-06-30",
      },
    ]);
    const result = await syncSanFranciscoCandidateFinance(baseInput(db));
    expect(result.linkWritten).toBe(true);
  });

  it("aborts when the filing history goes backwards", async () => {
    const db = fakeDb([
      { direct_contribution_total: "1000.00", reported_through: "2026-12-31" },
    ]);
    await expect(
      syncSanFranciscoCandidateFinance(baseInput(db)),
    ).rejects.toThrow(/filing history went backwards/);
    // bypassAnomalyCheck covers the drop bound only — a regression still
    // aborts under the override.
    await expect(
      syncSanFranciscoCandidateFinance({
        ...baseInput(
          fakeDb([
            {
              direct_contribution_total: "1000.00",
              reported_through: "2026-12-31",
            },
          ]),
        ),
        bypassAnomalyCheck: true,
      }),
    ).rejects.toThrow(/filing history went backwards/);
  });

  it("fails when the manifest shows funds but the summary dataset has no filings", async () => {
    vi.mocked(getSanFranciscoCommitteeSummaryRows).mockResolvedValue([]);
    vi.mocked(getSanFranciscoCommitteeCurrentForm460Filings).mockResolvedValue(
      [],
    );
    await expect(
      syncSanFranciscoCandidateFinance(baseInput(fakeDb())),
    ).rejects.toThrow(/manifest funds but no filings/);
  });

  it("does not write in dry-run mode", async () => {
    const result = await syncSanFranciscoCandidateFinance({
      ...baseInput(fakeDb()),
      dryRun: true,
    });
    expect(result.linkWritten).toBe(false);
    expect(replaceSanFranciscoCandidateFinanceSnapshot).not.toHaveBeenCalled();
  });
});

describe("checkSanFranciscoSourceFreshness", () => {
  it("returns observed record timestamps when both datasets are recent", async () => {
    vi.mocked(getSanFranciscoDatasetFreshness)
      .mockResolvedValueOnce(HEALTHY_FRESHNESS.summary)
      .mockResolvedValueOnce(HEALTHY_FRESHNESS.transactions);
    await expect(
      checkSanFranciscoSourceFreshness({ now: NOW }),
    ).resolves.toEqual(HEALTHY_FRESHNESS);
  });

  it("throws when a dataset has stalled", async () => {
    vi.mocked(getSanFranciscoDatasetFreshness)
      .mockResolvedValueOnce({
        dataAsOf: "2026-07-20T00:00:00.000",
        dataLoadedAt: "2026-07-21T00:00:00.000",
      })
      .mockResolvedValueOnce(HEALTHY_FRESHNESS.transactions);
    await expect(
      checkSanFranciscoSourceFreshness({ now: NOW }),
    ).rejects.toThrow(/summary-totals dataset is stale/);
  });

  it("accepts the witnessed October 7/11 record-added maxima without inferring a shared generation", async () => {
    const observed = {
      summary: {
        dataAsOf: "2026-10-07T00:00:00.000",
        dataLoadedAt: "2026-10-08T00:00:00.000",
      },
      transactions: {
        dataAsOf: "2026-10-11T00:00:00.000",
        dataLoadedAt: "2026-10-12T00:00:00.000",
      },
    };
    vi.mocked(getSanFranciscoDatasetFreshness)
      .mockResolvedValueOnce(observed.summary)
      .mockResolvedValueOnce(observed.transactions);
    await expect(
      checkSanFranciscoSourceFreshness({
        now: new Date("2026-10-12T22:00:00Z"),
      }),
    ).resolves.toEqual(observed);
  });

  it("still refuses stale transaction uploads when record-added dates differ", async () => {
    vi.mocked(getSanFranciscoDatasetFreshness)
      .mockResolvedValueOnce(HEALTHY_FRESHNESS.summary)
      .mockResolvedValueOnce({
        dataAsOf: "2026-07-20T00:00:00.000",
        dataLoadedAt: "2026-07-21T00:00:00.000",
      });
    await expect(
      checkSanFranciscoSourceFreshness({ now: NOW }),
    ).rejects.toThrow(/transactions dataset is stale/);
  });

  it("throws when freshness metadata is missing", async () => {
    vi.mocked(getSanFranciscoDatasetFreshness)
      .mockResolvedValueOnce({ dataAsOf: null, dataLoadedAt: null })
      .mockResolvedValueOnce(HEALTHY_FRESHNESS.transactions);
    await expect(
      checkSanFranciscoSourceFreshness({ now: NOW }),
    ).rejects.toThrow(/reports no freshness metadata/);
  });
});

describe("source-bound public funds fallback", () => {
  function missingNameSource() {
    vi.mocked(getSanFranciscoPublicFundsApproved).mockResolvedValue([
      {
        candidateName: "Test, Different",
        district: "4",
        pendingCompleted: null,
        fundsApprovedCents: 4950000,
      },
    ]);
    return {
      fppcId: "1490199",
      filerNid: "200001",
      electionDate: "2026-11-03",
      candidateName: "Jane Test",
      committeeName: MANIFEST.candidates[0]!.committeeName,
      contributionCents: 10050000,
      expenditureCents: 9000000,
      publicFundsCents: 4950000,
      sourceUrl: "https://raw.example/CA1490199.md",
      sha256: "a".repeat(64),
    };
  }
  it("uses exact-account published public funding rather than misclassifying the missed name as contributions", async () => {
    vi.mocked(getSanFranciscoCommitteePublicFunds).mockResolvedValue(
      missingNameSource(),
    );
    const result = await syncSanFranciscoCandidateFinance(baseInput(fakeDb()));
    expect(result).toMatchObject({
      totalRaisedCents: 15000000,
      directContributionCents: 10050000,
      publicFundsStatus: "matched",
      publicFundsCents: 4950000,
      reconciliationDifferenceCents: 0,
    });
    expect(
      vi.mocked(replaceSanFranciscoCandidateFinanceSnapshot).mock.calls[0]![0]
        .summary,
    ).toMatchObject({
      directContributionCents: 10050000,
      publicFundsReceivedCents: 4950000,
    });
    expect(getSanFranciscoCommitteePublicFunds).toHaveBeenCalledWith(
      {
        electionDate: "2026-11-03",
        contestCode: "bos04",
        candidate: MANIFEST.candidates[0],
      },
      undefined,
    );
  });
  it("still binds missed city late financing when counting it as donor money would falsely reconcile", async () => {
    vi.mocked(getSanFranciscoCommitteePublicFunds).mockResolvedValue(
      missingNameSource(),
    );
    vi.mocked(getSanFranciscoCommitteeItemizedTransactions).mockResolvedValue([
      ...TRANSACTION_ROWS,
      transactionRow({
        transactionId: "CITY-LATE",
        formType: "F497P1",
        entityCode: "OTH",
        contributorLastName: "CITY AND COUNTY OF SAN FRANCISCO",
        calculatedAmountCents: 4950000,
      }),
    ]);
    const result = await syncSanFranciscoCandidateFinance(baseInput(fakeDb()));
    expect(getSanFranciscoCommitteePublicFunds).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      directContributionCents: 10050000,
      publicFundsCents: 4950000,
      reconciliationDifferenceCents: 0,
    });
  });
  it.each([
    "contributionCents",
    "publicFundsCents",
    "expenditureCents",
  ] as const)(
    "preserves rather than accepting changed publication %s",
    (field) => {
      const published = missingNameSource();
      vi.mocked(getSanFranciscoCommitteePublicFunds).mockResolvedValue({
        ...published,
        [field]: published[field] + 1,
      });
      return expect(syncSanFranciscoCandidateFinance(baseInput(fakeDb())))
        .rejects.toThrow(/does not reconcile/)
        .then(() =>
          expect(
            replaceSanFranciscoCandidateFinanceSnapshot,
          ).not.toHaveBeenCalled(),
        );
    },
  );
  it("preserves when unmatched public funds cannot be bound to an available account publication", async () => {
    missingNameSource();
    vi.mocked(getSanFranciscoCommitteePublicFunds).mockRejectedValue(
      new Error("Missing account metadata"),
    );
    await expect(
      syncSanFranciscoCandidateFinance(baseInput(fakeDb())),
    ).rejects.toThrow("Missing account metadata");
    expect(replaceSanFranciscoCandidateFinanceSnapshot).not.toHaveBeenCalled();
  });
  it("does not fetch an account fallback for an existing exact match or infer zero from an empty approval lookup", async () => {
    await syncSanFranciscoCandidateFinance(baseInput(fakeDb()));
    expect(getSanFranciscoCommitteePublicFunds).not.toHaveBeenCalled();
    vi.mocked(getSanFranciscoPublicFundsApproved).mockResolvedValue([]);
    const manifest = structuredClone(MANIFEST);
    manifest.candidates[0]!.fundsCents = 10050000;
    const result = await syncSanFranciscoCandidateFinance({
      ...baseInput(fakeDb()),
      manifest,
    });
    expect(result.directContributionCents).toBe(10050000);
    expect(getSanFranciscoCommitteePublicFunds).not.toHaveBeenCalled();
  });
});
