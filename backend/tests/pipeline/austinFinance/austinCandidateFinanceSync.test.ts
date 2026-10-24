import { describe, expect, it, vi } from "vitest";

import {
  classifyFinanceLabel,
  normalizeFinanceLabel,
  type FinanceLabelClassification,
} from "../../../src/pipeline/finance/financeLabelClassifier.js";
import { financeClassificationKey } from "../../../src/pipeline/finance/financeIndustryClassificationService.js";
import { AUSTIN_FINANCE_LINK_SOURCE_URL } from "../../../src/pipeline/austinFinance/austinCandidateFinanceAutoLink.js";
import {
  buildAustinPacFunderBreakdownRows,
  loadAustinOutsideDatasets,
  syncAustinCandidateFinance,
} from "../../../src/pipeline/austinFinance/austinCandidateFinanceSync.js";

// Raw Socrata records (the client maps them); Qadri-shaped 2026 D9 cycle.
function reportRecord(over: Record<string, unknown>): Record<string, unknown> {
  return {
    report_id: "R11",
    filer_name: "Qadri, Zohaib",
    form_type: "COH - Candidate /Officeholder Campaign Finance Report",
    report_type: "July 15th semiannual",
    date_filed: "2025-07-15T00:00:00.000",
    period_from: "2025-01-01T00:00:00.000",
    period_to: "2025-06-30T00:00:00.000",
    election_date: "2026-11-03T00:00:00.000",
    election_type: "General",
    office_sought: "COUNCIL_MBR_DISTRICT_09",
    office_held: "COUNCIL_MBR_DISTRICT_09",
    contrib_total: "0",
    expend_total: "0",
    contrib_balance: "0",
    outstand_loan: "0",
    ...over,
  };
}

let nextTx = 1;
function contributionRecord(reportId: string, amount: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transaction_id: `${reportId}-A${String(nextTx++).padStart(5, "0")}`,
    recipient: "Qadri, Zohaib",
    donor: "Doe, Jane",
    donor_type: "INDIVIDUAL",
    contribution_type: "Monetary Political Contribution",
    contribution_amount: amount,
    contribution_date: "2025-03-01T00:00:00.000",
    donor_reported_occupation: "Attorney",
    donor_reported_employer: "Firm",
    ...over,
  };
}

function defaultRoutes(): Record<string, unknown[]> {
  return {
    "b2pc-2s8n": [
      // Jul-2025 semiannual, original + correction (correction wins), listed twice (duplicate rows).
      reportRecord({ report_id: "R11", contrib_total: "37474.00", expend_total: "15527.43", contrib_balance: "180855.45" }),
      reportRecord({ report_id: "R11", contrib_total: "37474.00", expend_total: "15527.43", contrib_balance: "180855.45" }),
      reportRecord({ report_id: "R12", form_type: "CORCOH - Correction/Amendment", date_filed: "2025-07-16T00:00:00.000", contrib_total: "37474.00", expend_total: "15527.43", contrib_balance: "184463.55" }),
      // Jan-2026 semiannual.
      reportRecord({ report_id: "R21", report_type: "January 15th semiannual", date_filed: "2026-01-15T00:00:00.000", period_from: "2025-07-01T00:00:00.000", period_to: "2025-12-31T00:00:00.000", contrib_total: "27064.00", expend_total: "29860.19", contrib_balance: "181776.50" }),
      // The 2022 cycle for the same seat: not this election.
      reportRecord({ report_id: "R01", date_filed: "2022-10-28T00:00:00.000", period_from: "2022-09-27T00:00:00.000", period_to: "2022-10-26T00:00:00.000", election_date: "2022-11-08T00:00:00.000", contrib_total: "50000.00", expend_total: "40000.00", contrib_balance: "1000.00" }),
    ],
    "3kfv-biw6": [
      contributionRecord("R12", "37000.00", { donor_reported_occupation: "Retired" }),
      contributionRecord("R12", "474.00", { donor_reported_occupation: "Attorney" }),
      contributionRecord("R11", "37474.00"), // superseded original — ignored
      contributionRecord("R21", "27000.00", { donor_reported_occupation: "Attorney" }),
      contributionRecord("R21", "64.00", { donor_reported_occupation: null }),
      contributionRecord("R21", "500.00", { contribution_type: "Pledged Contribution" }),
      contributionRecord("R01", "50000.00"),
    ],
    "8p2b-ewep": [
      // RECA supports Qadri, in window, single target, listed on two reports.
      { dce_id: "D1", parent_transaction: "R91-F00001", paid_by: "The Real Estate Council of Austin, Inc. Advancing Democracy PAC", payee: "Mailer Co", payment_date: "2025-10-01T00:00:00.000", payment_amount: "12000.00", candidate_or_measure: "Qadri, Zohaib", office_sought_info: "COUNCIL_MBR_DISTRICT_09" },
      { dce_id: "D2", parent_transaction: "R92-F00001", paid_by: "The Real Estate Council of Austin, Inc. Advancing Democracy PAC", payee: "Mailer Co", payment_date: "2025-10-01T00:00:00.000", payment_amount: "12000.00", candidate_or_measure: "Qadri, Zohaib", office_sought_info: "COUNCIL_MBR_DISTRICT_09" },
      // City Accountability Project opposes; no purpose row for 2026 → undirected.
      { dce_id: "D3", parent_transaction: "R81-F00001", paid_by: "City Accountability Project", payee: "Print Co", payment_date: "2026-03-01T00:00:00.000", payment_amount: "800.00", candidate_or_measure: "Qadri, Zohaib", office_sought_info: "COUNCIL_MBR_DISTRICT_09" },
      // Qadri's own DCE (self) — direct spending.
      { dce_id: "D4", parent_transaction: "R12-F00001", paid_by: "Qadri, Zohaib", payee: "Print Co", payment_date: "2025-05-01T00:00:00.000", payment_amount: "300.00", candidate_or_measure: "Qadri, Zohaib", office_sought_info: null },
      // 2022 cycle: outside the window.
      { dce_id: "D5", parent_transaction: "R71-F00001", paid_by: "City Accountability Project", payee: "Print Co", payment_date: "2022-10-15T00:00:00.000", payment_amount: "5000.00", candidate_or_measure: "Qadri, Zohaib", office_sought_info: "COUNCIL_MBR_DISTRICT_09" },
    ],
    // Report Detail facts behind the DCE / purpose report ids (the by-ids query).
    "report_id in (": [
      reportRecord({ report_id: "R91", filer_name: "The Real Estate Council of Austin, Inc. Advancing Democracy PAC", form_type: "MPAC - Monthly PAC", period_from: "2025-09-26T00:00:00.000", period_to: "2025-10-25T00:00:00.000", date_filed: "2025-10-28T00:00:00.000", election_date: null, office_sought: null }),
      reportRecord({ report_id: "R92", filer_name: "The Real Estate Council of Austin, Inc. Advancing Democracy PAC", form_type: "CORPAC - Correction", period_from: "2025-09-26T00:00:00.000", period_to: "2025-10-25T00:00:00.000", date_filed: "2025-11-02T00:00:00.000", election_date: null, office_sought: null }),
      reportRecord({ report_id: "R81", filer_name: "City Accountability Project", form_type: "GPAC - General Purpose PAC", period_from: "2026-01-01T00:00:00.000", period_to: "2026-06-30T00:00:00.000", date_filed: "2026-07-15T00:00:00.000", election_date: null, office_sought: null }),
      reportRecord({ report_id: "R71", filer_name: "City Accountability Project", form_type: "GPAC - General Purpose PAC", period_from: "2022-07-01T00:00:00.000", period_to: "2022-12-31T00:00:00.000", date_filed: "2023-01-15T00:00:00.000", election_date: null, office_sought: null }),
    ],
    // RECA's complete Report Detail picture (the Phase 3b by-filer fetch —
    // an empty correction must be visible even with no receipt rows on it).
    "filer_name = 'The Real Estate Council": [
      reportRecord({ report_id: "R91", filer_name: "The Real Estate Council of Austin, Inc. Advancing Democracy PAC", form_type: "MPAC - Monthly PAC", period_from: "2025-09-26T00:00:00.000", period_to: "2025-10-25T00:00:00.000", date_filed: "2025-10-28T00:00:00.000", election_date: null, office_sought: null }),
      reportRecord({ report_id: "R92", filer_name: "The Real Estate Council of Austin, Inc. Advancing Democracy PAC", form_type: "CORPAC - Correction", period_from: "2025-09-26T00:00:00.000", period_to: "2025-10-25T00:00:00.000", date_filed: "2025-11-02T00:00:00.000", election_date: null, office_sought: null }),
    ],
    // RECA's own receipts (the Phase 3b funder fetch, recipient = spender).
    "recipient = 'The Real Estate Council": [
      contributionRecord("R91", "10000.00", { recipient: "The Real Estate Council of Austin, Inc. Advancing Democracy PAC", donor: "Kilroy Realty, L.P.", donor_type: "ENTITY", contribution_date: "2025-11-10T00:00:00.000", donor_reported_occupation: null, donor_reported_employer: null }),
      contributionRecord("R91", "5000.00", { recipient: "The Real Estate Council of Austin, Inc. Advancing Democracy PAC", donor: "Way To Lead PAC", donor_type: "ENTITY", contribution_date: "2025-11-11T00:00:00.000", donor_reported_occupation: null, donor_reported_employer: null }),
      contributionRecord("R91", "2000.00", { recipient: "The Real Estate Council of Austin, Inc. Advancing Democracy PAC", donor: "Nosek, Nicole", donor_type: "INDIVIDUAL", contribution_date: "2025-11-12T00:00:00.000" }),
    ],
    "u3cd-iecr": [
      { committee_purp_id: "R91-C00001", report: "R91", filer_name: "The Real Estate Council of Austin, Inc. Advancing Democracy PAC", committee_activity: "SUPPORT", purpose_type: "CANDIDATE", recipient: "Zohaib,Qadri", office_sought: "COUNCIL_MBR_DISTRICT_09" },
      { committee_purp_id: "R71-C00001", report: "R71", filer_name: "City Accountability Project", committee_activity: "OPPOSE", purpose_type: "CANDIDATE", recipient: "Zo,Qadri", office_sought: "COUNCIL_MBR_DISTRICT_09", election_date: "2024-11-05T00:00:00.000" },
    ],
  };
}

function makeFetch(routes: Record<string, unknown[]>) {
  return vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = decodeURIComponent(String(input)).replace(/\+/g, " ");
    const entries = Object.entries(routes).sort(([a], [b]) => Number(b.includes(" ")) - Number(a.includes(" ")));
    for (const [needle, payload] of entries) {
      if (url.includes(needle.includes(" ") ? needle : `/resource/${needle}.json`))
        return new Response(JSON.stringify(payload), { status: 200 });
    }
    throw new Error(`Unexpected URL in test fetch: ${url}`);
  });
}

function dryDb(storedReceipts: string | null = null) {
  return {
    query: vi.fn(async () =>
      storedReceipts === null ? { rows: [] } : { rows: [{ total_receipts: storedReceipts }] },
    ),
    connect: async () => {
      throw new Error("dry-run test must not open a transaction");
    },
  } as never;
}

function baseInput(routes: Record<string, unknown[]>) {
  return {
    db: dryDb(),
    candidateId: "11111111-1111-4111-8111-111111111111",
    electionId: "22222222-2222-4222-8222-222222222222",
    electionYear: 2026,
    candidateDisplayName: 'Zohaib "Zo" Qadri',
    officeName: "City Council Member",
    district: "District 9",
    filerName: "Qadri, Zohaib",
    electionDate: "2026-11-03",
    officeCode: "COUNCIL_MBR_DISTRICT_09" as const,
    dryRun: true,
    now: new Date("2026-08-19T12:00:00Z"),
    clientOptions: { fetchImpl: makeFetch(routes) },
  };
}

describe("buildAustinPacFunderBreakdownRows", () => {
  it("keeps every industry's top donor persisted even past the display cap", () => {
    // 50 unclassifiable donors above the cap, one real-estate donor below
    // it: the industry row must not appear without its evidence donor.
    const donors = [
      ...Array.from({ length: 50 }, (_, index) => ({
        donorName: `Placeholder Partners ${String(index + 1).padStart(3, "0")}`,
        donorKey: `PLACEHOLDER PARTNERS ${String(index + 1).padStart(3, "0")}`,
        amountCents: 100_000_00 - index * 100,
        receiptCount: 1,
      })),
      { donorName: "Tail End Realty", donorKey: "TAIL END REALTY", amountCents: 50_00, receiptCount: 1 },
    ];
    const classifications = new Map<string, FinanceLabelClassification>();
    for (const donor of donors) {
      const classification = classifyFinanceLabel({ rawLabel: donor.donorName, labelType: "donor" });
      classifications.set(
        financeClassificationKey("donor", classification.normalizedLabel),
        classification,
      );
    }
    const rows = buildAustinPacFunderBreakdownRows({
      spenderName: "Vibrant Austin PAC",
      supportOppose: "support",
      donors,
      classifications,
    });
    const donorRows = rows.filter((row) => row.categoryType === "donor");
    const industryRows = rows.filter((row) => row.categoryType === "industry");
    expect(donorRows).toHaveLength(51); // top 50 + the appended evidence donor
    expect(donorRows.at(-1)).toMatchObject({ categoryName: "Tail End Realty", amountCents: 50_00 });
    expect(industryRows).toEqual([
      expect.objectContaining({ categoryName: "real_estate", amountCents: 50_00, contributorCount: 1 }),
    ]);
  });
});

describe("syncAustinCandidateFinance", () => {
  it("reconciles covers, buckets, cash, and outside spending on a dry run", async () => {
    const result = await syncAustinCandidateFinance(baseInput(defaultRoutes()));
    expect(result).toEqual({
      written: false,
      reportedCommitteeCashGroupCount: 0,
      reportedCommitteeCashCents: 0,
      reportedCommitteeCashGiftCount: 0,
      outsideComponentPreserved: false,
      totalRaisedCents: 6_453_800, // 37,474.00 + 27,064.00
      totalSpentCents: 4_538_762, // 15,527.43 + 29,860.19
      cashOnHandCents: 18_177_650,
      outsideSupportCents: 1_200_000, // RECA once, not twice
      outsideOpposeCents: 0,
      directBreakdownCount: 5, // Retired, Attorney + three size buckets
      outsideGroupCount: 1,
      cycleReportCount: 2,
      keptSpecialReportCount: 0,
      itemizedRowCount: 4,
      nonReceiptRowCount: 1,
      unitemizedCents: 0,
      outsideWindow: { from: "2025-01-01", to: "2026-11-03" },
      outsideMultiTargetCents: 0,
      outsideUndirectedCents: 80_000,
      outsideUndirectedSpenders: ["City Accountability Project"],
      outsideAmbiguousDirectionCents: 0,
      outsideSelfCents: 30_000,
      outsideGroupBreakdownCount: 2, // Kilroy donor row + real_estate industry row
      pacDonorCount: 1,
      pacIndividualCents: 200_000, // Nosek, Nicole
      pacIneligibleOrgCents: 500_000, // Way To Lead PAC
    });
  });

  it("bounds the funder fetch to the cycle window and the spender's exact name", async () => {
    const routes = defaultRoutes();
    const fetchImpl = makeFetch(routes);
    await syncAustinCandidateFinance({ ...baseInput(routes), clientOptions: { fetchImpl } });
    const urls = fetchImpl.mock.calls.map(([url]) => decodeURIComponent(String(url)).replace(/\+/g, " "));
    expect(
      urls.some(
        (url) =>
          url.includes("recipient = 'The Real Estate Council of Austin, Inc. Advancing Democracy PAC'") &&
          url.includes("contribution_date >= '2025-01-01T00:00:00.000'") &&
          url.includes("contribution_date <= '2026-11-03T23:59:59.999'"),
      ),
    ).toBe(true);
  });

  it("queries Socrata by the exact filer string", async () => {
    const routes = defaultRoutes();
    const fetchImpl = makeFetch(routes);
    await syncAustinCandidateFinance({ ...baseInput(routes), clientOptions: { fetchImpl } });
    const urls = fetchImpl.mock.calls.map(([url]) => decodeURIComponent(String(url)).replace(/\+/g, " "));
    expect(urls.some((url) => url.includes("b2pc-2s8n.json") && url.includes("filer_name = 'Qadri, Zohaib'"))).toBe(true);
    expect(urls.some((url) => url.includes("3kfv-biw6.json") && url.includes("recipient = 'Qadri, Zohaib'"))).toBe(true);
  });

  it("uses prefetched city-wide datasets when given", async () => {
    const routes = defaultRoutes();
    const outside = await loadAustinOutsideDatasets({ fetchImpl: makeFetch(routes) });
    expect([...outside.reportsById.keys()].sort()).toEqual(["R71", "R81", "R91", "R92"]);
    const fetchImpl = makeFetch({ "b2pc-2s8n": routes["b2pc-2s8n"]!, "3kfv-biw6": routes["3kfv-biw6"]! });
    const result = await syncAustinCandidateFinance({
      ...baseInput(routes),
      clientOptions: { fetchImpl },
      outsideDatasets: outside,
    });
    expect(result.outsideSupportCents).toBe(1_200_000);
    expect(fetchImpl.mock.calls.every(([url]) => !String(url).includes("8p2b-ewep") && !String(url).includes("u3cd-iecr"))).toBe(true);
  });

  it("refuses an empty city-wide dataset or an empty PAC-report join", async () => {
    const routes = defaultRoutes();
    routes["8p2b-ewep"] = [];
    await expect(loadAustinOutsideDatasets({ fetchImpl: makeFetch(routes) })).rejects.toThrow(
      /Direct Campaign Expenditures dataset returned no rows/,
    );
    const noReports = defaultRoutes();
    noReports["report_id in ("] = [];
    await expect(loadAustinOutsideDatasets({ fetchImpl: makeFetch(noReports) })).rejects.toThrow(
      /Report Detail returned no rows for 5 referenced PAC reports/,
    );
  });

  it("fails closed when the filer has no effective report for the link's seat and election", async () => {
    await expect(
      syncAustinCandidateFinance({ ...baseInput(defaultRoutes()), officeCode: "MAYOR" }),
    ).rejects.toThrow(/has no effective report for MAYOR \/ 2026-11-03/);
  });

  it("fails closed when itemized rows exceed a cover", async () => {
    const routes = defaultRoutes();
    routes["3kfv-biw6"] = [...routes["3kfv-biw6"]!, contributionRecord("R21", "0.01")];
    await expect(syncAustinCandidateFinance(baseInput(routes))).rejects.toThrow(
      /R21: itemized \$27064\.01 exceeds cover \$27064\.00/,
    );
  });

  it("rejects an election date outside the allowlist", async () => {
    await expect(
      syncAustinCandidateFinance({ ...baseInput(defaultRoutes()), electionDate: "2024-11-05" }),
    ).rejects.toThrow(/2024-11-05 is not in the v1 allowlist/);
  });

  it("aborts on an order-of-magnitude receipts collapse unless bypassed", async () => {
    await expect(
      syncAustinCandidateFinance({ ...baseInput(defaultRoutes()), db: dryDb("700000.00") }),
    ).rejects.toThrow(/total receipts collapsed for filer "Qadri, Zohaib": \$700000\.00 -> \$64538\.00/);
    const bypassed = await syncAustinCandidateFinance({
      ...baseInput(defaultRoutes()),
      db: dryDb("700000.00"),
      bypassAnomalyCheck: true,
    });
    expect(bypassed.totalRaisedCents).toBe(6_453_800);
  });

  it("writes the snapshot with exact dollar strings when not a dry run", async () => {
    const clientQueries: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        clientQueries.push({ sql, params: params ?? [] });
        if (sql.startsWith("INSERT INTO public.atx_candidate_finance_links"))
          return { rows: [{ id: "33333333-3333-4333-8333-333333333333" }] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const db = {
      query: vi.fn(async () => ({ rows: [] })),
      connect: async () => client,
    } as never;
    const result = await syncAustinCandidateFinance({ ...baseInput(defaultRoutes()), db, dryRun: false });
    expect(result.written).toBe(true);
    const linkInsert = clientQueries.find((entry) => entry.sql.startsWith("INSERT INTO public.atx_candidate_finance_links"));
    expect(linkInsert?.params).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      2026,
      "ZOHAIB ZO QADRI",
      "City Council Member",
      "District 9",
      "QADRI ZOHAIB",
      "Qadri, Zohaib",
      "active",
      "austin_clerk",
      AUSTIN_FINANCE_LINK_SOURCE_URL,
      "2026-08-19T12:00:00.000Z",
    ]);
    const summaryInsert = clientQueries.find((entry) => entry.sql.includes("atx_candidate_finance_summaries"));
    expect(summaryInsert?.params).toEqual([
      "33333333-3333-4333-8333-333333333333",
      2026,
      "64538.00",
      "64538.00",
      "45387.62",
      "181776.50",
      "12000.00",
      "0.00",
      AUSTIN_FINANCE_LINK_SOURCE_URL,
      "2026-08-19T12:00:00.000Z",
      true,
      true,
    ]);
    const groupInsert = clientQueries.find((entry) => entry.sql.includes("atx_candidate_finance_outside_groups ("));
    expect(groupInsert?.params).toEqual([
      "33333333-3333-4333-8333-333333333333",
      2026,
      "THE REAL ESTATE COUNCIL OF AUSTIN INC ADVANCING DEMOCRACY PAC",
      "The Real Estate Council of Austin, Inc. Advancing Democracy PAC",
      "support",
      "12000.00",
      AUSTIN_FINANCE_LINK_SOURCE_URL,
      "2026-08-19T12:00:00.000Z",
    ]);
    const breakdownInserts = clientQueries.filter((entry) =>
      entry.sql.includes("atx_candidate_finance_outside_group_breakdowns ("),
    );
    expect(breakdownInserts.map((entry) => entry.params)).toEqual([
      [
        "33333333-3333-4333-8333-333333333333",
        2026,
        "THE REAL ESTATE COUNCIL OF AUSTIN INC ADVANCING DEMOCRACY PAC",
        "support",
        "donor",
        "Kilroy Realty, L.P.",
        "10000.00",
        1,
        AUSTIN_FINANCE_LINK_SOURCE_URL,
        "2026-08-19T12:00:00.000Z",
      ],
      [
        "33333333-3333-4333-8333-333333333333",
        2026,
        "THE REAL ESTATE COUNCIL OF AUSTIN INC ADVANCING DEMOCRACY PAC",
        "support",
        "industry",
        "real_estate",
        "10000.00",
        1,
        AUSTIN_FINANCE_LINK_SOURCE_URL,
        "2026-08-19T12:00:00.000Z",
      ],
    ]);
    // The rule verdict behind the industry row lands in the shared cache so
    // the ballot-lookup evidence join can see it.
    const classificationUpserts = clientQueries.filter((entry) =>
      entry.sql.includes("finance_label_classifications"),
    );
    expect(classificationUpserts.map((entry) => entry.params)).toEqual([
      [
        "Kilroy Realty, L.P.",
        "donor",
        normalizeFinanceLabel("Kilroy Realty, L.P.", "donor"),
        "real_estate",
        "medium",
        "rule",
      ],
    ]);
    expect(clientQueries.map((entry) => entry.sql)).toContain("COMMIT");
  });
});


describe("Austin independent cash and incomplete outside evidence", () => {
  it("writes committee cash while preserving unresolved empty outside data", async () => {
    const routes = defaultRoutes();
    routes["u3cd-iecr"] = routes["u3cd-iecr"]!.map(row => ({ ...row, election_date: "2024-11-05T00:00:00.000" }));
    routes["3kfv-biw6"]![0] = { ...routes["3kfv-biw6"]![0], donor: "Example Workers PAC", donor_type: "ENTITY", donor_reported_occupation: null };
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }), connect: async () => ({
      query: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params });
        return { rows: sql.startsWith("INSERT INTO public.atx_candidate_finance_links") ? [{ id: "link" }] : [] }; }, release: vi.fn(),
    }) } as never;
    const result = await syncAustinCandidateFinance({ ...baseInput(routes), db, dryRun: false });
    expect(result.outsideComponentPreserved).toBe(true);
    expect(result.reportedCommitteeCashGroupCount).toBe(1);
    expect(result.reportedCommitteeCashCents).toBe(3_700_000);
    expect(calls.some(call => /(?:INSERT INTO|DELETE FROM) public.atx_candidate_finance_outside/.test(call.sql))).toBe(false);
    const summary = calls.find(call => call.sql.startsWith("INSERT INTO public.atx_candidate_finance_summaries"))!;
    expect(summary.params.slice(6, 8)).toEqual([null, null]);
    expect(summary.params.slice(10)).toEqual([false, false]);
    expect(calls.some(call => call.sql.startsWith("INSERT INTO public.atx_candidate_finance_pac_donors"))).toBe(true);
    expect(calls.at(-1)?.sql).toBe("COMMIT");
  });
});

describe("Austin unresolved multi-target payments that net to zero", () => {
  it("still preserves prior outside data instead of writing a zero", async () => {
    const routes = defaultRoutes();
    const dce = (id: string, amount: string, target: string) => ({ dce_id: id, parent_transaction: "R81-F0000" + id, paid_by: "City Accountability Project",
      payee: "Print Co", payment_date: "2026-03-01T00:00:00.000", payment_amount: amount, candidate_or_measure: target, office_sought_info: "COUNCIL_MBR_DISTRICT_09" });
    routes["8p2b-ewep"] = [dce("1", "100.00", "Qadri, Zohaib"), dce("2", "100.00", "Other, Person"),
      dce("3", "-100.00", "Qadri, Zohaib"), dce("4", "-100.00", "Other, Person")];
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }), connect: async () => ({
      query: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params });
        return { rows: sql.startsWith("INSERT INTO public.atx_candidate_finance_links") ? [{ id: "link" }] : [] }; }, release: vi.fn(),
    }) } as never;
    const result = await syncAustinCandidateFinance({ ...baseInput(routes), db, dryRun: false });
    expect(result.outsideComponentPreserved).toBe(true);
    expect(calls.some(call => /(?:INSERT INTO|DELETE FROM) public.atx_candidate_finance_outside/.test(call.sql))).toBe(false);
    const summary = calls.find(call => call.sql.startsWith("INSERT INTO public.atx_candidate_finance_summaries"))!;
    expect(summary.params.slice(10)).toEqual([false, false]);
  });
});
