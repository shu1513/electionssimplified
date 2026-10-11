import type { Pool, PoolClient } from "pg";

import { isTennesseeCampaignFinanceEnabled } from "../../config/featureFlags.js";
import {
  addFinanceBreakdown,
  buildOutsideIndustrySupportExplanation,
  buildStateFinanceSummaryRequests,
  candidateElectionKey,
  firstNonEmptySourceUrl,
  mapFinanceBreakdown,
  parseFinanceAmount,
  parseFinanceCount,
  type BallotLookupFinanceBreakdown,
  type BallotLookupFinanceOutsideGroup,
  type BallotLookupFinanceOutsideIndustrySupportEvidence,
  type BallotLookupFinanceOutsideIndustrySupportSummary,
  type BallotLookupFinanceSummary,
  type BallotLookupFinancePacInterest,
  type StateFinanceOutsideDonorEvidenceRow,
  type StateFinanceOutsideGroupRow,
  type StateFinanceOutsideIndustryRow,
  type StateFinanceDirectBreakdownRow,
  type StateFinanceRequestCandidateRow,
  type StateFinanceRequestElectionRow,
} from "../address/ballotLookupFinanceShared.js";
import { classifyFinanceLabel } from "../finance/financeLabelClassifier.js";
import { PAC_INTERESTS_NOT_LISTED, pacInterestDisplayName, UNCLASSIFIED_PAC_INTEREST } from "../finance/pacInterestClassifier.js";

const TENNESSEE_BALLOT_FINANCE_ELIGIBLE_OFFICES = new Set([
  "statewide::Governor",
  "state_upper::State Senator",
  "state_lower::State Lower Chamber Legislator",
]);

type Queryable = Pick<Pool | PoolClient, "query">;

// The loader body below moved verbatim from ballotLookup.ts
// (docs/plans/plan-ballot-lookup.md Phase 2); these aliases keep its signature and row
// references byte-identical while the shapes live in the shared module.
type CandidateRow = StateFinanceRequestCandidateRow;
type ElectionRow = StateFinanceRequestElectionRow;
type TennesseeFinanceDirectBreakdownRow = StateFinanceDirectBreakdownRow;
type TennesseeFinanceOutsideGroupRow = StateFinanceOutsideGroupRow;
type TennesseeFinanceOutsideIndustryRow = StateFinanceOutsideIndustryRow;
type TennesseeFinanceOutsideDonorEvidenceRow = StateFinanceOutsideDonorEvidenceRow;
const GENERIC_TENNESSEE_CAMP_SOURCE_URL = "https://apps.tn.gov/tncamp/public/cesearch.htm";

type TennesseeFinanceSummaryRow = {
  candidate_id: string;
  election_id: string;
  committee_id: string | null;
  election_year: number;
  total_receipts: string | number | null;
  direct_contribution_total: string | number | null;
  outside_support_total: string | number | null;
  outside_oppose_total: string | number | null;
  source_url: string | null;
  last_synced_at: string;
};

type TennesseeFinancePacDonorRow = {
  candidate_id: string;
  election_id: string;
  committee_id: string;
  committee_name: string;
  committee_type: string;
  amount: string | number;
  source_url: string | null;
  industry_slug: string | null;
  classification_source: string | null;
  confidence: string | null;
};

function groupTennesseePacDonors(rows: readonly TennesseeFinancePacDonorRow[]): Map<string, BallotLookupFinancePacInterest[]> {
  const grouped = new Map<string, Map<string, BallotLookupFinancePacInterest>>();
  for (const row of rows) {
    if (row.committee_type !== "Political Action Committee") continue;
    const amount = parseFinanceAmount(row.amount);
    if (amount === null || amount <= 0) continue;
    const classification = classifyFinanceLabel({ rawLabel: row.committee_name, labelType: "committee" });
    const stored = row.industry_slug && (row.classification_source === "manual"
      || (row.confidence === "high" && ["rule", "ai"].includes(row.classification_source ?? ""))) ? row.industry_slug : null;
    const rule = classification.classificationSource === "rule" && classification.confidence === "high"
      ? classification.industrySlug : null;
    const interest = stored ?? rule ?? UNCLASSIFIED_PAC_INTEREST;
    if ((PAC_INTERESTS_NOT_LISTED as readonly string[]).includes(interest)) continue;
    const key = candidateElectionKey(row.candidate_id, row.election_id);
    const interests = grouped.get(key) ?? new Map<string, BallotLookupFinancePacInterest>();
    const group = interests.get(interest) ?? { interest, interest_name: pacInterestDisplayName(interest),
      amount: 0, pac_count: 0, pacs: [] };
    group.amount = Math.round((group.amount + amount) * 100) / 100;
    group.pac_count += 1;
    group.pacs.push({ committee_id: row.committee_id, committee_name: row.committee_name,
      amount, source_url: firstNonEmptySourceUrl(row.source_url, GENERIC_TENNESSEE_CAMP_SOURCE_URL) });
    interests.set(interest, group); grouped.set(key, interests);
  }
  return new Map([...grouped].map(([key, interests]) => [key, [...interests.values()]
    .map(group => ({ ...group, pacs: group.pacs.sort((a, b) => b.amount - a.amount || a.committee_name.localeCompare(b.committee_name)).slice(0, 5) }))
    .sort((a, b) => b.amount - a.amount || a.interest.localeCompare(b.interest)).slice(0, 5)]));
}

export async function loadTennesseeCandidateFinanceSummariesByCandidateElection(
  db: Queryable,
  candidateRows: readonly CandidateRow[],
  electionRows: readonly ElectionRow[]
): Promise<Map<string, BallotLookupFinanceSummary>> {
  if (!isTennesseeCampaignFinanceEnabled()) {
    return new Map();
  }

  const requests = buildStateFinanceSummaryRequests("TN", candidateRows, electionRows, (row) =>
    TENNESSEE_BALLOT_FINANCE_ELIGIBLE_OFFICES.has(`${row.office_scope?.trim() ?? ""}::${row.office_canonical_name?.trim() ?? ""}`)
  );
  if (requests.length === 0) {
    return new Map();
  }

  const summaryResult = await db.query<TennesseeFinanceSummaryRow>(
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
          WHEN count(DISTINCT link.camp_candidate_id) = 1 THEN min(link.camp_candidate_id)
          ELSE NULL
        END AS committee_id,
        max(summary.election_year) AS election_year,
        CASE WHEN count(summary.total_receipts) = 0 THEN NULL ELSE sum(summary.total_receipts) END AS total_receipts,
        CASE
          WHEN count(summary.direct_contribution_total) = 0 THEN NULL
          ELSE sum(summary.direct_contribution_total)
        END AS direct_contribution_total,
        CASE
          WHEN count(summary.outside_support_total) = 0 THEN NULL
          ELSE sum(summary.outside_support_total)
        END AS outside_support_total,
        CASE
          WHEN count(summary.outside_oppose_total) = 0 THEN NULL
          ELSE sum(summary.outside_oppose_total)
        END AS outside_oppose_total,
        min(summary.source_url) FILTER (WHERE summary.source_url IS NOT NULL) AS source_url,
        max(summary.last_synced_at)::text AS last_synced_at
      FROM requested
      JOIN public.tn_candidate_finance_links AS link
        ON link.candidate_id = requested.candidate_id
       AND link.election_id = requested.election_id
       AND link.link_status = 'active'
      JOIN public.tn_candidate_finance_summaries AS summary
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

  const directBreakdownResult = await db.query<TennesseeFinanceDirectBreakdownRow>(
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
        JOIN public.tn_candidate_finance_links AS link
          ON link.candidate_id = selected.candidate_id
         AND link.election_id = selected.election_id
         AND link.link_status = 'active'
        JOIN public.tn_candidate_finance_direct_breakdowns AS breakdown
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

  const outsideGroupResult = await db.query<TennesseeFinanceOutsideGroupRow>(
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
          CASE
            WHEN count(outside_group.expenditure_count) = 0 THEN NULL
            ELSE max(outside_group.expenditure_count)
          END AS expenditure_count,
          min(outside_group.source_url) FILTER (WHERE outside_group.source_url IS NOT NULL) AS source_url
        FROM selected
        JOIN public.tn_candidate_finance_links AS link
          ON link.candidate_id = selected.candidate_id
         AND link.election_id = selected.election_id
         AND link.link_status = 'active'
        JOIN public.tn_candidate_finance_outside_groups AS outside_group
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
      SELECT candidate_id, election_id, committee_id, committee_name, support_oppose, amount, expenditure_count, source_url
      FROM ranked
      WHERE rn <= 5
      ORDER BY candidate_id, election_id, support_oppose, amount DESC, committee_name ASC
    `,
    [JSON.stringify(selectedRequests)]
  );

  const outsideIndustryResult = await db.query<TennesseeFinanceOutsideIndustryRow>(
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
        JOIN public.tn_candidate_finance_links AS link
          ON link.candidate_id = selected.candidate_id
         AND link.election_id = selected.election_id
         AND link.link_status = 'active'
        JOIN public.tn_candidate_finance_outside_group_breakdowns AS breakdown
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

  const outsideDonorEvidenceResult = await db.query<TennesseeFinanceOutsideDonorEvidenceRow>(
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
        JOIN public.tn_candidate_finance_links AS link
          ON link.candidate_id = selected.candidate_id
         AND link.election_id = selected.election_id
         AND link.link_status = 'active'
        JOIN public.tn_candidate_finance_outside_group_breakdowns AS industry
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
      evidence AS (
        SELECT
          selected.candidate_id::text AS candidate_id,
          selected.election_id::text AS election_id,
          top_industries.industry_name,
          breakdown.committee_key AS committee_id,
          COALESCE(outside_group.committee_name, breakdown.committee_key) AS committee_name,
          breakdown.support_oppose,
          breakdown.category_name AS organization_name,
          breakdown.category_type AS organization_type,
          breakdown.amount,
          breakdown.contributor_count,
          COALESCE(breakdown.source_url, outside_group.source_url) AS source_url,
          row_number() OVER (
            PARTITION BY selected.candidate_id, selected.election_id, top_industries.industry_name
            ORDER BY breakdown.amount DESC, breakdown.category_name ASC, breakdown.committee_key ASC
          ) AS rn
        FROM selected
        JOIN top_industries
          ON top_industries.candidate_id = selected.candidate_id::text
         AND top_industries.election_id = selected.election_id::text
        JOIN public.tn_candidate_finance_links AS link
          ON link.candidate_id = selected.candidate_id
         AND link.election_id = selected.election_id
         AND link.link_status = 'active'
        JOIN public.tn_candidate_finance_outside_group_breakdowns AS breakdown
          ON breakdown.link_id = link.id
         AND breakdown.election_year = link.election_year
        CROSS JOIN LATERAL (
          SELECT
            public.normalize_finance_label(breakdown.category_name) AS normalized_label
        ) AS normalized_breakdown
        JOIN public.finance_label_classifications AS classification
          ON classification.label_type = breakdown.category_type
         AND classification.normalized_label = normalized_breakdown.normalized_label
         AND classification.industry_slug = top_industries.industry_name
        LEFT JOIN public.tn_candidate_finance_outside_groups AS outside_group
          ON outside_group.link_id = breakdown.link_id
         AND outside_group.election_year = breakdown.election_year
         AND outside_group.committee_key = breakdown.committee_key
         AND outside_group.support_oppose = breakdown.support_oppose
        WHERE breakdown.category_type IN ('donor', 'employer')
          AND breakdown.support_oppose = 'support'
      )
      SELECT candidate_id, election_id, industry_name, committee_id, committee_name, support_oppose, organization_name, organization_type, amount, contributor_count, source_url
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
      mapFinanceBreakdown(row, summary?.source_url ?? GENERIC_TENNESSEE_CAMP_SOURCE_URL)
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
      expenditure_count: parseFinanceCount(row.expenditure_count ?? null),
      source_url: firstNonEmptySourceUrl(row.source_url, GENERIC_TENNESSEE_CAMP_SOURCE_URL),
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
      mapFinanceBreakdown(row, GENERIC_TENNESSEE_CAMP_SOURCE_URL)
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
      organization_type: row.organization_type ?? "donor",
      amount: parseFinanceAmount(row.amount) ?? 0,
      contributor_count: parseFinanceCount(row.contributor_count),
      committee_id: row.committee_id,
      committee_name:
        outsideGroupNameByCandidateElectionCommittee.get(`${candidateKey}\u0000${row.committee_id}\u0000${row.support_oppose}`) ??
        row.committee_name,
      source_url: firstNonEmptySourceUrl(row.source_url, GENERIC_TENNESSEE_CAMP_SOURCE_URL),
    });
    outsideIndustryEvidenceByCandidateElectionAndIndustry.set(
      evidenceKey,
      list.sort((left, right) => right.amount - left.amount || left.organization_name.localeCompare(right.organization_name)).slice(0, 5)
    );
  }

  const pacDonorResult = await db.query<TennesseeFinancePacDonorRow>(`
    WITH selected AS (
      SELECT candidate_id::uuid AS candidate_id,election_id::uuid AS election_id
      FROM jsonb_to_recordset($1::jsonb) AS x(candidate_id text,election_id text)
    ), grouped AS (
      SELECT selected.candidate_id::text AS candidate_id,selected.election_id::text AS election_id,
        donor.committee_id,min(donor.committee_name) AS committee_name,min(donor.committee_type) AS committee_type,
        sum(donor.amount) AS amount,min(donor.source_url) AS source_url
      FROM selected JOIN public.tn_candidate_finance_links link
        ON link.candidate_id=selected.candidate_id AND link.election_id=selected.election_id AND link.link_status='active'
      JOIN public.tn_candidate_finance_pac_donors donor ON donor.link_id=link.id AND donor.election_year=link.election_year
      WHERE donor.committee_type='Political Action Committee'
      GROUP BY selected.candidate_id,selected.election_id,donor.committee_id
    ) SELECT grouped.*,classification.industry_slug,classification.classification_source,classification.confidence
      FROM grouped LEFT JOIN public.finance_label_classifications classification
        ON classification.label_type='committee'
        AND classification.normalized_label=public.normalize_finance_label(grouped.committee_name)
      ORDER BY grouped.candidate_id,grouped.election_id,grouped.amount DESC,grouped.committee_name`,
  [JSON.stringify(selectedRequests)]);
  const pacInterests = groupTennesseePacDonors(pacDonorResult.rows);

  return new Map(
    summaryResult.rows.map((row) => {
      const key = candidateElectionKey(row.candidate_id, row.election_id);
      const topDirectDonorOccupations = directOccupationsByCandidateElection.get(key) ?? [];
      const pacMoney = pacInterests.get(key);
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
          source: "TENNESSEE_CAMP",
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
            ...(pacMoney?.length ? { pac_money_by_interest: pacMoney } : {}),
            direct_coverage_note: "PAC cash receipts are a subset of Raised. PAC counts represent source-reported donor groups; name aliases may split a legal PAC and identical reported names may combine legal PACs.",
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
