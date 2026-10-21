import { overlayIndianaNativePacFinance } from "./indianaNativePacReader.js";
import type { Pool, PoolClient } from "pg";

import { isIndianaCampaignFinanceEnabled } from "../../config/featureFlags.js";
import {
  addFinanceBreakdown,
  buildStateFinanceSummaryRequests,
  candidateElectionKey,
  financeIndustryDisplayName,
  mapFinanceBreakdown,
  parseFinanceAmount,
  type BallotLookupFinanceBreakdown,
  type BallotLookupFinanceSummary,
  type StateFinanceRequestCandidateRow,
  type StateFinanceRequestElectionRow,
} from "../address/ballotLookupFinanceShared.js";

type Queryable = Pick<Pool | PoolClient, "query">;

// The loader body below moved verbatim from ballotLookup.ts
// (docs/plans/plan-ballot-lookup.md Phase 2); these aliases keep its signature and row
// references byte-identical while the shapes live in the shared module.
type CandidateRow = StateFinanceRequestCandidateRow;
type ElectionRow = StateFinanceRequestElectionRow;

const GENERIC_INDIANA_PUBLIC_SOURCE_URL = "https://campaignfinance.in.gov/PublicSite/Reporting/DataDownload.aspx";

type IndianaFinanceSummaryRow = {
  candidate_id: string;
  election_id: string;
  committee_id: string | null;
  election_year: number;
  total_receipts: string | number | null;
  direct_contribution_total: string | number | null;
  source_url: string | null;
  last_synced_at: string;
};

type IndianaFinanceDirectBreakdownRow = {
  candidate_id: string;
  election_id: string;
  category_type: "occupation" | "contribution_size" | "pac_backed_industry";
  category_name: string;
  amount: string | number;
  contributor_count: string | number | null;
  source_url: string | null;
};

export async function loadIndianaCandidateFinanceSummariesByCandidateElection(
  db: Queryable,
  candidateRows: readonly CandidateRow[],
  electionRows: readonly ElectionRow[]
): Promise<Map<string, BallotLookupFinanceSummary>> {
  if (!isIndianaCampaignFinanceEnabled()) return new Map();
  let summaries = new Map<string, BallotLookupFinanceSummary>();
  try { summaries = await loadIndianaLegacyFinanceSummaries(db, candidateRows, electionRows); }
  catch { /* Legacy query failures do not suppress independently qualified native evidence. */ }
  try { return await overlayIndianaNativePacFinance(db, summaries, candidateRows, electionRows); }
  catch { return summaries; }
}

async function loadIndianaLegacyFinanceSummaries(
  db: Queryable,
  candidateRows: readonly CandidateRow[],
  electionRows: readonly ElectionRow[]
): Promise<Map<string, BallotLookupFinanceSummary>> {
  if (!isIndianaCampaignFinanceEnabled()) {
    return new Map();
  }

  const requests = buildStateFinanceSummaryRequests("IN", candidateRows, electionRows);
  if (requests.length === 0) {
    return new Map();
  }

  const summaryResult = await db.query<IndianaFinanceSummaryRow>(
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
      JOIN public.in_candidate_finance_links AS link
        ON link.candidate_id = requested.candidate_id
       AND link.election_id = requested.election_id
       AND link.link_status = 'active'
      JOIN public.in_candidate_finance_summaries AS summary
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

  const directBreakdownResult = await db.query<IndianaFinanceDirectBreakdownRow>(
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
        JOIN public.in_candidate_finance_links AS link
          ON link.candidate_id = selected.candidate_id
         AND link.election_id = selected.election_id
         AND link.link_status = 'active'
        JOIN public.in_candidate_finance_direct_breakdowns AS breakdown
          ON breakdown.link_id = link.id
         AND breakdown.election_year = link.election_year
        WHERE breakdown.category_type IN ('occupation', 'contribution_size', 'pac_backed_industry')
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
  const pacBackedIndustriesByCandidateElection = new Map<string, BallotLookupFinanceBreakdown[]>();
  const summaryByCandidateElection = new Map(
    summaryResult.rows.map((row) => [candidateElectionKey(row.candidate_id, row.election_id), row])
  );
  for (const row of directBreakdownResult.rows) {
    const summary = summaryByCandidateElection.get(candidateElectionKey(row.candidate_id, row.election_id));
    const mapped = mapFinanceBreakdown(row, summary?.source_url ?? GENERIC_INDIANA_PUBLIC_SOURCE_URL);
    if (row.category_type === "occupation") {
      addFinanceBreakdown(directOccupationsByCandidateElection, row.candidate_id, row.election_id, mapped);
    } else if (row.category_type === "contribution_size") {
      addFinanceBreakdown(contributionSizeBucketsByCandidateElection, row.candidate_id, row.election_id, mapped);
    } else if (row.category_type === "pac_backed_industry") {
      addFinanceBreakdown(pacBackedIndustriesByCandidateElection, row.candidate_id, row.election_id, mapped);
    }
  }

  return new Map(
    summaryResult.rows.map((row) => {
      const key = candidateElectionKey(row.candidate_id, row.election_id);
      const topDirectDonorOccupations = directOccupationsByCandidateElection.get(key) ?? [];
      const topPacBackedIndustries = (pacBackedIndustriesByCandidateElection.get(key) ?? []).map((industry) => ({
        ...industry,
        explanation:
          `The ${financeIndustryDisplayName(industry.category_name)} category is a top PAC-backed donor industry ` +
          "because organizations classified in this industry contributed to PACs that directly contributed to this candidate's committee.",
        supporting_organizations: [],
      }));
      return [
        key,
        {
          source: "INDIANA_CAMPAIGN_FINANCE",
          cycle: row.election_year,
          fec_candidate_id: null,
          controlled_committee_id: row.committee_id,
          last_synced_at: row.last_synced_at,
          direct_campaign: {
            total_raised: parseFinanceAmount(row.total_receipts),
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
            top_pac_backed_industries: topPacBackedIndustries,
          },
        } satisfies BallotLookupFinanceSummary,
      ];
    })
  );
}
