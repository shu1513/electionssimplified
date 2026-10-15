import type { Pool, PoolClient } from "pg";
import {
  candidateElectionKey,
  type BallotLookupFinancePacInterest,
  type BallotLookupFinanceSummary,
  type StateFinanceSummaryRequest,
} from "../address/ballotLookupFinanceShared.js";
import { classifyPacInterest, pacInterestDisplayName, UNCLASSIFIED_PAC_INTEREST } from "../finance/pacInterestClassifier.js";

type Row = {
  candidate_id: string; election_id: string; link_id: string; election_year: number;
  committee_id: string; active_link_count: number;
  net_amount: string; gross_amount: string; refund_amount: string; position_count: number;
  source_observed_at: string; inventory_observed_at: string; last_synced_at: string;
  financial_basis: string;
  id: string | null; donor_name: string | null; reported_class_code: string | null;
  amount: string | null; gross: string | null; refund: string | null; source_url: string | null;
};
const sourceUrl = "https://campaignfinance.maryland.gov";
const fail = (): never => { throw new Error("invalid_maryland_stored_committee_component"); };
const classes = new Set(["TCC", "TFED", "TPAC", "TPCC", "TPCLB", "TPOC", "TRNFC", "TUNFC", "TSLATE"]);
function cents(value: string | null): number {
  if (typeof value !== "string" || !/^-?\d+(?:\.\d{1,2})?$/.test(value)) return fail();
  const [whole, decimal = ""] = value.replace(/^-/, "").split(".");
  const n = Number(whole) * 100 + Number(decimal.padEnd(2, "0"));
  if (!Number.isSafeInteger(n)) return fail();
  return value.startsWith("-") ? -n : n;
}
function add(a: number, b: number) {
  const n = a + b; if (!Number.isSafeInteger(n)) return fail(); return n;
}
function instant(s: string) {
  const time = Date.parse(s); if (!Number.isFinite(time)) return fail(); return time;
}
function emptySummary(row: Row): BallotLookupFinanceSummary {
  return {source: "MARYLAND_CFS", cycle: row.election_year, fec_candidate_id: null,
    controlled_committee_id: row.committee_id,
    last_synced_at: new Date(row.source_observed_at).toISOString(),
    direct_campaign: {total_raised: null, total_spent: null, cash_on_hand: null, debts_owed: null,
      top_occupations: [], top_employers: [], top_industries: [], contribution_size_buckets: []},
    outside_spending: {support_total: null, oppose_total: null, top_supporting_groups: [],
      top_opposing_groups: [], top_supporting_industries: [], top_opposing_industries: []},
    backing_summary: {top_direct_donor_occupations: [], top_outside_supporting_industries: []}};
}

/** Reads all signed positions before any display cap. A complete component is
 * required for every active receiving link; partial candidates retain their
 * existing summary without a fabricated committee zero or freshness update. */
export async function attachMarylandCommitteeMonetaryFinance(input: {
  db: Pick<Pool | PoolClient, "query">;
  requests: readonly StateFinanceSummaryRequest[];
  summaries: Map<string, BallotLookupFinanceSummary>;
}): Promise<Map<string, BallotLookupFinanceSummary>> {
  if (!input.requests.length) return input.summaries;
  const result = await input.db.query<Row>(`WITH selected AS (
    SELECT candidate_id, election_id FROM jsonb_to_recordset($1::jsonb)
      AS req(candidate_id uuid, election_id uuid)
  ), active AS (
    SELECT link.*, count(*) OVER (PARTITION BY link.candidate_id, link.election_id)::integer AS active_link_count
    FROM selected JOIN public.md_candidate_finance_links AS link USING (candidate_id, election_id)
    WHERE link.link_status = 'active'
  ) SELECT link.candidate_id::text, link.election_id::text, link.id::text AS link_id,
      link.election_year, link.committee_id, link.active_link_count,
      src.net_amount::text, src.gross_amount::text, src.refund_amount::text, src.position_count,
      src.source_observed_at::text, src.inventory_observed_at::text, src.last_synced_at::text,
      src.provenance->>'financialBasis' AS financial_basis,
      donor.id::text, donor.donor_name, donor.reported_class_code,
      donor.amount::text, donor.gross_amount::text AS gross, donor.refund_amount::text AS refund, donor.source_url
    FROM active AS link JOIN public.md_candidate_finance_pac_sources AS src
      ON src.link_id = link.id AND src.election_year = link.election_year
    LEFT JOIN public.md_candidate_finance_pac_donors AS donor
      ON donor.link_id = src.link_id AND donor.election_year = src.election_year
    ORDER BY link.candidate_id, link.election_id, link.id, donor.amount DESC, donor.id`,
  [JSON.stringify(input.requests)]);
  const byCandidate = new Map<string, Map<string, Row[]>>();
  for (const row of result.rows) {
    const k = candidateElectionKey(row.candidate_id, row.election_id);
    const links = byCandidate.get(k) ?? new Map<string, Row[]>();
    const rows = links.get(row.link_id) ?? []; rows.push(row); links.set(row.link_id, rows); byCandidate.set(k, links);
  }
  const output = new Map(input.summaries);
  for (const [k, links] of byCandidate) {
    const first = [...links.values()][0]![0]!;
    if (!Number.isSafeInteger(first.active_link_count) || first.active_link_count < 1) fail();
    if (links.size !== first.active_link_count) continue;
    const interests = new Map<string, {cents: number; gross: number; refunds: number; pacs: BallotLookupFinancePacInterest["pacs"]}>();
    let oldest = Infinity;
    const ids = new Set<string>();
    for (const rows of links.values()) {
      const src = rows[0]!;
      if (src.election_year !== first.election_year || src.active_link_count !== first.active_link_count ||
        src.financial_basis !== "active_native_api_with_published_summary_controls" ||
        !Number.isSafeInteger(src.position_count) || src.position_count < 0 ||
        instant(src.source_observed_at) > instant(src.inventory_observed_at) ||
        instant(src.inventory_observed_at) > instant(src.last_synced_at)) fail();
      oldest = Math.min(oldest, instant(src.source_observed_at));
      let net = 0, gross = 0, refunds = 0, positions = 0;
      for (const row of rows) {
        if (row.id === null) {
          if (rows.length !== 1 || src.position_count !== 0 || row.amount !== null) fail();
          continue;
        }
        if (ids.has(row.id) || !row.donor_name?.trim() || !classes.has(row.reported_class_code ?? "")) fail();
        ids.add(row.id);
        const amount = cents(row.amount), g = cents(row.gross), r = cents(row.refund);
        if (g < 0 || r < 0 || amount !== g - r) fail();
        net = add(net, amount); gross = add(gross, g); refunds = add(refunds, r); positions++;
        // Candidate committees remain in scope; the federal card's exclusion
        // rule must not silently discard one of Maryland's nine classes.
        const interest = row.reported_class_code === "TCC" ? "candidate_committees" :
          classifyPacInterest({committeeName: row.donor_name!, committeeType: null, designation: null,
            organizationType: null, connectedOrganization: null}).interestSlug ?? UNCLASSIFIED_PAC_INTEREST;
        const group = interests.get(interest) ?? {cents: 0, gross: 0, refunds: 0, pacs: []};
        group.cents = add(group.cents, amount);
        group.gross = add(group.gross, g); group.refunds = add(group.refunds, r);
        group.pacs.push({committee_id: row.id, committee_name: row.donor_name!, amount: amount / 100,
          source_url: row.source_url ?? sourceUrl});
        interests.set(interest, group);
      }
      if (positions !== src.position_count || net !== cents(src.net_amount) || gross !== cents(src.gross_amount) ||
        refunds !== cents(src.refund_amount) || net !== gross - refunds) fail();
    }
    const grouped = [...interests].map(([interest, group]) => ({interest, interest_name: pacInterestDisplayName(interest),
      amount: group.cents / 100, pac_count: group.pacs.length,
      gross_amount: group.gross / 100, refund_amount: group.refunds / 100,
      pacs: group.pacs.sort((a, b) => b.amount - a.amount || a.committee_id.localeCompare(b.committee_id)).slice(0, 5)}))
      .sort((a, b) => b.amount - a.amount || a.interest.localeCompare(b.interest)).slice(0, 5);
    const existing = output.get(k);
    const summary = existing ?? emptySummary(first);
    const note = `Maryland public ledger committee cash gifts less cash refunds, grouped by reported class and name. Full receipt ledger totals reconcile to filed summaries; printed receipt details have unresolved differences. Includes negative balances; excludes individual and in-kind gifts. Data as of ${new Date(oldest).toISOString().slice(0, 10)}.`;
    output.set(k, {...summary, direct_campaign: {...summary.direct_campaign, pac_money_by_interest: grouped,
      pac_money_basis: "reported_committee_monetary_positions", pac_money_coverage_note: note}});
  }
  return output;
}
