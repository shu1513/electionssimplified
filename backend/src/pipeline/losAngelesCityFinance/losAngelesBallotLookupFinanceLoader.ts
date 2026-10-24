import { appendLosAngelesReportedCommitteeCash } from "./losAngelesReportedCommitteeCashBallotSummary.js";
import type { Pool, PoolClient } from "pg";
import { isLosAngelesCityCampaignFinanceEnabled, isLosAngelesReportedCommitteeCashEnabled } from "../../config/featureFlags.js";
import {
  buildStateFinanceSummaryRequests,
  candidateElectionKey,
  mapFinanceBreakdown,
  parseFinanceAmount,
  parseFinanceCount,
  type BallotLookupFinanceBreakdown,
  type BallotLookupFinanceOutsideGroup,
  type BallotLookupFinanceSummary,
} from "../address/ballotLookupFinanceShared.js";
import { isLosAngelesCityFinanceEligibleElection } from "./losAngelesCityFinanceEligibleOffices.js";

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
  fppc_committee_id: string;
  fppc_committee_ids?: string[] | null;
  election_year: number;
  total_receipts: string | number | null;
  total_disbursements: string | number | null;
  cash_on_hand: string | number | null;
  matching_funds: string | number | null;
  outside_support_total: string | number | null;
  outside_oppose_total: string | number | null;
  membership_support_total: string | number | null;
  membership_oppose_total: string | number | null;
  source_url: string | null;
  last_synced_at: string;
};

export async function loadLosAngelesCandidateFinanceSummariesByCandidateElection(
  db: Queryable,
  candidateRows: readonly Candidate[],
  electionRows: readonly Election[],
): Promise<Map<string, BallotLookupFinanceSummary>> {
  if (!isLosAngelesCityCampaignFinanceEnabled()) return new Map();
  const requests = buildStateFinanceSummaryRequests("CA", candidateRows, electionRows, (row) =>
    isLosAngelesCityFinanceEligibleElection({
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
        link.fppc_committee_id,
        link.fppc_committee_ids,
        summary.election_year,
        summary.total_receipts,
        summary.total_disbursements,
        summary.cash_on_hand,
        summary.matching_funds,
        summary.outside_support_total,
        summary.outside_oppose_total,
        summary.membership_support_total,
        summary.membership_oppose_total,
        summary.source_url,
        summary.last_synced_at::text
      FROM requested
      JOIN public.lacity_candidate_finance_links link
        ON link.candidate_id=requested.candidate_id
        AND link.election_id=requested.election_id
        AND link.link_status='active'
      JOIN public.lacity_candidate_finance_summaries summary
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
        JOIN public.lacity_candidate_finance_links l
          ON l.candidate_id=selected.candidate_id
          AND l.election_id=selected.election_id
          AND l.link_status='active'
        JOIN public.lacity_candidate_finance_direct_breakdowns b
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
    spender_id: string;
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
          g.spender_id,
          g.spender_name,
          g.support_oppose,
          g.amount,
          g.expenditure_count,
          g.source_url,
          row_number() OVER(PARTITION BY selected.candidate_id,selected.election_id,g.support_oppose ORDER BY g.amount DESC,g.spender_name,g.spender_id) rn
        FROM selected
        JOIN public.lacity_candidate_finance_links l
          ON l.candidate_id=selected.candidate_id
          AND l.election_id=selected.election_id
          AND l.link_status='active'
        JOIN public.lacity_candidate_finance_outside_groups g
          ON g.link_id=l.id
          AND g.election_year=l.election_year
      )
      SELECT candidate_id,election_id,spender_id,spender_name,support_oppose,amount,expenditure_count,source_url
      FROM ranked
      WHERE rn<=5
      ORDER BY candidate_id,election_id,support_oppose,amount DESC,spender_name,spender_id
    `,
    [JSON.stringify(selected)],
  );
  const maps = new Map<string, Map<string, BallotLookupFinanceBreakdown[]>>();
  for (const row of direct.rows) {
    const key = candidateElectionKey(row.candidate_id, row.election_id);
    const byType = maps.get(key) ?? new Map();
    const list = byType.get(row.category_type) ?? [];
    list.push(mapFinanceBreakdown(row));
    byType.set(row.category_type, list);
    maps.set(key, byType);
  }
  const groups = new Map<string, BallotLookupFinanceOutsideGroup[]>();
  for (const row of outside.rows) {
    const key = `${candidateElectionKey(row.candidate_id, row.election_id)}\u0000${row.support_oppose}`;
    const list = groups.get(key) ?? [];
    list.push({
      committee_id: row.spender_id,
      committee_name: row.spender_name,
      support_oppose: row.support_oppose,
      amount: parseFinanceAmount(row.amount) ?? 0,
      expenditure_count: parseFinanceCount(row.expenditure_count),
      source_url: row.source_url,
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
          source: "LOS_ANGELES_CITY_ETHICS",
          cycle: row.election_year,
          fec_candidate_id: null,
          controlled_committee_id: row.fppc_committee_id,
          last_synced_at: row.last_synced_at,
          direct_campaign: {
            total_raised: parseFinanceAmount(row.total_receipts),
            direct_coverage_note: (row.fppc_committee_ids?.length ?? 1) > 1 ? "City Ethics totals combine the candidate’s primary and general controlled committees for this election year. Raised excludes public matching funds; membership communications are separate." : undefined,
            total_spent: parseFinanceAmount(row.total_disbursements),
            cash_on_hand: parseFinanceAmount(row.cash_on_hand),
            debts_owed: null,
            public_funds_received: parseFinanceAmount(row.matching_funds),
            top_occupations: occupations,
            top_employers: byType.get("employer") ?? [],
            top_industries: byType.get("industry") ?? [],
            contribution_size_buckets: byType.get("contribution_size") ?? [],
          },
          outside_spending: {
            support_total: parseFinanceAmount(row.outside_support_total),
            oppose_total: parseFinanceAmount(row.outside_oppose_total),
            membership_support_total: parseFinanceAmount(row.membership_support_total),
            membership_oppose_total: parseFinanceAmount(row.membership_oppose_total),
            top_supporting_groups: groups.get(`${key}\u0000support`) ?? [],
            top_opposing_groups: groups.get(`${key}\u0000oppose`) ?? [],
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
  if (isLosAngelesReportedCommitteeCashEnabled()) await appendLosAngelesReportedCommitteeCash(db,result);
  return result;
}
