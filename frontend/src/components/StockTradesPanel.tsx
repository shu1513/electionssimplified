import { useState } from "react";
import {
  apiRequest,
  formatElectionDate,
  formatStockTradeRange,
  groupStockTradesByDate,
  STOCK_TRADES_SOURCE_LABELS,
  stockTradeAssetLabel,
  stockTradeAssetTypeLabel,
  stockTradeOwnerLabel,
  stockTradesSummaryLine,
  stockTradeTransactionLabel,
  type CandidateStockTradesResponse,
  type StockTrade,
  type StockTradesSummary,
} from "@voteapp/api-client";

// Securities trades a member of Congress or federal candidate reported in
// Periodic Transaction Reports. Facts and links only: each row says what the
// filing says and links to it.
export function StockTradesPanel({ candidateId, summary }: { candidateId: string; summary: StockTradesSummary }) {
  const [allTrades, setAllTrades] = useState<StockTrade[] | null>(null);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "failed">("idle");
  const trades = allTrades ?? summary.trades;
  const hidden = summary.trade_count - trades.length;

  async function showAll() {
    setLoadState("loading");
    try {
      const result = await apiRequest<CandidateStockTradesResponse>(`/api/candidates/${candidateId}/stock-trades`);
      setAllTrades(result.stock_trades?.trades ?? summary.trades);
      setLoadState("idle");
    } catch {
      setLoadState("failed");
    }
  }

  return (
    <section className="mt-6">
      {/* Same disclosure pattern as Campaign Finance Information: collapsed
          by default, content kept in the DOM, heading outside the summary. */}
      <h2 className="sr-only">Stock Trades</h2>
      <details>
        <summary className="cursor-pointer select-none">
          <span className="text-lg font-semibold">Stock Trades</span>
        </summary>
        <div className="mt-2 rounded-xl border border-line bg-surface p-4">
          <p className="text-sm">{stockTradesSummaryLine(summary)}</p>

          {/* One block per trade date, so the date is said once. Each row is
              a fixed grid: action tag, asset, amount. The amount column never
              wraps, so the ranges line up down the list. */}
          {groupStockTradesByDate(trades).map((group) => (
            <div key={group.date} className="mt-4">
              <h3 className="border-b border-line pb-1 text-xs font-semibold uppercase tracking-wide text-ink-soft">
                {formatElectionDate(group.date)}
              </h3>
              <ul className="divide-y divide-line">
                {group.trades.map((trade, index) => {
                  const assetType = stockTradeAssetTypeLabel(trade.asset_type);
                  return (
                    <li
                      key={`${trade.source_url}-${index}`}
                      className="grid grid-cols-[4.75rem_minmax(0,1fr)] gap-x-3 py-2 text-sm min-[520px]:grid-cols-[4.75rem_minmax(0,1fr)_auto]"
                    >
                      <span className="self-start rounded border border-line px-1 py-0.5 text-center text-xs font-medium">
                        {stockTradeTransactionLabel(trade.transaction_type)}
                      </span>
                      <div className="min-w-0">
                        <div className="truncate" title={stockTradeAssetLabel(trade)}>
                          {trade.ticker ? <span className="font-semibold">{trade.ticker} </span> : null}
                          <span className={trade.ticker ? "text-ink-soft" : "font-medium"}>{trade.asset_name}</span>
                        </div>
                        <div className="tabular-nums min-[520px]:hidden">{formatStockTradeRange(trade)}</div>
                        <div className="text-xs text-ink-soft">
                          {stockTradeOwnerLabel(trade.owner)}
                          {assetType ? ` · ${assetType}` : ""}
                          {" · "}
                          <a href={trade.source_url} target="_blank" rel="noopener noreferrer" className="underline hover:text-ink">
                            Filing
                          </a>
                        </div>
                      </div>
                      <span className="hidden whitespace-nowrap text-right tabular-nums min-[520px]:block">
                        {formatStockTradeRange(trade)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}

          {hidden > 0 ? (
            <button
              type="button"
              className="mt-2 text-sm underline hover:text-ink"
              disabled={loadState === "loading"}
              onClick={showAll}
            >
              {loadState === "loading"
                ? "Loading…"
                : loadState === "failed"
                  ? "Could not load. Try again"
                  : `Show all ${summary.trade_count.toLocaleString("en-US")} trades`}
            </button>
          ) : null}

          {summary.unread_filings.length > 0 ? (
            <p className="mt-3 text-xs text-ink-soft">
              Filed on paper, not listed above:{" "}
              {summary.unread_filings.map((filing, index) => (
                <span key={filing.source_url}>
                  {index > 0 ? ", " : ""}
                  <a href={filing.source_url} target="_blank" rel="noopener noreferrer" className="underline hover:text-ink">
                    {filing.filing_date ? formatElectionDate(filing.filing_date) : "filing"}
                  </a>
                </span>
              ))}
            </p>
          ) : null}

          <p className="mt-3 text-xs text-ink-soft">
            {summary.trade_count > 0 ? "Amounts are the ranges given in the filings. " : ""}Source:{" "}
            {summary.chambers.map((chamber, index) => (
              <span key={chamber}>
                {index > 0 ? "; " : ""}
                <a
                  href={STOCK_TRADES_SOURCE_LABELS[chamber].url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-ink"
                >
                  {STOCK_TRADES_SOURCE_LABELS[chamber].label}
                </a>
              </span>
            ))}{" "}
            · checked {formatElectionDate(summary.checked_through)}
          </p>
        </div>
      </details>
    </section>
  );
}
