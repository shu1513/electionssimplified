import type { Pool, PoolClient } from "pg";
import { candidateElectionKey, type BallotLookupFinanceSummary, type BallotLookupFinancePacInterest } from "../address/ballotLookupFinanceShared.js";
import { classifyPacInterest, isPacInterestSlug, pacInterestDisplayName, PAC_INTERESTS_NOT_LISTED, UNCLASSIFIED_PAC_INTEREST } from "../finance/pacInterestClassifier.js";
import { normalizeRhodeIslandCandidateNameForStorage } from "./rhodeIslandCandidateCommitteeResolver.js";
import { RHODE_ISLAND_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./rhodeIslandFinanceEligibleOffices.js";

type Row = {
  candidate_id: string; election_id: string; election_year: number; candidate_name: string; candidate_name_normalized: string;
  observed_at: string; period_end: string; source_url: string; group_count: number; cash_cents: string; selected_occurrences: number;
  reported_key: string | null; committee_name: string | null; source_class: string | null; amount_cents: string | null; contribution_count: number | null;
  industry_slug: string | null; classification_source: string | null; confidence: string | null;
};
function cents(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const result = Number(raw); return Number.isSafeInteger(result) ? result : null;
}

/** Read every accepted reported group before interest/display caps. A source
 * count/cent mismatch or changed canonical receiving context omits this
 * component; it cannot become a false "nothing reported" card.
 */
export async function appendRhodeIslandCommitteeCashSummaries(
  db: Pick<Pool | PoolClient, "query">, requests: readonly { candidate_id: string; election_id: string }[],
  summaries: Map<string, BallotLookupFinanceSummary>,
): Promise<void> {
  if (!requests.length) return;
  const result = await db.query<Row>(`WITH requested AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(candidate_id uuid,election_id uuid)
    ) SELECT link.candidate_id::text,link.election_id::text,link.election_year,
      COALESCE(NULLIF(trim(candidate.display_name),''),trim(candidate.first_name||' '||candidate.last_name)) candidate_name,
      link.candidate_name_normalized,source.observed_at::text,source.period_end::text,source.source_url,
      source.group_count,source.cash_cents::text,source.selected_occurrences,
      donor.reported_key,donor.committee_name,donor.source_class,donor.amount_cents::text,donor.contribution_count,
      label.industry_slug,label.classification_source,label.confidence
    FROM requested JOIN public.ri_candidate_finance_links link ON link.candidate_id=requested.candidate_id
      AND link.election_id=requested.election_id AND link.link_status='active'
    JOIN public.candidates candidate ON candidate.id=link.candidate_id
    JOIN public.candidate_elections roster ON roster.candidate_id=link.candidate_id AND roster.election_id=link.election_id
    JOIN public.elections election ON election.id=link.election_id
    JOIN public.districts district ON district.id=election.district_id JOIN public.offices office ON office.id=election.office_id
    JOIN public.ri_candidate_finance_pac_sources source ON source.link_id=link.id AND source.election_year=link.election_year
      AND source.receiving_committee_id=link.committee_id
    LEFT JOIN public.ri_candidate_finance_pac_donors donor ON donor.link_id=source.link_id AND donor.election_year=source.election_year
    LEFT JOIN public.finance_label_classifications label ON label.label_type='committee'
      AND label.normalized_label=public.normalize_finance_label(donor.committee_name)
    WHERE candidate.deleted_at IS NULL AND roster.status NOT IN ('withdrawn','lost')
      AND district.state='RI' AND election.race_type='office' AND election.election_stage='general'
      AND extract(year FROM election.election_date)::integer=link.election_year
      AND election.election_date BETWEEN CURRENT_DATE-1 AND CURRENT_DATE+730
      AND (office.scope||'::'||office.canonical_name)=ANY($2::text[]) AND link.office_name=office.canonical_name
      AND link.district IS NOT DISTINCT FROM CASE WHEN district.district_type IN ('state_upper','state_lower') THEN
        NULLIF(regexp_replace(substring(district.geoid_compact FROM char_length(district.state_fips)+1),'^0+',''),'') END
      AND ((office.scope='statewide' AND district.district_type='statewide' AND district.geoid_compact='44') OR
        (office.scope IN ('state_upper','state_lower') AND district.district_type=office.scope AND
          CASE WHEN district.geoid_compact ~ '^44[0-9]{3}$' THEN substring(district.geoid_compact FROM 3)::integer END
          BETWEEN 1 AND CASE WHEN office.scope='state_upper' THEN 38 ELSE 75 END))
      AND (SELECT count(*) FROM public.ri_candidate_finance_links sibling WHERE sibling.link_status='active' AND
        ((sibling.candidate_id=link.candidate_id AND sibling.election_id=link.election_id) OR
         (sibling.committee_id=link.committee_id AND sibling.election_year=link.election_year)))=1
    ORDER BY link.candidate_id,link.election_id,donor.amount_cents DESC NULLS LAST,donor.reported_key`,
  [JSON.stringify(requests), [...RHODE_ISLAND_FINANCE_ELIGIBLE_OFFICE_KEYS]]);
  const byCandidate = new Map<string, { first: Row; rows: Row[]; invalid: boolean }>();
  for (const row of result.rows) {
    const key = candidateElectionKey(row.candidate_id, row.election_id);
    const state = byCandidate.get(key) ?? { first: row, rows: [], invalid: false };
    if (normalizeRhodeIslandCandidateNameForStorage(row.candidate_name) !== row.candidate_name_normalized) state.invalid = true;
    state.rows.push(row); byCandidate.set(key, state);
  }
  for (const [key, state] of byCandidate) {
    const first = state.first, expected = cents(first.cash_cents), seen = new Set<string>();
    const interests = new Map<string, BallotLookupFinancePacInterest>();
    const interestCents = new Map<string, number>();
    let total = 0, occurrences = 0;
    for (const row of state.rows) {
      if (row.reported_key === null) continue;
      const amount = row.amount_cents === null ? null : cents(row.amount_cents);
      if (amount === null || amount <= 0 || !row.committee_name || !["PAC", "Party"].includes(row.source_class ?? "") ||
        row.reported_key !== JSON.stringify([row.source_class, row.committee_name.normalize("NFC").trim().replace(/\s+/g, " ").toUpperCase()]) ||
        !Number.isSafeInteger(row.contribution_count) || row.contribution_count! <= 0 || seen.has(row.reported_key)) {
        state.invalid = true; continue;
      }
      seen.add(row.reported_key); total += amount; occurrences += row.contribution_count!;
      const trusted = row.industry_slug && isPacInterestSlug(row.industry_slug) && (row.classification_source === "manual" ||
        row.confidence === "high" && ["rule", "ai"].includes(row.classification_source ?? "")) ? row.industry_slug : null;
      const interest = trusted ?? classifyPacInterest({ committeeName: row.committee_name, committeeType: null, designation: null,
        organizationType: null, connectedOrganization: null }).interestSlug ?? UNCLASSIFIED_PAC_INTEREST;
      if ((PAC_INTERESTS_NOT_LISTED as readonly string[]).includes(interest)) continue;
      const group = interests.get(interest) ?? { interest, interest_name: pacInterestDisplayName(interest), amount: 0, pac_count: 0, pacs: [] };
      interestCents.set(interest, (interestCents.get(interest) ?? 0) + amount);
      group.amount = interestCents.get(interest)! / 100; group.pac_count++;
      group.pacs.push({ committee_id: `reported:${row.reported_key}`, committee_name: row.committee_name, amount: amount / 100, source_url: row.source_url });
      interests.set(interest, group);
    }
    if (state.invalid || expected === null || !Number.isSafeInteger(total) || !Number.isSafeInteger(occurrences) ||
      total !== expected || seen.size !== first.group_count || occurrences !== first.selected_occurrences ||
      !Number.isFinite(Date.parse(first.observed_at))) continue;
    // Product-excluded interests must not turn positive receipts into an empty
    // "nothing reported" message. A genuine accepted zero still gets [].
    if (total > 0 && interests.size === 0) continue;
    let summary = summaries.get(key);
    if (!summary) {
      summary = { source: "RHODE_ISLAND_ERTS", cycle: first.election_year, fec_candidate_id: null, last_synced_at: first.observed_at,
        direct_campaign: { total_raised: null, total_spent: null, cash_on_hand: null, debts_owed: null, top_occupations: [], top_industries: [] },
        outside_spending: { support_total: null, oppose_total: null, top_supporting_groups: [], top_opposing_groups: [], top_supporting_industries: [], top_opposing_industries: [] },
        backing_summary: { top_direct_donor_occupations: [], top_outside_supporting_industries: [] } };
      summaries.set(key, summary);
    }
    summary.direct_campaign.pac_money_by_interest = [...interests.values()].map(group => ({ ...group,
      pacs: group.pacs.sort((a, b) => b.amount - a.amount || a.committee_name.localeCompare(b.committee_name)).slice(0, 5) }))
      .sort((a, b) => b.amount - a.amount || a.interest.localeCompare(b.interest)).slice(0, 5);
    summary.direct_campaign.pac_money_basis = "reported_itemized_committee_cash_contributions";
    summary.direct_campaign.pac_money_coverage_note = `Gross positive itemized PAC/Party cash receipts through ${first.period_end}. ` +
      "Loans, in-kind gifts, unnamed aggregates and separately reported expenditure-side returns are excluded; this is not a net position or all PAC money. " +
      `Names/classes are reported labels, not proof of registration identity. Observed ${new Date(first.observed_at).toISOString().slice(0, 10)}; other totals may cover different reports.`;
  }
}
