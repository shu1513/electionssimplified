import { describe, expect, it } from "vitest";
import {
  nmCents,
  nmCountedRows,
  nmDate,
  parseNewMexicoReportedJson,
} from "../../../src/pipeline/newMexicoFinance/newMexicoReportedNative.js";

const parse = (text: string) => parseNewMexicoReportedJson(Buffer.from(text));
describe("New Mexico native financial originals", () => {
  it("keeps monetary tokens exact before binary floating point", () => {
    const rows = parse(
      '[{"Amount":0.10000000000000001,"TransactionAmount":25.1200,"TransactionId":123}]',
    ) as Record<string, unknown>[];
    expect(rows[0]).toEqual({
      Amount: "0.10000000000000001",
      TransactionAmount: "25.1200",
      TransactionId: 123,
    });
    expect(() => nmCents(rows[0]!.Amount)).toThrow(
      "fractional_or_invalid_money",
    );
    expect(nmCents(rows[0]!.TransactionAmount)).toBe(2512);
  });
  it.each(["1e2", "0.001", "1.999", "90071992547410", "00.10", "+1", "NaN"])(
    "holds unsupported/unsafe amount %s",
    (value) => {
      expect(() => nmCents(value)).toThrow();
    },
  );
  it("retains valid signed cents without rounding", () => {
    expect(nmCents("-12.34000")).toBe(-1234);
    expect(nmCents("0.01")).toBe(1);
    expect(nmCents("90071992547409.91")).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => nmCents(1)).toThrow("exact_money_token_required");
  });
  it("recognizes keys rather than money-like text inside names or memos", () => {
    expect(
      parse(
        String.raw`{"Name":"Synthetic \"Amount\":100 {x}","Amount":1.25,"Nested":{"TransactionAmount":2},"Other":"Amount"}`,
      ),
    ).toEqual({
      Name: 'Synthetic "Amount":100 {x}',
      Amount: "1.25",
      Nested: { TransactionAmount: "2" },
      Other: "Amount",
    });
  });
  it.each([
    '{"Amount":1,"Amount":2}',
    '{"Amount":1,"\\u0041mount":2}',
    '{"Nested":{"Id":1,"Id":2}}',
  ])("rejects duplicate keys without silently taking last value", (text) => {
    expect(() => parse(text)).toThrow("duplicate_native_json_key");
  });
  it("allows the same field in different source objects", () => {
    expect(parse('[{"Amount":1},{"Amount":2}]')).toEqual([
      { Amount: "1" },
      { Amount: "2" },
    ]);
  });
  it("rejects broken framing and invalid UTF-8", () => {
    expect(() => parse("<html>verification</html>")).toThrow("native_json");
    expect(() => parseNewMexicoReportedJson(Uint8Array.from([0xff]))).toThrow(
      "native_json",
    );
  });
  it("requires exact uncapped page populations, preserving duplicate occurrences", () => {
    const rows = [
      { TotalRows: 3, Name: "Synthetic" },
      { TotalRows: 3, Name: "Synthetic" },
    ];
    expect(nmCountedRows(rows, 0, 2)).toEqual({ rows, total: 3 });
    expect(() => nmCountedRows(rows, 0, 1000)).toThrow(
      "incomplete_native_page",
    );
    expect(() => nmCountedRows([{ TotalRows: 4 }], 2, 2, 3)).toThrow(
      "native_count_changed",
    );
    expect(() => nmCountedRows([], 0, 1000)).toThrow(
      "native_population_without_count",
    );
  });
  it("checks future money against the original New Mexico observation day", () => {
    expect(nmDate("2026-10-19T00:00:00", "2026-10-20T01:00:00.000Z")).toBe(
      "2026-10-19",
    );
    expect(() =>
      nmDate("2026-10-20T00:00:00", "2026-10-20T01:00:00.000Z"),
    ).toThrow("future_at_original_observation");
    expect(nmDate("2024-02-29T00:00:00", "2026-10-20T18:00:00.000Z")).toBe(
      "2024-02-29",
    );
    expect(() =>
      nmDate("2025-02-29T00:00:00", "2026-10-20T18:00:00.000Z"),
    ).toThrow("native_transaction_date");
  });
});
