import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it } from "vitest";

import {
  aggregateRhodeIslandContributionSizeBuckets,
  aggregateRhodeIslandOrganizationCycleFinance,
  reconcileRhodeIslandPeriodAgainstCf2,
  rhodeIslandContributionSizeBucket,
  ERTS_BUCKETED_CONTRIBUTION_TYPES,
  ERTS_DONOR_CONTRIBUTION_TYPES,
  ERTS_NON_DONOR_CONTRIBUTION_TYPES,
  ERTS_PARTY_BUILDING_CONTRIBUTION_TYPES,
} from "../../../src/pipeline/rhodeIslandFinance/rhodeIslandDirectContributionAggregator.js";
import type { RhodeIslandCf2PeriodValues } from "../../../src/pipeline/rhodeIslandFinance/rhodeIslandCf2ReportSelector.js";
import { storeErtsArtifact } from "../../../src/pipeline/rhodeIslandFinance/rhodeIslandErtsArtifactCache.js";
import {
  parseErtsContributionExport,
  ERTS_CF2_SUMMARY_LABELS,
  ERTS_CONTRIBUTION_EXPORT_COLUMNS,
  ERTS_CONTRIBUTION_TYPE_CODES,
} from "../../../src/pipeline/rhodeIslandFinance/rhodeIslandErtsParsers.js";
import { makeMinimalPdf } from "../../helpers/minimalPdf.js";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../fixtures/rhodeIslandFinance/${name}`, import.meta.url)), "utf8");
}

// --- Cache-building helpers ---------------------------------------------------

function filingsPage(entries: { filingId: string; begin: string; end: string; reportType?: string }[]): string {
  const rows = entries
    .map(
      (entry) =>
        `<tr><td>${entry.reportType ?? "2026 On-Going Qrtly"}</td><td>${entry.begin}</td><td>${entry.end}</td>` +
        `<td>07/31/2026</td><td>Received by BOE</td><td>Jul 31 2026  9:00AM</td><td>No</td>` +
        `<td><a href="https://secure.ricampaignfinance.com/RhodeIslandCF/Candidate/FilingAmendmentSelect.aspx?X=T&amp;FilingID=${entry.filingId}&amp;FormName=RICF2">View</a></td></tr>`
    )
    .join("");
  return (
    '<table id="grdSearchResults">' +
    "<tr><td>Report Type</td><td>Begin</td><td>End</td><td>Due</td><td>Report Status</td><td>Original Filed</td><td>Amended</td><td>&nbsp;</td></tr>" +
    `${rows}</table>`
  );
}

function versionsPage(filingId: string, guid: string): string {
  return (
    '<table id="grdAmendments">' +
    "<tr><td>Amendment</td><td>Desc</td><td>Date Filed</td><td></td></tr>" +
    `<tr><td></td><td><a href="https://ricampaignfinance.com/ExportDocs/2235-RICF2-${filingId}-${guid}.pdf">report</a></td><td>Jul 31 2026  9:00AM</td><td></td></tr>` +
    "</table>"
  );
}

function cf2Pdf(values: Record<string, string>): Uint8Array {
  const lines: { text: string; x: number; y: number }[] = [];
  let y = 700;
  for (const label of ERTS_CF2_SUMMARY_LABELS) {
    lines.push({ text: label, x: 48, y });
    lines.push({ text: values[label] ?? "0", x: 300, y });
    y -= 20;
  }
  return makeMinimalPdf(lines);
}

function groupingsReport(groupings: Record<string, string>): string {
  const rows = Object.entries(groupings)
    .map(([label, total]) => `<tr><td>${label}</td><td>${total}</td></tr>`)
    .join("");
  return (
    '<table id="dgrReport"><tr><td>Summary Groupings</td><td>Total</td></tr>' +
    `${rows}</table><table id="dgrContribution"><tr><td>rows</td></tr></table>`
  );
}

function exportCsv(rows: Array<Record<string, string>>): string {
  const defaults: Record<string, string> = {
    ViewIncomplete: "Complete",
    ReceiptDate: "04/01/2026",
    DepositDate: "1/1/1900",
    Amount: "0.0000",
    MPFMatchAmount: "0.0000",
    BeginDate: "04/01/2026",
    EndDate: "06/30/2026",
    TransType: "Contribution",
  };
  const lines = [ERTS_CONTRIBUTION_EXPORT_COLUMNS.join(",")];
  for (const [index, row] of rows.entries()) {
    lines.push(
      ERTS_CONTRIBUTION_EXPORT_COLUMNS.map((column) => {
        const value = row[column] ?? defaults[column] ?? (column === "ContributionID" ? String(1000 + index) : "");
        return value.includes(",") ? `"${value}"` : value;
      }).join(",")
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

const NO_ROWS_EXPENDITURES = "<p>No Expenditures were found for the Search criteria you entered.</p>";

let cacheDir: string;

type PeriodArtifacts = {
  filingId: string;
  begin: string; // MM/DD/YYYY
  end: string;
  beginIso: string;
  endIso: string;
  pdfValues: Record<string, string>;
  contributionReportHtml: string;
  exportCsvText: string | null;
  expenditureReportHtml: string;
};

async function installPeriods(periods: PeriodArtifacts[]): Promise<void> {
  await storeErtsArtifact({
    cacheDir,
    key: { type: "organization_filings", orgId: "2235" },
    url: "https://www.ricampaignfinance.com/RIPublic/Filings.aspx",
    body: filingsPage(periods.map((period) => ({ filingId: period.filingId, begin: period.begin, end: period.end }))),
  });
  for (const period of periods) {
    const guid = `00000000-0000-0000-0000-${period.filingId.padStart(12, "0")}`;
    await storeErtsArtifact({
      cacheDir,
      key: { type: "filing_versions", filingId: period.filingId },
      url: `https://www.ricampaignfinance.com/RIPublic/FilingAmendmentSelect.aspx?X=T&FilingID=${period.filingId}&FormName=RICF2`,
      body: versionsPage(period.filingId, guid),
    });
    await storeErtsArtifact({
      cacheDir,
      key: { type: "filing_pdf", filingId: period.filingId, guid },
      url: `https://ricampaignfinance.com/ExportDocs/2235-RICF2-${period.filingId}-${guid}.pdf`,
      body: cf2Pdf(period.pdfValues),
    });
    const window = { orgId: "2235", beginIso: period.beginIso, endIso: period.endIso };
    await storeErtsArtifact({
      cacheDir,
      key: { type: "contribution_report", ...window },
      url: "https://www.ricampaignfinance.com/RIPublic/Reporting/TransactionReport.aspx",
      body: period.contributionReportHtml,
    });
    if (period.exportCsvText !== null) {
      await storeErtsArtifact({
        cacheDir,
        key: { type: "contribution_export", ...window },
        url: "https://www.ricampaignfinance.com/RIPublic/Reporting/DownloadFile.aspx",
        body: period.exportCsvText,
      });
    }
    await storeErtsArtifact({
      cacheDir,
      key: { type: "expenditure_report", ...window },
      url: "https://www.ricampaignfinance.com/RIPublic/Reporting/ExpenditureReport.aspx",
      body: period.expenditureReportHtml,
    });
  }
}

// The spike's McKee Q2 2026 reconciliation fixture (probe gate 1, plan
// arithmetic 1,355,115.78 + 258,945.01 - 945,434.57 = 668,626.22). The
// committed report fixtures carry the real summary groupings and the real
// expenditure total; the CF-2 values restate the real arithmetic.
const MCKEE_Q2_2026: PeriodArtifacts = {
  filingId: "230999",
  begin: "04/01/2026",
  end: "06/30/2026",
  beginIso: "2026-04-01",
  endIso: "2026-06-30",
  pdfValues: {
    "1. Beginning Cash Balance": "$ 1,355,115.78",
    "2. Individuals": "241,264.29",
    "3. Political Parties": "0",
    "4. Political Action Committees": "12,450.00",
    "7. Interest Received": "5,116.77",
    "3. Total Cash": "1,614,060.79",
    "5. Ending Cash Balance": "$ 668,626.22",
    "6. Report of In-Kind Contributions": "3,508.00",
  },
  contributionReportHtml: `${fixture("contribution-report-summary.html")}<table id="dgrContribution"><tr><td>rows</td></tr></table>`,
  exportCsvText: fixture("contribution-export-sample.csv"),
  expenditureReportHtml: `${fixture("expenditure-report-summary.html")}<table id="dgrExpenditure"><tr><td>rows</td></tr></table>`,
};

const CYCLE = { cycleBeginIso: "2025-01-01", cycleEndIso: "2026-12-31" };

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ri-direct-agg-"));
});

describe("decision-13 type partition", () => {
  it("classifies every pinned contribution type exactly once", () => {
    for (const type of Object.keys(ERTS_CONTRIBUTION_TYPE_CODES)) {
      const memberships = [
        ERTS_DONOR_CONTRIBUTION_TYPES.has(type),
        ERTS_NON_DONOR_CONTRIBUTION_TYPES.has(type),
        ERTS_PARTY_BUILDING_CONTRIBUTION_TYPES.has(type),
      ].filter(Boolean).length;
      expect(memberships, type).toBe(1);
    }
    // Buckets are a strict subset of donor money: itemized rows only.
    for (const type of ERTS_BUCKETED_CONTRIBUTION_TYPES) {
      expect(ERTS_DONOR_CONTRIBUTION_TYPES.has(type), type).toBe(true);
    }
    expect(ERTS_BUCKETED_CONTRIBUTION_TYPES.has("Aggregate - Individual")).toBe(false);
    expect(ERTS_BUCKETED_CONTRIBUTION_TYPES.has("In Kind - Aggregate")).toBe(false);
  });
});

describe("rhodeIslandContributionSizeBucket", () => {
  it("uses the georgia boundaries", () => {
    expect(rhodeIslandContributionSizeBucket(9_999)).toBe("$1-$99");
    expect(rhodeIslandContributionSizeBucket(10_000)).toBe("$100-$249");
    expect(rhodeIslandContributionSizeBucket(25_000)).toBe("$250-$499");
    expect(rhodeIslandContributionSizeBucket(50_000)).toBe("$500-$999");
    expect(rhodeIslandContributionSizeBucket(100_000)).toBe("$1,000-$4,999");
    expect(rhodeIslandContributionSizeBucket(500_000)).toBe("$5,000+");
  });
});

describe("aggregateRhodeIslandContributionSizeBuckets", () => {
  it("buckets itemized rows, counts unique contributors, and keeps aggregates and non-donor rows out", () => {
    const rows = parseErtsContributionExport(
      exportCsv([
        { ContDesc: "Individual", Amount: "250.0000", FullName: "Murray, Paul S.", EmployerName: "Cultivating RI" },
        { ContDesc: "Individual", Amount: "100.0000", FullName: "murray  paul s", EmployerName: "CULTIVATING RI" },
        { ContDesc: "PAC", Amount: "500.0000", FullName: "FEDEX PAC" },
        { ContDesc: "Aggregate - Individual", Amount: "75.0000", FullName: "Aggregate - Individual" },
        { ContDesc: "Interest Received", Amount: "1149.5300", FullName: "Citizens Bank" },
        { ContDesc: "In-Kind - Individual", Amount: "508.0000", FullName: "Reis, Gary", EmployerName: "Pawtucket Country Club" },
      ])
    );
    const result = aggregateRhodeIslandContributionSizeBuckets({ rows, sourceUrl: "https://example.test/report" });
    expect(result).toMatchObject({
      totalRowCount: 6,
      bucketedRowCount: 4,
      aggregateRowCount: 1,
      nonDonorRowCount: 1,
      partyBuildingRowCount: 0,
      unknownTypeRowCount: 0,
    });
    // The same donor (normalized name + employer) in two buckets still counts
    // once per bucket; distinct donors in one bucket count separately.
    expect(result.directBreakdowns).toEqual([
      {
        categoryType: "contribution_size",
        categoryName: "$500-$999",
        amount: 1_008,
        contributorCount: 2,
        sourceUrl: "https://example.test/report",
      },
      {
        categoryType: "contribution_size",
        categoryName: "$250-$499",
        amount: 250,
        contributorCount: 1,
        sourceUrl: "https://example.test/report",
      },
      {
        categoryType: "contribution_size",
        categoryName: "$100-$249",
        amount: 100,
        contributorCount: 1,
        sourceUrl: "https://example.test/report",
      },
    ]);
  });
});

describe("reconcileRhodeIslandPeriodAgainstCf2", () => {
  function period(values: Record<string, number>): RhodeIslandCf2PeriodValues {
    const map = new Map<string, number>();
    for (const label of ERTS_CF2_SUMMARY_LABELS) {
      map.set(label, values[label] ?? 0);
    }
    const beginning = map.get("1. Beginning Cash Balance") as number;
    const totalCash = map.get("3. Total Cash") as number;
    const ending = map.get("5. Ending Cash Balance") as number;
    return {
      filingId: "1",
      reportType: "test",
      beginIso: "2025-10-01",
      endIso: "2025-12-31",
      amendmentLabel: "",
      filedAt: "",
      pdfUrl: "https://ricampaignfinance.com/ExportDocs/x.pdf",
      versionCount: 1,
      values: map,
      beginningCashCents: beginning,
      totalCashCents: totalCash,
      endingCashCents: ending,
      cashReceiptsCents: totalCash - beginning,
      disbursementsCents: totalCash - ending,
    };
  }

  it("sums grouping SETS into CF-2 lines — line 6 is every in-kind type (spike result 5b)", () => {
    // The real 2022 window: In-Kind - Individual 3,049.67 + In-Kind - Party
    // 5,927.90 = line 6's 8,977.57.
    const cf2 = period({
      "1. Beginning Cash Balance": 0,
      "2. Individuals": 100_000,
      "3. Total Cash": 100_000,
      "5. Ending Cash Balance": 100_000,
      "6. Report of In-Kind Contributions": 897_757,
    });
    const groupings = new Map([
      ["Individual", 60_000],
      ["Aggregate - Individual", 40_000],
      ["In-Kind - Individual", 304_967],
      ["In-Kind - Party", 592_790],
    ]);
    expect(
      reconcileRhodeIslandPeriodAgainstCf2({ cf2, contributionGroupings: groupings, expenditureGroupingsTotalCents: 0 })
    ).toEqual([]);
  });

  it("reports every disagreement — cash receipts, expenditures, and mapped lines", () => {
    const cf2 = period({
      "2. Individuals": 25_000,
      "3. Total Cash": 50_000,
      "5. Ending Cash Balance": 40_000,
    });
    const failures = reconcileRhodeIslandPeriodAgainstCf2({
      cf2,
      contributionGroupings: new Map([["Individual", 25_000]]),
      expenditureGroupingsTotalCents: 5_000,
    });
    expect(failures.map((failure) => failure.detail)).toEqual([
      expect.stringContaining("cash receipts"),
      expect.stringContaining("expenditures"),
    ]);
  });
});

describe("aggregateRhodeIslandOrganizationCycleFinance", () => {
  it("withholds an empty expenditure page when the authoritative CF-2 reports spending", async () => {
    await installPeriods([{
      ...MCKEE_Q2_2026,
      expenditureReportHtml: '<span id="lblNoReportMsg">There were no reports found, please try your search again.</span>',
    }]);
    const result = await aggregateRhodeIslandOrganizationCycleFinance({ cacheDir, orgId: "2235", ...CYCLE });
    expect(result).toMatchObject({ publishable: false, summary: null, directBreakdowns: [] });
    expect(result.quarantineReasons).toContainEqual(expect.objectContaining({
      reason: "cf2_reconciliation_mismatch", detail: expect.stringContaining("search expenditures"),
    }));
  });
  it("reproduces the spike's McKee Q2 2026 reconciliation from cached fixtures and publishes", async () => {
    await installPeriods([MCKEE_Q2_2026]);
    const result = await aggregateRhodeIslandOrganizationCycleFinance({ cacheDir, orgId: "2235", ...CYCLE });

    expect(result.quarantineReasons).toEqual([]);
    expect(result).toMatchObject({ publishable: true, hasCf2Periods: true, periodCount: 1, exportRowCount: 4 });
    expect(result.summary).toMatchObject({
      // The plan's CF-2 arithmetic: 1,614,060.79 - 1,355,115.78.
      totalReceipts: 258_945.01,
      // Donor money only: Individual 241,264.29 + PAC 12,450.00 + In-Kind -
      // Individual 3,508.00; Interest and Other Receipt stay out.
      directContributionTotal: 257_222.29,
      totalDisbursements: 945_434.57,
      cashOnHand: 668_626.22,
      cashOnHandAsOfIso: "2026-06-30",
    });
    expect(result.summary?.sourceUrl).toContain("OrgID=2235");
    expect(result.summary?.sourceUrl).toContain("BeginDate=01/01/2025");
    // Fixture export: Individual 250 -> $250-$499; PAC 500 and In-Kind 508
    // -> $500-$999; the Interest row is not donor money and never buckets.
    expect(result.directBreakdowns).toEqual([
      expect.objectContaining({ categoryName: "$500-$999", amount: 1_008, contributorCount: 2 }),
      expect.objectContaining({ categoryName: "$250-$499", amount: 250, contributorCount: 1 }),
    ]);
    expect(result.unknownSummaryLabels).toEqual([]);
  });

  it("quarantines a search-vs-CF-2 disagreement instead of publishing mismatched money", async () => {
    await installPeriods([
      {
        ...MCKEE_Q2_2026,
        pdfValues: { ...MCKEE_Q2_2026.pdfValues, "2. Individuals": "241,264.30" },
      },
    ]);
    const result = await aggregateRhodeIslandOrganizationCycleFinance({ cacheDir, orgId: "2235", ...CYCLE });
    expect(result.quarantineReasons).toEqual([
      expect.objectContaining({
        reason: "cf2_reconciliation_mismatch",
        detail: expect.stringContaining("2. Individuals"),
      }),
    ]);
    expect(result).toMatchObject({ publishable: false, summary: null, directBreakdowns: [] });
  });

  it("reports unknown summary labels as diagnostics and quarantines party-building receipts", async () => {
    await installPeriods([
      {
        filingId: "230777",
        begin: "04/01/2026",
        end: "06/30/2026",
        beginIso: "2026-04-01",
        endIso: "2026-06-30",
        // Receipts: 1,000.00 - 100.00 + 50.00 = 950.00; no disbursements.
        pdfValues: {
          "1. Beginning Cash Balance": "100.00",
          "2. Individuals": "1,000.00",
          "3. Total Cash": "1,050.00",
          "5. Ending Cash Balance": "1,050.00",
        },
        contributionReportHtml: groupingsReport({
          Individual: "$1,000.00",
          "NSF Check": "($100.00)",
          "Party Building - Individual": "$50.00",
        }),
        exportCsvText: exportCsv([
          { ContDesc: "Individual", Amount: "1000.0000", FullName: "Doe, Jane" },
          { ContDesc: "Party Building - Individual", Amount: "50.0000", FullName: "Doe, John" },
        ]),
        expenditureReportHtml: NO_ROWS_EXPENDITURES,
      },
    ]);
    const result = await aggregateRhodeIslandOrganizationCycleFinance({ cacheDir, orgId: "2235", ...CYCLE });

    // The NSF label participates in the cash-receipts check (the CF-2's own
    // arithmetic includes it) but is excluded from the direct total and
    // surfaced, never guessed into a bucket.
    expect(result.quarantineReasons).toEqual([
      expect.objectContaining({ reason: "party_building_receipts", detail: expect.stringContaining("$50.00") }),
    ]);
    expect(result.unknownSummaryLabels).toEqual([{ label: "NSF Check", cents: -10_000 }]);
    expect(result.directContributionCents).toBe(100_000);
    expect(result.buckets.partyBuildingRowCount).toBe(1);
    expect(result).toMatchObject({ publishable: false, summary: null });
  });

  it("quarantines a negative cycle flow — the schema signs only cash_on_hand, so it cannot be persisted", async () => {
    await installPeriods([
      {
        filingId: "230888",
        begin: "04/01/2026",
        end: "06/30/2026",
        beginIso: "2026-04-01",
        endIso: "2026-06-30",
        // A refund-only period: cash receipts net to -100.00, cent-exact
        // against the CF-2's own arithmetic, so nothing else quarantines.
        pdfValues: {
          "1. Beginning Cash Balance": "1,050.00",
          "3. Total Cash": "950.00",
          "5. Ending Cash Balance": "950.00",
        },
        contributionReportHtml: groupingsReport({ "Refund of Contribution": "($100.00)" }),
        exportCsvText: exportCsv([{ ContDesc: "Refund of Contribution", Amount: "-100.0000", FullName: "Doe, Jane" }]),
        expenditureReportHtml: NO_ROWS_EXPENDITURES,
      },
    ]);
    const result = await aggregateRhodeIslandOrganizationCycleFinance({ cacheDir, orgId: "2235", ...CYCLE });
    expect(result.quarantineReasons).toEqual([
      expect.objectContaining({ reason: "negative_cycle_flow", detail: expect.stringContaining("total receipts") }),
    ]);
    expect(result.cf2Selection.cycleTotals?.totalReceiptsCents).toBe(-10_000);
    expect(result).toMatchObject({ publishable: false, summary: null });
  });

  it("does not publish anything for a committee with no in-cycle CF-2 — a CF-5 deferral is not a zero", async () => {
    await storeErtsArtifact({
      cacheDir,
      key: { type: "organization_filings", orgId: "2235" },
      url: "https://www.ricampaignfinance.com/RIPublic/Filings.aspx",
      body: fixture("organization-filings.html"),
    });
    const result = await aggregateRhodeIslandOrganizationCycleFinance({
      cacheDir,
      orgId: "2235",
      cycleBeginIso: "2020-01-01",
      cycleEndIso: "2020-12-31",
    });
    expect(result).toMatchObject({
      publishable: false,
      hasCf2Periods: false,
      quarantineReasons: [],
      summary: null,
      periodCount: 0,
    });
  });
});
