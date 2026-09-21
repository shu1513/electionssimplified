import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import {
  apiRequest,
  formatElectionDate,
  formatStockTradeRange,
  groupStockTradesByDate,
  STOCK_TRADES_INITIAL_ROWS,
  STOCK_TRADES_SOURCE_LABELS,
  stockTradeAssetLabel,
  stockTradeAssetTypeLabel,
  stockTradeOwnerLabel,
  stockTradesSummaryLine,
  stockTradeTransactionLabel,
  type CandidateStockTradesResponse,
} from "@voteapp/api-client";

import { openExternalUrl } from "../lib/openExternalUrl";

// Securities trades a member of Congress or federal candidate reported in
// Periodic Transaction Reports. Mirrors the web StockTradesPanel: collapsed
// by default, one-line summary first, each trade linked to its filing.
// Renders nothing for someone who does not file these reports, and nothing
// while loading or after a failed fetch.
export function StockTradesSection({ candidateId }: { candidateId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [wantAll, setWantAll] = useState(false);
  const initial = useQuery({
    queryKey: ["candidate-stock-trades", candidateId, STOCK_TRADES_INITIAL_ROWS],
    queryFn: () =>
      apiRequest<CandidateStockTradesResponse>(`/api/candidates/${candidateId}/stock-trades?limit=${STOCK_TRADES_INITIAL_ROWS}`),
  });
  const all = useQuery({
    queryKey: ["candidate-stock-trades", candidateId, "all"],
    queryFn: () => apiRequest<CandidateStockTradesResponse>(`/api/candidates/${candidateId}/stock-trades`),
    enabled: wantAll,
  });

  const summary = initial.data?.stock_trades ?? null;
  if (!summary) {
    return null;
  }
  const trades = all.data?.stock_trades?.trades ?? summary.trades;
  const hidden = summary.trade_count - trades.length;

  return (
    <View className="mt-6">
      <Pressable
        onPress={() => setExpanded((current) => !current)}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel="Stock Trades"
      >
        <Text className="text-lg font-semibold text-ink">
          {expanded ? "▾" : "▸"} Stock Trades
        </Text>
      </Pressable>
      {expanded ? (
        <View className="mt-2 rounded-xl border border-line bg-white p-4">
          <Text className="text-sm text-ink">{stockTradesSummaryLine(summary)}</Text>

          {/* Same structure as the web panel: one block per trade date, then
              action tag, ticker and asset, amount, owner and filing link. */}
          {groupStockTradesByDate(trades).map((group) => (
            <View key={group.date} className="mt-4">
              <Text className="border-b border-line pb-1 text-xs font-semibold uppercase text-ink-soft">
                {formatElectionDate(group.date)}
              </Text>
              {group.trades.map((trade, index) => {
                const assetType = stockTradeAssetTypeLabel(trade.asset_type);
                return (
                  <View key={`${trade.source_url}-${index}`} className="flex-row border-b border-line py-2">
                    <View className="mr-3 w-20 self-start rounded border border-line px-1 py-0.5">
                      <Text className="text-center text-xs font-medium text-ink">
                        {stockTradeTransactionLabel(trade.transaction_type)}
                      </Text>
                    </View>
                    <View className="flex-1">
                      <Text className="text-sm text-ink-soft" numberOfLines={1} accessibilityLabel={stockTradeAssetLabel(trade)}>
                        {trade.ticker ? <Text className="font-semibold text-ink">{trade.ticker} </Text> : null}
                        <Text className={trade.ticker ? "" : "font-medium text-ink"}>{trade.asset_name}</Text>
                      </Text>
                      <Text className="text-sm text-ink">{formatStockTradeRange(trade)}</Text>
                      <Text className="text-xs text-ink-soft">
                        {stockTradeOwnerLabel(trade.owner)}
                        {assetType ? ` · ${assetType}` : ""}
                        {" · "}
                        <Text className="underline" accessibilityRole="link" onPress={() => openExternalUrl(trade.source_url)}>
                          Filing
                        </Text>
                      </Text>
                    </View>
                  </View>
                );
              })}
            </View>
          ))}

          {hidden > 0 ? (
            <Pressable onPress={() => setWantAll(true)} accessibilityRole="button" disabled={all.isFetching}>
              <Text className="mt-3 text-sm text-ink underline">
                {all.isFetching
                  ? "Loading…"
                  : all.isError
                    ? "Could not load. Try again"
                    : `Show all ${summary.trade_count.toLocaleString("en-US")} trades`}
              </Text>
            </Pressable>
          ) : null}

          {summary.unread_filings.length > 0 ? (
            <Text className="mt-3 text-xs text-ink-soft">
              Filed on paper, not listed above:{" "}
              {summary.unread_filings.map((filing, index) => (
                <Text key={filing.source_url}>
                  {index > 0 ? ", " : ""}
                  <Text className="underline" accessibilityRole="link" onPress={() => openExternalUrl(filing.source_url)}>
                    {filing.filing_date ? formatElectionDate(filing.filing_date) : "filing"}
                  </Text>
                </Text>
              ))}
            </Text>
          ) : null}

          <Text className="mt-3 text-xs text-ink-soft">
            {summary.trade_count > 0 ? "Amounts are the ranges given in the filings. " : ""}Source:{" "}
            {summary.chambers.map((chamber, index) => (
              <Text key={chamber}>
                {index > 0 ? "; " : ""}
                <Text
                  className="underline"
                  accessibilityRole="link"
                  onPress={() => openExternalUrl(STOCK_TRADES_SOURCE_LABELS[chamber].url)}
                >
                  {STOCK_TRADES_SOURCE_LABELS[chamber].label}
                </Text>
              </Text>
            ))}{" "}
            · checked {formatElectionDate(summary.checked_through)}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
