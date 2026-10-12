import type { Pool, PoolClient } from "pg";

import { isNevadaCampaignFinanceEnabled } from "../../config/featureFlags.js";
import {
  candidateElectionKey,
  buildStateFinanceSummaryRequests,
  firstNonEmptySourceUrl,
  parseFinanceAmount,
  officeInputFromElectionRow,
  type BallotLookupFinancePacInterest,
  type BallotLookupFinanceSummary,
  type StateFinanceRequestCandidateRow,
  type StateFinanceRequestElectionRow,
} from "../address/ballotLookupFinanceShared.js";
import { loadStandardStateFinanceSummariesByCandidateElection } from "../finance/standardStateFinanceBallotLookupLoader.js";
import { classifyFinanceLabel } from "../finance/financeLabelClassifier.js";
import {
  PAC_INTERESTS_NOT_LISTED,
  PAC_INTEREST_SLUGS,
  UNCLASSIFIED_PAC_INTEREST,
  pacInterestDisplayName,
} from "../finance/pacInterestClassifier.js";
import { isNevadaFinanceEligibleOffice } from "./nevadaFinanceEligibleOffices.js";

type Queryable = Pick<Pool | PoolClient, "query">;

const NEVADA_AURORA_SOURCE_URL =
  "https://www.nvsos.gov/SOSCandidateServices/AnonymousAccess/CEFDSearchUU/Search.aspx";
const NEVADA_DIRECT_COVERAGE_NOTE =
  "Nevada does not collect donor occupation or employer; industry breakdowns cover identifiable organization donors only, and contribution-size buckets cover itemized transactions only. Totals cover the election year plus the prior year from searchable electronic filings.";
const NEVADA_OUTSIDE_COVERAGE_NOTE =
  "This Nevada integration has no verified candidate-specific outside-spending allocations; unavailable target, direction or amount evidence remains unknown.";

export async function loadNevadaCandidateFinanceSummariesByCandidateElection(
  db: Queryable,
  candidateRows: readonly StateFinanceRequestCandidateRow[],
  electionRows: readonly StateFinanceRequestElectionRow[],
): Promise<Map<string, BallotLookupFinanceSummary>> {
  if (!isNevadaCampaignFinanceEnabled()) return new Map();
  const requests = buildStateFinanceSummaryRequests(
    "NV",
    candidateRows,
    electionRows,
    (row) => isNevadaFinanceEligibleOffice(officeInputFromElectionRow(row)),
  );
  if (requests.length === 0) return new Map();
  const summaries = await loadStandardStateFinanceSummariesByCandidateElection({
    db,
    candidateRows,
    electionRows,
    state: "NV",
    source: "NEVADA_AURORA",
    sourceUrl: NEVADA_AURORA_SOURCE_URL,
    enabled: isNevadaCampaignFinanceEnabled,
    isEligibleElection: (row) =>
      isNevadaFinanceEligibleOffice(officeInputFromElectionRow(row)),
    linkIdentityColumn: "filer_key",
    outsideGroupIdentityColumns: {
      id: "filer_key",
      name: "filer_name",
    },
    directBreakdownCategoryTypes: ["industry", "contribution_size"],
    evidenceLabelTypes: ["donor"],
    directCoverageNote: NEVADA_DIRECT_COVERAGE_NOTE,
    outsideCoverageNote: NEVADA_OUTSIDE_COVERAGE_NOTE,
    tables: {
      links: "nv_candidate_finance_links",
      summaries: "nv_candidate_finance_summaries",
      directBreakdowns: "nv_candidate_finance_direct_breakdowns",
      outsideGroups: "nv_candidate_finance_outside_groups",
      outsideGroupBreakdowns: "nv_candidate_finance_outside_group_breakdowns",
    },
  });
  const result = await db.query<NevadaPacDonorRow>(
    `
    WITH requested AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(candidate_id uuid, election_id uuid)
    ), grouped AS (
      SELECT requested.candidate_id::text, requested.election_id::text,
        max(link.election_year) AS election_year,
        max(max(source.observed_at)) OVER (
          PARTITION BY requested.candidate_id, requested.election_id
        )::text AS observed_at,
        donor.committee_id, min(donor.committee_name) AS committee_name,
        sum(donor.amount) AS amount, sum(donor.contribution_count) AS contribution_count,
        min(donor.source_url) AS source_url
      FROM requested
      JOIN public.nv_candidate_finance_links link ON link.candidate_id = requested.candidate_id
        AND link.election_id = requested.election_id AND link.link_status = 'active'
      JOIN public.nv_candidate_finance_pac_sources source ON source.link_id = link.id AND source.election_year = link.election_year
      LEFT JOIN public.nv_candidate_finance_pac_donors donor ON donor.link_id = link.id AND donor.election_year = link.election_year
        AND donor.recognition_method IN ('registry_name', 'reported_name')
      GROUP BY requested.candidate_id, requested.election_id, donor.committee_id
    )
    SELECT grouped.*, classification.industry_slug, classification.classification_source, classification.confidence
    FROM grouped LEFT JOIN public.finance_label_classifications classification
      ON classification.label_type = 'committee'
      AND classification.normalized_label = public.normalize_finance_label(grouped.committee_name)
    ORDER BY candidate_id, election_id, amount DESC, committee_name`,
    [JSON.stringify(requests)],
  );
  const acceptedCandidates = new Set<string>();
  const byCandidate = new Map<
    string,
    Map<string, BallotLookupFinancePacInterest>
  >();
  for (const row of result.rows) {
    const key = candidateElectionKey(row.candidate_id, row.election_id);
    // Accepted donor evidence can precede the monthly direct-finance import.
    // Only new cards use donor freshness; existing direct cards keep theirs.
    if (!summaries.has(key)) {
      summaries.set(key, {
        source: "NEVADA_AURORA",
        cycle: row.election_year,
        fec_candidate_id: null,
        last_synced_at: row.observed_at,
        direct_campaign: {
          total_raised: null,
          total_spent: null,
          cash_on_hand: null,
          debts_owed: null,
          top_occupations: [],
          top_industries: [],
        },
        outside_spending: {
          support_total: null,
          oppose_total: null,
          outside_coverage_note: NEVADA_OUTSIDE_COVERAGE_NOTE,
          top_supporting_groups: [],
          top_opposing_groups: [],
          top_supporting_industries: [],
          top_opposing_industries: [],
        },
        backing_summary: {
          top_direct_donor_occupations: [],
          top_outside_supporting_industries: [],
        },
      });
    }
    acceptedCandidates.add(
      candidateElectionKey(row.candidate_id, row.election_id),
    );
    if (row.committee_id === null || row.committee_name === null) continue;
    const amount = parseFinanceAmount(row.amount);
    if (amount === null || amount <= 0) continue;
    const classification = classifyFinanceLabel({
      rawLabel: row.committee_name,
      labelType: "committee",
    });
    const trusted =
      row.industry_slug &&
      (row.classification_source === "manual" ||
        (row.confidence === "high" &&
          ["rule", "ai"].includes(row.classification_source ?? "")))
        ? row.industry_slug
        : null;
    const rule =
      classification.classificationSource === "rule" &&
      classification.confidence === "high"
        ? classification.industrySlug
        : null;
    const proposed = trusted ?? rule;
    const interest =
      proposed && (PAC_INTEREST_SLUGS as readonly string[]).includes(proposed)
        ? proposed
        : UNCLASSIFIED_PAC_INTEREST;
    if ((PAC_INTERESTS_NOT_LISTED as readonly string[]).includes(interest))
      continue;
    const groups =
      byCandidate.get(key) ?? new Map<string, BallotLookupFinancePacInterest>();
    const group = groups.get(interest) ?? {
      interest,
      interest_name: pacInterestDisplayName(interest),
      amount: 0,
      pac_count: 0,
      pacs: [],
    };
    group.amount = Math.round((group.amount + amount) * 100) / 100;
    group.pac_count += 1;
    group.pacs.push({
      committee_id: row.committee_id,
      committee_name: row.committee_name,
      amount,
      source_url: firstNonEmptySourceUrl(
        row.source_url,
        NEVADA_AURORA_SOURCE_URL,
      ),
    });
    groups.set(interest, group);
    byCandidate.set(key, groups);
  }
  for (const [key, summary] of summaries) {
    if (!acceptedCandidates.has(key)) continue;
    const interests = [...(byCandidate.get(key)?.values() ?? [])]
      .map((group) => ({
        ...group,
        pacs: group.pacs
          .sort(
            (a, b) =>
              b.amount - a.amount ||
              a.committee_id.localeCompare(b.committee_id),
          )
          .slice(0, 5),
      }))
      .sort(
        (a, b) => b.amount - a.amount || a.interest.localeCompare(b.interest),
      )
      .slice(0, 5);
    summary.direct_campaign.pac_money_by_interest = interests;
    summary.direct_campaign.direct_coverage_note = `${NEVADA_DIRECT_COVERAGE_NOTE} ${NEVADA_COMMITTEE_COVERAGE_NOTE}`;
  }
  return summaries;
}

const NEVADA_COMMITTEE_COVERAGE_NOTE =
  "Committee donor detail identifies reported PAC names in accepted itemized cash, not all PAC money. Name recognition does not establish legal registration identity. Donor detail and direct totals may cover different accepted filing periods.";

type NevadaPacDonorRow = {
  election_year: number;
  observed_at: string;
  candidate_id: string;
  election_id: string;
  committee_id: string | null;
  committee_name: string | null;
  amount: string | number | null;
  contribution_count: string | number;
  source_url: string | null;
  industry_slug: string | null;
  classification_source: string | null;
  confidence: string | null;
};
