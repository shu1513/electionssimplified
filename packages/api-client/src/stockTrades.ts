// "Stock Trades" panel: types and wording shared by web and mobile. The
// panel gives totals and the most-traded assets, then links the official
// filings. The wording states what the filings say and nothing more.

// Mirrors CandidateStockTradeAsset (backend stockTradesReader.ts).
export type StockTradeAsset = {
  asset_name: string;
  ticker: string | null;
  buy_count: number;
  /** Full and partial sales. */
  sell_count: number;
  exchange_count: number;
  /** Smallest low end and largest high end among the asset's trades. */
  trade_low_min: number;
  trade_high_max: number;
  /** True when the largest trade is open-ended; trade_high_max is its floor. */
  trade_high_is_minimum: boolean;
  /** True when every trade was filed in one and the same dollar band. */
  all_same_band: boolean;
};

// Mirrors CandidateStockTradesSummary (backend stockTradesReader.ts).
export type StockTradesSummary = {
  chambers: ("house" | "senate")[];
  checked_through: string;
  trade_count: number;
  since_year: number | null;
  /** The asset holding the most money, when the filed bands settle it. */
  largest_asset_name: string | null;
  /** Assets with the largest summed trade sizes, largest first. */
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

/** $25,000,000 → "$25 million"; under a million stays in full. */
export function formatStockTradeAmount(amount: number): string {
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

function times(count: number): string {
  return count === 1 ? "once" : `${count.toLocaleString("en-US")} times`;
}

/** "Bought 13 times, sold 24 times." Only the actions that happened. */
export function stockTradeAssetActivityLine(asset: StockTradeAsset): string {
  const parts = [
    asset.buy_count > 0 ? `bought ${times(asset.buy_count)}` : null,
    asset.sell_count > 0 ? `sold ${times(asset.sell_count)}` : null,
    asset.exchange_count > 0 ? `exchanged ${times(asset.exchange_count)}` : null,
  ].filter((part): part is string => part !== null);
  const sentence = parts.join(", ");
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

/**
 * "Each trade was $1,001 – $15,000." when every trade sits in one band, else
 * "Trades ranged from $1,001 to $25 million." The sizes are the filed bands.
 */
export function stockTradeAssetSizeLine(asset: StockTradeAsset): string {
  const count = asset.buy_count + asset.sell_count + asset.exchange_count;
  const low = formatStockTradeAmount(asset.trade_low_min);
  const high = `${asset.trade_high_is_minimum ? "over " : ""}${formatStockTradeAmount(asset.trade_high_max)}`;
  if (asset.all_same_band) {
    const band = asset.trade_high_is_minimum ? high : asset.trade_low_min === asset.trade_high_max ? low : `${low} – ${high}`;
    return `${count === 1 ? "The trade was" : "Each trade was"} ${band}.`;
  }
  return `Trades ranged from ${low} to ${high}.`;
}

/** The panel's opening line: how many trades, since when, and where most of the money was. */
export function stockTradesSummaryLine(summary: StockTradesSummary): string {
  if (summary.trade_count === 0) {
    const unread = summary.unread_filing_count;
    return unread === 0
      ? "No stock trades reported."
      : `Filed ${unread} trade ${unread === 1 ? "report" : "reports"} on paper. They are not summarized here.`;
  }
  const count = `${summary.trade_count.toLocaleString("en-US")} stock ${summary.trade_count === 1 ? "trade" : "trades"}`;
  const since = summary.since_year ? ` since ${summary.since_year}` : "";
  const largest = summary.largest_asset_name ? ` The most money was in ${summary.largest_asset_name}.` : "";
  return `Reported ${count}${since}.${largest}`;
}

/** Said once under the list: what the reports do and do not contain. */
export const STOCK_TRADES_SIZE_NOTE = "Reports give the size of each trade, not profit or loss.";

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
