import { describe, expect, it } from "vitest";
import { qualifyMarylandIndependentOutside } from "../../../src/pipeline/marylandFinance/marylandIndependentOutsideQualification.js";
import {
  fixture,
  id,
  book,
  owner,
  other,
  payer,
  report,
  parent,
} from "./marylandIndependentOutsideTestFixtures.js";
describe("complete Maryland independent outside financial qualification", () => {
  it("assigns only the target allocation, never the full multi-target parent", () => {
    const result = qualifyMarylandIndependentOutside(fixture());
    expect(result).toMatchObject({
      allocationCount: 1,
      supportCents: 6000,
      opposeCents: 0,
    });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.amountCents).toBe(6000);
  });
  it.each([
    "missing_other_allocation",
    "wrong_child_amount",
    "unknown_child_stance",
    "parent_mismatch",
    "wrong_report_version",
    "return",
    "unqualified_sibling_account",
  ])("holds entire component on %s", (kind) => {
    const f = fixture(),
      c = f.controls.get(parent)!;
    if (kind === "missing_other_allocation") f.rows.pop();
    if (kind === "wrong_child_amount") c.allocations[0]!.amount = 70;
    if (kind === "unknown_child_stance")
      (c.allocations[0] as Record<string, unknown>).isSupport = null;
    if (kind === "parent_mismatch") c.detail.transactionAmount = 200;
    if (kind === "wrong_report_version") f.rows[0]!.reportVersionId = 9;
    if (kind === "return") c.returns.push({ transactionAmount: 10 });
    if (kind === "unqualified_sibling_account") {
      const r = f.registry.get(owner)![0]!;
      (r as Record<string, unknown>).officeSoughtId = null;
    }
    expect(() => qualifyMarylandIndependentOutside(f)).toThrow(/outside_/);
  });
  it("uses explicit current amendment lineage rather than isAmended or maximum versions", () => {
    const f = fixture();
    f.previousRows = structuredClone(f.rows);
    for (const r of f.rows) {
      r.reportVersionId = 2;
      r.transactionVersionID = 2;
    }
    f.rows[0]!.amountApplied = 75;
    f.rows[1]!.amountApplied = 25;
    const c = f.controls.get(parent)!;
    c.allocations[0]!.amount = 75;
    c.allocations[1]!.amount = 25;
    f.reports.set(payer, [book(payer, report, 2)]);
    expect(qualifyMarylandIndependentOutside(f).supportCents).toBe(7500);
    f.reports.set(payer, [book()]);
    expect(() => qualifyMarylandIndependentOutside(f)).toThrow();
  });
  it("does not replace retained money with a missing parent or an unversioned subset", () => {
    const f = fixture();
    f.previousRows = structuredClone(f.rows);
    f.rows = [f.rows[1]!];
    f.rows[0]!.amountApplied = 100;
    const c = f.controls.get(parent)!;
    c.allocations = [c.allocations[1]!];
    c.allocations[0]!.amount = 100;
    expect(() => qualifyMarylandIndependentOutside(f)).toThrow(
      "outside_retained_allocation_unversioned_change",
    );
    f.rows = [];
    expect(() => qualifyMarylandIndependentOutside(f)).toThrow(
      "outside_retained_parent_current_scope_missing",
    );
  });
  it("does not let one current allocation vouch for two equal retained allocations", () => {
    const f = fixture(),
      c = f.controls.get(parent)!;
    // Retained: two $30 allocations to the owner plus $40 to the other target.
    f.rows[0]!.amountApplied = 30;
    f.previousRows = [
      structuredClone(f.rows[0]!),
      { ...structuredClone(f.rows[0]!), candidateMeasureGuid: id(42) },
      structuredClone(f.rows[1]!),
    ];
    // Current, same report and transaction version: one owner $30 vanished and
    // its $30 moved to a ballot question. Only the parent's children changed.
    f.rows.push({
      ...structuredClone(f.rows[0]!),
      candidateMeasureGuid: id(43),
      candidateGuid: null as unknown as string,
      candidateBallotIssueName: "Question 1",
    });
    c.allocations[0]!.amount = 30;
    c.allocations.push({
      filerRegistrationGuid: null as unknown as string,
      candidateMeasureTitle: "Question 1",
      isSupport: true,
      amount: 30,
    });
    expect(() => qualifyMarylandIndependentOutside(f)).toThrow(
      "outside_retained_allocation_unversioned_change",
    );
  });
  it("admits a zero only from a fully controlled amended retargeting of a retained parent", () => {
    const f = fixture();
    f.previousRows = structuredClone(f.rows);
    f.rows = [
      {
        ...f.rows[1]!,
        amountApplied: 100,
        reportVersionId: 2,
        transactionVersionID: 2,
      },
    ];
    f.reports.set(payer, [book(payer, report, 2)]);
    const c = f.controls.get(parent)!;
    c.allocations = [{ ...c.allocations[1]!, amount: 100 }];
    expect(qualifyMarylandIndependentOutside(f)).toEqual({
      groups: [],
      allocationCount: 0,
      supportCents: 0,
      opposeCents: 0,
    });
  });
  it("keeps more than fifty payer groups and all source totals before display ranking", () => {
    const f = fixture();
    f.rows = [];
    f.controls.clear();
    f.reports.clear();
    for (let i = 0; i < 60; i++) {
      const payerGuid = id(100 + i),
        reportGuid = id(200 + i),
        parentGuid = id(300 + i);
      const r = {
        ...fixture().rows[0]!,
        filerRegistrationGuid: payerGuid,
        reportGuId: reportGuid,
        transactionGuid: parentGuid,
        transactionAmount: 1,
        amountApplied: 1,
      };
      f.rows.push(r);
      f.reports.set(payerGuid, [book(payerGuid, reportGuid)]);
      f.controls.set(parentGuid, {
        ...fixture().controls.get(parent)!,
        detail: {
          guid: parentGuid,
          transactionAmount: 1,
          transactionSubTypeCode: "TIEXP",
          transactionDate: r.transactionDate,
        },
        allocations: [
          {
            filerRegistrationGuid: owner,
            candidateMeasureTitle: r.candidateBallotIssueName,
            isSupport: true,
            amount: 1,
          },
        ],
      });
    }
    const result = qualifyMarylandIndependentOutside(f);
    expect(result.groups).toHaveLength(60);
    expect(result.supportCents).toBe(6000);
  });
});
