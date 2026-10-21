import type { Pool, PoolClient } from "pg";

import { isVirginiaCampaignFinanceEnabled } from "../../config/featureFlags.js";
import {
  addFinanceBreakdown,
  buildStateFinanceSummaryRequests,
  candidateElectionKey,
  mapFinanceBreakdown,
  officeInputFromElectionRow,
  parseFinanceAmount,
  type BallotLookupFinanceBreakdown,
  type BallotLookupFinanceSummary,
  type StateFinanceDirectBreakdownRow,
  type StateFinanceRequestCandidateRow,
  type StateFinanceRequestElectionRow,
} from "../address/ballotLookupFinanceShared.js";
import { isVirginiaFinanceEligibleOffice } from "./virginiaFinanceEligibleOffices.js";
import { overlayVirginiaReportedFinance } from "./virginiaReportedReader.js";

type Queryable = Pick<Pool | PoolClient, "query">;

// The loader body below moved verbatim from ballotLookup.ts
// (docs/plans/plan-ballot-lookup.md Phase 2); these aliases keep its signature and row
// references byte-identical while the shapes live in the shared module.
type CandidateRow = StateFinanceRequestCandidateRow;
type ElectionRow = StateFinanceRequestElectionRow;
type VirginiaFinanceDirectBreakdownRow = StateFinanceDirectBreakdownRow;
const GENERIC_VIRGINIA_CFREPORTS_SOURCE_URL = "https://cfreports.elections.virginia.gov/";

type VirginiaFinanceSummaryRow = {
  candidate_id: string;
  election_id: string;
  committee_id: string | null;
  election_year: number;
  total_receipts: string | number | null;
  direct_contribution_total: string | number | null;
  source_url: string | null;
  last_synced_at: string;
};

export async function loadVirginiaCandidateFinanceSummariesByCandidateElection(
  db: Queryable,
  candidateRows: readonly CandidateRow[],
  electionRows: readonly ElectionRow[]
): Promise<Map<string, BallotLookupFinanceSummary>> {
  if (!isVirginiaCampaignFinanceEnabled()) return new Map();
  let summaries = new Map<string, BallotLookupFinanceSummary>();
  try { summaries = await loadLegacyVirginiaCandidateFinanceSummaries(db,candidateRows,electionRows); }
  catch { /* A legacy query failure does not suppress qualified native data. */ }
  try { return await overlayVirginiaReportedFinance(db,summaries,candidateRows,electionRows); }
  catch { return summaries; }
}

async function loadLegacyVirginiaCandidateFinanceSummaries(
  db: Queryable,
  candidateRows: readonly CandidateRow[],
  electionRows: readonly ElectionRow[]
): Promise<Map<string, BallotLookupFinanceSummary>> {
  if (!isVirginiaCampaignFinanceEnabled()) {
    return new Map();
  }

  const requests = buildStateFinanceSummaryRequests("VA", candidateRows, electionRows, (row) =>
    isVirginiaFinanceEligibleOffice(officeInputFromElectionRow(row))
  );
  if (requests.length === 0) {
    return new Map();
  }

  const summaryResult = await db.query<VirginiaFinanceSummaryRow>(
    `
      WITH requested AS (
        SELECT
          candidate_id::uuid AS candidate_id,
          election_id::uuid AS election_id
        FROM jsonb_to_recordset($1::jsonb) AS x(
          candidate_id text,
          election_id text
        )
      )
      SELECT
        requested.candidate_id::text AS candidate_id,
        requested.election_id::text AS election_id,
        CASE
          WHEN count(DISTINCT link.committee_id) = 1 THEN min(link.committee_id)
          ELSE NULL
        END AS committee_id,
        max(summary.election_year) AS election_year,
        CASE WHEN count(summary.total_receipts) = 0 THEN NULL ELSE sum(summary.total_receipts) END AS total_receipts,
        CASE
          WHEN count(summary.direct_contribution_total) = 0 THEN NULL
          ELSE sum(summary.direct_contribution_total)
        END AS direct_contribution_total,
        min(summary.source_url) FILTER (WHERE summary.source_url IS NOT NULL) AS source_url,
        max(summary.last_synced_at)::text AS last_synced_at
      FROM requested
      JOIN public.va_candidate_finance_links AS link
        ON link.candidate_id = requested.candidate_id
       AND link.election_id = requested.election_id
       AND link.link_status = 'active'
      JOIN public.va_candidate_finance_summaries AS summary
        ON summary.link_id = link.id
       AND summary.election_year = link.election_year
      GROUP BY requested.candidate_id, requested.election_id
    `,
    [JSON.stringify(requests)]
  );

  if (summaryResult.rows.length === 0) {
    return new Map();
  }

  const selectedRequests = summaryResult.rows.map((row) => ({
    candidate_id: row.candidate_id,
    election_id: row.election_id,
  }));

  const directBreakdownResult = await db.query<VirginiaFinanceDirectBreakdownRow>(
    `
      WITH selected AS (
        SELECT
          candidate_id::uuid AS candidate_id,
          election_id::uuid AS election_id
        FROM jsonb_to_recordset($1::jsonb) AS x(
          candidate_id text,
          election_id text
        )
      ),
      grouped AS (
        SELECT
          selected.candidate_id::text AS candidate_id,
          selected.election_id::text AS election_id,
          breakdown.category_type,
          breakdown.category_name,
          sum(breakdown.amount) AS amount,
          CASE
            WHEN count(breakdown.contributor_count) = 0 THEN NULL
            ELSE sum(breakdown.contributor_count)
          END AS contributor_count,
          min(breakdown.source_url) FILTER (WHERE breakdown.source_url IS NOT NULL) AS source_url
        FROM selected
        JOIN public.va_candidate_finance_links AS link
          ON link.candidate_id = selected.candidate_id
         AND link.election_id = selected.election_id
         AND link.link_status = 'active'
        JOIN public.va_candidate_finance_direct_breakdowns AS breakdown
          ON breakdown.link_id = link.id
         AND breakdown.election_year = link.election_year
        WHERE breakdown.category_type IN ('occupation', 'contribution_size')
        GROUP BY selected.candidate_id, selected.election_id, breakdown.category_type, breakdown.category_name
      ),
      ranked AS (
        SELECT
          *,
          row_number() OVER (
            PARTITION BY candidate_id, election_id, category_type
            ORDER BY amount DESC, category_name ASC
          ) AS rn
        FROM grouped
      )
      SELECT candidate_id, election_id, category_type, category_name, amount, contributor_count, source_url
      FROM ranked
      WHERE rn <= 5
      ORDER BY candidate_id, election_id, category_type, amount DESC, category_name ASC
    `,
    [JSON.stringify(selectedRequests)]
  );

  const directOccupationsByCandidateElection = new Map<string, BallotLookupFinanceBreakdown[]>();
  const contributionSizeBucketsByCandidateElection = new Map<string, BallotLookupFinanceBreakdown[]>();
  const summaryByCandidateElection = new Map(
    summaryResult.rows.map((row) => [candidateElectionKey(row.candidate_id, row.election_id), row])
  );
  for (const row of directBreakdownResult.rows) {
    const summary = summaryByCandidateElection.get(candidateElectionKey(row.candidate_id, row.election_id));
    const targetMap =
      row.category_type === "contribution_size"
        ? contributionSizeBucketsByCandidateElection
        : directOccupationsByCandidateElection;
    addFinanceBreakdown(
      targetMap,
      row.candidate_id,
      row.election_id,
      mapFinanceBreakdown(row, summary?.source_url ?? GENERIC_VIRGINIA_CFREPORTS_SOURCE_URL)
    );
  }

  return new Map(
    summaryResult.rows.map((row) => {
      const key = candidateElectionKey(row.candidate_id, row.election_id);
      const topDirectDonorOccupations = directOccupationsByCandidateElection.get(key) ?? [];
      return [
        key,
        {
          source: "VIRGINIA_CFREPORTS",
          cycle: row.election_year,
          fec_candidate_id: null,
          controlled_committee_id: row.committee_id,
          last_synced_at: row.last_synced_at,
          direct_campaign: {
            total_raised: parseFinanceAmount(row.direct_contribution_total) ?? parseFinanceAmount(row.total_receipts),
            total_spent: null,
            cash_on_hand: null,
            debts_owed: null,
            top_occupations: topDirectDonorOccupations,
            top_employers: [],
            top_industries: [],
            contribution_size_buckets: contributionSizeBucketsByCandidateElection.get(key) ?? [],
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
            top_direct_donor_occupations: topDirectDonorOccupations,
            top_outside_supporting_industries: [],
          },
        } satisfies BallotLookupFinanceSummary,
      ];
    })
  );
}
