// "Stock Trades" panel: types and wording shared by web and mobile. The
// wording states what the filing says and nothing more.

// Mirrors CandidateStockTradesSummary (backend stockTradesReader.ts).
export type StockTrade = {
  asset_name: string;
  ticker: string | null;
  asset_type: string | null;
  transaction_type: "purchase" | "sale" | "partial_sale" | "exchange";
  transaction_date: string;
  /** Dollar range as filed. amount_high is null for an open-ended top range. */
  amount_low: number;
  amount_high: number | null;
  owner: "self" | "spouse" | "child" | "joint";
  /** The official filing this row comes from. */
  source_url: string;
};

export type StockTradesSummary = {
  chambers: ("house" | "senate")[];
  checked_through: string;
  trade_count: number;
  since_year: number | null;
  amount_low_total: number;
  amount_high_total: number;
  /** True when an open-ended range makes the high total a floor. */
  amount_high_is_minimum: boolean;
  trades: StockTrade[];
  /** Filings on record whose rows were not read (scanned paper filings). */
  unread_filings: { source_url: string; filing_date: string | null }[];
};

// Rows a screen asks for up front (?limit=). Some filers report hundreds of
// trades a year; the rest load only when the reader asks for them.
export const STOCK_TRADES_INITIAL_ROWS = 25;

export type CandidateStockTradesResponse = { stock_trades: StockTradesSummary | null };

const OWNER_LABELS: Record<StockTrade["owner"], string> = {
  self: "Self",
  spouse: "Spouse",
  child: "Child",
  joint: "Joint",
};

const TRANSACTION_LABELS: Record<StockTrade["transaction_type"], string> = {
  purchase: "Buy",
  sale: "Sell",
  partial_sale: "Sell (part)",
  exchange: "Exchange",
};

// House asset type codes that are not plain stock, in everyday words. A code
// not listed here shows no label.
const ASSET_TYPE_LABELS: Record<string, string> = {
  GS: "Government bond",
  CS: "Corporate bond",
  OP: "Stock option",
  CT: "Cryptocurrency",
  EF: "Fund",
  MF: "Fund",
  ET: "Fund",
  PS: "Private stock",
  HN: "Private fund",
};

export function stockTradeOwnerLabel(owner: StockTrade["owner"]): string {
  return OWNER_LABELS[owner] ?? owner;
}

export function stockTradeTransactionLabel(type: StockTrade["transaction_type"]): string {
  return TRANSACTION_LABELS[type] ?? type;
}

export function stockTradeAssetTypeLabel(assetType: string | null): string | null {
  return assetType ? ASSET_TYPE_LABELS[assetType] ?? null : null;
}

/** "Rollins, Inc. Common Stock (ROL)", or the name alone with no ticker. */
export function stockTradeAssetLabel(trade: Pick<StockTrade, "asset_name" | "ticker">): string {
  return trade.ticker ? `${trade.asset_name} (${trade.ticker})` : trade.asset_name;
}

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

/** One row's range as filed: "$1,001 – $15,000", "Over $50,000,000". */
export function formatStockTradeRange(trade: Pick<StockTrade, "amount_low" | "amount_high">): string {
  if (trade.amount_high === null) {
    return `Over ${dollars(trade.amount_low)}`;
  }
  if (trade.amount_high === trade.amount_low) {
    return dollars(trade.amount_low);
  }
  return `${dollars(trade.amount_low)} – ${dollars(trade.amount_high)}`;
}

/**
 * The panel's one-line summary. Totals are the sum of the low ends and the
 * sum of the high ends of the filed ranges; no exact amount is implied.
 */
export function stockTradesSummaryLine(summary: StockTradesSummary): string {
  if (summary.trade_count === 0) {
    const unread = summary.unread_filings.length;
    return unread === 0
      ? "No stock trades reported."
      : `Filed ${unread} trade ${unread === 1 ? "report" : "reports"} on paper. The trades are not listed here.`;
  }
  const count = `${summary.trade_count.toLocaleString("en-US")} stock ${summary.trade_count === 1 ? "trade" : "trades"}`;
  const since = summary.since_year ? ` since ${summary.since_year}` : "";
  const low = formatStockTradeTotal(summary.amount_low_total);
  const high = formatStockTradeTotal(summary.amount_high_total);
  const worth = summary.amount_high_is_minimum
    ? `worth at least ${low}`
    : low === high
      ? `worth ${low}`
      : `worth between ${low} and ${high}`;
  return `Reported ${count}${since}, ${worth}.`;
}

export const STOCK_TRADES_SOURCE_LABELS: Record<StockTradesSummary["chambers"][number], { label: string; url: string }> = {
  house: {
    label: "Clerk of the U.S. House of Representatives, Periodic Transaction Reports",
    url: "https://disclosures-clerk.house.gov/FinancialDisclosure",
  },
  senate: {
    label: "U.S. Senate, Periodic Transaction Reports",
    url: "https://efdsearch.senate.gov/search/",
  },
};
