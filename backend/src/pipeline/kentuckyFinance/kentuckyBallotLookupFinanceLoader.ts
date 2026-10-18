import type { Pool, PoolClient } from "pg";

import { isKentuckyCampaignFinanceEnabled } from "../../config/featureFlags.js";
import type {
  BallotLookupFinanceBreakdown,
  BallotLookupFinanceOutsideGroup,
  BallotLookupFinanceOutsideIndustrySupportEvidence,
  BallotLookupFinanceOutsideIndustrySupportSummary,
  BallotLookupFinanceSummary,
} from "../address/ballotLookupFinanceShared.js";
import { buildOutsideIndustrySupportExplanation } from "../address/ballotLookupFinanceShared.js";
import { isKentuckyFinanceEligibleOffice } from "./kentuckyFinanceEligibleOffices.js";
import { attachKentuckyReportedFinance } from "./kentuckyReportedReader.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type KentuckyBallotLookupFinanceCandidateRow = {
  candidate_id: string;
  election_id: string;
};

export type KentuckyBallotLookupFinanceElectionRow = {
  election_id: string;
  state: string;
  office_scope?: string | null;
  office_canonical_name?: string | null;
};

type KentuckyFinanceSummaryRequest = {
  candidate_id: string;
  election_id: string;
};

type KentuckyFinanceSummaryRow = {
  candidate_id: string;
  election_id: string;
  committee_id: string | null;
  election_year: number;
  total_receipts: string | number | null;
  direct_contribution_total: string | number | null;
  total_disbursements: string | number | null;
  cash_on_hand: string | number | null;
  outside_support_total: string | number | null;
  outside_oppose_total: string | number | null;
  source_url: string | null;
  last_synced_at: string;
};

type KentuckyFinanceDirectBreakdownRow = {
  candidate_id: string;
  election_id: string;
  category_type: "occupation" | "contribution_size";
  category_name: string;
  amount: string | number;
  contributor_count: string | number | null;
  source_url: string | null;
};

type KentuckyFinanceOutsideGroupRow = {
  candidate_id: string;
  election_id: string;
  committee_id: string;
  committee_name: string;
  support_oppose: "support" | "oppose";
  amount: string | number;
  source_url: string | null;
};

type KentuckyFinanceOutsideIndustryRow = {
  candidate_id: string;
  election_id: string;
  support_oppose: "support" | "oppose";
  category_name: string;
  amount: string | number;
  contributor_count: string | number | null;
  source_url: string | null;
};

type KentuckyFinanceOutsideDonorEvidenceRow = {
  candidate_id: string;
  election_id: string;
  industry_name: string;
  committee_id: string;
  committee_name: string;
  support_oppose: "support" | "oppose";
  organization_name: string;
  amount: string | number;
  contributor_count: string | number | null;
  source_url: string | null;
};

const GENERIC_KENTUCKY_KREF_SOURCE_URL = "https://secure.kentucky.gov/kref/publicsearch";

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
): BallotLookupFinanceBreakdown {
  return {
    category_name: row.category_name,
    amount: parseFinanceAmount(row.amount) ?? 0,
    contributor_count: parseFinanceCount(row.contributor_count),
    source_url: firstNonEmptySourceUrl(row.source_url, fallbackSourceUrl),
  };
}

function addFinanceBreakdown(
  map: Map<string, BallotLookupFinanceBreakdown[]>,
  candidateId: string,
  electionId: string,
  row: BallotLookupFinanceBreakdown
): void {
  const key = candidateElectionKey(candidateId, electionId);
  const list = map.get(key) ?? [];
  list.push(row);
  map.set(key, list);
}

function buildKentuckyFinanceSummaryRequests(
  candidateRows: readonly KentuckyBallotLookupFinanceCandidateRow[],
  electionRows: readonly KentuckyBallotLookupFinanceElectionRow[]
): KentuckyFinanceSummaryRequest[] {
  const electionIds = new Set(
    electionRows
      .filter(
        (row) =>
          row.state.trim().toUpperCase() === "KY" &&
          isKentuckyFinanceEligibleOffice({
            officeScope: row.office_scope ?? null,
            officeCanonicalName: row.office_canonical_name ?? null,
          })
      )
      .map((row) => row.election_id)
  );
  const requests = new Map<string, KentuckyFinanceSummaryRequest>();
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

async function loadKentuckyLegacyFinanceSummariesByCandidateElection(
  db: Queryable,
  candidateRows: readonly KentuckyBallotLookupFinanceCandidateRow[],
  electionRows: readonly KentuckyBallotLookupFinanceElectionRow[]
): Promise<Map<string, BallotLookupFinanceSummary>> {
  if (!isKentuckyCampaignFinanceEnabled()) {
    return new Map();
  }

  const requests = buildKentuckyFinanceSummaryRequests(candidateRows, electionRows);
  if (requests.length === 0) {
    return new Map();
  }

  const summaryResult = await db.query<KentuckyFinanceSummaryRow>(
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
          WHEN count(DISTINCT link.committee_key) = 1 THEN min(link.committee_key)
          ELSE NULL
        END AS committee_id,
        max(summary.election_year) AS election_year,
        CASE WHEN count(summary.total_receipts) = 0 THEN NULL ELSE sum(summary.total_receipts) END AS total_receipts,
        CASE
          WHEN count(summary.direct_contribution_total) = 0 THEN NULL
          ELSE sum(summary.direct_contribution_total)
        END AS direct_contribution_total,
        CASE WHEN count(summary.total_disbursements) = 0 THEN NULL ELSE sum(summary.total_disbursements) END AS total_disbursements,
        CASE WHEN count(summary.cash_on_hand) = 0 THEN NULL ELSE sum(summary.cash_on_hand) END AS cash_on_hand,
        max(summary.outside_support_total) AS outside_support_total,
        max(summary.outside_oppose_total) AS outside_oppose_total,
        min(summary.source_url) FILTER (WHERE summary.source_url IS NOT NULL) AS source_url,
        max(summary.last_synced_at)::text AS last_synced_at
      FROM requested
      JOIN public.ky_candidate_finance_links AS link
        ON link.candidate_id = requested.candidate_id
       AND link.election_id = requested.election_id
       AND link.link_status = 'active'
      JOIN public.ky_candidate_finance_summaries AS summary
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

  const directBreakdownResult = await db.query<KentuckyFinanceDirectBreakdownRow>(
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
        JOIN public.ky_candidate_finance_links AS link
          ON link.candidate_id = selected.candidate_id
         AND link.election_id = selected.election_id
         AND link.link_status = 'active'
        JOIN public.ky_candidate_finance_direct_breakdowns AS breakdown
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

  const outsideGroupResult = await db.query<KentuckyFinanceOutsideGroupRow>(
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
          outside_group.committee_key AS committee_id,
          min(outside_group.committee_name) AS committee_name,
          outside_group.support_oppose,
          max(outside_group.amount) AS amount,
          min(outside_group.source_url) FILTER (WHERE outside_group.source_url IS NOT NULL) AS source_url
        FROM selected
        JOIN public.ky_candidate_finance_links AS link
          ON link.candidate_id = selected.candidate_id
         AND link.election_id = selected.election_id
         AND link.link_status = 'active'
        JOIN public.ky_candidate_finance_outside_groups AS outside_group
          ON outside_group.link_id = link.id
         AND outside_group.election_year = link.election_year
        GROUP BY selected.candidate_id, selected.election_id, outside_group.committee_key, outside_group.support_oppose
      ),
      ranked AS (
        SELECT
          *,
          row_number() OVER (
            PARTITION BY candidate_id, election_id, support_oppose
            ORDER BY amount DESC, committee_name ASC
          ) AS rn
        FROM grouped
      )
      SELECT candidate_id, election_id, committee_id, committee_name, support_oppose, amount, source_url
      FROM ranked
      WHERE rn <= 5
      ORDER BY candidate_id, election_id, support_oppose, amount DESC, committee_name ASC
    `,
    [JSON.stringify(selectedRequests)]
  );

  const outsideIndustryResult = await db.query<KentuckyFinanceOutsideIndustryRow>(
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
      per_group AS (
        SELECT
          selected.candidate_id::text AS candidate_id,
          selected.election_id::text AS election_id,
          breakdown.committee_key AS committee_id,
          breakdown.support_oppose,
          breakdown.category_name,
          max(breakdown.amount) AS amount,
          CASE
            WHEN count(breakdown.contributor_count) = 0 THEN NULL
            ELSE max(breakdown.contributor_count)
          END AS contributor_count,
          min(breakdown.source_url) FILTER (WHERE breakdown.source_url IS NOT NULL) AS source_url
        FROM selected
        JOIN public.ky_candidate_finance_links AS link
          ON link.candidate_id = selected.candidate_id
         AND link.election_id = selected.election_id
         AND link.link_status = 'active'
        JOIN public.ky_candidate_finance_outside_group_breakdowns AS breakdown
          ON breakdown.link_id = link.id
         AND breakdown.election_year = link.election_year
        WHERE breakdown.category_type = 'industry'
        GROUP BY
          selected.candidate_id,
          selected.election_id,
          breakdown.committee_key,
          breakdown.support_oppose,
          breakdown.category_name
      ),
      grouped AS (
        SELECT
          candidate_id,
          election_id,
          support_oppose,
          category_name,
          sum(amount) AS amount,
          CASE
            WHEN count(contributor_count) = 0 THEN NULL
            ELSE sum(contributor_count)
          END AS contributor_count,
          min(source_url) FILTER (WHERE source_url IS NOT NULL) AS source_url
        FROM per_group
        GROUP BY candidate_id, election_id, support_oppose, category_name
      ),
      ranked AS (
        SELECT
          *,
          row_number() OVER (
            PARTITION BY candidate_id, election_id, support_oppose
            ORDER BY amount DESC, category_name ASC
          ) AS rn
        FROM grouped
      )
      SELECT candidate_id, election_id, support_oppose, category_name, amount, contributor_count, source_url
      FROM ranked
      WHERE rn <= 5
      ORDER BY candidate_id, election_id, support_oppose, amount DESC, category_name ASC
    `,
    [JSON.stringify(selectedRequests)]
  );

  const outsideDonorEvidenceResult = await db.query<KentuckyFinanceOutsideDonorEvidenceRow>(
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
      top_industries_per_group AS (
        SELECT
          selected.candidate_id::text AS candidate_id,
          selected.election_id::text AS election_id,
          industry.committee_key AS committee_id,
          industry.category_name AS industry_name,
          max(industry.amount) AS amount
        FROM selected
        JOIN public.ky_candidate_finance_links AS link
          ON link.candidate_id = selected.candidate_id
         AND link.election_id = selected.election_id
         AND link.link_status = 'active'
        JOIN public.ky_candidate_finance_outside_group_breakdowns AS industry
          ON industry.link_id = link.id
         AND industry.election_year = link.election_year
        WHERE industry.support_oppose = 'support'
          AND industry.category_type = 'industry'
        GROUP BY selected.candidate_id, selected.election_id, industry.committee_key, industry.category_name
      ),
      top_industries_grouped AS (
        SELECT
          candidate_id,
          election_id,
          industry_name,
          sum(amount) AS amount
        FROM top_industries_per_group
        GROUP BY candidate_id, election_id, industry_name
      ),
      top_industries AS (
        SELECT candidate_id, election_id, industry_name
        FROM (
          SELECT
            *,
            row_number() OVER (
              PARTITION BY candidate_id, election_id
              ORDER BY amount DESC, industry_name ASC
            ) AS rn
          FROM top_industries_grouped
        ) ranked_industries
        WHERE rn <= 5
      ),
      raw_evidence AS (
        SELECT
          selected.candidate_id::text AS candidate_id,
          selected.election_id::text AS election_id,
          top_industries.industry_name,
          breakdown.committee_key AS committee_id,
          COALESCE(outside_group.committee_name, breakdown.committee_key) AS committee_name,
          breakdown.support_oppose,
          breakdown.category_name AS organization_name,
          breakdown.amount,
          breakdown.contributor_count,
          COALESCE(breakdown.source_url, outside_group.source_url) AS source_url
        FROM selected
        JOIN top_industries
          ON top_industries.candidate_id = selected.candidate_id::text
         AND top_industries.election_id = selected.election_id::text
        JOIN public.ky_candidate_finance_links AS link
          ON link.candidate_id = selected.candidate_id
         AND link.election_id = selected.election_id
         AND link.link_status = 'active'
        JOIN public.ky_candidate_finance_outside_group_breakdowns AS breakdown
          ON breakdown.link_id = link.id
         AND breakdown.election_year = link.election_year
        CROSS JOIN LATERAL (
          SELECT
            public.normalize_finance_label(breakdown.category_name) AS normalized_label
        ) AS normalized_breakdown
        JOIN public.finance_label_classifications AS classification
          ON classification.label_type = 'donor'
         AND classification.normalized_label = normalized_breakdown.normalized_label
         AND classification.industry_slug = top_industries.industry_name
        LEFT JOIN public.ky_candidate_finance_outside_groups AS outside_group
          ON outside_group.link_id = breakdown.link_id
         AND outside_group.election_year = breakdown.election_year
         AND outside_group.committee_key = breakdown.committee_key
         AND outside_group.support_oppose = breakdown.support_oppose
        WHERE breakdown.category_type = 'donor'
          AND breakdown.support_oppose = 'support'
      ),
      deduped_evidence AS (
        SELECT
          candidate_id,
          election_id,
          industry_name,
          committee_id,
          max(committee_name) AS committee_name,
          support_oppose,
          organization_name,
          max(amount) AS amount,
          max(contributor_count) AS contributor_count,
          max(source_url) AS source_url
        FROM raw_evidence
        GROUP BY candidate_id, election_id, industry_name, committee_id, support_oppose, organization_name
      ),
      evidence AS (
        SELECT
          *,
          row_number() OVER (
            PARTITION BY candidate_id, election_id, industry_name
            ORDER BY amount DESC, organization_name ASC, committee_id ASC
          ) AS rn
        FROM deduped_evidence
      )
      SELECT candidate_id, election_id, industry_name, committee_id, committee_name, support_oppose, organization_name, amount, contributor_count, source_url
      FROM evidence
      WHERE rn <= 3
      ORDER BY candidate_id, election_id, industry_name, amount DESC, organization_name ASC
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
      mapFinanceBreakdown(row, summary?.source_url ?? GENERIC_KENTUCKY_KREF_SOURCE_URL)
    );
  }

  const supportingGroupsByCandidateElection = new Map<string, BallotLookupFinanceOutsideGroup[]>();
  const opposingGroupsByCandidateElection = new Map<string, BallotLookupFinanceOutsideGroup[]>();
  const outsideGroupNameByCandidateElectionCommittee = new Map<string, string>();
  for (const row of outsideGroupResult.rows) {
    const key = candidateElectionKey(row.candidate_id, row.election_id);
    const map = row.support_oppose === "support" ? supportingGroupsByCandidateElection : opposingGroupsByCandidateElection;
    const list = map.get(key) ?? [];
    list.push({
      committee_id: row.committee_id,
      committee_name: row.committee_name,
      support_oppose: row.support_oppose,
      amount: parseFinanceAmount(row.amount) ?? 0,
      source_url: firstNonEmptySourceUrl(row.source_url, GENERIC_KENTUCKY_KREF_SOURCE_URL),
    });
    map.set(key, list);
    outsideGroupNameByCandidateElectionCommittee.set(`${key}\u0000${row.committee_id}\u0000${row.support_oppose}`, row.committee_name);
  }

  const supportingIndustriesByCandidateElection = new Map<string, BallotLookupFinanceBreakdown[]>();
  const opposingIndustriesByCandidateElection = new Map<string, BallotLookupFinanceBreakdown[]>();
  for (const row of outsideIndustryResult.rows) {
    const map =
      row.support_oppose === "support" ? supportingIndustriesByCandidateElection : opposingIndustriesByCandidateElection;
    addFinanceBreakdown(
      map,
      row.candidate_id,
      row.election_id,
      mapFinanceBreakdown(row, GENERIC_KENTUCKY_KREF_SOURCE_URL)
    );
  }

  const outsideIndustryEvidenceByCandidateElectionAndIndustry = new Map<
    string,
    BallotLookupFinanceOutsideIndustrySupportEvidence[]
  >();
  for (const row of outsideDonorEvidenceResult.rows) {
    const candidateKey = candidateElectionKey(row.candidate_id, row.election_id);
    const evidenceKey = `${candidateKey}\u0000${row.industry_name}`;
    const list = outsideIndustryEvidenceByCandidateElectionAndIndustry.get(evidenceKey) ?? [];
    list.push({
      organization_name: row.organization_name,
      organization_type: "donor",
      amount: parseFinanceAmount(row.amount) ?? 0,
      contributor_count: parseFinanceCount(row.contributor_count),
      committee_id: row.committee_id,
      committee_name:
        outsideGroupNameByCandidateElectionCommittee.get(`${candidateKey}\u0000${row.committee_id}\u0000${row.support_oppose}`) ??
        row.committee_name,
      source_url: firstNonEmptySourceUrl(row.source_url, GENERIC_KENTUCKY_KREF_SOURCE_URL),
    });
    outsideIndustryEvidenceByCandidateElectionAndIndustry.set(
      evidenceKey,
      list.sort((left, right) => right.amount - left.amount || left.organization_name.localeCompare(right.organization_name)).slice(0, 5)
    );
  }

  return new Map(
    summaryResult.rows.map((row) => {
      const key = candidateElectionKey(row.candidate_id, row.election_id);
      const topDirectDonorOccupations = directOccupationsByCandidateElection.get(key) ?? [];
      const contributionSizeBuckets = contributionSizeBucketsByCandidateElection.get(key) ?? [];
      const topOutsideSupportingIndustries = (supportingIndustriesByCandidateElection.get(key) ?? []).map(
        (industry): BallotLookupFinanceOutsideIndustrySupportSummary => {
          const evidenceKey = `${key}\u0000${industry.category_name}`;
          const supportingOrganizations = outsideIndustryEvidenceByCandidateElectionAndIndustry.get(evidenceKey) ?? [];
          return {
            ...industry,
            explanation: buildOutsideIndustrySupportExplanation(industry.category_name, supportingOrganizations),
            supporting_organizations: supportingOrganizations,
          };
        }
      );
      return [
        key,
        {
          source: "KENTUCKY_KREF",
          cycle: row.election_year,
          fec_candidate_id: null,
          controlled_committee_id: row.committee_id,
          last_synced_at: row.last_synced_at,
          direct_campaign: {
            total_raised: parseFinanceAmount(row.direct_contribution_total) ?? parseFinanceAmount(row.total_receipts),
            total_spent: parseFinanceAmount(row.total_disbursements),
            cash_on_hand: parseFinanceAmount(row.cash_on_hand),
            debts_owed: null,
            top_occupations: topDirectDonorOccupations,
            top_employers: [],
            top_industries: [],
            contribution_size_buckets: contributionSizeBuckets,
          },
          outside_spending: {
            support_total: parseFinanceAmount(row.outside_support_total),
            oppose_total: parseFinanceAmount(row.outside_oppose_total),
            top_supporting_groups: supportingGroupsByCandidateElection.get(key) ?? [],
            top_opposing_groups: opposingGroupsByCandidateElection.get(key) ?? [],
            top_supporting_industries: supportingIndustriesByCandidateElection.get(key) ?? [],
            top_opposing_industries: opposingIndustriesByCandidateElection.get(key) ?? [],
          },
          backing_summary: {
            top_direct_donor_occupations: topDirectDonorOccupations,
            top_outside_supporting_industries: topOutsideSupportingIndustries,
          },
        } satisfies BallotLookupFinanceSummary,
      ];
    })
  );
}

export async function loadKentuckyCandidateFinanceSummariesByCandidateElection(
  db: Queryable,
  candidateRows: readonly KentuckyBallotLookupFinanceCandidateRow[],
  electionRows: readonly KentuckyBallotLookupFinanceElectionRow[]
): Promise<Map<string, BallotLookupFinanceSummary>> {
  if (!isKentuckyCampaignFinanceEnabled()) return new Map();
  const summaries = await loadKentuckyLegacyFinanceSummariesByCandidateElection(db,candidateRows,electionRows);
  return attachKentuckyReportedFinance({db,requests:buildKentuckyFinanceSummaryRequests(candidateRows,electionRows),summaries});
}
