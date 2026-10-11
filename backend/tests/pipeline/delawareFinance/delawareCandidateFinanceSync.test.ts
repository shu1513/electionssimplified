import { describe, expect, it, vi } from "vitest";

import type {
  DelawareFiledReportRow,
  DelawareReceiptCsvRow,
  DelawareReportCover,
} from "../../../src/pipeline/delawareFinance/delawareCfrsParsers.js";
import type { DelawareCfrsCommitteeArtifacts } from "../../../src/pipeline/delawareFinance/delawareCfrsArtifactCache.js";
import { syncDelawareCandidateFinance } from "../../../src/pipeline/delawareFinance/delawareCandidateFinanceSync.js";

const CF_ID = "01009999";
const MEMBER_ID = 600001;
const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";
const LINK_ID = "33333333-3333-4333-8333-333333333333";

function receiptRow(amount: string, overrides: Partial<DelawareReceiptCsvRow> = {}): DelawareReceiptCsvRow {
  return {
    "Contribution Date": "06/30/2026",
    "Contributor Name": "Jane Donor",
    "Contributor Address Line 1": "",
    "Contributor Address Line 2": "",
    "Contributor City": "",
    "Contributor State": "",
    "Contributor Zip": "19801",
    "Contributor Type": "Individual",
    "Employer Name": "",
    "Employer Occupation": "Attorney",
    "Contribution Type": "Check",
    "Contribution Amount": amount,
    CF_ID,
    "Receiving Committee": "Jane Example for Delaware",
    "Filing Period": "2026 2026  General Election 11/03/2026 30 Day",
    Office: "(Attorney General)",
    "Fixed Asset": "No",
    ...overrides,
  };
}

const FILED_REPORT: DelawareFiledReportRow = {
  filingPeriodName: "2026 30 Day 2026 General Election 11/03/2026",
  reportName: "Original Financial Statement",
  cfId: CF_ID,
  committeeName: "Jane Example for Delaware",
  committeeType: "Candidate Committee",
  dateFiled: "10/06/2026",
  filingYear: "2026",
  office: "State Office - Attorney General",
  committeeStatus: "Active",
  document: { publicReportFileName: "report1.pdf", memberId: MEMBER_ID, filingCalendarId: 900 },
};

const COVER: DelawareReportCover = {
  pageNumber: 2,
  beginningBalanceCents: 0,
  receiptsCents: 700_00,
  expendituresCents: 300_00,
  endingBalanceCents: 400_00,
  reportingPeriodFrom: "01/01/2026",
  reportingPeriodTo: "10/05/2026",
  documentVersion: 1,
  method: "rows",
};

function artifacts(overrides: Partial<DelawareCfrsCommitteeArtifacts> = {}): DelawareCfrsCommitteeArtifacts {
  return {
    manifest: {
      version: 1,
      parserVersion: 1,
      cfId: CF_ID,
      memberId: MEMBER_ID,
      sourceUrl: "https://cfrs.elections.delaware.gov/",
      retrievedAt: "2026-08-28T00:00:00.000Z",
      receiptsSearchTotal: 2,
      expensesSearchTotal: 1,
      files: { receiptsCsv: e(), expensesCsv: e(), filedReportsHtml: e(), reportPdfs: [] },
    },
    receiptRows: [receiptRow("500.0000"), receiptRow("200.0000", { "Contributor Name": "Sam Donor" })],
    receiptsMalformedRowCount: 0,
    expenseRows: [
      {
        "Expenditure Date": "07/01/2026",
        "Payee Name": "Vendor",
        "Payee Address Line 1": "",
        "Payee Address Line 2": "",
        "Payee City": "",
        "Payee State": "",
        "Payee Zip": "",
        "Payee Type": "Business/Group/Organization",
        "Amount($)": "300.0000",
        "CF ID": CF_ID,
        "Committee Name": "Jane Example for Delaware",
        "Expense Category": "Media",
        "Expense Purpose": "Ads",
        "Expense Method": "Check",
        "Filing Period": "2026 30 Day General",
        "Fixed Asset": "No",
      },
    ],
    expensesMalformedRowCount: 0,
    filedReportRows: [FILED_REPORT],
    filedReportsGridTotal: 1,
    reportPdfs: [{ publicReportFileName: "report1.pdf", filingCalendarId: 900, body: Buffer.from("PDF") }],
    ...overrides,
  };

  function e() {
    return { path: "x", sha256: "0".repeat(64), byteSize: 1 };
  }
}

const extractReportCover = async () => COVER;

function baseInput(db: unknown) {
  return {
    db: db as never,
    candidateId: CANDIDATE_ID,
    electionId: ELECTION_ID,
    candidateName: "Jane Example",
    electionYear: 2026,
    electionDate: "2026-11-03",
    officeScope: "statewide",
    officeName: "Attorney General",
    committee: { cfId: CF_ID, committeeName: "Jane Example for Delaware", linkSource: "cfrs_portal" as const },
    artifacts: artifacts(),
    now: new Date("2026-08-28T00:00:00.000Z"),
    extractReportCover,
  };
}

describe("syncDelawareCandidateFinance", () => {
  it("computes window totals on a dry run without touching the database", async () => {
    const db = { query: vi.fn(), connect: vi.fn() };
    const result = await syncDelawareCandidateFinance({ ...baseInput(db), dryRun: true });

    expect(result.window).toEqual({ windowStart: "2026-01-01", windowEnd: "2026-12-31", publishedThrough: "2026-10-05", basis: "committee_first_report" });
    expect(result.windowPeriodKeys).toEqual(["2026 30 Day General"]);
    expect(result.totalReceipts).toBe(700);
    expect(result.directContributionTotal).toBe(700);
    expect(result.totalDisbursements).toBe(300);
    expect(result.cashOnHand).toBe(400);
    expect(result.linkWritten).toBe(false);
    expect(db.connect).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  it("writes the snapshot transactionally on a real run", async () => {
    const client = {
      query: vi.fn((sql: unknown) =>
        String(sql).includes("INSERT INTO public.de_candidate_finance_links")
          ? Promise.resolve({ rows: [{ id: LINK_ID }], rowCount: 1 })
          : Promise.resolve({ rows: [], rowCount: 0 })
      ),
      release: vi.fn(),
    };
    const db = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }), connect: vi.fn().mockResolvedValue(client) };

    const result = await syncDelawareCandidateFinance(baseInput(db));
    expect(result.linkWritten).toBe(true);
    expect(result.summaryWritten).toBe(true);
    // occupation (Attorney) + two size buckets.
    expect(result.directBreakdownsWritten).toBe(3);
    const summaryCall = client.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO public.de_candidate_finance_summaries")
    );
    expect(summaryCall?.[1]).toContain(700);
    expect(
      client.query.mock.calls.some((call) => String(call[0]).includes("INSERT INTO public.de_candidate_finance_outside_groups"))
    ).toBe(false);
  });

  it("fails closed when the committee's filed reports carry a different office", async () => {
    const db = { query: vi.fn(), connect: vi.fn() };
    const wrongOffice = artifacts();
    wrongOffice.filedReportRows = [{ ...FILED_REPORT, office: "State Office - Governor" }];
    await expect(
      syncDelawareCandidateFinance({ ...baseInput(db), artifacts: wrongOffice, dryRun: true })
    ).rejects.toThrow(/committee registration mismatch/);
  });

  it("fails closed on committee-identity and count drift", async () => {
    const db = { query: vi.fn(), connect: vi.fn() };
    const wrongCfId = artifacts();
    wrongCfId.receiptRows[0] = receiptRow("500.0000", { CF_ID: "01000000" });
    await expect(
      syncDelawareCandidateFinance({ ...baseInput(db), artifacts: wrongCfId, dryRun: true })
    ).rejects.toThrow(/receipt row carries CF_ID 01000000/);

    const badTotal = artifacts();
    badTotal.manifest.receiptsSearchTotal = 3;
    await expect(
      syncDelawareCandidateFinance({ ...baseInput(db), artifacts: badTotal, dryRun: true })
    ).rejects.toThrow(/receipts CSV rows \(2\) != stored-search total \(3\)/);
  });

  it("fails closed when per-period reconciliation breaks", async () => {
    const db = { query: vi.fn(), connect: vi.fn() };
    const shortRows = artifacts({ receiptRows: [receiptRow("500.0000")] });
    shortRows.manifest.receiptsSearchTotal = 1;
    await expect(
      syncDelawareCandidateFinance({ ...baseInput(db), artifacts: shortRows, dryRun: true })
    ).rejects.toThrow(/per-period cover reconciliation failed/);
  });

  it("fails closed on unrecognized contribution types inside the window", async () => {
    const db = { query: vi.fn(), connect: vi.fn() };
    const withUnknown = artifacts();
    withUnknown.receiptRows[1] = receiptRow("200.0000", { "Contribution Type": "Wire Transfer" });
    await expect(
      syncDelawareCandidateFinance({ ...baseInput(db), artifacts: withUnknown, dryRun: true })
    ).rejects.toThrow(/unrecognized Contribution Types in window: Wire Transfer/);
  });

  it("rejects ineligible offices before reading anything", async () => {
    const db = { query: vi.fn(), connect: vi.fn() };
    await expect(
      syncDelawareCandidateFinance({ ...baseInput(db), officeScope: "county", officeName: "Sheriff", dryRun: true })
    ).rejects.toThrow(/not Delaware-finance eligible/);
  });
});
