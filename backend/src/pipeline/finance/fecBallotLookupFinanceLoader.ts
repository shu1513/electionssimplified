import type { Pool, PoolClient } from "pg";

import { isCandidateFinanceEnabled } from "../../config/featureFlags.js";
import type { ElectionContestFamily, ElectionDistrictType, ElectionRaceType } from "../../types/election.js";
import { PAC_INTERESTS_NOT_LISTED, pacInterestDisplayName } from "./pacInterestClassifier.js";
import {
  addFinanceBreakdown,
  buildOutsideIndustrySupportExplanation,
  candidateElectionKey,
  electionYear,
  firstNonEmptySourceUrl,
  mapFinanceBreakdown,
  parseFinanceAmount,
  parseFinanceCount,
  type BallotLookupFinanceBreakdown,
  type BallotLookupFinanceConduitDonation,
  type BallotLookupFinanceOutsideGroup,
  type BallotLookupFinanceOutsideIndustrySupportEvidence,
  type BallotLookupFinanceOutsideIndustrySupportSummary,
  type BallotLookupFinancePacInterest,
  type BallotLookupFinanceSummary,
} from "../address/ballotLookupFinanceShared.js";

type Queryable = Pick<Pool | PoolClient, "query">;

// The loader, its office gate, and its request builder moved verbatim from
// ballotLookup.ts (docs/plans/plan-ballot-lookup.md Phase 2). The row aliases keep the
// bodies byte-identical: unlike the state loaders, the FEC loader reads the
// candidate's fec_ids and gates on the election's office identity, so its
// input rows carry more than the shared request shape.
type CandidateRow = {
  candidate_id: string;
  election_id: string;
  fec_ids: unknown;
};
type ElectionRow = {
  election_id: string;
  election_date: string;
  race_type: ElectionRaceType;
  district_type: ElectionDistrictType;
  discovery_contest_family: ElectionContestFamily | null;
  office_canonical_name?: string | null;
};

function parseStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return [
    ...new Set(
      raw
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    ),
  ];
}

const GENERIC_FEC_DATA_SOURCE_URL = "https://www.fec.gov/data/";
const GENERIC_FEC_OUTSIDE_SPENDING_SOURCE_URL = "https://www.fec.gov/data/independent-expenditures/";
// The card shows the largest few conduit groups, each with a researched
// one-line description, so the payload carries no more than that.
const MAX_FEC_CONDUIT_ROWS = 5;
// PACs named under each interest row's expandable detail.
const MAX_PACS_PER_INTEREST = 5;

type CandidateFinanceSummaryRequest = {
  candidate_id: string;
  election_id: string;
  fec_candidate_id: string;
  election_year: number;
};

type CandidateFinanceSummaryRow = {
  candidate_id: string;
  election_id: string;
  fec_candidate_id: string;
  election_year: number;
  total_receipts: string | number | null;
  total_disbursements: string | number | null;
  cash_on_hand: string | number | null;
  debts_owed: string | number | null;
  outside_support_total: string | number | null;
  outside_oppose_total: string | number | null;
  source_url: string | null;
  last_synced_at: string;
  contributors_synced_at: string | null;
};

type CandidateFinanceConduitRow = {
  candidate_id: string;
  election_id: string;
  committee_id: string;
  committee_name: string;
  amount: string | number;
  contribution_count: number;
  source_url: string | null;
};

type CandidateFinancePacInterestRow = {
  candidate_id: string;
  election_id: string;
  interest: string;
  amount: string | number;
  pac_count: number;
  pacs: { committee_id: string; committee_name: string; amount: number; source_url: string | null }[];
};

type CandidateFinanceDirectBreakdownRow = {
  candidate_id: string;
  election_id: string;
  category_type: "occupation" | "employer" | "industry";
  category_name: string;
  amount: string | number;
  contributor_count: number | null;
  source_url: string | null;
};

type CandidateFinanceOutsideGroupRow = {
  candidate_id: string;
  election_id: string;
  committee_id: string;
  committee_name: string;
  support_oppose: "support" | "oppose";
  amount: string | number;
  source_url: string | null;
};

type CandidateFinanceOutsideIndustryRow = {
  candidate_id: string;
  election_id: string;
  support_oppose: "support" | "oppose";
  category_name: string;
  amount: string | number;
  contributor_count: string | number | null;
  source_url: string | null;
};

type CandidateFinanceOutsideIndustryEvidenceRow = {
  candidate_id: string;
  election_id: string;
  industry_name: string;
  organization_name: string;
  organization_type: "employer" | "donor";
  amount: string | number;
  contributor_count: string | number | null;
  committee_id: string;
  committee_name: string;
  source_url: string | null;
};

function normalizeFecCandidateIdForFinance(value: string): string | null {
  const normalized = value.trim().toUpperCase();
  return /^[HPS][0-9A-Z]{8}$/.test(normalized) ? normalized : null;
}

// FEC ids are office-typed (S = Senate, H = House, P = President), stored
// additively on the candidate, and candidate_finance_summaries is keyed
// (fec_candidate_id, election_year) with no election_id — so an id must only
// be requested for an election of its own federal office, or a candidate's
// federal money would attach to an unrelated same-year race (and win the
// merge, since FEC merges last). Mirrors the office gates in
// candidateFinanceBatchSync. US House is identified structurally (us_house
// districts hold nothing else). US Senate shares statewide districts with
// governors, so it needs identity metadata — and the two signals are not
// equally trustworthy: office_canonical_name comes from the curated offices
// table via write-time office matching, while discovery_contest_family is a
// breadcrumb of which search found the election, stored with no
// consistency check against the office. So a resolved office is
// authoritative in both directions (a linked Governor blocks Senate finance
// even if the family wrongly says us_senate), and the family only decides
// when no office is linked. Senate elections with neither signal stay
// fail-closed — no finance beats wrong finance. P ids never match:
// presidential contests live in presidential_cycles, never in district
// elections.
function isFecRequestableElection(row: ElectionRow, fecCandidateId: string): boolean {
  if (row.race_type !== "office") {
    return false;
  }
  if (fecCandidateId.startsWith("H")) {
    return row.district_type === "us_house";
  }
  if (fecCandidateId.startsWith("S")) {
    if (row.district_type !== "statewide") {
      return false;
    }
    const canonicalOffice = row.office_canonical_name?.trim();
    if (canonicalOffice) {
      return canonicalOffice === "United States Senator";
    }
    return row.discovery_contest_family === "us_senate";
  }
  return false;
}

function buildFinanceSummaryRequests(
  candidateRows: readonly CandidateRow[],
  electionRows: readonly ElectionRow[]
): CandidateFinanceSummaryRequest[] {
  const electionById = new Map(electionRows.map((row) => [row.election_id, row]));
  const requests = new Map<string, CandidateFinanceSummaryRequest>();

  for (const row of candidateRows) {
    const election = electionById.get(row.election_id);
    if (!election) {
      continue;
    }
    const year = electionYear(election.election_date);
    if (year === null) {
      continue;
    }
    for (const rawFecId of parseStringArray(row.fec_ids)) {
      const fecCandidateId = normalizeFecCandidateIdForFinance(rawFecId);
      if (!fecCandidateId || !isFecRequestableElection(election, fecCandidateId)) {
        continue;
      }
      const key = `${row.candidate_id}\u0000${row.election_id}\u0000${fecCandidateId}\u0000${year}`;
      requests.set(key, {
        candidate_id: row.candidate_id,
        election_id: row.election_id,
        fec_candidate_id: fecCandidateId,
        election_year: year,
      });
    }
  }

  return [...requests.values()];
}

export async function loadFecCandidateFinanceSummariesByCandidateElection(
  db: Queryable,
  candidateRows: readonly CandidateRow[],
  electionRows: readonly ElectionRow[]
): Promise<Map<string, BallotLookupFinanceSummary>> {
  if (!isCandidateFinanceEnabled()) {
    return new Map();
  }

  const requests = buildFinanceSummaryRequests(candidateRows, electionRows);
  if (requests.length === 0) {
    return new Map();
  }

  const summaryResult = await db.query<CandidateFinanceSummaryRow>(
    `
      WITH requested AS (
        SELECT
          candidate_id::uuid AS candidate_id,
          election_id::uuid AS election_id,
          fec_candidate_id,
          election_year
        FROM jsonb_to_recordset($1::jsonb) AS x(
          candidate_id text,
          election_id text,
          fec_candidate_id text,
          election_year int
        )
      )
      SELECT DISTINCT ON (requested.candidate_id, requested.election_id)
        requested.candidate_id::text AS candidate_id,
        requested.election_id::text AS election_id,
        summary.fec_candidate_id,
        summary.election_year,
        summary.total_receipts,
        summary.total_disbursements,
        summary.cash_on_hand,
        summary.debts_owed,
        summary.outside_support_total,
        summary.outside_oppose_total,
        summary.source_url,
        summary.last_synced_at::text AS last_synced_at,
        summary.contributors_synced_at::text AS contributors_synced_at
      FROM requested
      JOIN public.candidate_finance_summaries AS summary
        ON summary.fec_candidate_id = requested.fec_candidate_id
       AND summary.election_year = requested.election_year
      ORDER BY requested.candidate_id, requested.election_id, summary.last_synced_at DESC, summary.id
    `,
    [JSON.stringify(requests)]
  );

  if (summaryResult.rows.length === 0) {
    return new Map();
  }

  const selectedRequests = summaryResult.rows.map((row) => ({
    candidate_id: row.candidate_id,
    election_id: row.election_id,
    fec_candidate_id: row.fec_candidate_id,
    election_year: row.election_year,
  }));

  const directBreakdownResult = await db.query<CandidateFinanceDirectBreakdownRow>(
    `
      WITH selected AS (
        SELECT
          candidate_id::uuid AS candidate_id,
          election_id::uuid AS election_id,
          fec_candidate_id,
          election_year
        FROM jsonb_to_recordset($1::jsonb) AS x(
          candidate_id text,
          election_id text,
          fec_candidate_id text,
          election_year int
        )
      ),
      ranked AS (
        SELECT
          selected.candidate_id::text AS candidate_id,
          selected.election_id::text AS election_id,
          breakdown.category_type,
          breakdown.category_name,
          breakdown.amount,
          breakdown.contributor_count,
          breakdown.source_url,
          row_number() OVER (
            PARTITION BY selected.candidate_id, selected.election_id, breakdown.category_type
            ORDER BY breakdown.amount DESC, breakdown.category_name ASC
          ) AS rn
        FROM selected
        JOIN public.candidate_finance_direct_breakdowns AS breakdown
          ON breakdown.fec_candidate_id = selected.fec_candidate_id
         AND breakdown.election_year = selected.election_year
        WHERE breakdown.category_type IN ('occupation', 'employer', 'industry')
      )
      SELECT candidate_id, election_id, category_type, category_name, amount, contributor_count, source_url
      FROM ranked
      WHERE rn <= 5
      ORDER BY candidate_id, election_id, category_type, amount DESC, category_name ASC
    `,
    [JSON.stringify(selectedRequests)]
  );

  const outsideGroupResult = await db.query<CandidateFinanceOutsideGroupRow>(
    `
      WITH selected AS (
        SELECT
          candidate_id::uuid AS candidate_id,
          election_id::uuid AS election_id,
          fec_candidate_id,
          election_year
        FROM jsonb_to_recordset($1::jsonb) AS x(
          candidate_id text,
          election_id text,
          fec_candidate_id text,
          election_year int
        )
      ),
      ranked AS (
        SELECT
          selected.candidate_id::text AS candidate_id,
          selected.election_id::text AS election_id,
          outside_group.committee_id,
          outside_group.committee_name,
          outside_group.support_oppose,
          outside_group.amount,
          outside_group.source_url,
          row_number() OVER (
            PARTITION BY selected.candidate_id, selected.election_id, outside_group.support_oppose
            ORDER BY outside_group.amount DESC, outside_group.committee_name ASC
          ) AS rn
        FROM selected
        JOIN public.candidate_finance_outside_groups AS outside_group
          ON outside_group.fec_candidate_id = selected.fec_candidate_id
         AND outside_group.election_year = selected.election_year
      )
      SELECT candidate_id, election_id, committee_id, committee_name, support_oppose, amount, source_url
      FROM ranked
      WHERE rn <= 5
      ORDER BY candidate_id, election_id, support_oppose, amount DESC, committee_name ASC
    `,
    [JSON.stringify(selectedRequests)]
  );

  const outsideIndustryResult = await db.query<CandidateFinanceOutsideIndustryRow>(
    `
      WITH selected AS (
        SELECT
          candidate_id::uuid AS candidate_id,
          election_id::uuid AS election_id,
          fec_candidate_id,
          election_year
        FROM jsonb_to_recordset($1::jsonb) AS x(
          candidate_id text,
          election_id text,
          fec_candidate_id text,
          election_year int
        )
      ),
      grouped AS (
        SELECT
          selected.candidate_id::text AS candidate_id,
          selected.election_id::text AS election_id,
          breakdown.support_oppose,
          breakdown.category_name,
          sum(breakdown.amount) AS amount,
          CASE
            WHEN count(breakdown.contributor_count) = 0 THEN NULL
            ELSE sum(breakdown.contributor_count)
          END AS contributor_count,
          min(breakdown.source_url) FILTER (WHERE breakdown.source_url IS NOT NULL) AS source_url
        FROM selected
        JOIN public.candidate_finance_outside_group_breakdowns AS breakdown
          ON breakdown.fec_candidate_id = selected.fec_candidate_id
         AND breakdown.election_year = selected.election_year
        WHERE breakdown.category_type = 'industry'
        GROUP BY selected.candidate_id, selected.election_id, breakdown.support_oppose, breakdown.category_name
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

  const outsideIndustryEvidenceResult = await db.query<CandidateFinanceOutsideIndustryEvidenceRow>(
    `
      WITH selected AS (
        SELECT
          candidate_id::uuid AS candidate_id,
          election_id::uuid AS election_id,
          fec_candidate_id,
          election_year
        FROM jsonb_to_recordset($1::jsonb) AS x(
          candidate_id text,
          election_id text,
          fec_candidate_id text,
          election_year int
        )
      ),
      top_industries AS (
        SELECT *
        FROM (
          SELECT
            selected.candidate_id::text AS candidate_id,
            selected.election_id::text AS election_id,
            industry.category_name AS industry_name,
            row_number() OVER (
              PARTITION BY selected.candidate_id, selected.election_id
              ORDER BY sum(industry.amount) DESC, industry.category_name ASC
            ) AS rn
          FROM selected
          JOIN public.candidate_finance_outside_group_breakdowns AS industry
            ON industry.fec_candidate_id = selected.fec_candidate_id
           AND industry.election_year = selected.election_year
          WHERE industry.support_oppose = 'support'
            AND industry.category_type = 'industry'
          GROUP BY selected.candidate_id, selected.election_id, industry.category_name
        ) ranked_industries
        WHERE rn <= 5
      ),
      evidence AS (
        SELECT
          selected.candidate_id::text AS candidate_id,
          selected.election_id::text AS election_id,
          top_industries.industry_name,
          breakdown.category_name AS organization_name,
          breakdown.category_type AS organization_type,
          breakdown.amount,
          breakdown.contributor_count,
          breakdown.committee_id,
          COALESCE(outside_group.committee_name, breakdown.committee_id) AS committee_name,
          COALESCE(breakdown.source_url, outside_group.source_url) AS source_url,
          row_number() OVER (
            PARTITION BY selected.candidate_id, selected.election_id, top_industries.industry_name
            ORDER BY breakdown.amount DESC, breakdown.category_name ASC, breakdown.committee_id ASC
          ) AS rn
        FROM selected
        JOIN top_industries
          ON top_industries.candidate_id = selected.candidate_id::text
         AND top_industries.election_id = selected.election_id::text
        JOIN public.candidate_finance_outside_group_breakdowns AS breakdown
          ON breakdown.fec_candidate_id = selected.fec_candidate_id
         AND breakdown.election_year = selected.election_year
         AND breakdown.support_oppose = 'support'
         AND breakdown.category_type IN ('employer', 'donor')
        CROSS JOIN LATERAL (
          SELECT
            public.normalize_finance_label(breakdown.category_name) AS normalized_label
        ) AS normalized_breakdown
        JOIN public.finance_label_classifications AS classification
          ON classification.label_type = breakdown.category_type
         AND classification.normalized_label = normalized_breakdown.normalized_label
         AND classification.industry_slug = top_industries.industry_name
        LEFT JOIN public.candidate_finance_outside_groups AS outside_group
          ON outside_group.fec_candidate_id = breakdown.fec_candidate_id
         AND outside_group.election_year = breakdown.election_year
         AND outside_group.committee_id = breakdown.committee_id
         AND outside_group.support_oppose = breakdown.support_oppose
      )
      SELECT
        candidate_id,
        election_id,
        industry_name,
        organization_name,
        organization_type,
        amount,
        contributor_count,
        committee_id,
        committee_name,
        source_url
      FROM evidence
      WHERE rn <= 3
      ORDER BY candidate_id, election_id, industry_name, amount DESC, organization_name ASC
    `,
    [JSON.stringify(selectedRequests)]
  );

  // Only candidates whose list was loaded are queried, so a page with none
  // pays for no extra round trip.
  const conduitRequests = summaryResult.rows
    .filter((row) => row.contributors_synced_at)
    .map((row) => ({
      candidate_id: row.candidate_id,
      election_id: row.election_id,
      fec_candidate_id: row.fec_candidate_id,
      election_year: row.election_year,
    }));
  const conduitResult =
    conduitRequests.length > 0
      ? await db.query<CandidateFinanceConduitRow>(
          `
            WITH selected AS (
              SELECT
                candidate_id::uuid AS candidate_id,
                election_id::uuid AS election_id,
                fec_candidate_id,
                election_year
              FROM jsonb_to_recordset($1::jsonb) AS x(
                candidate_id text,
                election_id text,
                fec_candidate_id text,
                election_year int
              )
            ),
            ranked AS (
              SELECT
                selected.candidate_id::text AS candidate_id,
                selected.election_id::text AS election_id,
                conduit.committee_id,
                conduit.committee_name,
                conduit.amount,
                conduit.contribution_count,
                conduit.source_url,
                row_number() OVER (
                  PARTITION BY selected.candidate_id, selected.election_id
                  ORDER BY conduit.amount DESC, conduit.committee_name ASC
                ) AS rn
              FROM selected
              JOIN public.candidate_finance_conduit_totals AS conduit
                ON conduit.fec_candidate_id = selected.fec_candidate_id
               AND conduit.election_year = selected.election_year
              WHERE NOT conduit.is_payment_platform
            )
            SELECT candidate_id, election_id, committee_id, committee_name, amount, contribution_count, source_url
            FROM ranked
            WHERE rn <= $2::int
            ORDER BY candidate_id, election_id, amount DESC, committee_name ASC
          `,
          [JSON.stringify(conduitRequests), MAX_FEC_CONDUIT_ROWS]
        )
      : { rows: [] as CandidateFinanceConduitRow[] };

  const pacInterestResult =
    conduitRequests.length > 0
      ? await db.query<CandidateFinancePacInterestRow>(
          `
            WITH selected AS (
              SELECT
                candidate_id::uuid AS candidate_id,
                election_id::uuid AS election_id,
                fec_candidate_id,
                election_year
              FROM jsonb_to_recordset($1::jsonb) AS x(
                candidate_id text,
                election_id text,
                fec_candidate_id text,
                election_year int
              )
            ),
            donors AS (
              SELECT
                selected.candidate_id::text AS candidate_id,
                selected.election_id::text AS election_id,
                interests.interest_slug AS interest,
                donor.committee_id,
                donor.committee_name,
                donor.amount,
                donor.source_url,
                row_number() OVER (
                  PARTITION BY selected.candidate_id, selected.election_id, interests.interest_slug
                  ORDER BY donor.amount DESC, donor.committee_name ASC
                ) AS rn
              FROM selected
              JOIN public.candidate_finance_pac_donors AS donor
                ON donor.fec_candidate_id = selected.fec_candidate_id
               AND donor.election_year = selected.election_year
              JOIN public.finance_pac_interests AS interests
                ON interests.committee_id = donor.committee_id
              WHERE interests.interest_slug IS NOT NULL
                AND interests.interest_slug <> ALL($3::text[])
            )
            SELECT
              candidate_id,
              election_id,
              interest,
              sum(amount) AS amount,
              count(*)::int AS pac_count,
              jsonb_agg(
                jsonb_build_object(
                  'committee_id', committee_id,
                  'committee_name', committee_name,
                  'amount', amount,
                  'source_url', source_url
                ) ORDER BY rn
              ) FILTER (WHERE rn <= $2::int) AS pacs
            FROM donors
            GROUP BY candidate_id, election_id, interest
            ORDER BY candidate_id, election_id, sum(amount) DESC, interest ASC
          `,
          [JSON.stringify(conduitRequests), MAX_PACS_PER_INTEREST, PAC_INTERESTS_NOT_LISTED]
        )
      : { rows: [] as CandidateFinancePacInterestRow[] };

  const pacInterestsByCandidateElection = new Map<string, BallotLookupFinancePacInterest[]>();
  for (const row of pacInterestResult.rows) {
    const key = candidateElectionKey(row.candidate_id, row.election_id);
    const list = pacInterestsByCandidateElection.get(key) ?? [];
    list.push({
      interest: row.interest,
      interest_name: pacInterestDisplayName(row.interest),
      amount: parseFinanceAmount(row.amount) ?? 0,
      pac_count: row.pac_count,
      pacs: (row.pacs ?? []).map((pac) => ({
        committee_id: pac.committee_id,
        committee_name: pac.committee_name,
        amount: parseFinanceAmount(pac.amount) ?? 0,
        source_url: firstNonEmptySourceUrl(pac.source_url, GENERIC_FEC_DATA_SOURCE_URL),
      })),
    });
    pacInterestsByCandidateElection.set(key, list);
  }

  const directOccupationsByCandidateElection = new Map<string, BallotLookupFinanceBreakdown[]>();
  const directEmployersByCandidateElection = new Map<string, BallotLookupFinanceBreakdown[]>();
  const directIndustriesByCandidateElection = new Map<string, BallotLookupFinanceBreakdown[]>();
  const summaryByCandidateElection = new Map(
    summaryResult.rows.map((row) => [candidateElectionKey(row.candidate_id, row.election_id), row])
  );
  for (const row of directBreakdownResult.rows) {
    const summary = summaryByCandidateElection.get(candidateElectionKey(row.candidate_id, row.election_id));
    const mapped = mapFinanceBreakdown(row, summary?.source_url ?? GENERIC_FEC_DATA_SOURCE_URL);
    if (row.category_type === "occupation") {
      addFinanceBreakdown(directOccupationsByCandidateElection, row.candidate_id, row.election_id, mapped);
    } else if (row.category_type === "employer") {
      addFinanceBreakdown(directEmployersByCandidateElection, row.candidate_id, row.election_id, mapped);
    } else {
      addFinanceBreakdown(directIndustriesByCandidateElection, row.candidate_id, row.election_id, mapped);
    }
  }

  const conduitsByCandidateElection = new Map<string, BallotLookupFinanceConduitDonation[]>();
  for (const row of conduitResult.rows) {
    const key = candidateElectionKey(row.candidate_id, row.election_id);
    const list = conduitsByCandidateElection.get(key) ?? [];
    list.push({
      committee_id: row.committee_id,
      committee_name: row.committee_name,
      amount: parseFinanceAmount(row.amount) ?? 0,
      contribution_count: row.contribution_count,
      source_url: firstNonEmptySourceUrl(row.source_url, GENERIC_FEC_DATA_SOURCE_URL),
    });
    conduitsByCandidateElection.set(key, list);
  }

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
      source_url: firstNonEmptySourceUrl(row.source_url, GENERIC_FEC_OUTSIDE_SPENDING_SOURCE_URL),
    });
    map.set(key, list);
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
      mapFinanceBreakdown(row, GENERIC_FEC_OUTSIDE_SPENDING_SOURCE_URL)
    );
  }

  const outsideIndustryEvidenceByCandidateElectionAndIndustry = new Map<
    string,
    BallotLookupFinanceOutsideIndustrySupportEvidence[]
  >();
  for (const row of outsideIndustryEvidenceResult.rows) {
    const key = `${candidateElectionKey(row.candidate_id, row.election_id)}\u0000${row.industry_name}`;
    const list = outsideIndustryEvidenceByCandidateElectionAndIndustry.get(key) ?? [];
    list.push({
      organization_name: row.organization_name,
      organization_type: row.organization_type,
      amount: parseFinanceAmount(row.amount) ?? 0,
      contributor_count: parseFinanceCount(row.contributor_count),
      committee_id: row.committee_id,
      committee_name: row.committee_name,
      source_url: firstNonEmptySourceUrl(row.source_url, GENERIC_FEC_OUTSIDE_SPENDING_SOURCE_URL),
    });
    outsideIndustryEvidenceByCandidateElectionAndIndustry.set(key, list);
  }

  return new Map(
    summaryResult.rows.map((row) => {
      const key = candidateElectionKey(row.candidate_id, row.election_id);
      const topDirectDonorOccupations = directOccupationsByCandidateElection.get(key) ?? [];
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
          source: "FEC",
          cycle: row.election_year,
          fec_candidate_id: row.fec_candidate_id,
          last_synced_at: row.last_synced_at,
          direct_campaign: {
            total_raised: parseFinanceAmount(row.total_receipts),
            total_spent: parseFinanceAmount(row.total_disbursements),
            cash_on_hand: parseFinanceAmount(row.cash_on_hand),
            debts_owed: parseFinanceAmount(row.debts_owed),
            top_occupations: topDirectDonorOccupations,
            top_employers: directEmployersByCandidateElection.get(key) ?? [],
            top_industries: directIndustriesByCandidateElection.get(key) ?? [],
            // Present only once the list was loaded, so an empty list
            // means "none reported", never "not loaded yet".
            ...(row.contributors_synced_at
              ? {
                  conduit_donations: conduitsByCandidateElection.get(key) ?? [],
                  pac_money_by_interest: pacInterestsByCandidateElection.get(key) ?? [],
                }
              : {}),
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
