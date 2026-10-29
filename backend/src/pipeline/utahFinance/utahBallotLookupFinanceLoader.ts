import { appendUtahReportedIeSummaries } from "./utahReportedIeBallotSummary.js";
import type { BallotLookupFinanceSummary } from "../address/ballotLookupFinanceShared.js";
import { appendUtahCommitteeCashSummaries, UTAH_OUTSIDE_CASH_NOTE } from "./utahCommitteeCashBallotSummary.js";
import type { Pool, PoolClient } from "pg";

import { isUtahCampaignFinanceEnabled } from "../../config/featureFlags.js";
import { isUtahFinanceEligibleOffice } from "./utahFinanceEligibleOffices.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type UtahBallotLookupCandidateRow = {
  candidate_id: string;
  election_id: string;
};

export type UtahBallotLookupElectionRow = {
  election_id: string;
  state: string;
  // Optional to accept ballot lookup's election rows directly (the old
  // dynamic-import wrapper cast this away); the loader already reads both
  // with ?? null.
  office_scope?: string | null;
  office_canonical_name?: string | null;
};

export type UtahBallotLookupFinanceBreakdown = {
  category_name: string;
  amount: number;
  contributor_count: number | null;
  source_url: string | null;
};

export type UtahBallotLookupSupportingCommitteeIndustrySummary = UtahBallotLookupFinanceBreakdown & {
  supporting_committee_name: string;
};

export type UtahBallotLookupFinanceSummary = BallotLookupFinanceSummary;

type UtahFinanceSummaryRequest = {
  candidate_id: string;
  election_id: string;
};

type UtahFinanceSummaryRow = {
  candidate_id: string;
  election_id: string;
  folder_id: string | null;
  election_year: number;
  total_receipts: string | number | null;
  direct_contribution_total: string | number | null;
  total_disbursements: string | number | null;
  cash_on_hand: string | number | null;
  source_url: string | null;
  last_synced_at: string;
};

type UtahFinanceDirectBreakdownRow = {
  candidate_id: string;
  election_id: string;
  category_type: "contribution_size";
  category_name: string;
  amount: string | number;
  contributor_count: string | number | null;
  source_url: string | null;
};

type UtahFinanceSupportingCommitteeIndustryRow = {
  candidate_id: string;
  election_id: string;
  supporting_committee_name: string;
  category_name: string;
  amount: string | number;
  contributor_count: string | number | null;
  source_url: string | null;
};

const GENERIC_UTAH_DISCLOSURES_SOURCE_URL = "https://disclosures.utah.gov/Search/AdvancedSearch";

function parseFinanceAmount(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseFinanceCount(value: string | number | null | undefined): number | null {
  const parsed = parseFinanceAmount(value);
  return parsed === null ? null : Math.trunc(parsed);
}

function candidateElectionKey(candidateId: string, electionId: string): string {
  return `${candidateId}\u0000${electionId}`;
}

function firstNonEmptySourceUrl(...urls: Array<string | null | undefined>): string | null {
  for (const url of urls) {
    const trimmed = url?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

function mapFinanceBreakdown(
  row: {
    category_name: string;
    amount: string | number;
    contributor_count: string | number | null;
    source_url?: string | null;
  },
  fallbackSourceUrl: string | null = null
): UtahBallotLookupFinanceBreakdown {
  return {
    category_name: row.category_name,
    amount: parseFinanceAmount(row.amount) ?? 0,
    contributor_count: parseFinanceCount(row.contributor_count),
    source_url: firstNonEmptySourceUrl(row.source_url, fallbackSourceUrl),
  };
}

function addFinanceBreakdown(
  byCandidateElection: Map<string, UtahBallotLookupFinanceBreakdown[]>,
  candidateId: string,
  electionId: string,
  breakdown: UtahBallotLookupFinanceBreakdown
): void {
  const key = candidateElectionKey(candidateId, electionId);
  const existing = byCandidateElection.get(key) ?? [];
  existing.push(breakdown);
  byCandidateElection.set(key, existing);
}

function buildUtahFinanceSummaryRequests(
  candidateRows: readonly UtahBallotLookupCandidateRow[],
  electionRows: readonly UtahBallotLookupElectionRow[]
): UtahFinanceSummaryRequest[] {
  const electionIds = new Set(
    electionRows
      .filter(
        (row) =>
          row.state.trim().toUpperCase() === "UT" &&
          isUtahFinanceEligibleOffice({
            officeScope: row.office_scope ?? null,
            officeCanonicalName: row.office_canonical_name ?? null,
          })
      )
      .map((row) => row.election_id)
  );
  const requests = new Map<string, UtahFinanceSummaryRequest>();
  for (const row of candidateRows) {
    if (!electionIds.has(row.election_id)) {
      continue;
    }
    const key = candidateElectionKey(row.candidate_id, row.election_id);
    requests.set(key, {
      candidate_id: row.candidate_id,
      election_id: row.election_id,
    });
  }
  return [...requests.values()];
}

export async function loadUtahCandidateFinanceSummariesByCandidateElection(input: {
  db: Queryable;
  candidateRows: readonly UtahBallotLookupCandidateRow[];
  electionRows: readonly UtahBallotLookupElectionRow[];
}): Promise<Map<string, UtahBallotLookupFinanceSummary>> {
  if (!isUtahCampaignFinanceEnabled()) {
    return new Map();
  }

  const requests = buildUtahFinanceSummaryRequests(input.candidateRows, input.electionRows);
  if (requests.length === 0) {
    return new Map();
  }

  const summaryResult = await input.db.query<UtahFinanceSummaryRow>(
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
          WHEN count(DISTINCT link.folder_id) = 1 THEN min(link.folder_id)
          ELSE NULL
        END AS folder_id,
        max(summary.election_year) AS election_year,
        CASE WHEN count(summary.total_receipts) = 0 THEN NULL ELSE sum(summary.total_receipts) END AS total_receipts,
        CASE
          WHEN count(summary.direct_contribution_total) = 0 THEN NULL
          ELSE sum(summary.direct_contribution_total)
        END AS direct_contribution_total,
        CASE
          WHEN count(summary.total_disbursements) = 0 THEN NULL
          ELSE sum(summary.total_disbursements)
        END AS total_disbursements,
        CASE
          WHEN count(summary.cash_on_hand) = 0 THEN NULL
          ELSE sum(summary.cash_on_hand)
        END AS cash_on_hand,
        min(summary.source_url) FILTER (WHERE summary.source_url IS NOT NULL) AS source_url,
        max(summary.last_synced_at)::text AS last_synced_at
      FROM requested
      JOIN public.ut_candidate_finance_links AS link
        ON link.candidate_id = requested.candidate_id
       AND link.election_id = requested.election_id
       AND link.link_status = 'active'
      JOIN public.ut_candidate_finance_summaries AS summary
        ON summary.link_id = link.id
       AND summary.election_year = link.election_year
      GROUP BY requested.candidate_id, requested.election_id
    `,
    [JSON.stringify(requests)]
  );

  const selectedRequests = requests;

  const directBreakdownResult = await input.db.query<UtahFinanceDirectBreakdownRow>(
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
        JOIN public.ut_candidate_finance_links AS link
          ON link.candidate_id = selected.candidate_id
         AND link.election_id = selected.election_id
         AND link.link_status = 'active'
        JOIN public.ut_candidate_finance_direct_breakdowns AS breakdown
          ON breakdown.link_id = link.id
         AND breakdown.election_year = link.election_year
        WHERE breakdown.category_type = 'contribution_size'
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
      ORDER BY candidate_id, election_id, amount DESC, category_name ASC
    `,
    [JSON.stringify(selectedRequests)]
  );

  const supportingCommitteeIndustryResult = await input.db.query<UtahFinanceSupportingCommitteeIndustryRow>(
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
          industry.supporting_committee_name,
          industry.industry_slug AS category_name,
          sum(industry.amount) AS amount,
          CASE
            WHEN count(industry.contributor_count) = 0 THEN NULL
            ELSE sum(industry.contributor_count)
          END AS contributor_count,
          min(industry.source_url) FILTER (WHERE industry.source_url IS NOT NULL) AS source_url
        FROM selected
        JOIN public.ut_candidate_finance_links AS link
          ON link.candidate_id = selected.candidate_id
         AND link.election_id = selected.election_id
         AND link.link_status = 'active'
        JOIN public.ut_candidate_finance_supporting_committee_industries AS industry
          ON industry.link_id = link.id
         AND industry.election_year = link.election_year
        GROUP BY
          selected.candidate_id,
          selected.election_id,
          industry.supporting_committee_name,
          industry.industry_slug
      ),
      ranked AS (
        SELECT
          *,
          row_number() OVER (
            PARTITION BY candidate_id, election_id
            ORDER BY amount DESC, supporting_committee_name ASC, category_name ASC
          ) AS rn
        FROM grouped
      )
      SELECT
        candidate_id,
        election_id,
        supporting_committee_name,
        category_name,
        amount,
        contributor_count,
        source_url
      FROM ranked
      WHERE rn <= 5
      ORDER BY candidate_id, election_id, amount DESC, supporting_committee_name ASC, category_name ASC
    `,
    [JSON.stringify(selectedRequests)]
  );

  const summaryByCandidateElection = new Map(
    summaryResult.rows.map((row) => [candidateElectionKey(row.candidate_id, row.election_id), row])
  );
  const contributionSizeBucketsByCandidateElection = new Map<string, UtahBallotLookupFinanceBreakdown[]>();
  for (const row of directBreakdownResult.rows) {
    const summary = summaryByCandidateElection.get(candidateElectionKey(row.candidate_id, row.election_id));
    addFinanceBreakdown(
      contributionSizeBucketsByCandidateElection,
      row.candidate_id,
      row.election_id,
      mapFinanceBreakdown(row, summary?.source_url ?? GENERIC_UTAH_DISCLOSURES_SOURCE_URL)
    );
  }

  const supportingCommitteeIndustriesByCandidateElection = new Map<
    string,
    UtahBallotLookupSupportingCommitteeIndustrySummary[]
  >();
  for (const row of supportingCommitteeIndustryResult.rows) {
    const key = candidateElectionKey(row.candidate_id, row.election_id);
    const list = supportingCommitteeIndustriesByCandidateElection.get(key) ?? [];
    list.push({
      supporting_committee_name: row.supporting_committee_name,
      ...mapFinanceBreakdown(row, GENERIC_UTAH_DISCLOSURES_SOURCE_URL),
    });
    supportingCommitteeIndustriesByCandidateElection.set(key, list);
  }

  const summaries = new Map<string, UtahBallotLookupFinanceSummary>(
    summaryResult.rows.map((row) => {
      const key = candidateElectionKey(row.candidate_id, row.election_id);
      const supportingCommitteeIndustries = supportingCommitteeIndustriesByCandidateElection.get(key) ?? [];
      return [
        key,
        {
          source: "UTAH_DISCLOSURES",
          cycle: row.election_year,
          fec_candidate_id: null,
          controlled_committee_id: row.folder_id,
          last_synced_at: row.last_synced_at,
          direct_campaign: {
            total_raised: parseFinanceAmount(row.direct_contribution_total) ?? parseFinanceAmount(row.total_receipts),
            total_spent: parseFinanceAmount(row.total_disbursements),
            cash_on_hand: parseFinanceAmount(row.cash_on_hand),
            debts_owed: null,
            top_occupations: [],
            top_employers: [],
            top_industries: [],
            contribution_size_buckets: contributionSizeBucketsByCandidateElection.get(key) ?? [],
          },
          outside_spending: {
            outside_coverage_note: UTAH_OUTSIDE_CASH_NOTE,
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
            ...(supportingCommitteeIndustries.length > 0
              ? { top_supporting_committee_industries: supportingCommitteeIndustries }
              : {}),
          },
        },
      ];
    })
  );
  await appendUtahCommitteeCashSummaries(input.db, requests, summaries);
  await appendUtahReportedIeSummaries(input.db, requests, summaries);
  return summaries;
}
