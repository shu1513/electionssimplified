// Ballot-lookup finance loader for San Francisco (Phase 8 of
// docs/plans/plan-san-francisco-finance.md). Modeled on the Los Angeles City loader —
// a bespoke loader over the ballotLookupFinanceShared primitives, NOT
// standardStateFinanceBallotLookupLoader: the standard loader expects an
// outsideGroupBreakdowns table SF will never have (the SFEC manifest
// discloses per-relation totals only, with no spender-funder backtrace).
import type { Pool, PoolClient } from "pg";
import { isSanFranciscoCampaignFinanceEnabled } from "../../config/featureFlags.js";
import {
  buildStateFinanceSummaryRequests,
  candidateElectionKey,
  mapFinanceBreakdown,
  parseFinanceAmount,
  type BallotLookupFinanceBreakdown,
  type BallotLookupFinanceOutsideGroup,
  type BallotLookupFinanceSummary,
} from "../address/ballotLookupFinanceShared.js";
import { isSanFranciscoFinanceEligibleElection } from "./sanFranciscoFinanceEligibleOffices.js";
import {
  groupSanFranciscoCommitteeCashByInterest,
  type SanFranciscoCommitteeCashReaderRow,
} from "./sanFranciscoCommitteeCashReader.js";

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
  total_receipts: string | number | null;
  direct_contribution_total: string | number | null;
  total_disbursements: string | number | null;
  cash_on_hand: string | number | null;
  debts_owed: string | number | null;
  loans_received: string | number | null;
  public_funds_received: string | number | null;
  outside_support_total: string | number | null;
  outside_oppose_total: string | number | null;
  source_url: string | null;
  last_synced_at: string;
};

export async function loadSanFranciscoCandidateFinanceSummariesByCandidateElection(
  db: Queryable,
  candidateRows: readonly Candidate[],
  electionRows: readonly Election[],
): Promise<Map<string, BallotLookupFinanceSummary>> {
  if (!isSanFranciscoCampaignFinanceEnabled()) return new Map();
  const requests = buildStateFinanceSummaryRequests(
    "CA",
    candidateRows,
    electionRows,
    (row) =>
      isSanFranciscoFinanceEligibleElection({
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
        summary.total_receipts,
        summary.direct_contribution_total,
        summary.total_disbursements,
        summary.cash_on_hand,
        summary.debts_owed,
        summary.loans_received,
        summary.public_funds_received,
        summary.outside_support_total,
        summary.outside_oppose_total,
        summary.source_url,
        summary.last_synced_at::text
      FROM requested
      JOIN public.sfc_candidate_finance_links link
        ON link.candidate_id=requested.candidate_id
        AND link.election_id=requested.election_id
        AND link.link_status='active'
      JOIN public.sfc_candidate_finance_summaries summary
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
        JOIN public.sfc_candidate_finance_links l
          ON l.candidate_id=selected.candidate_id
          AND l.election_id=selected.election_id
          AND l.link_status='active'
        JOIN public.sfc_candidate_finance_direct_breakdowns b
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
    spender_fppc_id: string;
    spender_name: string;
    support_oppose: "support" | "oppose";
    amount: string | number;
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
          g.spender_fppc_id,
          g.spender_name,
          g.support_oppose,
          g.amount,
          g.source_url,
          row_number() OVER(PARTITION BY selected.candidate_id,selected.election_id,g.support_oppose ORDER BY g.amount DESC,g.spender_name,g.spender_fppc_id) rn
        FROM selected
        JOIN public.sfc_candidate_finance_links l
          ON l.candidate_id=selected.candidate_id
          AND l.election_id=selected.election_id
          AND l.link_status='active'
        JOIN public.sfc_candidate_finance_outside_groups g
          ON g.link_id=l.id
          AND g.election_year=l.election_year
      )
      SELECT candidate_id,election_id,spender_fppc_id,spender_name,support_oppose,amount,source_url
      FROM ranked
      WHERE rn<=5
      ORDER BY candidate_id,election_id,support_oppose,amount DESC,spender_name,spender_fppc_id
    `,
    [JSON.stringify(selected)],
  );
  const committeeCash = await db.query<SanFranciscoCommitteeCashReaderRow>(
    `WITH selected AS (
       SELECT candidate_id::uuid candidate_id,election_id::uuid election_id
       FROM jsonb_to_recordset($1::jsonb)x(candidate_id text,election_id text)
     )
     SELECT selected.candidate_id::text candidate_id,selected.election_id::text election_id,
       d.committee_id,min(d.committee_name) committee_name,sum(d.amount) amount,
       min(d.source_url) source_url,min(d.reported_through)::text reported_through,
       min(d.last_synced_at)::text last_synced_at
     FROM selected JOIN public.sfc_candidate_finance_links l
       ON l.candidate_id=selected.candidate_id AND l.election_id=selected.election_id
       AND l.link_status='active'
     JOIN public.sfc_candidate_finance_pac_donors d
       ON d.link_id=l.id AND d.election_year=l.election_year
     GROUP BY selected.candidate_id,selected.election_id,d.committee_id
     ORDER BY selected.candidate_id,selected.election_id,sum(d.amount) DESC,d.committee_id`,
    [JSON.stringify(selected)],
  );
  const cashByInterest = groupSanFranciscoCommitteeCashByInterest(
    committeeCash.rows,
  );
  const cashObservationByKey = new Map<string, string>();
  for (const row of committeeCash.rows) {
    const key = candidateElectionKey(row.candidate_id, row.election_id);
    const date = row.last_synced_at.slice(0, 10);
    const previous = cashObservationByKey.get(key);
    if (!previous || date < previous) cashObservationByKey.set(key, date);
  }
  // SF stores the source URL on the summary row only (the breakdown rows are
  // derived aggregates with no per-row URL, unlike LA's), and the card's
  // footer link is built exclusively from breakdown/group rows — without this
  // fallback every SF card would name the source with no clickable link.
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
    const key = `${candidateElectionKey(row.candidate_id, row.election_id)}\u0000${row.support_oppose}`;
    const list = groups.get(key) ?? [];
    list.push({
      // spender_fppc_id carries the synthetic "name:…" identity for id-less
      // manifest spenders (migration 215); it is still the row's stable key.
      committee_id: row.spender_fppc_id,
      committee_name: row.spender_name,
      support_oppose: row.support_oppose,
      amount: parseFinanceAmount(row.amount) ?? 0,
      // The SFEC manifest discloses per-relation totals only — no
      // per-expenditure rows exist, so no count is stored (migration 229).
      expenditure_count: null,
      source_url: row.source_url,
    });
    groups.set(key, list);
  }
  return new Map(
    summaries.rows.map((row) => {
      const key = candidateElectionKey(row.candidate_id, row.election_id);
      const byType = maps.get(key) ?? new Map();
      const occupations = byType.get("occupation") ?? [];
      return [
        key,
        {
          source: "SAN_FRANCISCO_ETHICS",
          cycle: row.election_year,
          fec_candidate_id: null,
          controlled_committee_id: row.fppc_id,
          last_synced_at: row.last_synced_at,
          direct_campaign: {
            // Donor money preferred: the manifest funds figure
            // (total_receipts) includes public-financing disbursements, and
            // the card shows "Raised" and "Public funds" as disjoint stats.
            total_raised:
              parseFinanceAmount(row.direct_contribution_total) ??
              parseFinanceAmount(row.total_receipts),
            total_spent: parseFinanceAmount(row.total_disbursements),
            cash_on_hand: parseFinanceAmount(row.cash_on_hand),
            debts_owed: parseFinanceAmount(row.debts_owed),
            loans_received: parseFinanceAmount(row.loans_received),
            public_funds_received: parseFinanceAmount(
              row.public_funds_received,
            ),
            top_occupations: occupations,
            top_employers: byType.get("employer") ?? [],
            top_industries: byType.get("industry") ?? [],
            contribution_size_buckets: byType.get("contribution_size") ?? [],
            ...(cashByInterest.has(key)
              ? {
                  pac_money_by_interest: cashByInterest.get(key),
                  direct_coverage_note: `Committee amounts are net reported cash from recipient and small-contributor committees, already included in Raised. They exclude loans and nonmonetary gifts; candidate campaign donors are omitted. Committee cash last checked ${cashObservationByKey.get(key)}.`,
                }
              : {}),
          },
          // No membership totals: SF does not disclose member communications
          // separately (unlike LA Ethics).
          outside_spending: {
            support_total: parseFinanceAmount(row.outside_support_total),
            oppose_total: parseFinanceAmount(row.outside_oppose_total),
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
}
