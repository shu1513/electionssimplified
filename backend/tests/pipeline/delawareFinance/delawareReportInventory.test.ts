import { describe, expect, it } from "vitest";

import type { DelawareFiledReportRow, DelawareReportCover } from "../../../src/pipeline/delawareFinance/delawareCfrsParsers.js";
import {
  buildDelawareCanonicalReportInventory,
  delawareCoverDateToIso,
  delawareFilingPeriodKey,
  DelawareReportInventoryError,
  resolveDelawareElectionPeriodWindow,
} from "../../../src/pipeline/delawareFinance/delawareReportInventory.js";

function report(input: {
  period: string;
  calendarId: number;
  version: number;
  from: string;
  to: string;
  beginning: number;
  receipts: number;
  expenditures: number;
}): { row: DelawareFiledReportRow; cover: DelawareReportCover } {
  return {
    row: {
      filingPeriodName: input.period,
      reportName: input.version > 1 ? "Amended Financial Statement" : "Original Financial Statement",
      cfId: "01005311",
      committeeName: "Example for Delaware",
      committeeType: "Candidate Committee",
      dateFiled: "01/01/2026",
      filingYear: input.period.slice(0, 4),
      office: "State Office - Governor",
      committeeStatus: "Active",
      document: { publicReportFileName: `r${input.calendarId}v${input.version}.pdf`, memberId: 558171, filingCalendarId: input.calendarId },
    },
    cover: {
      pageNumber: 2,
      beginningBalanceCents: input.beginning,
      receiptsCents: input.receipts,
      expendituresCents: input.expenditures,
      endingBalanceCents: input.beginning + input.receipts - input.expenditures,
      reportingPeriodFrom: input.from,
      reportingPeriodTo: input.to,
      documentVersion: input.version,
      method: "rows",
    },
  };
}

// A Meyer-shaped committee: county-era 2022 election reports, then
// governor-era 2023/2024 money. Amounts in cents.
function meyerShapedReports() {
  return [
    report({ period: "2021 Annual", calendarId: 1, version: 1, from: "01/01/2021", to: "12/31/2021", beginning: 0, receipts: 100_00, expenditures: 40_00 }),
    report({ period: "2022 30 Day 2022 General Election 11/08/2022", calendarId: 2, version: 1, from: "01/01/2022", to: "10/10/2022", beginning: 60_00, receipts: 500_00, expenditures: 200_00 }),
    report({ period: "2022 8 Day 2022 General Election 11/08/2022", calendarId: 3, version: 1, from: "10/11/2022", to: "10/31/2022", beginning: 360_00, receipts: 50_00, expenditures: 10_00 }),
    report({ period: "2022 Annual", calendarId: 4, version: 1, from: "11/01/2022", to: "12/31/2022", beginning: 400_00, receipts: 20_00, expenditures: 5_00 }),
    report({ period: "2023 Annual", calendarId: 5, version: 1, from: "01/01/2023", to: "12/31/2023", beginning: 415_00, receipts: 800_00, expenditures: 100_00 }),
    // Same-period amendment: v2 is canonical.
    report({ period: "2024 30 Day 2024 General Election 11/05/2024", calendarId: 6, version: 1, from: "01/01/2024", to: "10/07/2024", beginning: 1_115_00, receipts: 900_00, expenditures: 300_00 }),
    report({ period: "2024 30 Day 2024 General Election 11/05/2024", calendarId: 6, version: 2, from: "01/01/2024", to: "10/07/2024", beginning: 1_115_00, receipts: 950_00, expenditures: 300_00 }),
    report({ period: "2024 8 Day 2024 General Election 11/05/2024", calendarId: 7, version: 1, from: "10/08/2024", to: "10/28/2024", beginning: 1_765_00, receipts: 60_00, expenditures: 25_00 }),
  ];
}

describe("delawareFilingPeriodKey", () => {
  it("normalizes the three artifact vocabularies to one key", () => {
    expect(delawareFilingPeriodKey("2024 2024  General Election 11/05/2024 30 Day")).toBe("2024 30 Day General");
    expect(delawareFilingPeriodKey("2024 30 Day 2024 General Election 11/05/2024")).toBe("2024 30 Day General");
    expect(delawareFilingPeriodKey("2024 30 Day General")).toBe("2024 30 Day General");
    expect(delawareFilingPeriodKey("2021  Annual")).toBe("2021 Annual");
    expect(delawareFilingPeriodKey("2026 8 Day 2026 Primary Election 09/15/2026")).toBe("2026 8 Day Primary");
    expect(() => delawareFilingPeriodKey("Quarterly Report")).toThrow(DelawareReportInventoryError);
    expect(() => delawareFilingPeriodKey("2024 30 Day")).toThrow(/no election kind/);
  });

  it("converts cover dates to ISO and fails closed on drift", () => {
    expect(delawareCoverDateToIso("10/29/2024")).toBe("2024-10-29");
    expect(() => delawareCoverDateToIso("2024-10-29")).toThrow(DelawareReportInventoryError);
    expect(() => delawareCoverDateToIso(null)).toThrow(DelawareReportInventoryError);
    expect(() => delawareCoverDateToIso("02/29/2025")).toThrow(/invalid Delaware cover date/);
    expect(() => delawareCoverDateToIso("13/01/2026")).toThrow(/invalid Delaware cover date/);
    expect(delawareCoverDateToIso("02/29/2024")).toBe("2024-02-29");
  });
});

describe("buildDelawareCanonicalReportInventory", () => {
  it("selects max-version per filing calendar and validates the chain", () => {
    const canonical = buildDelawareCanonicalReportInventory(meyerShapedReports());
    expect(canonical).toHaveLength(7);
    const thirtyDay2024 = canonical.find((entry) => entry.periodKey === "2024 30 Day General");
    expect(thirtyDay2024?.documentVersion).toBe(2);
    expect(thirtyDay2024?.receiptsCents).toBe(950_00);
    expect(canonical.map((entry) => entry.periodFrom)).toEqual(
      [...canonical.map((entry) => entry.periodFrom)].sort()
    );
  });

  it("fails closed on a balance chain break", () => {
    const reports = meyerShapedReports();
    // Corrupt one beginning balance.
    reports[4]!.cover.beginningBalanceCents += 1;
    reports[4]!.cover.endingBalanceCents += 1;
    expect(() => buildDelawareCanonicalReportInventory(reports)).toThrow(/balance chain break/);
  });

  it("fails closed on ambiguous versions and overlapping periods", () => {
    const duplicated = [...meyerShapedReports()];
    duplicated.push(report({ period: "2024 8 Day 2024 General Election 11/05/2024", calendarId: 7, version: 1, from: "10/08/2024", to: "10/28/2024", beginning: 1_765_00, receipts: 60_00, expenditures: 25_00 }));
    expect(() => buildDelawareCanonicalReportInventory(duplicated)).toThrow(/ambiguous canonical version/);

    const overlapping = meyerShapedReports();
    overlapping[2]!.cover.reportingPeriodFrom = "10/01/2022";
    expect(() => buildDelawareCanonicalReportInventory(overlapping)).toThrow(/overlap/);
  });
});

describe("resolveDelawareElectionPeriodWindow", () => {
  it("includes the year-end annual filing and distinguishes its published coverage", () => {
    const reports = meyerShapedReports();
    reports.push(report({ period: "2024 Annual", calendarId: 8, version: 1, from: "10/29/2024", to: "12/31/2024", beginning: 1_800_00, receipts: 200_00, expenditures: 20_00 }));
    reports.push(report({ period: "2025 Annual", calendarId: 9, version: 1, from: "01/01/2025", to: "12/31/2025", beginning: 1_980_00, receipts: 50_00, expenditures: 0 }));
    const canonical = buildDelawareCanonicalReportInventory(reports);
    const window = resolveDelawareElectionPeriodWindow({ electionDate: "2024-11-05", canonicalReports: canonical });
    expect(window.windowEnd).toBe("2024-12-31");
    expect(window.publishedThrough).toBe("2024-12-31");
    expect(window.reports.map((entry) => entry.periodKey)).toEqual(["2023 Annual", "2024 30 Day General", "2024 8 Day General", "2024 Annual"]);
    const beforeAnnual = resolveDelawareElectionPeriodWindow({ electionDate: "2024-11-05", canonicalReports: canonical.slice(0, -2) });
    expect(beforeAnnual.windowEnd).toBe("2024-12-31");
    expect(beforeAnnual.publishedThrough).toBe("2024-10-28");
  });

  it("rejects impossible election dates and a report crossing the year-end boundary", () => {
    const canonical = buildDelawareCanonicalReportInventory(meyerShapedReports());
    expect(() => resolveDelawareElectionPeriodWindow({ electionDate: "2024-02-30", canonicalReports: canonical })).toThrow(/invalid election date/);
    canonical.at(-1)!.periodTo = "2025-01-01";
    expect(() => resolveDelawareElectionPeriodWindow({ electionDate: "2024-11-05", canonicalReports: canonical })).toThrow(/straddles the window end/);
  });

  it("starts the window Jan 1 after the committee's prior election reports (office-spanning case)", () => {
    const canonical = buildDelawareCanonicalReportInventory(meyerShapedReports());
    const window = resolveDelawareElectionPeriodWindow({ electionDate: "2024-11-05", canonicalReports: canonical });
    expect(window.basis).toBe("post_prior_election");
    expect(window.windowStart).toBe("2023-01-01");
    // 2021/2022 county-era money is excluded; 2023 Annual + both 2024
    // election reports are in.
    expect(window.reports.map((entry) => entry.periodKey)).toEqual([
      "2023 Annual",
      "2024 30 Day General",
      "2024 8 Day General",
    ]);
  });

  it("covers a fresh committee's whole history (challenger case)", () => {
    const fresh = [
      report({ period: "2025 Annual", calendarId: 11, version: 1, from: "03/15/2025", to: "12/31/2025", beginning: 0, receipts: 200_00, expenditures: 50_00 }),
      report({ period: "2026 30 Day 2026 General Election 11/03/2026", calendarId: 12, version: 1, from: "01/01/2026", to: "10/05/2026", beginning: 150_00, receipts: 700_00, expenditures: 300_00 }),
    ];
    const canonical = buildDelawareCanonicalReportInventory(fresh);
    const window = resolveDelawareElectionPeriodWindow({ electionDate: "2026-11-03", canonicalReports: canonical });
    expect(window.basis).toBe("committee_first_report");
    expect(window.windowStart).toBe("2025-03-15");
    expect(window.reports).toHaveLength(2);
  });

  it("fails closed when a report straddles the window start", () => {
    const reports = meyerShapedReports();
    // Make the 2023 Annual start in 2022 so it straddles 2023-01-01.
    reports[4]!.cover.reportingPeriodFrom = "12/30/2022";
    reports[3]!.cover.reportingPeriodTo = "12/29/2022";
    const canonical = buildDelawareCanonicalReportInventory(reports);
    expect(() =>
      resolveDelawareElectionPeriodWindow({ electionDate: "2024-11-05", canonicalReports: canonical })
    ).toThrow(/straddles the window start/);
  });
});
