// Ballot-lookup finance loader for San José (plan Phase 5). Modeled on the
// San Francisco loader — a bespoke loader over the ballotLookupFinanceShared
// primitives, NOT standardStateFinanceBallotLookupLoader: San José stores no
// outside-group industry breakdowns, its coverage note is PER CANDIDATE (a
// summary column the sync derives from aggregator violations), and its
// outside groups carry real expenditure counts.
import { appendSanJoseCommitteeCash } from "./sanJoseCommitteeCashBallotSummary.js";
import type { Pool, PoolClient } from "pg";
import { isSanJoseCampaignFinanceEnabled, isSanJoseCommitteeCashEnabled } from "../../config/featureFlags.js";
import {
  buildStateFinanceSummaryRequests,
  candidateElectionKey,
  mapFinanceBreakdown,
  parseFinanceAmount,
  type BallotLookupFinanceBreakdown,
  type BallotLookupFinanceOutsideGroup,
  type BallotLookupFinanceSummary,
} from "../address/ballotLookupFinanceShared.js";
import { isSanJoseCityFinanceEligibleElection } from "./sanJoseFinanceEligibleOffices.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type Candidate = { candidate_id: string; election_id: string };
type Election = {
  election_id: string;
  state: string;
  district_type?: string | null;
  geoid_compact?: string | null;
  office_scope?: string | null;
  office_canonical_name?: string | null;
  official_ballot_title?: string | null;
};
type SummaryRow = {
  candidate_id: string;
  election_id: string;
  fppc_id: string;
  election_year: number;
  total_raised: string | number | null;
  total_spent: string | number | null;
  cash_on_hand: string | number | null;
  debts_owed: string | number | null;
  loans_received: string | number | null;
  outside_support_total: string | number | null;
  outside_oppose_total: string | number | null;
  direct_coverage_note: string | null;
  source_url: string | null;
  last_synced_at: string;
};

export async function loadSanJoseCandidateFinanceSummariesByCandidateElection(
  db: Queryable,
  candidateRows: readonly Candidate[],
  electionRows: readonly Election[],
): Promise<Map<string, BallotLookupFinanceSummary>> {
  if (!isSanJoseCampaignFinanceEnabled()) return new Map();
  const requests = buildStateFinanceSummaryRequests("CA", candidateRows, electionRows, (row) =>
    isSanJoseCityFinanceEligibleElection({
      state: row.state,
      districtType: row.district_type,
      geoidCompact: row.geoid_compact,
      officeScope: row.office_scope,
      officeCanonicalName: row.office_canonical_name,
      officialBallotTitle: row.official_ballot_title,
    }),
  );
  if (!requests.length) return new Map();
  const summaries = await db.query<SummaryRow>(
    `
      WITH requested AS (
        SELECT candidate_id::uuid candidate_id,election_id::uuid election_id
        FROM jsonb_to_recordset($1::jsonb) x(candidate_id text,election_id text)
      )
      SELECT
        requested.candidate_id::text candidate_id,
        requested.election_id::text election_id,
        link.fppc_id,
        summary.election_year,
        summary.total_raised,
        summary.total_spent,
        summary.cash_on_hand,
        summary.debts_owed,
        summary.loans_received,
        summary.outside_support_total,
        summary.outside_oppose_total,
        summary.direct_coverage_note,
        summary.source_url,
        summary.last_synced_at::text
      FROM requested
      JOIN public.sjc_candidate_finance_links link
        ON link.candidate_id=requested.candidate_id
        AND link.election_id=requested.election_id
        AND link.link_status='active'
      JOIN public.sjc_candidate_finance_summaries summary
        ON summary.link_id=link.id
        AND summary.election_year=link.election_year
    `,
    [JSON.stringify(requests)],
  );
  if (!summaries.rows.length) return new Map();
  const selected = summaries.rows.map((row) => ({
    candidate_id: row.candidate_id,
    election_id: row.election_id,
  }));
  const direct = await db.query<{
    candidate_id: string;
    election_id: string;
    category_type: "occupation" | "employer" | "industry" | "contribution_size";
    category_name: string;
    amount: string | number;
    contributor_count: string | number | null;
    source_url: string | null;
  }>(
    `
      WITH selected AS (
        SELECT candidate_id::uuid candidate_id,election_id::uuid election_id
        FROM jsonb_to_recordset($1::jsonb)x(candidate_id text,election_id text)
      ),ranked AS (
        SELECT
          selected.candidate_id::text candidate_id,
          selected.election_id::text election_id,
          b.category_type,
          b.category_name,
          b.amount,
          b.contributor_count,
          b.source_url,
          row_number() OVER(PARTITION BY selected.candidate_id,selected.election_id,b.category_type ORDER BY b.amount DESC,b.category_name) rn
        FROM selected
        JOIN public.sjc_candidate_finance_links l
          ON l.candidate_id=selected.candidate_id
          AND l.election_id=selected.election_id
          AND l.link_status='active'
        JOIN public.sjc_candidate_finance_direct_breakdowns b
          ON b.link_id=l.id
          AND b.election_year=l.election_year
      )
      SELECT candidate_id,election_id,category_type,category_name,amount,contributor_count,source_url
      FROM ranked
      WHERE rn<=20
      ORDER BY candidate_id,election_id,category_type,amount DESC,category_name
    `,
    [JSON.stringify(selected)],
  );
  const outside = await db.query<{
    candidate_id: string;
    election_id: string;
    spender_filer_id: string;
    spender_name: string;
    support_oppose: "support" | "oppose";
    amount: string | number;
    expenditure_count: string | number | null;
    source_url: string | null;
  }>(
    `
      WITH selected AS (
        SELECT candidate_id::uuid candidate_id,election_id::uuid election_id
        FROM jsonb_to_recordset($1::jsonb)x(candidate_id text,election_id text)
      ),ranked AS (
        SELECT
          selected.candidate_id::text candidate_id,
          selected.election_id::text election_id,
          g.spender_filer_id,
          g.spender_name,
          g.support_oppose,
          g.amount,
          g.expenditure_count,
          g.source_url,
          row_number() OVER(PARTITION BY selected.candidate_id,selected.election_id,g.support_oppose ORDER BY g.amount DESC,g.spender_name,g.spender_filer_id) rn
        FROM selected
        JOIN public.sjc_candidate_finance_links l
          ON l.candidate_id=selected.candidate_id
          AND l.election_id=selected.election_id
          AND l.link_status='active'
        JOIN public.sjc_candidate_finance_outside_groups g
          ON g.link_id=l.id
          AND g.election_year=l.election_year
      )
      SELECT candidate_id,election_id,spender_filer_id,spender_name,support_oppose,amount,expenditure_count,source_url
      FROM ranked
      WHERE rn<=5
      ORDER BY candidate_id,election_id,support_oppose,amount DESC,spender_name,spender_filer_id
    `,
    [JSON.stringify(selected)],
  );
  // The summary row carries the stable portal URL; breakdown/group rows store
  // the same URL today, but the fallback keeps the card's footer link alive
  // if a future sync stops writing per-row URLs (the SF lesson).
  const summarySourceUrlByKey = new Map(
    summaries.rows.map((row) => [
      candidateElectionKey(row.candidate_id, row.election_id),
      row.source_url,
    ]),
  );
  const maps = new Map<string, Map<string, BallotLookupFinanceBreakdown[]>>();
  for (const row of direct.rows) {
    const key = candidateElectionKey(row.candidate_id, row.election_id);
    const byType = maps.get(key) ?? new Map();
    const list = byType.get(row.category_type) ?? [];
    list.push(mapFinanceBreakdown(row, summarySourceUrlByKey.get(key) ?? null));
    byType.set(row.category_type, list);
    maps.set(key, byType);
  }
  const groups = new Map<string, BallotLookupFinanceOutsideGroup[]>();
  for (const row of outside.rows) {
    const key = `${candidateElectionKey(row.candidate_id, row.election_id)}|${row.support_oppose}`;
    const list = groups.get(key) ?? [];
    const expenditureCount =
      row.expenditure_count === null ? null : Number(row.expenditure_count);
    list.push({
      // spender_filer_id may be the literal "Pending" — kept verbatim; the
      // (id, name) pair is the row's stable key (migration 233).
      committee_id: row.spender_filer_id,
      committee_name: row.spender_name,
      support_oppose: row.support_oppose,
      amount: parseFinanceAmount(row.amount) ?? 0,
      expenditure_count: Number.isFinite(expenditureCount)
        ? expenditureCount
        : null,
      source_url: row.source_url ?? summarySourceUrlByKey.get(candidateElectionKey(row.candidate_id, row.election_id)) ?? null,
    });
    groups.set(key, list);
  }
  const result = new Map(
    summaries.rows.map((row) => {
      const key = candidateElectionKey(row.candidate_id, row.election_id);
      const byType = maps.get(key) ?? new Map();
      const occupations = byType.get("occupation") ?? [];
      return [
        key,
        {
          source: "SAN_JOSE_CITY_CLERK",
          cycle: row.election_year,
          fec_candidate_id: null,
          controlled_committee_id: row.fppc_id,
          last_synced_at: row.last_synced_at,
          direct_campaign: {
            // Donor money only: Σ(F460 line 1 + line 4). Loans stay separate
            // per the shared read contract.
            total_raised: parseFinanceAmount(row.total_raised),
            total_spent: parseFinanceAmount(row.total_spent),
            cash_on_hand: parseFinanceAmount(row.cash_on_hand),
            debts_owed: parseFinanceAmount(row.debts_owed),
            loans_received: parseFinanceAmount(row.loans_received),
            top_occupations: occupations,
            top_employers: byType.get("employer") ?? [],
            top_industries: byType.get("industry") ?? [],
            contribution_size_buckets: byType.get("contribution_size") ?? [],
            // Omitted entirely (not null) when this candidate has no known
            // gap, so complete-coverage payloads stay byte-identical.
            ...(row.direct_coverage_note === null
              ? {}
              : { direct_coverage_note: row.direct_coverage_note }),
          },
          outside_spending: {
            support_total: parseFinanceAmount(row.outside_support_total),
            oppose_total: parseFinanceAmount(row.outside_oppose_total),
            top_supporting_groups: groups.get(`${key}|support`) ?? [],
            top_opposing_groups: groups.get(`${key}|oppose`) ?? [],
            top_supporting_industries: [],
            top_opposing_industries: [],
          },
          backing_summary: {
            top_direct_donor_occupations: occupations,
            top_outside_supporting_industries: [],
          },
        } satisfies BallotLookupFinanceSummary,
      ] as const;
    }),
  );
  if (isSanJoseCommitteeCashEnabled()) await appendSanJoseCommitteeCash(db,result);
  return result;
}
