import type { Pool, PoolClient } from "pg";
import {
  candidateElectionKey,
  parseFinanceAmount,
  type BallotLookupFinancePacInterest,
  type BallotLookupFinanceSummary,
  type StateFinanceSummaryRequest,
} from "../address/ballotLookupFinanceShared.js";
import { classifyFinanceLabel } from "../finance/financeLabelClassifier.js";
import {
  PAC_INTERESTS_NOT_LISTED, PAC_INTEREST_SLUGS, UNCLASSIFIED_PAC_INTEREST,
  pacInterestDisplayName,
} from "../finance/pacInterestClassifier.js";
import { VERMONT_FINANCE_ELIGIBLE_OFFICE_KEYS, toVermontOfficeSearchInput } from "./vermontFinanceEligibleOffices.js";

export const VERMONT_OUTSIDE_COVERAGE_NOTE =
  "Candidate independent-expenditure allocations have not been acquired. Stored PAC transfers are a separate channel and do not establish overall outside-spending totals.";

export type VermontCommitteeCashReaderRow = {
  candidate_id: string; election_id: string; election_year: number;
  receiving_filer_guid: string; observed_at: string;
  period_start: string; period_end: string;
  committee_id: string | null; committee_name: string | null;
  amount: string | number | null; source_url: string | null;
  industry_slug: string | null; classification_source: string | null; confidence: string | null;
};

/** Rows contain the complete signed net of the selected generation, before display caps. */
export function groupVermontCommitteeCashByInterest(
  rows: readonly VermontCommitteeCashReaderRow[],
): Map<string, BallotLookupFinancePacInterest[]> {
  const grouped = new Map<string, Map<string, BallotLookupFinancePacInterest>>();
  for (const row of rows) {
    if (!row.committee_id || !row.committee_name) continue;
    const amount = parseFinanceAmount(row.amount);
    if (amount === null || amount <= 0) continue;
    const rule = classifyFinanceLabel({ rawLabel: row.committee_name, labelType: "committee" });
    const trusted = row.industry_slug && (row.classification_source === "manual" ||
      (row.confidence === "high" && ["rule", "ai"].includes(row.classification_source ?? "")))
      ? row.industry_slug : null;
    const proposed = trusted ?? (rule.classificationSource === "rule" && rule.confidence === "high" ? rule.industrySlug : null);
    const interest = proposed && (PAC_INTEREST_SLUGS as readonly string[]).includes(proposed)
      ? proposed : UNCLASSIFIED_PAC_INTEREST;
    if ((PAC_INTERESTS_NOT_LISTED as readonly string[]).includes(interest)) continue;
    const key = candidateElectionKey(row.candidate_id, row.election_id);
    const interests = grouped.get(key) ?? new Map<string, BallotLookupFinancePacInterest>();
    const group = interests.get(interest) ?? {
      interest, interest_name: pacInterestDisplayName(interest), amount: 0, pac_count: 0, pacs: [],
    };
    group.amount = Math.round((group.amount + amount) * 100) / 100;
    group.pac_count += 1;
    group.pacs.push({ committee_id: row.committee_id, committee_name: row.committee_name,
      amount, source_url: row.source_url });
    interests.set(interest, group);
    grouped.set(key, interests);
  }
  return new Map([...grouped].map(([key, interests]) => [key,
    [...interests.values()].map(group => ({ ...group,
      pacs: group.pacs.sort((a,b) => b.amount-a.amount || a.committee_id.localeCompare(b.committee_id)).slice(0,5),
    })).sort((a,b) => b.amount-a.amount || a.interest.localeCompare(b.interest)),
  ]));
}

export async function addVermontCommitteeCashToSummaries(
  db: Pick<Pool | PoolClient, "query">,
  requests: readonly StateFinanceSummaryRequest[],
  summaries: Map<string, BallotLookupFinanceSummary>,
): Promise<Map<string, BallotLookupFinanceSummary>> {
  if (!requests.length) return summaries;
  const offices = VERMONT_FINANCE_ELIGIBLE_OFFICE_KEYS.filter(key => key.startsWith("statewide::"))
    .map(key => {
      const officeCanonicalName = key.split("::")[1]!;
      const source = toVermontOfficeSearchInput({ officeScope: "statewide",officeCanonicalName })!;
      return { office_canonical_name: officeCanonicalName,source_office_id: source.officeId,source_office_name: source.officeName };
    });
  const result = await db.query<VermontCommitteeCashReaderRow>(`
    WITH selected AS (
      SELECT candidate_id::uuid candidate_id,election_id::uuid election_id
      FROM jsonb_to_recordset($1::jsonb)x(candidate_id text,election_id text)
    ),grouped AS (
      SELECT selected.candidate_id::text,selected.election_id::text,
        link.election_year,link.filer_registration_guid AS receiving_filer_guid,
        source.observed_at::text,source.period_start::text,source.period_end::text,
        donor.committee_id,min(donor.committee_name) AS committee_name,
        sum(donor.amount) AS amount,min(donor.source_url) AS source_url
      FROM selected
      JOIN public.vt_candidate_finance_links link ON link.candidate_id=selected.candidate_id
        AND link.election_id=selected.election_id AND link.link_status='active'
      JOIN public.vt_candidate_finance_pac_sources source ON source.link_id=link.id
        AND source.election_year=link.election_year
      JOIN public.candidates candidate ON candidate.id=link.candidate_id
        AND candidate.deleted_at IS NULL AND candidate.merged_into_candidate_id IS NULL
      JOIN public.candidate_elections ce ON ce.candidate_id=link.candidate_id
        AND ce.election_id=link.election_id AND ce.status='declared'
      JOIN public.elections election ON election.id=link.election_id
        AND election.race_type='office' AND election.election_stage='general'
        AND extract(year FROM election.election_date)=link.election_year
      JOIN public.offices office ON office.id=election.office_id AND office.scope='statewide'
        AND office.canonical_name=link.office_name
      JOIN jsonb_to_recordset($2::jsonb) native_office(office_canonical_name text,source_office_id integer,source_office_name text)
        ON native_office.office_canonical_name=office.canonical_name
      JOIN public.districts district ON district.id=election.district_id
        AND district.state='VT' AND district.district_type='statewide' AND district.geoid_compact='50'
      LEFT JOIN public.vt_candidate_finance_pac_donors donor ON donor.link_id=source.link_id
        AND donor.election_year=source.election_year AND donor.capture_digest=source.capture_digest
        AND donor.reported_type='Political Action Committee'
      WHERE source.receiving_context=jsonb_build_object(
        'linkId',link.id::text,'candidateId',link.candidate_id::text,'electionId',link.election_id::text,
        'electionYear',link.election_year,
        'candidateName',COALESCE(NULLIF(trim(candidate.display_name),''),NULLIF(trim(candidate.first_name || ' ' || candidate.last_name),'')),
        'receivingFilerName',link.filer_name,'filerRegistrationGuid',link.filer_registration_guid,
        'entityId',link.entity_id,'officeId',native_office.source_office_id,'officeName',native_office.source_office_name,
        'electionDate',election.election_date::text,'electionType','general','sourceElectionId',source.source_election_id)
        AND NOT EXISTS (
          SELECT 1 FROM public.vt_candidate_finance_links sibling
          WHERE sibling.candidate_id=link.candidate_id AND sibling.election_id=link.election_id
            AND sibling.link_status='active' AND sibling.id<>link.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.vt_candidate_finance_links other
          JOIN public.candidates other_candidate ON other_candidate.id=other.candidate_id
            AND other_candidate.deleted_at IS NULL AND other_candidate.merged_into_candidate_id IS NULL
          JOIN public.candidate_elections other_ce ON other_ce.candidate_id=other.candidate_id
            AND other_ce.election_id=other.election_id AND other_ce.status='declared'
          JOIN public.elections other_election ON other_election.id=other.election_id
            AND other_election.race_type='office' AND other_election.election_stage='general'
          JOIN public.districts other_district ON other_district.id=other_election.district_id AND other_district.state='VT'
          WHERE other.link_status='active' AND lower(other.filer_registration_guid)=lower(link.filer_registration_guid)
            AND other.election_year=link.election_year AND other.id<>link.id
            AND extract(year FROM other_election.election_date)=link.election_year
        )
      GROUP BY selected.candidate_id,selected.election_id,link.election_year,
        link.filer_registration_guid,source.observed_at,source.period_start,source.period_end,donor.committee_id
    )
    SELECT grouped.*,classification.industry_slug,classification.classification_source,classification.confidence
    FROM grouped LEFT JOIN public.finance_label_classifications classification
      ON classification.label_type='committee'
      AND classification.normalized_label=public.normalize_finance_label(grouped.committee_name)
    ORDER BY candidate_id,election_id,amount DESC,committee_name`, [JSON.stringify(requests),JSON.stringify(offices)]);
  const interests = groupVermontCommitteeCashByInterest(result.rows);
  for (const row of result.rows) {
    const key = candidateElectionKey(row.candidate_id,row.election_id);
    const summary = summaries.get(key) ?? {
      source: "VERMONT_CFD", cycle: row.election_year, fec_candidate_id: null,
      controlled_committee_id: row.receiving_filer_guid, last_synced_at: row.observed_at,
      direct_campaign: { total_raised: null,total_spent: null,cash_on_hand: null,debts_owed: null,
        top_occupations: [],top_employers: [],top_industries: [],contribution_size_buckets: [] },
      outside_spending: { support_total: null,oppose_total: null,
        top_supporting_groups: [],top_opposing_groups: [],top_supporting_industries: [],top_opposing_industries: [] },
      backing_summary: { top_direct_donor_occupations: [],top_outside_supporting_industries: [] },
    } satisfies BallotLookupFinanceSummary;
    summary.direct_campaign.pac_money_by_interest = interests.get(key) ?? [];
    summary.direct_campaign.direct_coverage_note =
      `Reported-name PAC cash receipts in accepted reports from ${row.period_start} through ${row.period_end}; source observed ${row.observed_at}. Other committee types, untyped receipts, in-kind and loans are excluded. Reported names do not establish legal registration identity. Direct totals have a separate source observation.`;
    summaries.set(key,summary);
  }
  for (const summary of summaries.values()) {
    summary.outside_spending.support_total = null;
    summary.outside_spending.oppose_total = null;
    summary.outside_spending.outside_coverage_note = VERMONT_OUTSIDE_COVERAGE_NOTE;
  }
  return summaries;
}
