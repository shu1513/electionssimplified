import { describe, expect, it, vi } from "vitest";

import { syncDenverCandidateFinance } from "../../../src/pipeline/denverFinance/denverCandidateFinanceSync.js";
import type { DenverCycleCandidate } from "../../../src/pipeline/denverFinance/denverSearchlightClient.js";

const REGISTRANT: DenverCycleCandidate = {
  fullName: "Mike Johnston",
  firstName: "Mike",
  middleName: null,
  lastName: "Johnston",
  officeSoughtId: 1,
  officeSought: "Mayor",
  district: null,
  committeeId: 641,
  filerId: 658,
};

let nextTransactionId = 1;
function contributionRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transactionId: nextTransactionId++,
    transactionSubType: "Monetary",
    recipientCommitteeId: 807,
    contributorOccupation: "Teacher",
    amount: 100.0,
    fefTransaction: false,
    ...over,
  };
}

/** The consistent live-shaped fixture: receipts 200 = private 150 + FEF 50. */
function defaultRoutes(): Record<string, unknown> {
  return {
    "/api/Filer/filer/658": {
      filerId: 658,
      filerTypeName: "Candidate",
      filerStatusName: "Active",
      isTerminated: false,
      committeeIds: [641, 807],
      independentExpenditureIds: [],
    },
    getContributionsTotalByCommittee: { total: 200.0 },
    getExpendituresTotalByCommittee: { total: 120.0 },
    getFinancialOverviewByCandCommittee: {
      fairElectionsFundToCandidate: 50.0,
      campaignContributionsToCandidate: 150.0,
      independentExpendituresSupportingCandidate: 30.0,
      independentExpendituresOpposingCandidate: 10.0,
      fairElectionsFundToOthers: 0,
      campaignContributionsToOthers: 0,
      independentExpendituresSupportingOthers: 0,
      independentExpendituresOpposingOthers: 0,
    },
    SearchContributionTransactions: {
      totalContributionAmount: 200.0,
      totalRecords: 4,
      searchContributionTransactions: [
        contributionRow({ amount: 100.0 }),
        contributionRow({
          transactionSubType: "In-Kind",
          amount: 60.0,
          contributorOccupation: "Lawyer",
        }),
        contributionRow({ amount: -10.0, txnPurpose: "Overlimit" }),
        contributionRow({
          transactionSubType: "Fair Elections Payments",
          amount: 50.0,
          contributorOccupation: null,
        }),
      ],
    },
    "positionType=1": [{ name: "Advancing Denver", total: 30.0 }],
    "positionType=2": [{ name: "A Better Denver", total: 10.0 }],
    "search=Advancing%20Denver": [
      { uniqueId: "Ind787", id: 787, name: "Advancing Denver", type: 3 },
    ],
    "search=A%20Better%20Denver": [
      { uniqueId: "Ind808", id: 808, name: "A Better Denver", type: 3 },
      { uniqueId: "Ind678", id: 678, name: "A Better Denver!", type: 3 },
    ],
    GetCampaignFilingByCommittee: [
      [
        filing({ filingId: 1, filingPeriodId: 11, filingVersion: 1, startDate: "2023-01-01" }),
        filing({ filingId: 2, filingPeriodId: 11, filingVersion: 2, startDate: "2023-01-01" }),
      ],
      [filing({ filingId: 3, filingPeriodId: 12, filingVersion: 1, startDate: "2023-04-01" })],
      // Event-based row (null period) — must be filtered before selection.
      [filing({ filingId: 4, filingPeriodId: null, filingTypeName: "Major Contributions Report" })],
      // Another cycle's filing — must be filtered out by the cycle gate.
      [filing({ filingId: 5, filingPeriodId: 20, electionCycleId: 33, startDate: "2026-01-01" })],
    ],
    GetSummaryInfoByFiling: {
      openingBalance: 10.0,
      totalMonetaryContributions: 90.0,
      totalFEFQualifyingContributions: 0,
      totalInKindContributions: 0,
      totalRefunds: 10.0,
      totalExpenditures: 97.38,
      totalFairElectionExpenditures: 0,
      totalOtherExpenditures: 0,
      totalFairElectionsFunding: 0,
      totalNewLoans: 0,
      totalLoanBalance: 0,
      closingBalance: -7.38,
      totalNonDonorFunds: 0,
    },
  };
}

function filing(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    filingId: 1,
    filerId: 658,
    entityId: 641,
    electionCycleId: 26,
    filingPeriodId: 11,
    filingPeriodName: "Q1",
    filingTypeName: "Campaign Finance Report",
    filingVersion: 1,
    filingStatusName: "Filed",
    filingTypeId: 5,
    submittedDate: "2023-04-15",
    startDate: "2023-01-01",
    endDate: "2023-03-31",
    ...over,
  };
}

function makeFetch(routes: Record<string, unknown>) {
  return vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    for (const [needle, payload] of Object.entries(routes)) {
      if (url.includes(needle))
        return new Response(JSON.stringify(payload), { status: 200 });
    }
    throw new Error(`Unexpected URL in test fetch: ${url}`);
  });
}

function dryDb(storedReceipts: string | null = null) {
  return {
    query: vi.fn(async () =>
      storedReceipts === null
        ? { rows: [] }
        : { rows: [{ total_receipts: storedReceipts }] },
    ),
    connect: async () => {
      throw new Error("dry-run test must not open a transaction");
    },
  } as never;
}

function baseInput(routes: Record<string, unknown>) {
  return {
    db: dryDb(),
    candidateId: "11111111-1111-4111-8111-111111111111",
    electionId: "22222222-2222-4222-8222-222222222222",
    electionYear: 2026,
    candidateDisplayName: "Mike Johnston",
    officeName: "City Council Member",
    district: null,
    filerId: 658,
    committeeName: "Johnston for Denver",
    electionCycleId: 26,
    cycleRegistrants: [REGISTRANT],
    dryRun: true,
    clientOptions: { fetchImpl: makeFetch(routes) },
  };
}

describe("syncDenverCandidateFinance", () => {
  it("reconciles totals, feed, outside lists, and cash on a dry run", async () => {
    const result = await syncDenverCandidateFinance(baseInput(defaultRoutes()));
    expect(result).toMatchObject({
      written: false,
      totalReceiptsCents: 20_000,
      directContributionCents: 15_000,
      fefFundingCents: 5_000,
      loanCents: 0,
      totalDisbursementsCents: 12_000,
      cashOnHandCents: -738,
      outsideSupportCents: 3_000,
      outsideOpposeCents: 1_000,
      directBreakdownCount: 4,
      outsideGroupCount: 2,
      contributionRowCount: 4,
      entityFilteredRowCount: 0,
    });
  });

  it("selects cash from the latest in-force period report of THIS cycle", async () => {
    const routes = defaultRoutes();
    const fetchImpl = makeFetch(routes);
    await syncDenverCandidateFinance({
      ...baseInput(routes),
      clientOptions: { fetchImpl },
    });
    const summaryCalls = fetchImpl.mock.calls.filter(([url]) =>
      String(url).includes("GetSummaryInfoByFiling"),
    );
    // Period 12 (filingId 3) is the latest period; the amended period-11
    // filing and the other cycle's filing are never fetched.
    expect(summaryCalls.map(([url]) => String(url))).toEqual([
      "https://denver.maplight.com/api/filing/GetSummaryInfoByFiling?filingId=3",
    ]);
  });

  it("publishes null cash when the committee has no period reports yet", async () => {
    const routes = defaultRoutes();
    routes.GetCampaignFilingByCommittee = [];
    const result = await syncDenverCandidateFinance(baseInput(routes));
    expect(result.cashOnHandCents).toBeNull();
  });

  it("fails closed when the receipts composition breaks", async () => {
    const routes = defaultRoutes();
    routes.getContributionsTotalByCommittee = { total: 250.0 };
    await expect(syncDenverCandidateFinance(baseInput(routes))).rejects.toThrow(
      /receipts composition failed/,
    );
  });

  it("fails closed when the transaction feed disagrees with the overview", async () => {
    const routes = defaultRoutes();
    routes.SearchContributionTransactions = {
      totalContributionAmount: 100.0,
      totalRecords: 3,
      searchContributionTransactions: [
        contributionRow({ amount: 100.0 }),
        contributionRow({ amount: -10.0 }),
        contributionRow({
          transactionSubType: "Fair Elections Payments",
          amount: 50.0,
        }),
      ],
    };
    await expect(syncDenverCandidateFinance(baseInput(routes))).rejects.toThrow(
      /direct-contribution feed sum \$90\.00 \+ loans \$0\.00 != overview private figure \$150\.00/,
    );
  });

  it("reconciles a candidate with loan rows (Walker-shaped: loans inside the overview private figure, outside the contributions endpoint)", async () => {
    const routes = defaultRoutes();
    // Donor 150 + loan 25 = overview private 175; endpoint stays donor + FEF.
    routes.getFinancialOverviewByCandCommittee = {
      ...(routes.getFinancialOverviewByCandCommittee as Record<string, unknown>),
      campaignContributionsToCandidate: 175.0,
    };
    routes.getContributionsTotalByCommittee = { total: 200.0 };
    routes.SearchContributionTransactions = {
      totalContributionAmount: 225.0,
      totalRecords: 5,
      searchContributionTransactions: [
        contributionRow({ amount: 100.0 }),
        contributionRow({
          transactionSubType: "In-Kind",
          amount: 60.0,
          contributorOccupation: "Lawyer",
        }),
        contributionRow({ amount: -10.0, txnPurpose: "Overlimit" }),
        contributionRow({
          transactionSubType: "Loan",
          amount: 25.0,
          contributorOccupation: "Candidate",
        }),
        contributionRow({
          transactionSubType: "Fair Elections Payments",
          amount: 50.0,
          contributorOccupation: null,
        }),
      ],
    };
    const result = await syncDenverCandidateFinance(baseInput(routes));
    expect(result).toMatchObject({
      totalReceiptsCents: 22_500, // private 175 (incl. loan) + FEF 50
      directContributionCents: 15_000, // donor money only
      fefFundingCents: 5_000,
      loanCents: 2_500,
    });
    // The loan never lands in a breakdown (same count as the loan-free run).
    expect(result.directBreakdownCount).toBe(4);
  });

  it("refuses to sync a filer that left the registration list", async () => {
    await expect(
      syncDenverCandidateFinance({
        ...baseInput(defaultRoutes()),
        cycleRegistrants: [],
      }),
    ).rejects.toThrow(/no longer on the cycle 26 registration list/);
  });

  it("refuses to sync when the registration committee left the filer's set", async () => {
    const routes = defaultRoutes();
    routes["/api/Filer/filer/658"] = {
      filerId: 658,
      filerTypeName: "Candidate",
      filerStatusName: "Active",
      isTerminated: false,
      committeeIds: [999],
      independentExpenditureIds: [],
    };
    await expect(syncDenverCandidateFinance(baseInput(routes))).rejects.toThrow(
      /registration committee 641 is not on filer 658's committee list/,
    );
  });

  it("aborts on an order-of-magnitude receipts collapse unless bypassed", async () => {
    const input = { ...baseInput(defaultRoutes()), db: dryDb("3000.00") };
    await expect(syncDenverCandidateFinance(input)).rejects.toThrow(
      /total receipts collapsed for filer 658: \$3000\.00 -> \$200\.00/,
    );
    const bypassed = await syncDenverCandidateFinance({
      ...baseInput(defaultRoutes()),
      db: dryDb("3000.00"),
      bypassAnomalyCheck: true,
    });
    expect(bypassed.totalReceiptsCents).toBe(20_000);
  });

  it("writes the snapshot with exact dollar strings when not a dry run", async () => {
    const clientQueries: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        clientQueries.push({ sql, params: params ?? [] });
        if (sql.startsWith("INSERT INTO public.denver_candidate_finance_links"))
          return { rows: [{ id: "33333333-3333-4333-8333-333333333333" }] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const db = {
      query: vi.fn(async () => ({ rows: [] })),
      connect: async () => client,
    } as never;
    const result = await syncDenverCandidateFinance({
      ...baseInput(defaultRoutes()),
      db,
      dryRun: false,
    });
    expect(result.written).toBe(true);
    const summaryInsert = clientQueries.find((entry) =>
      entry.sql.includes("denver_candidate_finance_summaries"),
    );
    expect(summaryInsert?.params).toEqual([
      "33333333-3333-4333-8333-333333333333",
      2026,
      "200.00",
      "150.00",
      "120.00",
      "-7.38",
      // Loans and FEF matching are persisted as their own columns, not
      // folded into the raised figure.
      "0.00",
      "50.00",
      "30.00",
      "10.00",
      "https://denver.maplight.com",
      expect.any(String),
    ]);
    expect(clientQueries.map((entry) => entry.sql)).toContain("COMMIT");
  });
});

describe("Denver committee cash sync integration", () => {
 it("feeds qualified monetary committee cash independently of outside spending", async () => {
  const routes=defaultRoutes(), page=routes.SearchContributionTransactions as {searchContributionTransactions: Record<string,unknown>[]};
  Object.assign(page.searchContributionTransactions[0]!,{contactTypeId:3,contributorName:"Example PAC",orgName:"Example PAC",date:"2026-10-14T06:00:00"});
  routes["positionType=1"]=[];routes["positionType=2"]=[];
  Object.assign(routes.getFinancialOverviewByCandCommittee as object,{independentExpendituresSupportingCandidate:0,independentExpendituresOpposingCandidate:0});
  const result=await syncDenverCandidateFinance(baseInput(routes));expect(result).toMatchObject({reportedCommitteeCashCents:10000,reportedCommitteeCashGroupCount:1,reportedCommitteeCashGiftCount:1,outsideGroupCount:0,directContributionCents:15000});
 });
 it("holds an identified signed committee adjustment instead of exposing gross cash as net", async () => {
  const routes=defaultRoutes(),page=routes.SearchContributionTransactions as {searchContributionTransactions: Record<string,unknown>[]};
  Object.assign(page.searchContributionTransactions[2]!,{contactTypeId:3,contributorName:"Example PAC",date:"2026-10-14T06:00:00"});
  await expect(syncDenverCandidateFinance(baseInput(routes))).rejects.toThrow(/signed/);
 });
});
