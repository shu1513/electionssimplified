import {
  formatElectionDate,
  STOCK_TRADES_SOURCE_LABELS,
  stockTradeAssetLine,
  stockTradesPaperNote,
  stockTradesSummaryLine,
  type StockTradesSummary,
} from "@voteapp/api-client";

// Securities trades a member of Congress or federal candidate reported in
// Periodic Transaction Reports. The panel gives the totals and the assets
// traded most, then links the official filings, which hold every trade.
// Single trades are not listed: some filers report hundreds a year.
export function StockTradesPanel({ summary }: { summary: StockTradesSummary }) {
  const paperNote = stockTradesPaperNote(summary);
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

          {summary.top_assets.length > 0 ? (
            <>
              <h3 className="mt-4 text-sm font-semibold">Most traded</h3>
              <ol className="mt-1 divide-y divide-line">
                {summary.top_assets.map((asset) => (
                  <li key={`${asset.ticker ?? ""}-${asset.asset_name}`} className="py-2 text-sm">
                    <div className="truncate" title={asset.asset_name}>
                      {asset.ticker ? <span className="font-semibold">{asset.ticker} </span> : null}
                      <span className={asset.ticker ? "text-ink-soft" : "font-medium"}>{asset.asset_name}</span>
                    </div>
                    <div className="text-xs text-ink-soft tabular-nums">{stockTradeAssetLine(asset)}</div>
                  </li>
                ))}
              </ol>
            </>
          ) : null}

          <p className="mt-3 text-xs text-ink-soft">
            {summary.trade_count > 0 ? "Amounts add up the dollar ranges given in the reports. " : ""}
            {paperNote ? `${paperNote} ` : ""}
            Source:{" "}
            {summary.filing_count > 0
              ? `${summary.filing_count.toLocaleString("en-US")} ${summary.filing_count === 1 ? "report" : "reports"} filed with the `
              : ""}
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
            ))}
            {summary.latest_filing ? (
              <>
                {" · "}
                <a
                  href={summary.latest_filing.source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-ink"
                >
                  Latest report
                  {summary.latest_filing.filing_date ? ` (${formatElectionDate(summary.latest_filing.filing_date)})` : ""}
                </a>
              </>
            ) : null}
            {" · "}checked {formatElectionDate(summary.checked_through)}
          </p>
        </div>
      </details>
    </section>
  );
}
