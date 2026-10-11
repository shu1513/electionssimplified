import type { Pool, PoolClient } from "pg";

import { isConnecticutCampaignFinanceEnabled } from "../../config/featureFlags.js";
import {
  addFinanceBreakdown,
  buildStateFinanceSummaryRequests,
  candidateElectionKey,
  firstNonEmptySourceUrl,
  mapFinanceBreakdown,
  parseFinanceAmount,
  type BallotLookupFinanceBreakdown,
  type BallotLookupFinanceOutsideGroup,
  type BallotLookupFinancePacInterest,
  type BallotLookupFinanceSummary,
  type StateFinanceRequestCandidateRow,
  type StateFinanceRequestElectionRow,
} from "../address/ballotLookupFinanceShared.js";

import {
  PAC_INTERESTS_NOT_LISTED,
  UNCLASSIFIED_PAC_INTEREST,
  classifyPacInterest,
  pacInterestDisplayName,
} from "../finance/pacInterestClassifier.js";

type Queryable = Pick<Pool | PoolClient, "query">;

// The loader body below moved verbatim from ballotLookup.ts
// (docs/plans/plan-ballot-lookup.md Phase 2); these aliases keep its signature and row
// references byte-identical while the shapes live in the shared module.
type CandidateRow = StateFinanceRequestCandidateRow;
type ElectionRow = StateFinanceRequestElectionRow;

const GENERIC_CONNECTICUT_ECRIS_SOURCE_URL = "https://seec.ct.gov/portal/ecris/CurPreYears";
const CONNECTICUT_ECRIS_INDEPENDENT_EXPENDITURE_SEARCH_URL =
  "https://seec.ct.gov/eCrisReporting/SearchingIndependentExpenditure.aspx";
// See connecticutOutsideSpendingAggregator.ts for why each of these is out.
const CONNECTICUT_OUTSIDE_COVERAGE_NOTE =
  "Connecticut totals count independent expenditures that SEEC Form 40 filers reported as paid and tied to this one candidate; expenditures not yet paid, lines naming several candidates at once, and spending reported on other SEEC forms (party and PAC statements, and reports by spenders that are not committees) are not included.";

type ConnecticutFinanceSummaryRow = {
  candidate_id: string;
  election_id: string;
  committee_id: string | null;
  election_year: number;
  total_receipts: string | number | null;
  total_disbursements: string | number | null;
  outside_support_total: string | number | null;
  outside_oppose_total: string | number | null;
  source_url: string | null;
  last_synced_at: string;
};

type ConnecticutFinanceOutsideGroupRow = {
  candidate_id: string;
  election_id: string;
  committee_id: string;
  committee_name: string;
  support_oppose: "support" | "oppose";
  amount: string | number;
  source_url: string | null;
};

type ConnecticutFinanceDirectBreakdownRow = {
  candidate_id: string;
  election_id: string;
  category_type: "occupation" | "employer" | "industry" | "contribution_size";
  category_name: string;
  amount: string | number;
  contributor_count: string | number | null;
  source_url: string | null;
};

type ConnecticutFinancePacDonorRow = {
  candidate_id: string;
  election_id: string;
  committee_id: string;
  committee_name: string;
  committee_type: string | null;
  amount: string | number;
  source_url: string | null;
};
const MAX_PAC_INTEREST_ROWS = 5;
const MAX_PACS_PER_INTEREST = 5;

function groupConnecticutPacDonorsByInterest(
  rows: readonly ConnecticutFinancePacDonorRow[]
): Map<string, BallotLookupFinancePacInterest[]> {
  const byCandidateElection = new Map<string, Map<string, BallotLookupFinancePacInterest>>();
  for (const row of rows) {
    const type = row.committee_type?.trim().toLowerCase();
    if (["candidate committee", "exploratory committee", "ambiguous committee"].includes(type ?? "")) continue;
    const name = row.committee_name.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
    const registeredPac = ["political committee", "political action committee", "party committee"].includes(type ?? "");
    // C1 can contain a business reported in the committee section. Its
    // corporate suffix alone cannot make it a PAC (e.g. Shore Winds, LLC).
    if (!registeredPac && !/\b(PAC|POLITICAL)\b/.test(name) &&
        /\b(LLC|L L C|INC|INCORPORATED|CORPORATION|CORP|LTD|LIMITED)$/.test(name)) continue;
    const interest = classifyPacInterest({
      committeeName: row.committee_name, committeeType: null, designation: null,
      organizationType: null, connectedOrganization: null,
    }).interestSlug ?? UNCLASSIFIED_PAC_INTEREST;
    if ((PAC_INTERESTS_NOT_LISTED as readonly string[]).includes(interest)) {
      continue;
    }
    const key = candidateElectionKey(row.candidate_id, row.election_id);
    const interests = byCandidateElection.get(key) ?? new Map<string, BallotLookupFinancePacInterest>();
    const entry = interests.get(interest) ?? {
      interest,
      interest_name: pacInterestDisplayName(interest),
      amount: 0,
      pac_count: 0,
      pacs: [],
    };
    const amount = parseFinanceAmount(row.amount) ?? 0;
    entry.amount = Math.round((entry.amount + amount) * 100) / 100;
    entry.pac_count += 1;
    if (entry.pacs.length < MAX_PACS_PER_INTEREST) {
      entry.pacs.push({
        committee_id: row.committee_id,
        committee_name: row.committee_name,
        amount,
        source_url: firstNonEmptySourceUrl(row.source_url, GENERIC_CONNECTICUT_ECRIS_SOURCE_URL),
      });
    }
    interests.set(interest, entry);
    byCandidateElection.set(key, interests);
  }
  return new Map(
    [...byCandidateElection.entries()].map(([key, interests]) => [
      key,
      [...interests.values()]
        .sort((left, right) => right.amount - left.amount || left.interest.localeCompare(right.interest))
        .slice(0, MAX_PAC_INTEREST_ROWS),
    ])
  );
}

export async function loadConnecticutCandidateFinanceSummariesByCandidateElection(
  db: Queryable,
  candidateRows: readonly CandidateRow[],
  electionRows: readonly ElectionRow[]
): Promise<Map<string, BallotLookupFinanceSummary>> {
  if (!isConnecticutCampaignFinanceEnabled()) {
    return new Map();
  }

  const requests = buildStateFinanceSummaryRequests("CT", candidateRows, electionRows);
  if (requests.length === 0) {
    return new Map();
  }

  const summaryResult = await db.query<ConnecticutFinanceSummaryRow>(
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
        CASE WHEN count(summary.total_disbursements) = 0 THEN NULL ELSE sum(summary.total_disbursements) END AS total_disbursements,
        max(summary.outside_support_total) AS outside_support_total,
        max(summary.outside_oppose_total) AS outside_oppose_total,
        min(summary.source_url) FILTER (WHERE summary.source_url IS NOT NULL) AS source_url,
        max(summary.last_synced_at)::text AS last_synced_at
      FROM requested
      JOIN public.ct_candidate_finance_links AS link
        ON link.candidate_id = requested.candidate_id
       AND link.election_id = requested.election_id
       AND link.link_status = 'active'
      JOIN public.ct_candidate_finance_summaries AS summary
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

  const directBreakdownResult = await db.query<ConnecticutFinanceDirectBreakdownRow>(
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
        JOIN public.ct_candidate_finance_links AS link
          ON link.candidate_id = selected.candidate_id
         AND link.election_id = selected.election_id
         AND link.link_status = 'active'
        JOIN public.ct_candidate_finance_direct_breakdowns AS breakdown
          ON breakdown.link_id = link.id
         AND breakdown.election_year = link.election_year
        WHERE breakdown.category_type IN ('occupation', 'industry')
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

  // Outside groups are stored once per committee and stance per link; a
  // candidate with several active links repeats the same candidate-level
  // group, hence max() rather than sum() (the standard loader's rule).
  const outsideGroupResult = await db.query<ConnecticutFinanceOutsideGroupRow>(
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
          outside_group.committee_id,
          min(outside_group.committee_name) AS committee_name,
          outside_group.support_oppose,
          max(outside_group.amount) AS amount,
          min(outside_group.source_url) FILTER (WHERE outside_group.source_url IS NOT NULL) AS source_url
        FROM selected
        JOIN public.ct_candidate_finance_links AS link
          ON link.candidate_id = selected.candidate_id
         AND link.election_id = selected.election_id
         AND link.link_status = 'active'
        JOIN public.ct_candidate_finance_outside_groups AS outside_group
          ON outside_group.link_id = link.id
         AND outside_group.election_year = link.election_year
        GROUP BY selected.candidate_id, selected.election_id, outside_group.committee_id, outside_group.support_oppose
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

  const pacDonorResult = await db.query<ConnecticutFinancePacDonorRow>(
    `
      WITH selected AS (
        SELECT candidate_id::uuid AS candidate_id, election_id::uuid AS election_id
        FROM jsonb_to_recordset($1::jsonb) AS x(candidate_id text, election_id text)
      )
      SELECT selected.candidate_id::text AS candidate_id, selected.election_id::text AS election_id,
        donor.committee_id, min(donor.committee_name) AS committee_name,
        CASE WHEN bool_or(lower(donor.committee_type) IN
          ('candidate committee', 'exploratory committee', 'ambiguous committee'))
          THEN 'Candidate Committee' ELSE min(donor.committee_type) END AS committee_type,
        sum(donor.amount) AS amount,
        min(donor.source_url) FILTER (WHERE donor.source_url IS NOT NULL) AS source_url
      FROM selected
      JOIN public.ct_candidate_finance_links AS link
        ON link.candidate_id = selected.candidate_id AND link.election_id = selected.election_id
       AND link.link_status = 'active'
      JOIN public.ct_candidate_finance_pac_donors AS donor
        ON donor.link_id = link.id AND donor.election_year = link.election_year
      GROUP BY selected.candidate_id, selected.election_id, donor.committee_id
      ORDER BY candidate_id, election_id, amount DESC, committee_name ASC
    `,
    [JSON.stringify(selectedRequests)]
  );
  const pacInterests = groupConnecticutPacDonorsByInterest(pacDonorResult.rows);

  const directOccupationsByCandidateElection = new Map<string, BallotLookupFinanceBreakdown[]>();
  const directIndustriesByCandidateElection = new Map<string, BallotLookupFinanceBreakdown[]>();
  const summaryByCandidateElection = new Map(
    summaryResult.rows.map((row) => [candidateElectionKey(row.candidate_id, row.election_id), row])
  );
  const supportingGroupsByCandidateElection = new Map<string, BallotLookupFinanceOutsideGroup[]>();
  const opposingGroupsByCandidateElection = new Map<string, BallotLookupFinanceOutsideGroup[]>();
  for (const row of outsideGroupResult.rows) {
    const key = candidateElectionKey(row.candidate_id, row.election_id);
    const map = row.support_oppose === "support" ? supportingGroupsByCandidateElection : opposingGroupsByCandidateElection;
    const list = map.get(key) ?? [];
    list.push({
      committee_id: row.committee_id,
      committee_name: row.committee_name,
      support_oppose: row.support_oppose,
      amount: parseFinanceAmount(row.amount) ?? 0,
      source_url: firstNonEmptySourceUrl(row.source_url, CONNECTICUT_ECRIS_INDEPENDENT_EXPENDITURE_SEARCH_URL),
    });
    map.set(key, list);
  }
  for (const row of directBreakdownResult.rows) {
    const summary = summaryByCandidateElection.get(candidateElectionKey(row.candidate_id, row.election_id));
    const mapped = mapFinanceBreakdown(row, summary?.source_url ?? GENERIC_CONNECTICUT_ECRIS_SOURCE_URL);
    if (row.category_type === "occupation") {
      addFinanceBreakdown(directOccupationsByCandidateElection, row.candidate_id, row.election_id, mapped);
    } else if (row.category_type === "industry") {
      addFinanceBreakdown(directIndustriesByCandidateElection, row.candidate_id, row.election_id, mapped);
    }
  }

  return new Map(
    summaryResult.rows.map((row) => {
      const key = candidateElectionKey(row.candidate_id, row.election_id);
      const topDirectDonorOccupations = directOccupationsByCandidateElection.get(key) ?? [];
      return [
        key,
        {
          source: "CONNECTICUT_ECRIS",
          cycle: row.election_year,
          fec_candidate_id: null,
          controlled_committee_id: row.committee_id,
          last_synced_at: row.last_synced_at,
          direct_campaign: {
            total_raised: parseFinanceAmount(row.total_receipts),
            total_spent: parseFinanceAmount(row.total_disbursements),
            cash_on_hand: null,
            debts_owed: null,
            top_occupations: topDirectDonorOccupations,
            top_employers: [],
            top_industries: directIndustriesByCandidateElection.get(key) ?? [],
            ...(pacInterests.get(key)?.length ? { pac_money_by_interest: pacInterests.get(key) } : {}),
          },
          outside_spending: {
            support_total: parseFinanceAmount(row.outside_support_total),
            oppose_total: parseFinanceAmount(row.outside_oppose_total),
            outside_coverage_note: CONNECTICUT_OUTSIDE_COVERAGE_NOTE,
            top_supporting_groups: supportingGroupsByCandidateElection.get(key) ?? [],
            top_opposing_groups: opposingGroupsByCandidateElection.get(key) ?? [],
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
