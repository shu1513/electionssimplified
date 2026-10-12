// Delaware ballot-lookup finance loader: thin config wrapper over the
// standard loader. Outside coverage remains incomplete; unavailable totals
// surface as null, while previously stored groups remain readable. Occupation
// breakdowns are the voluntarily disclosed values only (hard fact 1), named
// as such by the direct coverage note.

import type { Pool, PoolClient } from "pg";

import { isDelawareCampaignFinanceEnabled } from "../../config/featureFlags.js";
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
import { isDelawareFinanceEligibleOffice } from "./delawareFinanceEligibleOffices.js";
import { classifyFinanceLabel } from "../finance/financeLabelClassifier.js";
import { PAC_INTERESTS_NOT_LISTED, pacInterestDisplayName, UNCLASSIFIED_PAC_INTEREST } from "../finance/pacInterestClassifier.js";

type Queryable = Pick<Pool | PoolClient, "query">;

const DELAWARE_CFRS_SOURCE_URL = "https://cfrs.elections.delaware.gov/";
const DELAWARE_DIRECT_COVERAGE_NOTE =
  "Delaware does not require donor occupation disclosure; occupation charts reflect voluntarily disclosed contributions only.";
const DELAWARE_OUTSIDE_COVERAGE_NOTE =
  "Delaware outside spending coverage is incomplete. Unavailable totals do not mean zero.";

const ELIGIBLE_COMMITTEE_TYPES = ["Political Action Committee", "Political Committee", "PAC",
  "Out-of-State or Federal Committee", "Dem or Rep National Sub-Committees"];
type DonorRow = {
  candidate_id: string; election_id: string; committee_id: string; committee_name: string;
  committee_type: string; amount: string | number; source_url: string | null;
  industry_slug: string | null; classification_source: string | null; confidence: string | null;
};
function groupDonors(rows: readonly DonorRow[]): Map<string, BallotLookupFinancePacInterest[]> {
  const candidates = new Map<string, Map<string, BallotLookupFinancePacInterest>>();
  for (const row of rows) {
    if (!ELIGIBLE_COMMITTEE_TYPES.includes(row.committee_type)) continue;
    const amount = parseFinanceAmount(row.amount);
    if (amount === null || amount <= 0 || !Number.isSafeInteger(Math.round(amount * 100))) continue;
    const rule = classifyFinanceLabel({ rawLabel: row.committee_name, labelType: "committee" });
    const stored = row.industry_slug && (row.classification_source === "manual" ||
      row.confidence === "high" && ["rule", "ai"].includes(row.classification_source ?? "")) ? row.industry_slug : null;
    const label = stored ?? (rule.classificationSource === "rule" && rule.confidence === "high" ? rule.industrySlug : null);
    // Interest-name rules cannot demote an explicitly reported political committee.
    const interest = !label || (PAC_INTERESTS_NOT_LISTED as readonly string[]).includes(label) ? UNCLASSIFIED_PAC_INTEREST : label;
    const key = candidateElectionKey(row.candidate_id, row.election_id);
    const groups = candidates.get(key) ?? new Map<string, BallotLookupFinancePacInterest>();
    const group = groups.get(interest) ?? { interest, interest_name: pacInterestDisplayName(interest), amount: 0, pac_count: 0, pacs: [] };
    group.amount = Math.round((group.amount + amount) * 100) / 100;
    if (!Number.isSafeInteger(Math.round(group.amount * 100))) throw new Error("Delaware PAC reader amount exceeds safe precision");
    group.pac_count += 1;
    group.pacs.push({ committee_id: row.committee_id, committee_name: row.committee_name, amount,
      source_url: firstNonEmptySourceUrl(row.source_url, DELAWARE_CFRS_SOURCE_URL) });
    groups.set(interest, group); candidates.set(key, groups);
  }
  return new Map([...candidates].map(([key, groups]) => [key, [...groups.values()].map(group => ({ ...group,
    pacs: group.pacs.sort((a, b) => b.amount - a.amount || a.committee_name.localeCompare(b.committee_name)).slice(0, 5),
  })).sort((a, b) => b.amount - a.amount || a.interest.localeCompare(b.interest)).slice(0, 5)]));
}

export async function loadDelawareCandidateFinanceSummariesByCandidateElection(
  db: Queryable,
  candidateRows: readonly StateFinanceRequestCandidateRow[],
  electionRows: readonly StateFinanceRequestElectionRow[]
): Promise<Map<string, BallotLookupFinanceSummary>> {
  const summaries = await loadStandardStateFinanceSummariesByCandidateElection({
    db,
    candidateRows,
    electionRows,
    state: "DE",
    source: "DELAWARE_CFRS",
    sourceUrl: DELAWARE_CFRS_SOURCE_URL,
    enabled: isDelawareCampaignFinanceEnabled,
    isEligibleElection: (row) => isDelawareFinanceEligibleOffice(officeInputFromElectionRow(row)),
    outsideCoverageNote: DELAWARE_OUTSIDE_COVERAGE_NOTE,
    directCoverageNote: DELAWARE_DIRECT_COVERAGE_NOTE,
    tables: {
      links: "de_candidate_finance_links",
      summaries: "de_candidate_finance_summaries",
      directBreakdowns: "de_candidate_finance_direct_breakdowns",
      outsideGroups: "de_candidate_finance_outside_groups",
      outsideGroupBreakdowns: "de_candidate_finance_outside_group_breakdowns",
    },
  });
  if (!summaries.size) return summaries;
  const selected = [...summaries.keys()].map(key => {
    const [candidate_id, election_id] = key.split("\u0000");
    return { candidate_id, election_id };
  });
  const donors = await db.query<DonorRow>(`
    WITH selected AS (
      SELECT candidate_id::uuid AS candidate_id, election_id::uuid AS election_id
      FROM jsonb_to_recordset($1::jsonb) AS x(candidate_id text, election_id text)
    ), per_receiver AS (
      SELECT selected.candidate_id, selected.election_id, link.committee_id AS receiving_committee_id,
        donor.committee_id, min(donor.committee_name) AS committee_name,
        min(donor.committee_type) AS committee_type, max(donor.amount) AS amount,
        min(donor.source_url) AS source_url
      FROM selected JOIN public.de_candidate_finance_links link
        ON link.candidate_id = selected.candidate_id AND link.election_id = selected.election_id
        AND link.link_status = 'active'
      JOIN public.de_candidate_finance_pac_donors donor
        ON donor.link_id = link.id AND donor.election_year = link.election_year
      WHERE donor.committee_type = ANY($2::text[])
        AND coalesce(donor.registered_committee_id, '') <> link.committee_id
      GROUP BY selected.candidate_id, selected.election_id, link.committee_id, donor.committee_id
    ), grouped AS (
      SELECT candidate_id::text AS candidate_id, election_id::text AS election_id,
        committee_id, min(committee_name) AS committee_name, min(committee_type) AS committee_type,
        sum(amount) AS amount, min(source_url) AS source_url
      FROM per_receiver GROUP BY candidate_id, election_id, committee_id
    ) SELECT grouped.*, classification.industry_slug, classification.classification_source, classification.confidence
      FROM grouped LEFT JOIN public.finance_label_classifications classification
        ON classification.label_type = 'committee'
        AND classification.normalized_label = public.normalize_finance_label(grouped.committee_name)
      ORDER BY grouped.candidate_id, grouped.election_id, grouped.amount DESC, grouped.committee_name`,
  [JSON.stringify(selected), ELIGIBLE_COMMITTEE_TYPES]);
  for (const [key, pacs] of groupDonors(donors.rows)) {
    const summary = summaries.get(key);
    if (summary) summary.direct_campaign.pac_money_by_interest = pacs;
  }
  return summaries;
}
