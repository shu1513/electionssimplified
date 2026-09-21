import { describe, expect, it } from "vitest";

import {
  formatStockTradeTotal,
  stockTradeAssetLine,
  stockTradesPaperNote,
  stockTradesSummaryLine,
  type StockTradesSummary,
} from "./stockTrades";

function summary(overrides: Partial<StockTradesSummary> = {}): StockTradesSummary {
  return {
    chambers: ["house"],
    checked_through: "2026-09-20",
    trade_count: 47,
    since_year: 2023,
    amount_low_total: 1_234_047,
    amount_high_total: 4_560_000,
    amount_high_is_minimum: false,
    top_assets: [],
    filing_count: 9,
    latest_filing: { source_url: "https://example.gov/9.pdf", filing_date: "2026-08-20" },
    unread_filing_count: 0,
    ...overrides,
  };
}

describe("stockTradesSummaryLine", () => {
  it("states the count, the first year and the summed range", () => {
    expect(stockTradesSummaryLine(summary())).toBe(
      "Reported 47 stock trades since 2023, worth between $1.2 million and $4.5 million."
    );
  });

  it("uses the singular and full dollars under a million", () => {
    expect(
      stockTradesSummaryLine(summary({ trade_count: 1, since_year: 2025, amount_low_total: 1001, amount_high_total: 15000 }))
    ).toBe("Reported 1 stock trade since 2025, worth between $1,001 and $15,000.");
  });

  it("says 'at least' when a range is open-ended, and one figure when both ends agree", () => {
    expect(stockTradesSummaryLine(summary({ amount_high_is_minimum: true }))).toBe(
      "Reported 47 stock trades since 2023, worth at least $1.2 million."
    );
    expect(stockTradesSummaryLine(summary({ trade_count: 1, amount_low_total: 823, amount_high_total: 823 }))).toBe(
      "Reported 1 stock trade since 2023, worth $823."
    );
  });

  it("covers a filer with no trades and a filer with only paper reports", () => {
    const none = summary({ trade_count: 0, since_year: null, amount_low_total: 0, amount_high_total: 0 });
    expect(stockTradesSummaryLine(none)).toBe("No stock trades reported.");
    expect(stockTradesSummaryLine({ ...none, unread_filing_count: 1 })).toBe(
      "Filed 1 trade report on paper. They are not summarized here."
    );
  });
});

describe("stock trade wording helpers", () => {
  it("formats totals", () => {
    expect(formatStockTradeTotal(999_999)).toBe("$999,999");
    expect(formatStockTradeTotal(1_000_000)).toBe("$1 million");
    expect(formatStockTradeTotal(2_360_000_000)).toBe("$2.3 billion");
  });

  it("describes one asset by trade count and summed range", () => {
    expect(
      stockTradeAssetLine({
        asset_name: "Microsoft Corporation - Common Stock",
        ticker: "MSFT",
        trade_count: 112,
        amount_low_total: 71_673_112,
        amount_high_total: 323_770_000,
        amount_high_is_minimum: false,
      })
    ).toBe("112 trades · $71.6 million to $323.7 million");
  });

  it("notes paper reports only beside read ones", () => {
    expect(stockTradesPaperNote(summary())).toBeNull();
    expect(stockTradesPaperNote(summary({ unread_filing_count: 2 }))).toBe(
      "2 more reports were filed on paper and are not counted."
    );
    expect(stockTradesPaperNote(summary({ trade_count: 0, unread_filing_count: 2 }))).toBeNull();
  });
});
