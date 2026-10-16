import { describe, expect, it } from "vitest";

import { reconcileNewHampshireCurrentReports as reconcile } from "../../../src/pipeline/newHampshireFinance/newHampshireCurrentReportAuthority.js";

// Synthetic report identities; genuine source records remain private.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const page = (items: unknown[], totalItems = items.length) => ({ succeeded: true, data: { items, totalItems } });
const report = (n: number, v = 1) => ({ filerReportGuid: id(n), filerReportVersionID: v, hasChild: v > 1 });
const transaction = (n: number, v = 1) => ({ filerReportGuid: id(n), filerReportVersionId: v });
const amendment = () => ({
  currentPages: [page([report(2, 2)])],
  histories: [{ parentReportGuid: id(2), pages: [page([report(1)])] }],
  transactions: [transaction(1), transaction(2, 2)],
});

describe("New Hampshire independent current-report authority", () => {
  it("excludes an older report even when its numeric report ID changes", () => {
    const input = amendment();
    const rows = input.transactions.map((r, i) => ({ ...r, filerReportId: 100 + i }));
    expect(reconcile({ ...input, transactions: rows })).toEqual({
      status: "reconciled", currentRows: [rows[1]], currentReportCount: 1, historicalReportCount: 1, historicalRowCount: 1,
    });
  });

  it("excludes old rows when the new amendment contains no transactions", () => {
    const input = amendment();
    expect(reconcile({ ...input, transactions: [input.transactions[0]!] })).toMatchObject({
      status: "reconciled", currentRows: [], historicalRowCount: 1,
    });
  });

  it("preserves repeated equal current occurrences and their order", () => {
    const row = transaction(1);
    expect(reconcile({ currentPages: [page([report(1)])], histories: [], transactions: [row, row] })).toMatchObject({
      status: "reconciled", currentRows: [row, row],
    });
  });

  it("holds an empty filing inventory instead of asserting financial zero", () => {
    expect(reconcile({ currentPages: [page([])], histories: [], transactions: [] })).toEqual({ status: "held", reason: "empty_current_inventory" });
  });

  it.each([
    [],
    [page([report(1)], 2)],
    [page([report(1)], 2), page([report(2)], 3)],
    [page([], 1)],
  ].map((pages) => [pages]))("holds incomplete or changing current page populations", (currentPages) => {
    expect(reconcile({ currentPages, histories: [], transactions: [] }).status).toBe("held");
  });

  it("accepts a closed multi-page inventory", () => {
    expect(reconcile({ currentPages: [page([report(1)], 2), page([report(2)], 2)], histories: [], transactions: [transaction(2)] }).status).toBe("reconciled");
  });

  it("rejects a failed native response", () => {
    expect(reconcile({ currentPages: [{ ...page([report(1)]), succeeded: false }], histories: [], transactions: [] })).toEqual({ status: "held", reason: "invalid_page" });
  });

  it("requires every advertised history even if current transactions look valid", () => {
    expect(reconcile({ ...amendment(), histories: [] })).toEqual({ status: "held", reason: "incomplete_history" });
  });

  it("requires all preceding versions", () => {
    expect(reconcile({ ...amendment(), currentPages: [page([report(2, 3)])] })).toEqual({ status: "held", reason: "incomplete_history" });
  });

  it("holds duplicate history versions", () => {
    const input = amendment();
    input.histories[0]!.pages = [page([report(1), report(3)], 2)];
    expect(reconcile(input)).toEqual({ status: "held", reason: "incomplete_history" });
  });

  it("rejects unadvertised or repeated parent histories", () => {
    const input = amendment();
    expect(reconcile({ ...input, histories: [input.histories[0]!, input.histories[0]!] })).toEqual({ status: "held", reason: "unexpected_history" });
    expect(reconcile({ ...input, histories: [{ parentReportGuid: id(3), pages: [page([report(1)])] }] })).toEqual({ status: "held", reason: "unexpected_history" });
  });

  it("holds duplicate current parents and contradictory child flags", () => {
    expect(reconcile({ currentPages: [page([report(1), report(1)])], histories: [], transactions: [] })).toEqual({ status: "held", reason: "duplicate_report" });
    expect(reconcile({ currentPages: [page([{ ...report(1), hasChild: true }])], histories: [], transactions: [] })).toEqual({ status: "held", reason: "invalid_report" });
  });

  it("holds unknown transaction reports without returning a publishable subset", () => {
    expect(reconcile({ ...amendment(), transactions: [transaction(2, 2), transaction(3)] })).toEqual({ status: "held", reason: "unknown_transaction_report" });
  });

  it("normalizes GUID case but rejects malformed identity/version", () => {
    const uppercase = "ABCDEF00-0000-4000-8000-000000000001";
    expect(reconcile({ currentPages: [page([{ ...report(1), filerReportGuid: uppercase }])], histories: [], transactions: [{ ...transaction(1), filerReportGuid: uppercase.toLowerCase() }] }).status).toBe("reconciled");
    expect(reconcile({ ...amendment(), transactions: [{ filerReportGuid: "bad", filerReportVersionId: 1 }] })).toEqual({ status: "held", reason: "invalid_report" });
    expect(reconcile({ ...amendment(), transactions: [{ ...transaction(2), filerReportVersionId: "2" }] })).toEqual({ status: "held", reason: "invalid_report" });
  });
});
