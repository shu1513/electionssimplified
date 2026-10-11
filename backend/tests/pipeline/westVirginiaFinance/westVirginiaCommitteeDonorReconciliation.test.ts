import { describe, expect, it } from "vitest";
import type { WestVirginiaContributionCsvRow } from "../../../src/pipeline/westVirginiaFinance/westVirginiaCfrsCsv.js";
import type { WestVirginiaTransactionRow } from "../../../src/pipeline/westVirginiaFinance/westVirginiaCfrsClient.js";
import { reconcileWestVirginiaCommitteeDonors } from "../../../src/pipeline/westVirginiaFinance/westVirginiaCommitteeDonorReconciliation.js";

const ENTITY = "1010003884";
const WINDOW = { windowStart: "2025-07-01", windowEnd: "2026-12-31" };
function csv(overrides: Partial<WestVirginiaContributionCsvRow> = {}): WestVirginiaContributionCsvRow {
  return { line: 2, registrantId: ENTITY, committeeName: "Committee to Elect Barry Marcum", candidateName: "Barry Marcum",
    transactionType: "Contributions", transactionCategory: "Monetary", transactionDate: "2026-03-30", amountCents: 280000,
    contributorType: "Political Action Committee", contributorName: "West Virginia Trial Lawyers Association (LAWPAC)",
    employerName: null, filedDate: "2026-04-06", recovered: false, ...overrides };
}
function api(overrides: Partial<WestVirginiaTransactionRow> = {}): WestVirginiaTransactionRow {
  return { transactionID: 556921, entityID: ENTITY, orgID: 3884, committeeName: "Committee to Elect Barry Marcum",
    candidateName: "Marcum, Barry C", transactionAmount: 2800, transactionDate: "2026-03-30T00:00:00", filedDate: "2026-04-06T00:00:00",
    entityTypeDesc: "Political Action Committee", transactionCategoryDesc: "Monetary", transactionTypeDesc: "Contributions",
    transactionPurpose: null, contributorPayeeName: "West Virginia Trial Lawyers Association (LAWPAC)", employerName: null, employerOccupation: null,
    transactionTotalYTD: "2800.0000", amendedFlag: false, reportVersionID: "1", reportFileName: "2026 1st Quarter Report",
    s3ReportFilePath: null, stanceDescription: null, candidateNameAssocation: null, ballotMeasureDescription: null, orgType: "State Candidate", ...overrides };
}
function reconcile(csvRows: WestVirginiaContributionCsvRow[], apiRows: WestVirginiaTransactionRow[]) {
  return reconcileWestVirginiaCommitteeDonors({ entityId: ENTITY, csvRows, apiRows, window: WINDOW });
}

describe("reconcileWestVirginiaCommitteeDonors", () => {
  it("reconciles the source-positive Marcum donors without adding YTD or filtering amendedFlag false", () => {
    const umwa = "United Mine Workers of America Coal Miners PAC (UMWA PAC)";
    const result = reconcile([csv(), csv({ transactionDate: "2026-06-18" }), csv({ contributorName: umwa, transactionDate: "2026-09-17", amountCents: 25000 })],
      [api(), api({ transactionID: 573763, transactionDate: "2026-06-18T00:00:00", transactionTotalYTD: "5600.0000", reportVersionID: "2", amendedFlag: false }), api({ transactionID: 589717, contributorPayeeName: umwa, transactionDate: "2026-09-17T00:00:00", transactionAmount: 250 })]);
    expect(result).toEqual({ entityId: ENTITY, csvRowCount: 3, apiRowCount: 3, multisetMatch: true, onlyInCsv: 0, onlyInApi: 0 });
  });

  it("normalizes organization formatting and preserves duplicate donation and Return multiplicities", () => {
    const returned = csv({ transactionCategory: "Return", amountCents: 5000 });
    const result = reconcile([csv(), csv({ line: 3 }), returned], [api({ contributorPayeeName: " west virginia trial lawyers association lawpac " }), api({ transactionID: 2 }), api({ transactionID: 3, transactionCategoryDesc: "Return", transactionAmount: 50 })]);
    expect(result.csvRowCount).toBe(3);
    expect(result.apiRowCount).toBe(3);
    expect(() => reconcile([csv(), csv({ line: 3 })], [api()])).toThrow("only-in-CSV 1");
    expect(() => reconcile([csv()], [api(), api({ transactionID: 2 })])).toThrow("only-in-API 1");
  });

  it("rejects same-money amended donor renames, rather than accepting the old CSV identity", () => {
    expect(() => reconcile([csv()], [api({ contributorPayeeName: "Different PAC", reportVersionID: "2", amendedFlag: false })])).toThrow("Committee donor identities do not reconcile");
  });

  it.each(["Political Party Committee / Caucus Campaign Committee", "Business or Organization"])("rejects same-money donor type amendment to %s", (entityTypeDesc) => {
    expect(() => reconcile([csv()], [api({ entityTypeDesc, reportVersionID: "2" })])).toThrow("Committee donor identities do not reconcile");
  });

  it("reconciles typed party/caucus In-Kind and Returns", () => {
    const type = "Political Party Committee / Caucus Campaign Committee";
    const name = "West Virginia Republican Labor Caucus";
    expect(reconcile([csv({ contributorType: type, contributorName: name, transactionCategory: "In-Kind" }), csv({ contributorType: type, contributorName: name, transactionCategory: "Return", amountCents: 10000 })],
      [api({ entityTypeDesc: type, contributorPayeeName: name, transactionCategoryDesc: "In-Kind" }), api({ entityTypeDesc: type, contributorPayeeName: name, transactionCategoryDesc: "Return", transactionAmount: 100 })]).multisetMatch).toBe(true);
  });

  it("detects changed dates, cents, categories and missing Returns", () => {
    for (const change of [{ transactionDate: "2026-03-31T00:00:00" }, { transactionAmount: 2800.01 }, { transactionCategoryDesc: "In-Kind" }]) {
      expect(() => reconcile([csv()], [api(change)])).toThrow("Committee donor identities do not reconcile");
    }
    expect(() => reconcile([csv(), csv({ transactionCategory: "Return", amountCents: 10000 })], [api()])).toThrow("only-in-CSV 1");
  });

  it("ignores other recipients, outside-cycle rows and non-donor categories, without requiring individual name order", () => {
    const csvRows = [csv({ registrantId: "1010009999" }), csv({ transactionDate: "2025-06-30" }), csv({ transactionDate: "2027-01-01" }), csv({ transactionCategory: "Receipt of Transfer of Excess Funds" }), csv({ contributorType: "Individual", contributorName: "Jane Doe" })];
    const apiRows = [api({ entityID: "1010009999" }), api({ transactionDate: "2025-06-30" }), api({ transactionDate: "2027-01-01" }), api({ transactionCategoryDesc: "Loans" }), api({ entityTypeDesc: "Individual", contributorPayeeName: "Doe Jane" })];
    expect(reconcile(csvRows, apiRows)).toMatchObject({ csvRowCount: 0, apiRowCount: 0, multisetMatch: true });
  });

  it("rejects blank or recovered truncated donor identities instead of guessing an alias", () => {
    expect(() => reconcile([csv({ contributorName: "" })], [api()])).toThrow("Invalid committee donor identity");
    expect(() => reconcile([csv({ contributorName: "West Virginia Trial", recovered: true })], [api()])).toThrow("Committee donor identities do not reconcile");
    expect(() => reconcile([csv()], [api({ contributorPayeeName: null })])).toThrow("Invalid committee donor identity");
  });

  it("rejects negative, fractional and zero Return cents", () => {
    for (const amountCents of [-1, 1.5, 0]) {
      expect(() => reconcile([csv({ transactionCategory: "Return", amountCents })], [])).toThrow("Invalid committee donor identity or amount");
    }
  });
});
