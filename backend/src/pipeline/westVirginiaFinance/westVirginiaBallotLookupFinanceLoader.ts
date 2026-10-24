import type { Pool, PoolClient } from "pg";

import { isWestVirginiaCampaignFinanceEnabled } from "../../config/featureFlags.js";
import {
  officeInputFromElectionRow,
  candidateElectionKey,
  firstNonEmptySourceUrl,
  parseFinanceAmount,
  type BallotLookupFinancePacInterest,
  type BallotLookupFinanceSummary,
  type StateFinanceRequestCandidateRow,
  type StateFinanceRequestElectionRow,
} from "../address/ballotLookupFinanceShared.js";
import { loadStandardStateFinanceSummariesByCandidateElection } from "../finance/standardStateFinanceBallotLookupLoader.js";
import { WEST_VIRGINIA_DIRECT_COVERAGE_NOTE } from "./westVirginiaDirectContributionAggregator.js";
import { isWestVirginiaFinanceEligibleOffice } from "./westVirginiaFinanceEligibleOffices.js";
import { WEST_VIRGINIA_CFRS_SOURCE_URL } from "./westVirginiaFinanceWriter.js";

import { classifyFinanceLabel } from "../finance/financeLabelClassifier.js";
import { PAC_INTERESTS_NOT_LISTED, pacInterestDisplayName, UNCLASSIFIED_PAC_INTEREST } from "../finance/pacInterestClassifier.js";

type Queryable = Pick<Pool | PoolClient, "query">;

const WEST_VIRGINIA_OUTSIDE_COVERAGE_NOTE =
  "Includes independent expenditure and electioneering communication reports filed by committees registered with the Secretary of State, read from the filed documents, plus electronically reported independent expenditures with verified filing versions. Spending by filers without a registered committee is not covered; unavailable or unproven empty data preserves prior spending.";

type WestVirginiaFinancePacDonorRow = {
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

// Official PAC and party/caucus donor classes, retained verbatim.
const PAC_DONOR_COMMITTEE_TYPES = new Set(["102", "103"]);

function groupPacDonorsByInterest(
  rows: readonly WestVirginiaFinancePacDonorRow[]
): Map<string, BallotLookupFinancePacInterest[]> {
  const grouped = new Map<string, Map<string, BallotLookupFinancePacInterest>>();
  for (const row of rows) {
    if (!PAC_DONOR_COMMITTEE_TYPES.has(row.committee_type.trim().toUpperCase())) {
      continue;
    }
    const amount = parseFinanceAmount(row.amount);
    if (amount === null || amount <= 0) {
      continue;
    }
    const classification = classifyFinanceLabel({ rawLabel: row.committee_name, labelType: "committee" });
    // Researched classifications override names; loose keyword matches do not
    // turn an unknown committee into a claimed industry (same rule as PA).
    const storedInterest =
      row.industry_slug &&
      (row.classification_source === "manual" ||
        (row.confidence === "high" && ["rule", "ai"].includes(row.classification_source ?? "")))
        ? row.industry_slug
        : null;
    const ruleInterest =
      classification.classificationSource === "rule" && classification.confidence === "high"
        ? classification.industrySlug
        : null;
    const interest = storedInterest ?? ruleInterest ?? UNCLASSIFIED_PAC_INTEREST;
    if ((PAC_INTERESTS_NOT_LISTED as readonly string[]).includes(interest)) {
      continue;
    }
    const key = candidateElectionKey(row.candidate_id, row.election_id);
    const interests = grouped.get(key) ?? new Map<string, BallotLookupFinancePacInterest>();
    const entry = interests.get(interest) ?? {
      interest,
      interest_name: pacInterestDisplayName(interest),
      amount: 0,
      pac_count: 0,
      pacs: [],
    };
    entry.amount = Math.round((entry.amount + amount) * 100) / 100;
    entry.pac_count += 1;
    entry.pacs.push({
      committee_id: row.committee_id,
      committee_name: row.committee_name,
      amount,
      source_url: firstNonEmptySourceUrl(row.source_url, WEST_VIRGINIA_CFRS_SOURCE_URL),
    });
    interests.set(interest, entry);
    grouped.set(key, interests);
  }
  return new Map(
    [...grouped].map(([key, interests]) => [
      key,
      [...interests.values()]
        .map((entry) => ({
          ...entry,
          pacs: entry.pacs
            .sort((left, right) => right.amount - left.amount || left.committee_name.localeCompare(right.committee_name))
            .slice(0, 5),
        }))
        .sort((left, right) => right.amount - left.amount || left.interest.localeCompare(right.interest))
        .slice(0, 5),
    ])
  );
}

export async function loadWestVirginiaCandidateFinanceSummariesByCandidateElection(
  db: Queryable,
  candidateRows: readonly StateFinanceRequestCandidateRow[],
  electionRows: readonly StateFinanceRequestElectionRow[]
): Promise<Map<string, BallotLookupFinanceSummary>> {
  const summaries = await loadStandardStateFinanceSummariesByCandidateElection({
    db,
    candidateRows,
    electionRows,
    state: "WV",
    source: "WEST_VIRGINIA_CFRS",
    sourceUrl: WEST_VIRGINIA_CFRS_SOURCE_URL,
    enabled: isWestVirginiaCampaignFinanceEnabled,
    isEligibleElection: (row) => isWestVirginiaFinanceEligibleOffice(officeInputFromElectionRow(row)),
    directBreakdownCategoryTypes: ["occupation", "industry", "contribution_size"],
    directCoverageNote: WEST_VIRGINIA_DIRECT_COVERAGE_NOTE + " Committee donors require an explicit PAC or party/caucus source type and a unique registry match; ambiguous and unregistered donors are omitted.",
    outsideCoverageNote: WEST_VIRGINIA_OUTSIDE_COVERAGE_NOTE,
    tables: {
      links: "wv_candidate_finance_links",
      summaries: "wv_candidate_finance_summaries",
      directBreakdowns: "wv_candidate_finance_direct_breakdowns",
      outsideGroups: "wv_candidate_finance_outside_groups",
      outsideGroupBreakdowns: "wv_candidate_finance_outside_group_breakdowns",
    },
  });
  if (summaries.size === 0) return summaries;
  const selectedRequests = [...new Map(candidateRows
    .filter((row) => summaries.has(candidateElectionKey(row.candidate_id, row.election_id)))
    .map((row) => [candidateElectionKey(row.candidate_id, row.election_id), {
      candidate_id: row.candidate_id, election_id: row.election_id,
    }])).values()];
  const pacDonorResult = await db.query<WestVirginiaFinancePacDonorRow>(
    `
      WITH selected AS (
        SELECT candidate_id::uuid AS candidate_id, election_id::uuid AS election_id
        FROM jsonb_to_recordset($1::jsonb) AS x(candidate_id text, election_id text)
      ), grouped AS (
        SELECT selected.candidate_id::text AS candidate_id,
          selected.election_id::text AS election_id,
          donor.committee_id,
          min(donor.committee_name) AS committee_name,
          min(donor.committee_type) AS committee_type,
          sum(donor.amount) AS amount,
          min(donor.source_url) FILTER (WHERE donor.source_url IS NOT NULL) AS source_url
        FROM selected
        JOIN public.wv_candidate_finance_links AS link
          ON link.candidate_id = selected.candidate_id
         AND link.election_id = selected.election_id
         AND link.link_status = 'active'
        JOIN public.wv_candidate_finance_pac_donors AS donor
          ON donor.link_id = link.id
         AND donor.election_year = link.election_year
        WHERE upper(btrim(donor.committee_type)) IN (
          '102', '103'
        )
        -- Different receiving committees add together; each donor is displayed once.
        GROUP BY selected.candidate_id, selected.election_id, donor.committee_id
      )
      SELECT grouped.*, classification.industry_slug, classification.classification_source, classification.confidence
      FROM grouped
      LEFT JOIN public.finance_label_classifications AS classification
        ON classification.label_type = 'committee'
       AND classification.normalized_label = public.normalize_finance_label(grouped.committee_name)
      ORDER BY candidate_id, election_id, amount DESC, committee_name ASC
    `,
    [JSON.stringify(selectedRequests)]
  );
  for (const [key, interests] of groupPacDonorsByInterest(pacDonorResult.rows)) {
    const summary = summaries.get(key);
    if (summary) summary.direct_campaign.pac_money_by_interest = interests;
  }
  return summaries;
}
