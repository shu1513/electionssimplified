import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import {
  apiRequest,
  formatElectionDate,
  STOCK_TRADES_SOURCE_LABELS,
  stockTradeAssetLine,
  stockTradesPaperNote,
  stockTradesSummaryLine,
  type CandidateStockTradesResponse,
} from "@voteapp/api-client";

import { openExternalUrl } from "../lib/openExternalUrl";

// Securities trades a member of Congress or federal candidate reported in
// Periodic Transaction Reports. Mirrors the web StockTradesPanel: collapsed
// by default, totals and most-traded assets, then links to the official
// filings. Renders nothing for someone who does not file these reports, and
// nothing while loading or after a failed fetch.
export function StockTradesSection({ candidateId }: { candidateId: string }) {
  const [expanded, setExpanded] = useState(false);
  const query = useQuery({
    queryKey: ["candidate-stock-trades", candidateId],
    queryFn: () => apiRequest<CandidateStockTradesResponse>(`/api/candidates/${candidateId}/stock-trades`),
  });

  const summary = query.data?.stock_trades ?? null;
  if (!summary) {
    return null;
  }
  const paperNote = stockTradesPaperNote(summary);
  const latest = summary.latest_filing;

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

          {summary.top_assets.length > 0 ? (
            <View className="mt-4">
              <Text className="text-sm font-semibold text-ink">Most traded</Text>
              {summary.top_assets.map((asset) => (
                <View key={`${asset.ticker ?? ""}-${asset.asset_name}`} className="border-b border-line py-2">
                  <Text className="text-sm text-ink-soft" numberOfLines={1}>
                    {asset.ticker ? <Text className="font-semibold text-ink">{asset.ticker} </Text> : null}
                    <Text className={asset.ticker ? "" : "font-medium text-ink"}>{asset.asset_name}</Text>
                  </Text>
                  <Text className="text-xs text-ink-soft">{stockTradeAssetLine(asset)}</Text>
                </View>
              ))}
            </View>
          ) : null}

          <Text className="mt-3 text-xs text-ink-soft">
            {summary.trade_count > 0 ? "Amounts add up the dollar ranges given in the reports. " : ""}
            {paperNote ? `${paperNote} ` : ""}
            Source:{" "}
            {summary.filing_count > 0
              ? `${summary.filing_count.toLocaleString("en-US")} ${summary.filing_count === 1 ? "report" : "reports"} filed with the `
              : ""}
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
            ))}
            {latest ? (
              <>
                {" · "}
                <Text className="underline" accessibilityRole="link" onPress={() => openExternalUrl(latest.source_url)}>
                  Latest report{latest.filing_date ? ` (${formatElectionDate(latest.filing_date)})` : ""}
                </Text>
              </>
            ) : null}
            {" · "}checked {formatElectionDate(summary.checked_through)}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
