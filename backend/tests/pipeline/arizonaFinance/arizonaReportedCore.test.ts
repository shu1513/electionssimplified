import { describe, expect, it, vi } from "vitest";
import { azBag, azCaptureDay, azCents, azFinancialKey, azSameBag, azUnits, parseArizonaReportedJson, parseArizonaReportedRow, parseArizonaReportedTable } from "../../../src/pipeline/arizonaFinance/arizonaReportedCore.js";
import { capturedAt, nativeRow } from "./arizonaReportedFixtures.js";

describe("Arizona reported source primitives", () => {
  it("keeps decimal and integer lexemes exact, including inside unrelated quoted text", () => {
    const value = parseArizonaReportedJson('{"Amount":90071992547409.91,"id":9007199254740991,"memo":' + JSON.stringify('123, "x" 1e2') + '}');
    expect(value.Amount).toBe("90071992547409.91"); expect(value.id).toBe("9007199254740991");
    expect(value.memo).toBe('123, "x" 1e2');
    expect(azCents(azUnits(value.Amount))).toBe(Number.MAX_SAFE_INTEGER);
  });
  it.each(['{"Amount":01}', '{"Amount":NaN}', '{"Amount":}', '{"memo":"unterminated}'])
    ("holds invalid JSON without repairing it: %s", text => expect(() => parseArizonaReportedJson(text)).toThrow());
  it("does not silently turn exponent notation or excess decimal precision into cents", () => {
    for (const input of ["1e2", "1.00001", "90071992547409.92", "-90071992547409.92"])
      expect(() => azUnits(input)).toThrow();
    expect(azUnits("10.0050")).toBe(100050n);
    expect(() => azCents(azUnits("10.0050"))).toThrow("fractional_cent_allocation");
  });
  it("preserves signed returns and native trailing zero precision", () => {
    expect(azCents(azUnits("-123.4500"))).toBe(-12345);
    expect(azCents(azUnits("0.0000"))).toBe(0);
  });
  it("rejects a truncated population even when the returned prefix is otherwise valid", () => {
    expect(() => parseArizonaReportedTable({ draw: "1", recordsTotal: "2", recordsFiltered: "2", data: [nativeRow()] }, capturedAt))
      .toThrow("incomplete_native_population");
    expect(() => parseArizonaReportedTable({ draw: "1", recordsTotal: "20001", recordsFiltered: "20001", data: [] }, capturedAt)).toThrow();
    expect(() => parseArizonaReportedTable({ draw: "1", recordsTotal: "2", recordsFiltered: "1", data: [nativeRow()] }, capturedAt)).toThrow();
  });
  it("distinguishes an explicit empty table from a malformed source", () => {
    expect(parseArizonaReportedTable({ draw: "1", recordsTotal: "0", recordsFiltered: "0", data: [] }, capturedAt)).toEqual([]);
    expect(() => parseArizonaReportedTable([], capturedAt)).toThrow();
    expect(() => parseArizonaReportedTable({ draw: "1", data: [] }, capturedAt)).toThrow();
  });
  it("retains identical source occurrences while ignoring source order", () => {
    expect(azSameBag([{ amount: 5 }, { amount: 5 }, { amount: 7 }], [{ amount: 7 }, { amount: 5 }, { amount: 5 }])).toBe(true);
    expect(azSameBag([{ amount: 5 }, { amount: 5 }], [{ amount: 5 }])).toBe(false);
    expect([...azBag([nativeRow(), nativeRow()]).values()]).toEqual([2]);
  });
  it("rejects unexpected native fields and freezes original decoded financial facts", () => {
    expect(() => parseArizonaReportedRow(nativeRow({ unrecognizedAllocation: true }), capturedAt)).toThrow("native_row_schema");
    const row = parseArizonaReportedRow(nativeRow(), capturedAt);
    expect(Object.isFrozen(row)).toBe(true); expect(Object.isFrozen(row.raw)).toBe(true);
    expect(() => { (row.raw as any).Amount = "999.0000"; }).toThrow();
  });
  it("compares parent monetary magnitudes explicitly without losing return signs in the row", () => {
    const returned = parseArizonaReportedRow(nativeRow({ Amount: "-10.0000" }), capturedAt), posted = parseArizonaReportedRow(nativeRow(), capturedAt);
    expect(azSameBag([azFinancialKey(returned)], [azFinancialKey(posted)])).toBe(false);
    expect(azSameBag([azFinancialKey(returned, true)], [azFinancialKey(posted, true)])).toBe(true);
    expect(returned.units).toBe(-100000n);
  });
  it("uses Arizona's original capture day for future-row admission, including on replay", () => {
    const original = "2026-10-19T06:59:59.999Z";
    expect(azCaptureDay(original)).toBe("2026-10-18");
    const future = () => parseArizonaReportedRow(nativeRow({ TransactionDate: `/Date(${Date.UTC(2026, 9, 19)})/` }), original);
    expect(future).toThrow("row_outside_capture_window");
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2027, 0, 20));
    try { expect(future).toThrow("row_outside_capture_window"); } finally { clock.mockRestore(); }
  });
});
