// "Stock Trades" panel: types and wording shared by web and mobile. The
// panel gives totals and the most-traded assets, then links the official
// filings. The wording states what the filings say and nothing more.

// Mirrors CandidateStockTradeAsset (backend stockTradesReader.ts).
export type StockTradeAsset = {
  asset_name: string;
  ticker: string | null;
  trade_count: number;
  /** Sum of the low ends and of the high ends of the filed ranges. */
  amount_low_total: number;
  amount_high_total: number;
  /** True when an open-ended range makes the high total a floor. */
  amount_high_is_minimum: boolean;
};

// Mirrors CandidateStockTradesSummary (backend stockTradesReader.ts).
export type StockTradesSummary = {
  chambers: ("house" | "senate")[];
  checked_through: string;
  trade_count: number;
  since_year: number | null;
  amount_low_total: number;
  amount_high_total: number;
  amount_high_is_minimum: boolean;
  /** Assets with the largest summed ranges, largest first. */
  top_assets: StockTradeAsset[];
  filing_count: number;
  latest_filing: { source_url: string; filing_date: string | null } | null;
  /** Paper reports whose trades are in none of the numbers. */
  unread_filing_count: number;
};

export type CandidateStockTradesResponse = { stock_trades: StockTradesSummary | null };

function dollars(amount: number): string {
  return `$${Math.round(amount).toLocaleString("en-US")}`;
}

/** $1,234,567 → "$1.2 million"; under a million stays in full. */
export function formatStockTradeTotal(amount: number): string {
  const units: [number, string][] = [
    [1_000_000_000, "billion"],
    [1_000_000, "million"],
  ];
  for (const [size, word] of units) {
    if (amount >= size) {
      const value = Math.floor((amount / size) * 10) / 10;
      return `$${value.toLocaleString("en-US", { maximumFractionDigits: 1 })} ${word}`;
    }
  }
  return dollars(amount);
}

type RangeTotals = Pick<StockTradesSummary, "amount_low_total" | "amount_high_total" | "amount_high_is_minimum">;

/** "$1.2 million to $4.5 million", "at least $1.2 million", or one figure. */
export function formatStockTradeTotalRange(totals: RangeTotals): string {
  const low = formatStockTradeTotal(totals.amount_low_total);
  const high = formatStockTradeTotal(totals.amount_high_total);
  if (totals.amount_high_is_minimum) {
    return `at least ${low}`;
  }
  return low === high ? low : `${low} to ${high}`;
}

function tradeCount(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "trade" : "trades"}`;
}

/** "112 trades · $71.6 million to $323.7 million" */
export function stockTradeAssetLine(asset: StockTradeAsset): string {
  return `${tradeCount(asset.trade_count)} · ${formatStockTradeTotalRange(asset)}`;
}

/**
 * The panel's one-line summary. Totals are the sum of the low ends and the
 * sum of the high ends of the filed ranges; no exact amount is implied.
 */
export function stockTradesSummaryLine(summary: StockTradesSummary): string {
  if (summary.trade_count === 0) {
    const unread = summary.unread_filing_count;
    return unread === 0
      ? "No stock trades reported."
      : `Filed ${unread} trade ${unread === 1 ? "report" : "reports"} on paper. They are not summarized here.`;
  }
  const count = `${summary.trade_count.toLocaleString("en-US")} stock ${summary.trade_count === 1 ? "trade" : "trades"}`;
  const since = summary.since_year ? ` since ${summary.since_year}` : "";
  const range = formatStockTradeTotalRange(summary);
  const worth = summary.amount_high_is_minimum || !range.includes(" to ") ? `worth ${range}` : `worth between ${range.replace(" to ", " and ")}`;
  return `Reported ${count}${since}, ${worth}.`;
}

/** Shown only when some reports were read and some were not. */
export function stockTradesPaperNote(summary: StockTradesSummary): string | null {
  const unread = summary.unread_filing_count;
  if (unread === 0 || summary.trade_count === 0) {
    return null;
  }
  return `${unread} more ${unread === 1 ? "report was" : "reports were"} filed on paper and ${unread === 1 ? "is" : "are"} not counted.`;
}

export const STOCK_TRADES_SOURCE_LABELS: Record<StockTradesSummary["chambers"][number], { label: string; url: string }> = {
  house: {
    label: "Clerk of the U.S. House of Representatives",
    url: "https://disclosures-clerk.house.gov/FinancialDisclosure",
  },
  senate: {
    label: "U.S. Senate financial disclosures",
    url: "https://efdsearch.senate.gov/search/",
  },
};
