// Kansas ballot-lookup finance loader: thin config wrapper over the standard
// loader. Totals are report cover lines (receipts = line 2, spent = line 4,
// cash = latest line 5; "raised" adds in-kind line 6 and removes loans and
// refunds). Buckets come from Schedules A/B of e-filed reports, so a paper
// filer whose covers were transcribed has totals and no buckets. Outside
// totals come from transcribed independent-expenditure statements and stay
// null until a statement names the candidate. A transcribed paper cover has
// receipts but no donor total, and receipts include loans and refunds, so
// "raised" stays unknown for those rows instead of borrowing receipts.

import type { Pool, PoolClient } from "pg";
import { attachKansasCommitteeReceipts } from "./kansasCommitteeReceipts.js";

import { isKansasCampaignFinanceEnabled } from "../../config/featureFlags.js";
import {
  buildStateFinanceSummaryRequests,
  candidateElectionKey,
  officeInputFromElectionRow,
  type BallotLookupFinanceOutsideGroup,
  type BallotLookupFinanceSummary,
  type StateFinanceRequestCandidateRow,
  type StateFinanceRequestElectionRow,
} from "../address/ballotLookupFinanceShared.js";
import { loadStandardStateFinanceSummariesByCandidateElection } from "../finance/standardStateFinanceBallotLookupLoader.js";
import {
  buildKansasCfrUrl,
  KANSAS_CFR_VIEWER_PAGES,
} from "./kansasCfrViewerClient.js";
import { normalizeKansasIEReportedName } from "./kansasIndependentExpenditureStore.js";
import { isKansasFinanceEligibleOffice } from "./kansasFinanceEligibleOffices.js";

type Queryable = Pick<Pool | PoolClient, "query">;

// The viewer keeps report identity in server session state, so there is no
// per-report deep link; the entry page is the only stable public URL.
export const KANSAS_CFR_PUBLIC_SITE_URL = buildKansasCfrUrl(
  KANSAS_CFR_VIEWER_PAGES.entry,
);

const KANSAS_DIRECT_COVERAGE_NOTE =
  "Totals are the cover-page figures of the reports filed with the Kansas Secretary of State. Contribution-size and occupation breakdowns come from the itemized schedules of electronically filed reports, so paper filers show totals only, and Kansas records an occupation only for individual donors who give more than $150.";

const KANSAS_OUTSIDE_COVERAGE_NOTE =
  "Outside spending counts independent-expenditure statements filed with the Kansas Public Disclosure Commission that name this candidate, using the stance each statement states. The groups' own funders are not shown.";

export async function loadKansasCandidateFinanceSummariesByCandidateElection(
  db: Queryable,
  candidateRows: readonly StateFinanceRequestCandidateRow[],
  electionRows: readonly StateFinanceRequestElectionRow[],
): Promise<Map<string, BallotLookupFinanceSummary>> {
  if (!isKansasCampaignFinanceEnabled()) return new Map();
  const requests = buildStateFinanceSummaryRequests(
    "KS",
    candidateRows,
    electionRows,
    (row) => isKansasFinanceEligibleOffice(officeInputFromElectionRow(row)),
  );
  if (!requests.length) return new Map();
  const summaries = await loadStandardStateFinanceSummariesByCandidateElection({
    db,
    candidateRows,
    electionRows,
    state: "KS",
    source: "KANSAS_SOS",
    sourceUrl: KANSAS_CFR_PUBLIC_SITE_URL,
    enabled: isKansasCampaignFinanceEnabled,
    isEligibleElection: (row) =>
      isKansasFinanceEligibleOffice(officeInputFromElectionRow(row)),
    directCoverageNote: KANSAS_DIRECT_COVERAGE_NOTE,
    raisedFallsBackToReceipts: false,
    outsideCoverageNote: KANSAS_OUTSIDE_COVERAGE_NOTE,
    tables: {
      links: "ks_candidate_finance_links",
      summaries: "ks_candidate_finance_summaries",
      directBreakdowns: "ks_candidate_finance_direct_breakdowns",
      outsideGroups: "ks_candidate_finance_outside_groups",
      outsideGroupBreakdowns: "ks_candidate_finance_outside_group_breakdowns",
    },
  });
  const evidence = await db.query<KansasIEReadRow>(
    `
    WITH requested AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(candidate_id uuid, election_id uuid)
    )
    SELECT evidence.candidate_id::text, evidence.election_id::text, evidence.election_year,
      evidence.payer_name, evidence.support_oppose, evidence.amount_cents::text,
      evidence.source_url, evidence.observed_at::text,
      evidence.candidate_name, evidence.house_district,
      COALESCE(NULLIF(trim(candidate.display_name), ''),
        trim(candidate.first_name || ' ' || candidate.last_name)) AS local_candidate_name
    FROM requested
    JOIN public.ks_independent_expenditure_evidence evidence
      ON evidence.candidate_id = requested.candidate_id AND evidence.election_id = requested.election_id
    JOIN public.candidate_elections roster ON roster.candidate_id = evidence.candidate_id
      AND roster.election_id = evidence.election_id
    JOIN public.candidates candidate ON candidate.id = evidence.candidate_id
    JOIN public.elections election ON election.id = evidence.election_id
    JOIN public.offices office ON office.id = election.office_id
    JOIN public.districts district ON district.id = election.district_id
    WHERE candidate.deleted_at IS NULL AND roster.status NOT IN ('withdrawn', 'lost')
      AND district.state = 'KS' AND district.district_type = 'state_lower'
      AND office.scope = 'state_lower' AND office.canonical_name = 'State Lower Chamber Legislator'
      AND district.geoid_compact ~ '^20[0-9]{3}$'
      AND substring(district.geoid_compact FROM 3)::integer = evidence.house_district
      AND election.race_type = 'office' AND election.election_stage = 'general'
      AND EXTRACT(YEAR FROM election.election_date)::integer = evidence.election_year
      AND evidence.row_date >= make_date(evidence.election_year - 1, 1, 1)
      AND evidence.row_date <= make_date(evidence.election_year, 12, 31)
    ORDER BY evidence.observed_at, evidence.source_url, evidence.row_index`,
    [JSON.stringify(requests)],
  );
  const byCandidate = new Map<
    string,
    {
      cycle: number;
      observedAt: string;
      groups: Map<string, BallotLookupFinanceOutsideGroup>;
    }
  >();
  for (const row of evidence.rows) {
    if (
      normalizeKansasIEReportedName(row.candidate_name) !==
      normalizeKansasIEReportedName(row.local_candidate_name)
    )
      continue;
    const cents = Number(row.amount_cents);
    if (
      !Number.isSafeInteger(cents) ||
      !Number.isFinite(Date.parse(row.observed_at)) ||
      !["support", "oppose"].includes(row.support_oppose)
    )
      throw new Error("Invalid stored Kansas IE evidence");
    const key = candidateElectionKey(row.candidate_id, row.election_id);
    const entry = byCandidate.get(key) ?? {
      cycle: row.election_year,
      observedAt: row.observed_at,
      groups: new Map(),
    };
    if (entry.cycle !== row.election_year)
      throw new Error("Conflicting Kansas IE election years");
    if (Date.parse(row.observed_at) > Date.parse(entry.observedAt))
      entry.observedAt = row.observed_at;
    const payerKey = `reported:${normalizeKansasIEReportedName(row.payer_name)}`;
    const groupKey = `${payerKey}\u0000${row.support_oppose}`;
    const group = entry.groups.get(groupKey) ?? {
      committee_id: payerKey,
      committee_name: row.payer_name,
      support_oppose: row.support_oppose,
      amount: 0,
      expenditure_count: 0,
      source_url: row.source_url,
    };
    const groupCents = Math.round(group.amount * 100) + cents;
    if (!Number.isSafeInteger(groupCents))
      throw new Error("Kansas IE grouped amount exceeds safe cents");
    group.amount = groupCents / 100;
    group.expenditure_count = (group.expenditure_count ?? 0) + 1;
    if (group.source_url !== row.source_url) group.source_url = KANSAS_CFR_PUBLIC_SITE_URL;
    entry.groups.set(groupKey, group);
    byCandidate.set(key, entry);
  }
  for (const [key, entry] of byCandidate) {
    const previous = summaries.get(key);
    const groups = [...entry.groups.values()]
      .filter((group) => group.amount > 0)
      .sort(
        (a, b) =>
          b.amount - a.amount || a.committee_id.localeCompare(b.committee_id),
      );
    const summary: BallotLookupFinanceSummary = previous ?? {
      source: "KANSAS_SOS",
      cycle: entry.cycle,
      fec_candidate_id: null,
      controlled_committee_id: null,
      last_synced_at: entry.observedAt,
      direct_campaign: {
        total_raised: null,
        total_spent: null,
        cash_on_hand: null,
        debts_owed: null,
        top_occupations: [],
        top_employers: [],
        top_industries: [],
        contribution_size_buckets: [],
      },
      outside_spending: {
        support_total: null,
        oppose_total: null,
        top_supporting_groups: [],
        top_opposing_groups: [],
        top_supporting_industries: [],
        top_opposing_industries: [],
      },
      backing_summary: {
        top_direct_donor_occupations: [],
        top_outside_supporting_industries: [],
      },
    };
    summaries.set(key, {
      ...summary,
      outside_spending: {
        support_total: null,
        oppose_total: null,
        top_supporting_groups: groups
          .filter((group) => group.support_oppose === "support")
          .slice(0, 5),
        top_opposing_groups: groups
          .filter((group) => group.support_oppose === "oppose")
          .slice(0, 5),
        top_supporting_industries: [],
        top_opposing_industries: [],
        outside_coverage_note: KANSAS_ITEMIZED_IE_COVERAGE_NOTE,
      },
      backing_summary: {
        ...summary.backing_summary,
        top_outside_supporting_industries: [],
      },
    });
  }
  return attachKansasCommitteeReceipts({db, requests, summaries});
}

const KANSAS_ITEMIZED_IE_COVERAGE_NOTE =
  "Groups show itemized spending reported in Kansas independent-expenditure statements included here. Overall outside-spending totals are unknown; other filings and shared spending may be missing. The groups' own funders are not shown.";

type KansasIEReadRow = {
  candidate_id: string;
  election_id: string;
  election_year: number;
  payer_name: string;
  support_oppose: "support" | "oppose";
  amount_cents: string | number;
  source_url: string;
  observed_at: string;
  candidate_name: string;
  local_candidate_name: string;
  house_district: number;
};
