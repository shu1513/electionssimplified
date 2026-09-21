import type { Pool } from "pg";

import { isCandidateStockTradesEnabled } from "../../config/featureFlags.js";

// Read side of the "Stock Trades" panel: one candidate's reported securities
// trades as totals and most-traded assets. Single trades are not served; the
// panel links the official filings instead. Reads the database only.

type Queryable = Pick<Pool, "query">;

// One traded asset, all its trades added up. Trades are grouped by ticker
// when the filings give one, else by asset name.
export type CandidateStockTradeAsset = {
  asset_name: string;
  ticker: string | null;
  trade_count: number;
  // Sum of the low ends and of the high ends of the filed ranges. An
  // open-ended row adds its low end to both and sets amount_high_is_minimum.
  amount_low_total: number;
  amount_high_total: number;
  amount_high_is_minimum: boolean;
};

export type CandidateStockTradesSummary = {
  chambers: ("house" | "senate")[];
  // Date the filing index was last read.
  checked_through: string;
  trade_count: number;
  // Year of the earliest trade, or null with no trades.
  since_year: number | null;
  amount_low_total: number;
  amount_high_total: number;
  amount_high_is_minimum: boolean;
  // The assets with the largest summed ranges, largest first. The panel
  // shows these instead of single trades; the filings hold every trade.
  top_assets: CandidateStockTradeAsset[];
  // Reports on record, read or not, and the newest one to link to.
  filing_count: number;
  latest_filing: { source_url: string; filing_date: string | null } | null;
  // Reports whose rows were not read (paper filings scanned as images).
  // Their trades are in none of the numbers above.
  unread_filing_count: number;
};

export const STOCK_TRADES_TOP_ASSET_COUNT = 5;

export type CandidateStockTradesResult = {
  // null = this person is not a covered filer, or the feature is off.
  stock_trades: CandidateStockTradesSummary | null;
};

/**
 * null = the candidate does not exist (deleted and merged rows included, so
 * this sub-resource 404s whenever the profile does).
 */
export async function lookupCandidateStockTradesById(
  db: Queryable,
  candidateId: string
): Promise<CandidateStockTradesResult | null> {
  const id = candidateId.trim();
  if (id.length === 0) {
    return null;
  }
  const candidate = await db.query(
    `SELECT 1 FROM public.candidates WHERE id = $1::uuid AND deleted_at IS NULL AND merged_into_candidate_id IS NULL`,
    [id]
  );
  if (candidate.rows.length === 0) {
    return null;
  }
  if (!isCandidateStockTradesEnabled()) {
    return { stock_trades: null };
  }

  const filers = await db.query<{ chamber: "house" | "senate"; checked_through: string }>(
    `
      SELECT chamber, checked_through::text AS checked_through
      FROM public.candidate_stock_trade_filers
      WHERE candidate_id = $1::uuid
      ORDER BY chamber
    `,
    [id]
  );
  if (filers.rows.length === 0) {
    return { stock_trades: null };
  }

  const trades = await db.query<{
    asset_name: string;
    ticker: string | null;
    transaction_date: string;
    amount_low: string;
    amount_high: string | null;
  }>(
    `
      SELECT t.asset_name, t.ticker, t.transaction_date::text AS transaction_date, t.amount_low, t.amount_high
      FROM public.candidate_stock_trades AS t
      JOIN public.candidate_stock_trade_filings AS f ON f.id = t.filing_id
      WHERE f.candidate_id = $1::uuid
        AND t.superseded_by_trade_id IS NULL
    `,
    [id]
  );
  const filings = await db.query<{ source_url: string; filing_date: string | null; parse_status: string }>(
    `
      SELECT source_url, filing_date::text AS filing_date, parse_status
      FROM public.candidate_stock_trade_filings
      WHERE candidate_id = $1::uuid
      ORDER BY filing_date DESC NULLS LAST, doc_id DESC
    `,
    [id]
  );

  let lowTotal = 0;
  let highTotal = 0;
  let openEnded = false;
  let earliest: string | null = null;
  const assets = new Map<string, CandidateStockTradeAsset & { names: Map<string, number> }>();
  for (const row of trades.rows) {
    const low = Number(row.amount_low);
    const high = row.amount_high === null ? null : Number(row.amount_high);
    lowTotal += low;
    highTotal += high ?? low;
    openEnded ||= high === null;
    if (earliest === null || row.transaction_date < earliest) {
      earliest = row.transaction_date;
    }
    const key = row.ticker ? `ticker:${row.ticker}` : `name:${row.asset_name.toLowerCase()}`;
    const asset = assets.get(key) ?? {
      asset_name: row.asset_name,
      ticker: row.ticker,
      trade_count: 0,
      amount_low_total: 0,
      amount_high_total: 0,
      amount_high_is_minimum: false,
      names: new Map<string, number>(),
    };
    asset.trade_count += 1;
    asset.amount_low_total += low;
    asset.amount_high_total += high ?? low;
    asset.amount_high_is_minimum ||= high === null;
    asset.names.set(row.asset_name, (asset.names.get(row.asset_name) ?? 0) + 1);
    assets.set(key, asset);
  }
  const topAssets = [...assets.values()]
    .sort(
      (a, b) =>
        b.amount_high_total - a.amount_high_total ||
        b.trade_count - a.trade_count ||
        a.asset_name.localeCompare(b.asset_name)
    )
    .slice(0, STOCK_TRADES_TOP_ASSET_COUNT)
    .map(({ names, ...asset }) => ({
      ...asset,
      // One ticker is filed under several spellings; show the commonest.
      asset_name: [...names.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0],
    }));
  const latest = filings.rows[0];

  return {
    stock_trades: {
      chambers: filers.rows.map((row) => row.chamber),
      checked_through: filers.rows.map((row) => row.checked_through).sort()[0]!,
      trade_count: trades.rows.length,
      since_year: earliest ? Number(earliest.slice(0, 4)) : null,
      amount_low_total: lowTotal,
      amount_high_total: highTotal,
      amount_high_is_minimum: openEnded,
      top_assets: topAssets,
      filing_count: filings.rows.length,
      latest_filing: latest ? { source_url: latest.source_url, filing_date: latest.filing_date } : null,
      unread_filing_count: filings.rows.filter((row) => row.parse_status !== "parsed").length,
    },
  };
}
