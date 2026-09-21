import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { lookupCandidateStockTradesById, plainAssetName } from "../../../src/pipeline/stockTrades/stockTradesReader.js";

type Row = Record<string, unknown>;

function fakeDb(tables: { candidate?: Row[]; filers?: Row[]; trades?: Row[]; filings?: Row[] }) {
  return {
    query: async (sql: string) => {
      if (sql.includes("FROM public.candidates")) return { rows: tables.candidate ?? [{}] };
      if (sql.includes("candidate_stock_trade_filers")) return { rows: tables.filers ?? [] };
      if (sql.includes("FROM public.candidate_stock_trades")) return { rows: tables.trades ?? [] };
      return { rows: tables.filings ?? [] };
    },
  } as never;
}

const trade = (ticker: string | null, name: string, type: string, date: string, low: number, high: number | null): Row => ({
  asset_name: name,
  ticker,
  transaction_type: type,
  transaction_date: date,
  amount_low: String(low),
  amount_high: high === null ? null : String(high),
});

describe("lookupCandidateStockTradesById", () => {
  const previous = process.env.CANDIDATE_STOCK_TRADES_ENABLED;
  beforeEach(() => {
    process.env.CANDIDATE_STOCK_TRADES_ENABLED = "true";
  });
  afterEach(() => {
    process.env.CANDIDATE_STOCK_TRADES_ENABLED = previous;
  });

  it("404s a missing candidate and hides non-filers and a disabled flag", async () => {
    expect(await lookupCandidateStockTradesById(fakeDb({ candidate: [] }), "c")).toBeNull();
    expect(await lookupCandidateStockTradesById(fakeDb({}), "c")).toEqual({ stock_trades: null });
    process.env.CANDIDATE_STOCK_TRADES_ENABLED = "false";
    const filers = [{ chamber: "house", checked_through: "2026-09-20" }];
    expect(await lookupCandidateStockTradesById(fakeDb({ filers }), "c")).toEqual({ stock_trades: null });
  });

  it("groups by ticker, counts buys and sells, and names the asset with the most money", async () => {
    const result = await lookupCandidateStockTradesById(
      fakeDb({
        filers: [{ chamber: "house", checked_through: "2026-09-20" }],
        trades: [
          trade("MSFT", "Microsoft Corporation - Common Stock", "purchase", "2024-02-01", 1001, 15000),
          trade("MSFT", "Microsoft Corporation - Common Stock", "sale", "2025-03-01", 1_000_001, 5_000_000),
          trade("MSFT", "Microsoft Corp", "partial_sale", "2023-05-01", 15001, 50000),
          trade("LLY", "Eli Lilly and Company", "purchase", "2025-01-01", 1001, 15000),
          trade("LLY", "Eli Lilly and Company", "exchange", "2025-01-02", 1001, 15000),
        ],
        filings: [
          { source_url: "https://example.gov/2.pdf", filing_date: "2025-03-10", parse_status: "parsed" },
          { source_url: "https://example.gov/1.pdf", filing_date: "2024-02-10", parse_status: "scanned" },
        ],
      }),
      "c"
    );
    expect(result?.stock_trades).toEqual({
      chambers: ["house"],
      checked_through: "2026-09-20",
      trade_count: 5,
      since_year: 2023,
      largest_asset_name: "Microsoft Corporation",
      top_assets: [
        {
          asset_name: "Microsoft Corporation",
          ticker: "MSFT",
          buy_count: 1,
          sell_count: 2,
          exchange_count: 0,
          trade_low_min: 1001,
          trade_high_max: 5_000_000,
          trade_high_is_minimum: false,
          all_same_band: false,
        },
        {
          asset_name: "Eli Lilly and Company",
          ticker: "LLY",
          buy_count: 1,
          sell_count: 0,
          exchange_count: 1,
          trade_low_min: 1001,
          trade_high_max: 15000,
          trade_high_is_minimum: false,
          all_same_band: true,
        },
      ],
      filing_count: 2,
      latest_filing: { source_url: "https://example.gov/2.pdf", filing_date: "2025-03-10" },
      unread_filing_count: 1,
    });
  });
});

describe("plainAssetName", () => {
  it("drops trailing share-class wording only", () => {
    expect(plainAssetName("Microsoft Corporation - Common Stock")).toBe("Microsoft Corporation");
    expect(plainAssetName("Alphabet Inc. - Class C Capital Stock")).toBe("Alphabet Inc.");
    expect(plainAssetName("Rollins, Inc. Common Stock")).toBe("Rollins, Inc.");
    expect(plainAssetName("US TREASURY NOTE 4.25% DUE 12/31/25")).toBe("US TREASURY NOTE 4.25% DUE 12/31/25");
    expect(plainAssetName("Common Stock")).toBe("Common Stock");
  });
});
