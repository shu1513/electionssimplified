// Standard state money and outside groups, plus verified PAC cash receipts.

import type { Pool, PoolClient } from "pg";

import { isArkansasCampaignFinanceEnabled } from "../../config/featureFlags.js";
import {
  candidateElectionKey,
  firstNonEmptySourceUrl,
  officeInputFromElectionRow,
  parseFinanceAmount,
  type BallotLookupFinancePacInterest,
  type BallotLookupFinanceSummary,
  type StateFinanceRequestCandidateRow,
  type StateFinanceRequestElectionRow,
} from "../address/ballotLookupFinanceShared.js";
import { loadStandardStateFinanceSummariesByCandidateElection } from "../finance/standardStateFinanceBallotLookupLoader.js";
import { classifyFinanceLabel } from "../finance/financeLabelClassifier.js";
import { PAC_INTERESTS_NOT_LISTED, pacInterestDisplayName, UNCLASSIFIED_PAC_INTEREST } from "../finance/pacInterestClassifier.js";
import { ARKANSAS_CFIS_PUBLIC_URL } from "./arkansasCfisClient.js";
import { isArkansasFinanceEligibleOffice } from "./arkansasFinanceEligibleOffices.js";

type Queryable = Pick<Pool | PoolClient, "query">;

// Totals are the state system's own registration figures; breakdowns are
// computed from itemized receipts and published only when those receipts
// reconcile to the state total (arkansasDirectContributionAggregator.ts).
export const ARKANSAS_DIRECT_COVERAGE_NOTE =
  "Totals are the Arkansas Secretary of State's registration figures; occupation and contribution-size breakdowns are computed from itemized receipts, so non-itemized contributions are not broken down. PAC cash receipts are part of contributions and use verified current original reports across the receiving election cycle; Raised and PAC totals may have different coverage. Unregistered typed PAC donors retain their exact reported names.";
export const ARKANSAS_OUTSIDE_COVERAGE_NOTE =
  "Groups include verified candidate-specific expenditures in original electronic reports and retained prior evidence. Allocation uses reported transaction election context and exact candidate, office and district evidence; conflicting cover metadata is retained for review. Overall totals remain unavailable rather than zero until coverage is complete; later or amended reports may be unavailable.";

type ArkansasPacDonorRow = {
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

function groupPacDonors(rows: readonly ArkansasPacDonorRow[]): Map<string, BallotLookupFinancePacInterest[]> {
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
    const group = interests.get(interest) ?? {
      interest, interest_name: pacInterestDisplayName(interest), amount: 0, pac_count: 0, pacs: [],
    };
    group.amount = Math.round((group.amount + amount) * 100) / 100;
    group.pac_count += 1;
    group.pacs.push({ committee_id: row.committee_id, committee_name: row.committee_name, amount,
      source_url: firstNonEmptySourceUrl(row.source_url, ARKANSAS_CFIS_PUBLIC_URL) });
    interests.set(interest, group);
    grouped.set(key, interests);
  }
  return new Map([...grouped].map(([key, interests]) => [key, [...interests.values()]
    .map(group => ({ ...group, pacs: group.pacs.sort((a, b) => b.amount - a.amount
      || a.committee_name.localeCompare(b.committee_name)).slice(0, 5) }))
    .sort((a, b) => b.amount - a.amount || a.interest.localeCompare(b.interest)).slice(0, 5)]));
}

export async function loadArkansasCandidateFinanceSummariesByCandidateElection(
  db: Queryable,
  candidateRows: readonly StateFinanceRequestCandidateRow[],
  electionRows: readonly StateFinanceRequestElectionRow[]
): Promise<Map<string, BallotLookupFinanceSummary>> {
  const summaries = await loadStandardStateFinanceSummariesByCandidateElection({
    db,
    candidateRows,
    electionRows,
    state: "AR",
    source: "ARKANSAS_CFIS",
    sourceUrl: ARKANSAS_CFIS_PUBLIC_URL,
    enabled: isArkansasCampaignFinanceEnabled,
    isEligibleElection: (row) => isArkansasFinanceEligibleOffice(officeInputFromElectionRow(row)),
    linkIdentityColumn: "filing_entity_id",
    outsideGroupIdentityColumns: {
      id: "filing_entity_id",
      name: "filer_name",
    },
    directCoverageNote: ARKANSAS_DIRECT_COVERAGE_NOTE,
    outsideCoverageNote: ARKANSAS_OUTSIDE_COVERAGE_NOTE,
    tables: {
      links: "ar_candidate_finance_links",
      summaries: "ar_candidate_finance_summaries",
      directBreakdowns: "ar_candidate_finance_direct_breakdowns",
      outsideGroups: "ar_candidate_finance_outside_groups",
      outsideGroupBreakdowns: "ar_candidate_finance_outside_group_breakdowns",
    },
  });
  if (!summaries.size) return summaries;
  const selected = [...summaries.keys()].map(key => {
    const [candidate_id, election_id] = key.split("\u0000");
    return { candidate_id, election_id };
  });
  const pacRows = await db.query<ArkansasPacDonorRow>(`
    WITH selected AS (
      SELECT candidate_id::uuid AS candidate_id, election_id::uuid AS election_id
      FROM jsonb_to_recordset($1::jsonb) AS x(candidate_id text, election_id text)
    ), per_filer AS (
      SELECT selected.candidate_id, selected.election_id, link.filing_entity_id,
        donor.committee_id, min(donor.committee_name) AS committee_name,
        min(donor.committee_type) AS committee_type, max(donor.amount) AS amount,
        min(donor.source_url) AS source_url
      FROM selected JOIN public.ar_candidate_finance_links link
        ON link.candidate_id = selected.candidate_id AND link.election_id = selected.election_id
        AND link.link_status = 'active'
      JOIN public.ar_candidate_finance_pac_donors donor
        ON donor.link_id = link.id AND donor.election_year = link.election_year
      WHERE donor.committee_type = 'Political Action Committee'
      GROUP BY selected.candidate_id, selected.election_id, link.filing_entity_id, donor.committee_id
    ), grouped AS (
      SELECT candidate_id::text AS candidate_id, election_id::text AS election_id,
        committee_id, min(committee_name) AS committee_name, min(committee_type) AS committee_type,
        sum(amount) AS amount, min(source_url) AS source_url
      FROM per_filer GROUP BY candidate_id, election_id, committee_id
    ) SELECT grouped.*, classification.industry_slug, classification.classification_source, classification.confidence
      FROM grouped LEFT JOIN public.finance_label_classifications classification
        ON classification.label_type = 'committee'
        AND classification.normalized_label = public.normalize_finance_label(grouped.committee_name)
      ORDER BY grouped.candidate_id, grouped.election_id, grouped.amount DESC, grouped.committee_name`,
  [JSON.stringify(selected)]);
  for (const [key, pacs] of groupPacDonors(pacRows.rows)) {
    const summary = summaries.get(key);
    if (summary) summary.direct_campaign.pac_money_by_interest = pacs;
  }
  return summaries;
}
