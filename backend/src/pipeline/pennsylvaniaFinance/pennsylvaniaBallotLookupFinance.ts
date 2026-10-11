import type { Pool, PoolClient } from "pg";

import { isPennsylvaniaCampaignFinanceEnabled } from "../../config/featureFlags.js";
import type {
  BallotLookupFinanceBreakdown,
  BallotLookupFinanceOutsideGroup,
  BallotLookupFinanceOutsideIndustrySupportEvidence,
  BallotLookupFinanceOutsideIndustrySupportSummary,
  BallotLookupFinancePacInterest,
  BallotLookupFinanceSummary,
} from "../address/ballotLookupFinanceShared.js";
import { buildOutsideIndustrySupportExplanation } from "../address/ballotLookupFinanceShared.js";
import {
  PAC_INTERESTS_NOT_LISTED,
  UNCLASSIFIED_PAC_INTEREST,
  classifyPacInterest,
  pacInterestDisplayName,
} from "../finance/pacInterestClassifier.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type PennsylvaniaBallotLookupCandidateRow = {
  candidate_id: string;
  election_id: string;
};

export type PennsylvaniaBallotLookupElectionRow = {
  election_id: string;
  state: string;
};

type PennsylvaniaFinanceSummaryRequest = {
  candidate_id: string;
  election_id: string;
};

type PennsylvaniaFinanceSummaryRow = {
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

type PennsylvaniaFinanceDirectBreakdownRow = {
  candidate_id: string;
  election_id: string;
  category_type: "occupation" | "contribution_size";
  category_name: string;
  amount: string | number;
  contributor_count: string | number | null;
  source_url: string | null;
};

type PennsylvaniaFinanceOutsideGroupRow = {
  candidate_id: string;
  election_id: string;
  committee_id: string;
  committee_name: string;
  support_oppose: "support" | "oppose";
  amount: string | number;
  source_url: string | null;
};

type PennsylvaniaFinanceOutsideIndustryRow = {
  candidate_id: string;
  election_id: string;
  support_oppose: "support" | "oppose";
  category_name: string;
  amount: string | number;
  contributor_count: string | number | null;
  source_url: string | null;
};

type PennsylvaniaFinanceOutsideDonorEvidenceRow = {
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

type PennsylvaniaFinancePacDonorRow = {
  candidate_id: string;
  election_id: string;
  committee_id: string;
  committee_name: string;
  amount: string | number;
  source_url: string | null;
};

const GENERIC_PENNSYLVANIA_DOS_SOURCE_URL =
  "https://www.pa.gov/agencies/dos/resources/voting-and-elections-resources/campaign-finance-data";
// Same display caps as the federal card.
const MAX_PAC_INTEREST_ROWS = 5;
const MAX_PACS_PER_INTEREST = 5;

// Pennsylvania candidate committees are named "Friends of <name>",
// "Committee to Elect <name>", "Citizens for <name>" or "<name> for <office>"
// (a 2026 sample of 234 such donor names held no PAC). A name that also says
// PAC / Committee on / Political stays a PAC ("Friends of Teamsters 397 PAC
// Fund"). Exported for tests.
const CANDIDATE_COMMITTEE_PREFIX_PATTERN = /^(FRIENDS OF|COMMITTEE TO ELECT|CITIZENS FOR|PEOPLE FOR)\b/;
const CANDIDATE_COMMITTEE_OFFICE_PATTERN =
  /\bFOR (STATE |LT |LIEUTENANT )?(REP|REPRESENTATIVE|SENATE|SENATOR|GOVERNOR|CONGRESS|JUDGE|MAYOR|COUNCIL|COMMISSIONER|TREASURER|AUDITOR|ATTORNEY GENERAL|PA|PENNSYLVANIA|DA|DISTRICT ATTORNEY|SHERIFF|CONTROLLER|SUPERVISOR|SCHOOL BOARD)\b/;
const PAC_WORD_PATTERN = /\b(PAC|COMMITTEE ON|POLITICAL)\b/;

export function isPennsylvaniaCandidateCommitteeName(committeeName: string): boolean {
  const key = committeeName
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
  if (!key || PAC_WORD_PATTERN.test(key)) {
    return false;
  }
  return CANDIDATE_COMMITTEE_PREFIX_PATTERN.test(key) || CANDIDATE_COMMITTEE_OFFICE_PATTERN.test(key);
}

// Where the committee's money is placed on the card: other candidates'
// committees are recognised by name (and, like the federal card, not
// listed); everything else goes through the shared rule classifier on the
// committee name (finance_pac_interests cannot help here: it is keyed by FEC
// committee id). Unsorted committees are kept under "Not yet sorted", unlike
// the federal card, because the name rules sort almost no Pennsylvania
// committees and hiding them would hide most of the PAC money. Researched
// labels (finance_committee_labels) still say who each committee is.
function pennsylvaniaPacInterest(row: PennsylvaniaFinancePacDonorRow): string {
  if (isPennsylvaniaCandidateCommitteeName(row.committee_name)) {
    return "candidate_committees";
  }
  return (
    classifyPacInterest({
      committeeName: row.committee_name,
      committeeType: null,
      designation: null,
      organizationType: null,
      connectedOrganization: null,
    }).interestSlug ?? UNCLASSIFIED_PAC_INTEREST
  );
}

// Rows are one per committee per candidate-election (the query merges the
// candidate's links) and arrive largest first, so each interest's pacs are
// its top ones.
function groupPennsylvaniaPacDonorsByInterest(
  rows: readonly PennsylvaniaFinancePacDonorRow[]
): Map<string, BallotLookupFinancePacInterest[]> {
  const byCandidateElection = new Map<string, Map<string, BallotLookupFinancePacInterest>>();
  for (const row of rows) {
    const interest = pennsylvaniaPacInterest(row);
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
        source_url: firstNonEmptySourceUrl(row.source_url, GENERIC_PENNSYLVANIA_DOS_SOURCE_URL),
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

function firstNonEmptySourceUrl(...urls: Array<string | null | undefined>): string | null {
  for (const url of urls) {
    const trimmed = url?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

function candidateElectionKey(candidateId: string, electionId: string): string {
  return `${candidateId}\u0000${electionId}`;
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
  grouped: Map<string, BallotLookupFinanceBreakdown[]>,
  candidateId: string,
  electionId: string,
  row: BallotLookupFinanceBreakdown
): void {
  const key = candidateElectionKey(candidateId, electionId);
  const list = grouped.get(key) ?? [];
  list.push(row);
  grouped.set(key, list);
}

function buildPennsylvaniaFinanceSummaryRequests(
  candidateRows: readonly PennsylvaniaBallotLookupCandidateRow[],
  electionRows: readonly PennsylvaniaBallotLookupElectionRow[]
): PennsylvaniaFinanceSummaryRequest[] {
  const electionIds = new Set(
    electionRows
      .filter((row) => row.state.trim().toUpperCase() === "PA")
      .map((row) => row.election_id)
  );
  const requests = new Map<string, PennsylvaniaFinanceSummaryRequest>();
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

export async function loadPennsylvaniaCandidateFinanceSummariesByCandidateElection(input: {
  db: Queryable;
  candidateRows: readonly PennsylvaniaBallotLookupCandidateRow[];
  electionRows: readonly PennsylvaniaBallotLookupElectionRow[];
}): Promise<Map<string, BallotLookupFinanceSummary>> {
  if (!isPennsylvaniaCampaignFinanceEnabled()) {
    return new Map();
  }

  const requests = buildPennsylvaniaFinanceSummaryRequests(input.candidateRows, input.electionRows);
  if (requests.length === 0) {
    return new Map();
  }

  const summaryResult = await input.db.query<PennsylvaniaFinanceSummaryRow>(
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
          WHEN count(DISTINCT link.filer_id) = 1 THEN min(link.filer_id)
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
        CASE WHEN count(summary.outside_support_total) = 0 THEN NULL ELSE sum(summary.outside_support_total) END AS outside_support_total,
        CASE WHEN count(summary.outside_oppose_total) = 0 THEN NULL ELSE sum(summary.outside_oppose_total) END AS outside_oppose_total,
        min(summary.source_url) FILTER (WHERE summary.source_url IS NOT NULL) AS source_url,
        max(summary.last_synced_at)::text AS last_synced_at
      FROM requested
      JOIN public.pa_candidate_finance_links AS link
        ON link.candidate_id = requested.candidate_id
       AND link.election_id = requested.election_id
       AND link.link_status = 'active'
      JOIN public.pa_candidate_finance_summaries AS summary
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

  const directBreakdownResult = await input.db.query<PennsylvaniaFinanceDirectBreakdownRow>(
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
        JOIN public.pa_candidate_finance_links AS link
          ON link.candidate_id = selected.candidate_id
         AND link.election_id = selected.election_id
         AND link.link_status = 'active'
        JOIN public.pa_candidate_finance_direct_breakdowns AS breakdown
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

  const outsideGroupResult = await input.db.query<PennsylvaniaFinanceOutsideGroupRow>(
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
          outside_group.group_id AS committee_id,
          min(outside_group.group_name) AS committee_name,
          outside_group.support_oppose,
          max(outside_group.amount) AS amount,
          min(outside_group.source_url) FILTER (WHERE outside_group.source_url IS NOT NULL) AS source_url
        FROM selected
        JOIN public.pa_candidate_finance_links AS link
          ON link.candidate_id = selected.candidate_id
         AND link.election_id = selected.election_id
         AND link.link_status = 'active'
        JOIN public.pa_candidate_finance_outside_groups AS outside_group
          ON outside_group.link_id = link.id
         AND outside_group.election_year = link.election_year
        GROUP BY selected.candidate_id, selected.election_id, outside_group.group_id, outside_group.support_oppose
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

  const outsideIndustryResult = await input.db.query<PennsylvaniaFinanceOutsideIndustryRow>(
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
          breakdown.group_id AS committee_id,
          breakdown.support_oppose,
          breakdown.category_name,
          max(breakdown.amount) AS amount,
          CASE
            WHEN count(breakdown.contributor_count) = 0 THEN NULL
            ELSE max(breakdown.contributor_count)
          END AS contributor_count,
          min(breakdown.source_url) FILTER (WHERE breakdown.source_url IS NOT NULL) AS source_url
        FROM selected
        JOIN public.pa_candidate_finance_links AS link
          ON link.candidate_id = selected.candidate_id
         AND link.election_id = selected.election_id
         AND link.link_status = 'active'
        JOIN public.pa_candidate_finance_outside_group_breakdowns AS breakdown
          ON breakdown.link_id = link.id
         AND breakdown.election_year = link.election_year
        WHERE breakdown.category_type = 'industry'
        GROUP BY
          selected.candidate_id,
          selected.election_id,
          breakdown.group_id,
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

  const outsideDonorEvidenceResult = await input.db.query<PennsylvaniaFinanceOutsideDonorEvidenceRow>(
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
          industry.group_id,
          industry.category_name AS industry_name,
          max(industry.amount) AS amount
        FROM selected
        JOIN public.pa_candidate_finance_links AS link
          ON link.candidate_id = selected.candidate_id
         AND link.election_id = selected.election_id
         AND link.link_status = 'active'
        JOIN public.pa_candidate_finance_outside_group_breakdowns AS industry
          ON industry.link_id = link.id
         AND industry.election_year = link.election_year
        WHERE industry.support_oppose = 'support'
          AND industry.category_type = 'industry'
        GROUP BY selected.candidate_id, selected.election_id, industry.group_id, industry.category_name
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
          breakdown.group_id AS committee_id,
          COALESCE(outside_group.group_name, breakdown.group_id) AS committee_name,
          breakdown.support_oppose,
          breakdown.category_name AS organization_name,
          breakdown.amount,
          breakdown.contributor_count,
          COALESCE(breakdown.source_url, outside_group.source_url) AS source_url,
          row_number() OVER (
            PARTITION BY selected.candidate_id, selected.election_id, top_industries.industry_name
            ORDER BY breakdown.amount DESC, breakdown.category_name ASC, breakdown.group_id ASC
          ) AS rn
        FROM selected
        JOIN top_industries
          ON top_industries.candidate_id = selected.candidate_id::text
         AND top_industries.election_id = selected.election_id::text
        JOIN public.pa_candidate_finance_links AS link
          ON link.candidate_id = selected.candidate_id
         AND link.election_id = selected.election_id
         AND link.link_status = 'active'
        JOIN public.pa_candidate_finance_outside_group_breakdowns AS breakdown
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
        LEFT JOIN public.pa_candidate_finance_outside_groups AS outside_group
          ON outside_group.link_id = breakdown.link_id
         AND outside_group.election_year = breakdown.election_year
         AND outside_group.group_id = breakdown.group_id
         AND outside_group.support_oppose = breakdown.support_oppose
        WHERE breakdown.category_type = 'donor'
          AND breakdown.support_oppose = 'support'
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
      mapFinanceBreakdown(row, summary?.source_url ?? GENERIC_PENNSYLVANIA_DOS_SOURCE_URL)
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
      source_url: firstNonEmptySourceUrl(row.source_url, GENERIC_PENNSYLVANIA_DOS_SOURCE_URL),
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
      mapFinanceBreakdown(row, GENERIC_PENNSYLVANIA_DOS_SOURCE_URL)
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
      source_url: firstNonEmptySourceUrl(row.source_url, GENERIC_PENNSYLVANIA_DOS_SOURCE_URL),
    });
    outsideIndustryEvidenceByCandidateElectionAndIndustry.set(
      evidenceKey,
      list.sort((left, right) => right.amount - left.amount || left.organization_name.localeCompare(right.organization_name)).slice(0, 5)
    );
  }

  const pacDonorResult = await input.db.query<PennsylvaniaFinancePacDonorRow>(
    `
      WITH selected AS (
        SELECT
          candidate_id::uuid AS candidate_id,
          election_id::uuid AS election_id
        FROM jsonb_to_recordset($1::jsonb) AS x(
          candidate_id text,
          election_id text
        )
      )
      SELECT
        selected.candidate_id::text AS candidate_id,
        selected.election_id::text AS election_id,
        donor.committee_id,
        min(donor.committee_name) AS committee_name,
        sum(donor.amount) AS amount,
        min(donor.source_url) FILTER (WHERE donor.source_url IS NOT NULL) AS source_url
      FROM selected
      JOIN public.pa_candidate_finance_links AS link
        ON link.candidate_id = selected.candidate_id
       AND link.election_id = selected.election_id
       AND link.link_status = 'active'
      JOIN public.pa_candidate_finance_pac_donors AS donor
        ON donor.link_id = link.id
       AND donor.election_year = link.election_year
      -- A candidate with two linked committees gets one row per donor
      -- committee, not one per link.
      GROUP BY selected.candidate_id, selected.election_id, donor.committee_id
      ORDER BY selected.candidate_id, selected.election_id, sum(donor.amount) DESC, min(donor.committee_name) ASC
    `,
    [JSON.stringify(selectedRequests)]
  );
  const pacInterestsByCandidateElection = groupPennsylvaniaPacDonorsByInterest(pacDonorResult.rows);

  return new Map(
    summaryResult.rows.map((row) => {
      const key = candidateElectionKey(row.candidate_id, row.election_id);
      const topDirectDonorOccupations = directOccupationsByCandidateElection.get(key) ?? [];
      const pacMoneyByInterest = pacInterestsByCandidateElection.get(key);
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
          source: "PENNSYLVANIA_DOS",
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
            // Present only when committee donors were stored for the link:
            // an absent list means "not loaded", never "none reported".
            ...(pacMoneyByInterest && pacMoneyByInterest.length > 0 ? { pac_money_by_interest: pacMoneyByInterest } : {}),
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
