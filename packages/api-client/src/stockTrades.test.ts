import { describe, expect, it } from "vitest";

import {
  formatStockTradeRange,
  formatStockTradeTotal,
  stockTradeAssetLabel,
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
    trades: [],
    unread_filings: [],
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

  it("says 'at least' when a range is open-ended", () => {
    expect(stockTradesSummaryLine(summary({ amount_high_is_minimum: true }))).toBe(
      "Reported 47 stock trades since 2023, worth at least $1.2 million."
    );
  });

  it("covers a filer with no trades and a filer with only paper reports", () => {
    const none = summary({ trade_count: 0, since_year: null, amount_low_total: 0, amount_high_total: 0 });
    expect(stockTradesSummaryLine(none)).toBe("No stock trades reported.");
    expect(
      stockTradesSummaryLine({ ...none, unread_filings: [{ source_url: "https://example.gov/1.pdf", filing_date: null }] })
    ).toBe("Filed 1 trade report on paper. The trades are not listed here.");
  });
});

describe("stock trade formatters", () => {
  it("formats totals", () => {
    expect(formatStockTradeTotal(999_999)).toBe("$999,999");
    expect(formatStockTradeTotal(1_000_000)).toBe("$1 million");
    expect(formatStockTradeTotal(2_360_000_000)).toBe("$2.3 billion");
  });

  it("formats a row's range as filed", () => {
    expect(formatStockTradeRange({ amount_low: 1001, amount_high: 15000 })).toBe("$1,001 – $15,000");
    expect(formatStockTradeRange({ amount_low: 50_000_000, amount_high: null })).toBe("Over $50,000,000");
    expect(formatStockTradeRange({ amount_low: 823, amount_high: 823 })).toBe("$823");
  });

  it("adds the ticker only when the filing has one", () => {
    expect(stockTradeAssetLabel({ asset_name: "Rollins, Inc.", ticker: "ROL" })).toBe("Rollins, Inc. (ROL)");
    expect(stockTradeAssetLabel({ asset_name: "US Treasury Bill", ticker: null })).toBe("US Treasury Bill");
  });
});
