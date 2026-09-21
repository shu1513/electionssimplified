import { useState } from "react";
import {
  apiRequest,
  formatElectionDate,
  formatStockTradeRange,
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

          {trades.length > 0 ? (
            <ul className="mt-3 divide-y divide-line">
              {trades.map((trade, index) => {
                const assetType = stockTradeAssetTypeLabel(trade.asset_type);
                return (
                  <li key={`${trade.source_url}-${index}`} className="py-2 text-sm">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <span className="font-medium">{stockTradeAssetLabel(trade)}</span>
                      <span className="tabular-nums">{formatStockTradeRange(trade)}</span>
                    </div>
                    <div className="text-xs text-ink-soft">
                      {stockTradeTransactionLabel(trade.transaction_type)} · {formatElectionDate(trade.transaction_date)} ·{" "}
                      {stockTradeOwnerLabel(trade.owner)}
                      {assetType ? ` · ${assetType}` : ""}
                      {" · "}
                      <a href={trade.source_url} target="_blank" rel="noopener noreferrer" className="underline hover:text-ink">
                        Filing
                      </a>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : null}

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
