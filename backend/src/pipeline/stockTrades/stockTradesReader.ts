import type { Pool } from "pg";

import { isCandidateStockTradesEnabled } from "../../config/featureFlags.js";

// Read side of the "Stock Trades" panel: one candidate's reported securities
// trades as totals and most-traded assets. Single trades are not served; the
// panel links the official filings instead. Reads the database only.

type Queryable = Pick<Pool, "query">;

// One traded asset. Trades are grouped by ticker when the filings give one,
// else by asset name. The filings give the size of each trade as a dollar
// band and never a price, a share count, a profit or a loss, so an asset is
// described by how often it was bought and sold and how big the trades were.
export type CandidateStockTradeAsset = {
  // Asset name without share-class boilerplate ("Microsoft Corporation").
  asset_name: string;
  ticker: string | null;
  buy_count: number;
  // Full and partial sales.
  sell_count: number;
  exchange_count: number;
  // Smallest low end and largest high end among the asset's trades.
  trade_low_min: number;
  trade_high_max: number;
  // True when the largest trade is open-ended ("Over $50,000,000");
  // trade_high_max is then that floor.
  trade_high_is_minimum: boolean;
  // True when every trade of the asset was filed in one and the same band.
  all_same_band: boolean;
};

export type CandidateStockTradesSummary = {
  chambers: ("house" | "senate")[];
  // Date the filing index was last read.
  checked_through: string;
  trade_count: number;
  // Year of the earliest trade, or null with no trades.
  since_year: number | null;
  // The asset that holds the most money by both the summed low ends and the
  // summed high ends of its trades; null when the two disagree.
  largest_asset_name: string | null;
  // The assets with the largest summed trade sizes, largest first. The
  // panel shows these instead of single trades; the filings hold every
  // trade.
  top_assets: CandidateStockTradeAsset[];
  // Reports on record, read or not, and the newest one to link to.
  filing_count: number;
  latest_filing: { source_url: string; filing_date: string | null } | null;
  // Reports whose rows were not read (paper filings scanned as images).
  // Their trades are in none of the numbers above.
  unread_filing_count: number;
};

export const STOCK_TRADES_TOP_ASSET_COUNT = 5;

/**
 * "Microsoft Corporation - Common Stock" → "Microsoft Corporation". Drops
 * only trailing share-class wording; a name that is nothing else stays whole.
 */
export function plainAssetName(name: string): string {
  const plain = name
    .replace(/\s+-\s+(?:Class [A-Z] )?(?:Common|Capital|Ordinary|Depositary|American Depositary)\b.*$/i, "")
    .replace(/,?\s+(?:Class [A-Z]\s+)?(?:Common Stock|Common Shares|Ordinary Shares|Capital Stock)\.?$/i, "")
    .trim();
  return plain.length > 0 ? plain : name;
}

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
    transaction_type: "purchase" | "sale" | "partial_sale" | "exchange";
    transaction_date: string;
    amount_low: string;
    amount_high: string | null;
  }>(
    `
      SELECT t.asset_name, t.ticker, t.transaction_type, t.transaction_date::text AS transaction_date,
             t.amount_low, t.amount_high
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

  type AssetTally = CandidateStockTradeAsset & {
    lowTotal: number;
    highTotal: number;
    bands: Set<string>;
    names: Map<string, number>;
  };
  let earliest: string | null = null;
  const assets = new Map<string, AssetTally>();
  for (const row of trades.rows) {
    const low = Number(row.amount_low);
    const high = row.amount_high === null ? null : Number(row.amount_high);
    if (earliest === null || row.transaction_date < earliest) {
      earliest = row.transaction_date;
    }
    const key = row.ticker ? `ticker:${row.ticker}` : `name:${row.asset_name.toLowerCase()}`;
    const asset: AssetTally = assets.get(key) ?? {
      asset_name: row.asset_name,
      ticker: row.ticker,
      buy_count: 0,
      sell_count: 0,
      exchange_count: 0,
      trade_low_min: low,
      trade_high_max: high ?? low,
      trade_high_is_minimum: false,
      all_same_band: true,
      lowTotal: 0,
      highTotal: 0,
      bands: new Set<string>(),
      names: new Map<string, number>(),
    };
    if (row.transaction_type === "purchase") {
      asset.buy_count += 1;
    } else if (row.transaction_type === "exchange") {
      asset.exchange_count += 1;
    } else {
      asset.sell_count += 1;
    }
    asset.trade_low_min = Math.min(asset.trade_low_min, low);
    if ((high ?? low) >= asset.trade_high_max) {
      // An open-ended band outranks a closed band that ends at the same figure.
      asset.trade_high_is_minimum = high === null || ((high ?? low) === asset.trade_high_max && asset.trade_high_is_minimum);
      asset.trade_high_max = high ?? low;
    }
    asset.lowTotal += low;
    asset.highTotal += high ?? low;
    asset.bands.add(`${low}-${high ?? "open"}`);
    asset.names.set(row.asset_name, (asset.names.get(row.asset_name) ?? 0) + 1);
    assets.set(key, asset);
  }
  const ranked = [...assets.values()].sort(
    (a, b) =>
      b.highTotal - a.highTotal ||
      b.lowTotal - a.lowTotal ||
      a.asset_name.localeCompare(b.asset_name)
  );
  const displayName = (asset: AssetTally): string =>
    // One ticker is filed under several spellings; show the commonest.
    plainAssetName([...asset.names.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0]);
  const topAssets = ranked.slice(0, STOCK_TRADES_TOP_ASSET_COUNT).map(({ lowTotal: _low, highTotal: _high, bands, names: _names, ...asset }) => ({
    ...asset,
    asset_name: displayName(assets.get(asset.ticker ? `ticker:${asset.ticker}` : `name:${asset.asset_name.toLowerCase()}`)!),
    all_same_band: bands.size === 1,
  }));
  const first = ranked[0];
  const largestByLow = first ? ranked.every((asset) => asset === first || asset.lowTotal < first.lowTotal) : false;
  const largestByHigh = first ? ranked.every((asset) => asset === first || asset.highTotal < first.highTotal) : false;
  const latest = filings.rows[0];

  return {
    stock_trades: {
      chambers: filers.rows.map((row) => row.chamber),
      checked_through: filers.rows.map((row) => row.checked_through).sort()[0]!,
      trade_count: trades.rows.length,
      since_year: earliest ? Number(earliest.slice(0, 4)) : null,
      largest_asset_name: first && largestByLow && largestByHigh && ranked.length > 1 ? displayName(first) : null,
      top_assets: topAssets,
      filing_count: filings.rows.length,
      latest_filing: latest ? { source_url: latest.source_url, filing_date: latest.filing_date } : null,
      unread_filing_count: filings.rows.filter((row) => row.parse_status !== "parsed").length,
    },
  };
}
