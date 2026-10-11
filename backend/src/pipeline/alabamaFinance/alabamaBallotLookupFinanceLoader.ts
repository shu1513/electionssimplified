// Alabama ballot-lookup finance loader: thin config wrapper over the
// standard loader. Acquired sources lack verified candidate-specific outside
// dollar coverage; unknown totals remain unavailable and prior stored outside
// components are preserved. The direct note is the source-wide static one
// from the aggregator; the standard family persists no per-candidate note.

import type { Pool, PoolClient } from "pg";

import { isAlabamaCampaignFinanceEnabled } from "../../config/featureFlags.js";
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
import { ALABAMA_DIRECT_COVERAGE_NOTE } from "./alabamaDirectFinanceAggregator.js";
import { isAlabamaFinanceEligibleOffice } from "./alabamaFinanceEligibleOffices.js";

import { classifyFinanceLabel } from "../finance/financeLabelClassifier.js";
import { PAC_INTERESTS_NOT_LISTED, pacInterestDisplayName, UNCLASSIFIED_PAC_INTEREST } from "../finance/pacInterestClassifier.js";

type Queryable = Pick<Pool | PoolClient, "query">;

const ALABAMA_FCPA_SOURCE_URL = "https://fcpa.alabamavotes.gov/";
const ALABAMA_OUTSIDE_COVERAGE_NOTE =
  "This integration lacks verified candidate-specific outside spending dollar coverage. Unknown totals are unavailable rather than zero; previously stored outside components are preserved.";

type AlabamaFinancePacDonorRow = {
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

// Explicit source classification; a committee-like name alone is insufficient.
const PAC_DONOR_COMMITTEE_TYPES = new Set(["POLITICAL ACTION COMMITTEE"]);

function groupPacDonorsByInterest(
  rows: readonly AlabamaFinancePacDonorRow[]
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
      source_url: firstNonEmptySourceUrl(row.source_url, ALABAMA_FCPA_SOURCE_URL),
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

export async function loadAlabamaCandidateFinanceSummariesByCandidateElection(
  db: Queryable,
  candidateRows: readonly StateFinanceRequestCandidateRow[],
  electionRows: readonly StateFinanceRequestElectionRow[]
): Promise<Map<string, BallotLookupFinanceSummary>> {
  const summaries = await loadStandardStateFinanceSummariesByCandidateElection({
    db,
    candidateRows,
    electionRows,
    state: "AL",
    source: "ALABAMA_FCPA",
    sourceUrl: ALABAMA_FCPA_SOURCE_URL,
    enabled: isAlabamaCampaignFinanceEnabled,
    isEligibleElection: (row) => isAlabamaFinanceEligibleOffice(officeInputFromElectionRow(row)),
    directCoverageNote: ALABAMA_DIRECT_COVERAGE_NOTE,
    outsideCoverageNote: ALABAMA_OUTSIDE_COVERAGE_NOTE,
    tables: {
      links: "al_candidate_finance_links",
      summaries: "al_candidate_finance_summaries",
      directBreakdowns: "al_candidate_finance_direct_breakdowns",
      outsideGroups: "al_candidate_finance_outside_groups",
      outsideGroupBreakdowns: "al_candidate_finance_outside_group_breakdowns",
    },
  });
  if (summaries.size === 0) return summaries;
  const selectedRequests = [...new Map(candidateRows
    .filter((row) => summaries.has(candidateElectionKey(row.candidate_id, row.election_id)))
    .map((row) => [candidateElectionKey(row.candidate_id, row.election_id), {
      candidate_id: row.candidate_id, election_id: row.election_id,
    }])).values()];
  const pacDonorResult = await db.query<AlabamaFinancePacDonorRow>(
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
        JOIN public.al_candidate_finance_links AS link
          ON link.candidate_id = selected.candidate_id
         AND link.election_id = selected.election_id
         AND link.link_status = 'active'
        JOIN public.al_candidate_finance_pac_donors AS donor
          ON donor.link_id = link.id
         AND donor.election_year = link.election_year
        WHERE upper(btrim(donor.committee_type)) IN (
          'POLITICAL ACTION COMMITTEE'
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
