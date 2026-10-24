import type { Pool, PoolClient } from "pg";
import { isColoradoNativeReceiptsEnabled } from "../../config/featureFlags.js";
import {
  buildStateFinanceSummaryRequests,
  candidateElectionKey,
  type BallotLookupFinanceSummary,
  type StateFinanceRequestCandidateRow,
  type StateFinanceRequestElectionRow,
} from "../address/ballotLookupFinanceShared.js";
import { listColoradoIeReceivers } from "./coloradoReportedIeReceiver.js";
import { readColoradoNativeReceiptPacket } from "./coloradoNativeReceiptStore.js";
import type { ColoradoNativeReceiptsPacket } from "./coloradoNativeReceiptSource.js";
const SOURCE =
  "https://tracer.sos.colorado.gov/PublicSite/Reports/Reports.aspx";
export function overlayColoradoNativeReceiptPacket(
  base: BallotLookupFinanceSummary | undefined,
  p: ColoradoNativeReceiptsPacket,
): BallotLookupFinanceSummary {
  const r = p.receiver,
    summary: BallotLookupFinanceSummary = base ?? {
      source: "COLORADO_TRACER",
      cycle: r.electionYear,
      fec_candidate_id: null,
      controlled_committee_id: r.receivingId,
      last_synced_at: p.facts.receipts.completedAt,
      direct_campaign: {
        total_raised: null,
        total_spent: null,
        cash_on_hand: null,
        debts_owed: null,
        top_occupations: [],
        top_employers: [],
        top_industries: [],
      },
      outside_spending: {
        support_total: null,
        oppose_total: null,
        top_supporting_groups: [],
        top_opposing_groups: [],
        top_supporting_industries: [],
        top_opposing_industries: [],
      },
      backing_summary: {
        top_direct_donor_occupations: [],
        top_outside_supporting_industries: [],
      },
    };
  const groups = p.groups
    .filter((g) => g.cashCents !== 0)
    .sort((a, b) => b.cashCents - a.cashCents || a.key.localeCompare(b.key));
  return {
    ...summary,
    direct_campaign: {
      ...summary.direct_campaign,
      pac_money_by_interest: groups.length
        ? [
            {
              interest: "unclassified",
              interest_name: "Not yet sorted",
              amount: p.controls.cashCents / 100,
              pac_count: groups.length,
              pacs: groups
                .slice(0, 5)
                .map((g) => ({
                  committee_id: `co-registered-name:${encodeURIComponent(g.key)}`,
                  committee_name: g.name,
                  amount: g.cashCents / 100,
                  source_url: SOURCE,
                })),
            },
          ]
        : [],
      pac_money_basis: "reported_itemized_committee_cash_contributions",
      pac_money_coverage_note: `Colorado itemized cash contributions matching exact names in the complete typed committee registry, ${p.facts.cycleStart}–${p.facts.regularThrough}, net of signed returns. Covered major-contributor notices count once. Excludes individuals, unmatched names, nonitemized cash, noncash gifts and loans. Groups use reported names, not verified legal entities. Filings checked ${p.facts.receipts.observedAt.slice(0, 10)}–${p.facts.receipts.completedAt.slice(0, 10)}; later, amended or unfiled receipts may be absent. The headline update date may reflect another finance component.`,
    },
    backing_summary: {
      ...summary.backing_summary,
      top_pac_backed_industries: [],
    },
  };
}
/** Validate uncapped stored groups and current receiving ownership before
 * selecting display rows. Component failure leaves other money and clocks. */
export async function overlayColoradoNativeReceipts(
  db: Pick<Pool | PoolClient, "query">,
  summaries: Map<string, BallotLookupFinanceSummary>,
  candidates: readonly StateFinanceRequestCandidateRow[],
  elections: readonly StateFinanceRequestElectionRow[],
) {
  if (!isColoradoNativeReceiptsEnabled()) return summaries;
  const requests = new Set(
    buildStateFinanceSummaryRequests("CO", candidates, elections).map((r) =>
      candidateElectionKey(r.candidate_id, r.election_id),
    ),
  );
  if (!requests.size) return summaries;
  const receivers = (await listColoradoIeReceivers(db)).filter((r) =>
    requests.has(candidateElectionKey(r.candidateId, r.electionId)),
  );
  if (!receivers.length) return summaries;
  const rows = (
    await db.query<Record<string, unknown>>(
      `SELECT s.*,COALESCE((SELECT jsonb_agg(to_jsonb(d)) FROM public.co_native_receipt_donors d WHERE d.link_id=s.link_id AND d.election_year=s.election_year),'[]'::jsonb) donors FROM public.co_native_receipt_sources s WHERE s.link_id=ANY($1::uuid[])`,
      [receivers.map((r) => r.linkId)],
    )
  ).rows;
  for (const r of receivers) {
    const matches = rows.filter(
      (s) =>
        s.link_id === r.linkId && Number(s.election_year) === r.electionYear,
    );
    if (matches.length !== 1) continue;
    try {
      const s = matches[0]!,
        p = readColoradoNativeReceiptPacket(
          s,
          s.donors as Record<string, unknown>[],
          r,
        ),
        key = candidateElectionKey(r.candidateId, r.electionId);
      summaries.set(
        key,
        overlayColoradoNativeReceiptPacket(summaries.get(key), p),
      );
    } catch {
      /* Invalid evidence preserves existing components. */
    }
  }
  return summaries;
}
