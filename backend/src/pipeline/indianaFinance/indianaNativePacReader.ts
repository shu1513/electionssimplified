import type { Pool, PoolClient } from "pg";
import { isIndianaNativePacEnabled } from "../../config/featureFlags.js";
import {
  buildStateFinanceSummaryRequests,
  candidateElectionKey,
  type BallotLookupFinanceSummary,
  type StateFinanceRequestCandidateRow,
  type StateFinanceRequestElectionRow,
} from "../address/ballotLookupFinanceShared.js";
import {
  IN_NATIVE_SELECT,
  IN_NATIVE_FROM,
  IN_NATIVE_WHERE,
  type IndianaNativeReceiver,
} from "./indianaNativeReceiver.js";
import { readIndianaNativeStoredPac } from "./indianaNativePacStore.js";
import type { IndianaNativePacPacket } from "./indianaNativePacSource.js";
import { inHash } from "./indianaNativeOriginals.js";
const SOURCE =
  "https://campaignfinance.in.gov/PublicSite/SearchPages/ContributionSearch.aspx";
export function overlayIndianaNativePac(
  summary: BallotLookupFinanceSummary | undefined,
  p: IndianaNativePacPacket,
): BallotLookupFinanceSummary {
  const r = p.receiver,
    base: BallotLookupFinanceSummary = summary ?? {
      source: "INDIANA_CAMPAIGN_FINANCE",
      cycle: r.electionYear,
      fec_candidate_id: null,
      controlled_committee_id: r.receivingId,
      last_synced_at: p.facts.observedAt,
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
  const cash = p.groups
    .filter((g) => g.cashCents !== 0)
    .sort((a, b) => b.cashCents - a.cashCents || a.key.localeCompare(b.key));
  return {
    ...base,
    direct_campaign: {
      ...base.direct_campaign,
      pac_money_by_interest: cash.length
        ? [
            {
              interest: "unclassified",
              interest_name: "Not yet sorted",
              amount: p.controls.cashCents / 100,
              pac_count: cash.length,
              pacs: cash
                .slice(0, 5)
                .map((g) => ({
                  committee_id: `in-reported:${inHash(g.key)}`,
                  committee_name: g.name,
                  amount: g.cashCents / 100,
                  source_url: SOURCE,
                })),
            },
          ]
        : [],
      pac_money_basis: "reported_itemized_committee_cash_contributions",
      pac_money_coverage_note: `Indiana receiving-side cash gifts and signed credits with the published contributor class Political Action Committee. Reported-name groups, not verified legal entities; excludes loans and in-kind gifts. Receipt dates ${p.facts.from}–${p.facts.through}; regular reports through ${p.facts.regularThrough}. Covered earlier supplements counted once. Originals observed ${p.facts.observedAt.slice(0, 10)}–${p.facts.completedAt.slice(0, 10)}. Later or unfiled receipts may be absent.`,
    },
    backing_summary: { ...base.backing_summary, top_pac_backed_industries: [] },
  };
}
/** Validate the complete stored group set and current canonical ownership before
 * applying any display cap. Native PAC evidence may stand without direct money. */
export async function overlayIndianaNativePacFinance(
  db: Pick<Pool | PoolClient, "query">,
  summaries: Map<string, BallotLookupFinanceSummary>,
  candidates: readonly StateFinanceRequestCandidateRow[],
  elections: readonly StateFinanceRequestElectionRow[],
) {
  if (!isIndianaNativePacEnabled()) return summaries;
  const requests = buildStateFinanceSummaryRequests(
    "IN",
    candidates,
    elections,
  );
  if (!requests.length) return summaries;
  type Row = IndianaNativeReceiver & {
    stored: Record<string, unknown>;
    donors: Record<string, unknown>[];
  };
  const result = await db.query<Row>(
    `SELECT ${IN_NATIVE_SELECT},to_jsonb(s) stored,
 COALESCE((SELECT jsonb_agg(to_jsonb(g)) FROM public.in_native_pac_donors g WHERE g.link_id=s.link_id AND g.election_year=s.election_year),'[]'::jsonb) donors
 ${IN_NATIVE_FROM} JOIN jsonb_to_recordset($1::jsonb) requested(candidate_id uuid,election_id uuid) ON requested.candidate_id=l.candidate_id AND requested.election_id=l.election_id
 JOIN public.in_native_pac_sources s ON s.link_id=l.id AND s.election_year=l.election_year WHERE ${IN_NATIVE_WHERE}`,
    [JSON.stringify(requests)],
  );
  const counts = new Map<string, number>();
  for (const r of result.rows) {
    const k = candidateElectionKey(r.candidateId, r.electionId);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  for (const row of result.rows) {
    const { stored, donors, ...receiver } = row,
      key = candidateElectionKey(receiver.candidateId, receiver.electionId);
    if (counts.get(key) !== 1) continue;
    try {
      const p = readIndianaNativeStoredPac(stored, donors, receiver);
      summaries.set(key, overlayIndianaNativePac(summaries.get(key), p));
    } catch {
      /* Invalid components preserve the existing summary and its clocks. */
    }
  }
  return summaries;
}
