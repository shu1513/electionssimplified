import type { Pool } from "pg";

import { isCandidateStockTradesEnabled } from "../../config/featureFlags.js";

// Read side of the "Stock Trades" panel: one candidate's reported securities
// trades, newest first, with range totals. Reads the database only.

type Queryable = Pick<Pool, "query">;

export type StockTradeOwnerLabel = "self" | "spouse" | "child" | "joint";

export type CandidateStockTrade = {
  asset_name: string;
  ticker: string | null;
  asset_type: string | null;
  transaction_type: "purchase" | "sale" | "partial_sale" | "exchange";
  transaction_date: string;
  // Dollar range as filed. amount_high is null for an open-ended top range.
  amount_low: number;
  amount_high: number | null;
  owner: StockTradeOwnerLabel;
  // The official filing this row comes from.
  source_url: string;
};

export type CandidateStockTradeUnreadFiling = {
  source_url: string;
  filing_date: string | null;
};

export type CandidateStockTradesSummary = {
  chambers: ("house" | "senate")[];
  // Date the filing index was last read.
  checked_through: string;
  trade_count: number;
  // Year of the earliest listed trade, or null with no trades.
  since_year: number | null;
  // Sum of the low ends and of the high ends. An open-ended row adds its
  // low end to both sums and sets amount_high_is_minimum.
  amount_low_total: number;
  amount_high_total: number;
  amount_high_is_minimum: boolean;
  // Newest first. Holds at most `limit` rows when the request set one;
  // trade_count and the totals always cover every row.
  trades: CandidateStockTrade[];
  // Filings on record whose rows were not read (paper filings scanned as
  // images). Linked so a reader can open them.
  unread_filings: CandidateStockTradeUnreadFiling[];
};

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
  candidateId: string,
  limit: number | null = null
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
    asset_type: string | null;
    transaction_type: CandidateStockTrade["transaction_type"];
    transaction_date: string;
    amount_low: string;
    amount_high: string | null;
    owner: StockTradeOwnerLabel;
    source_url: string;
  }>(
    `
      SELECT t.asset_name, t.ticker, t.asset_type, t.transaction_type,
             t.transaction_date::text AS transaction_date,
             t.amount_low, t.amount_high, t.owner, f.source_url
      FROM public.candidate_stock_trades AS t
      JOIN public.candidate_stock_trade_filings AS f ON f.id = t.filing_id
      WHERE f.candidate_id = $1::uuid
        AND t.superseded_by_trade_id IS NULL
      ORDER BY t.transaction_date DESC, f.doc_id DESC, t.row_index
    `,
    [id]
  );
  const unread = await db.query<CandidateStockTradeUnreadFiling>(
    `
      SELECT source_url, filing_date::text AS filing_date
      FROM public.candidate_stock_trade_filings
      WHERE candidate_id = $1::uuid AND parse_status <> 'parsed'
      ORDER BY filing_date DESC NULLS LAST, doc_id DESC
    `,
    [id]
  );

  let lowTotal = 0;
  let highTotal = 0;
  let openEnded = false;
  const rows: CandidateStockTrade[] = trades.rows.map((row) => {
    const low = Number(row.amount_low);
    const high = row.amount_high === null ? null : Number(row.amount_high);
    lowTotal += low;
    highTotal += high ?? low;
    openEnded ||= high === null;
    return { ...row, amount_low: low, amount_high: high };
  });
  const earliest = rows.length > 0 ? rows[rows.length - 1]!.transaction_date : null;

  return {
    stock_trades: {
      chambers: filers.rows.map((row) => row.chamber),
      checked_through: filers.rows.map((row) => row.checked_through).sort()[0]!,
      trade_count: rows.length,
      since_year: earliest ? Number(earliest.slice(0, 4)) : null,
      amount_low_total: lowTotal,
      amount_high_total: highTotal,
      amount_high_is_minimum: openEnded,
      trades: limit === null ? rows : rows.slice(0, limit),
      unread_filings: unread.rows,
    },
  };
}
