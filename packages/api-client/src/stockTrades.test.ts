import { describe, expect, it } from "vitest";

import {
  formatStockTradeAmount,
  stockTradeAssetActivityLine,
  stockTradeAssetSizeLine,
  stockTradesPaperNote,
  stockTradesSummaryLine,
  type StockTradeAsset,
  type StockTradesSummary,
} from "./stockTrades";

function summary(overrides: Partial<StockTradesSummary> = {}): StockTradesSummary {
  return {
    chambers: ["house"],
    checked_through: "2026-09-20",
    trade_count: 1712,
    since_year: 2022,
    largest_asset_name: "Microsoft Corporation",
    top_assets: [],
    filing_count: 45,
    latest_filing: { source_url: "https://example.gov/9.pdf", filing_date: "2026-08-20" },
    unread_filing_count: 0,
    ...overrides,
  };
}

function asset(overrides: Partial<StockTradeAsset> = {}): StockTradeAsset {
  return {
    asset_name: "Eli Lilly and Company",
    ticker: "LLY",
    buy_count: 13,
    sell_count: 24,
    exchange_count: 0,
    trade_low_min: 1001,
    trade_high_max: 15000,
    trade_high_is_minimum: false,
    all_same_band: true,
    ...overrides,
  };
}

describe("stockTradesSummaryLine", () => {
  it("states the count, the first year and where the most money was", () => {
    expect(stockTradesSummaryLine(summary())).toBe(
      "Reported 1,712 stock trades since 2022. The most money was in Microsoft Corporation."
    );
  });

  it("leaves the second sentence out when no asset clearly leads", () => {
    expect(stockTradesSummaryLine(summary({ trade_count: 1, since_year: 2025, largest_asset_name: null }))).toBe(
      "Reported 1 stock trade since 2025."
    );
  });

  it("covers a filer with no trades and a filer with only paper reports", () => {
    const none = summary({ trade_count: 0, since_year: null, largest_asset_name: null });
    expect(stockTradesSummaryLine(none)).toBe("No stock trades reported.");
    expect(stockTradesSummaryLine({ ...none, unread_filing_count: 1 })).toBe(
      "Filed 1 trade report on paper. They are not summarized here."
    );
  });
});

describe("asset lines", () => {
  it("says how often the asset was bought and sold", () => {
    expect(stockTradeAssetActivityLine(asset())).toBe("Bought 13 times, sold 24 times.");
    expect(stockTradeAssetActivityLine(asset({ buy_count: 0, sell_count: 1 }))).toBe("Sold once.");
    expect(stockTradeAssetActivityLine(asset({ buy_count: 1, sell_count: 0, exchange_count: 2 }))).toBe(
      "Bought once, exchanged 2 times."
    );
  });

  it("gives one band when every trade shares it, else the span", () => {
    expect(stockTradeAssetSizeLine(asset())).toBe("Each trade was $1,001 – $15,000.");
    expect(stockTradeAssetSizeLine(asset({ buy_count: 1, sell_count: 0 }))).toBe("The trade was $1,001 – $15,000.");
    expect(stockTradeAssetSizeLine(asset({ trade_high_max: 25_000_000, all_same_band: false }))).toBe(
      "Trades ranged from $1,001 to $25 million."
    );
    expect(
      stockTradeAssetSizeLine(asset({ trade_high_max: 50_000_000, trade_high_is_minimum: true, all_same_band: false }))
    ).toBe("Trades ranged from $1,001 to over $50 million.");
    expect(stockTradeAssetSizeLine(asset({ trade_low_min: 823, trade_high_max: 823 }))).toBe("Each trade was $823.");
  });

  it("formats amounts", () => {
    expect(formatStockTradeAmount(999_999)).toBe("$999,999");
    expect(formatStockTradeAmount(1_000_000)).toBe("$1 million");
    expect(formatStockTradeAmount(2_360_000_000)).toBe("$2.3 billion");
  });

  it("notes paper reports only beside read ones", () => {
    expect(stockTradesPaperNote(summary())).toBeNull();
    expect(stockTradesPaperNote(summary({ unread_filing_count: 2 }))).toBe(
      "2 more reports were filed on paper and are not counted."
    );
    expect(stockTradesPaperNote(summary({ trade_count: 0, unread_filing_count: 2 }))).toBeNull();
  });
});
