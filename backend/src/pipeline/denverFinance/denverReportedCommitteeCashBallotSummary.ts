import type { Pool, PoolClient } from "pg";
import { candidateElectionKey, type BallotLookupFinancePacInterest, type BallotLookupFinanceSummary } from "../address/ballotLookupFinanceShared.js";
import { classifyPacInterest, isPacInterestSlug, pacInterestDisplayName, PAC_INTERESTS_NOT_LISTED, UNCLASSIFIED_PAC_INTEREST } from "../finance/pacInterestClassifier.js";
import { parseDenverAtLargeSeatLetter, DENVER_2026_VACANCY_ELECTION_DATE } from "./denverFinanceEligibleOffices.js";
import { normalizeDenverTextKey } from "./denverCandidateCommitteeResolver.js";

const SOURCE_URL = "https://denver.maplight.com/public/transaction-search";
type Row = {
  candidate_id: string; election_id: string; candidate_name: string; candidate_name_normalized: string;
  office_name: string; official_ballot_title: string | null; district: string | null;
  amount_cents: string; contribution_count: number; group_count: number; transaction_through: string | null; observed_at: string;
  committee_key: string | null; committee_name: string | null; donor_cents: string | null; donor_count: number | null;
  industry_slug: string | null; classification_source: string | null; confidence: string | null;
};
const cents = (raw: string): number | null => /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null;

/** Close every stored reported group against its source counts/cents before
 * classification or display caps. Invalid evidence omits this component.
 */
export async function appendDenverReportedCommitteeCash(
  db: Pick<Pool | PoolClient, "query">, summaries: Map<string, BallotLookupFinanceSummary>,
): Promise<void> {
  if (!summaries.size) return;
  const requested = [...summaries.keys()].map(key => {
    const [candidate_id, election_id] = key.split("\u0000"); return { candidate_id, election_id };
  });
  const result = await db.query<Row>(`WITH requested AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) r(candidate_id uuid,election_id uuid)
    ) SELECT link.candidate_id::text,link.election_id::text,link.candidate_name_normalized,
      COALESCE(NULLIF(trim(candidate.display_name),''),trim(candidate.first_name||' '||candidate.last_name)) candidate_name,
      office.canonical_name office_name,election.official_ballot_title,link.district,
      source.amount_cents::text,source.contribution_count,source.group_count,source.transaction_through::text,source.observed_at::text,
      donor.committee_key,donor.committee_name,donor.amount_cents::text donor_cents,donor.contribution_count donor_count,
      label.industry_slug,label.classification_source,label.confidence
    FROM requested JOIN public.denver_candidate_finance_links link ON link.candidate_id=requested.candidate_id
      AND link.election_id=requested.election_id AND link.link_status='active'
    JOIN public.candidates candidate ON candidate.id=link.candidate_id
    JOIN public.candidate_elections roster ON roster.candidate_id=link.candidate_id AND roster.election_id=link.election_id
    JOIN public.elections election ON election.id=link.election_id
    JOIN public.districts district ON district.id=election.district_id JOIN public.offices office ON office.id=election.office_id
    JOIN public.denver_candidate_finance_pac_sources source ON source.link_id=link.id AND source.election_year=link.election_year
    LEFT JOIN public.denver_candidate_finance_pac_donors donor ON donor.link_id=source.link_id AND donor.election_year=source.election_year
    LEFT JOIN public.finance_label_classifications label ON label.label_type='committee'
      AND label.normalized_label=public.normalize_finance_label(donor.committee_name)
    WHERE candidate.deleted_at IS NULL AND roster.status NOT IN ('withdrawn','lost')
      AND district.state='CO' AND district.district_type='place' AND district.geoid_compact='0820000'
      AND office.scope='place' AND office.canonical_name='City Council Member'
      AND election.race_type='office' AND election.election_date=ANY($2::date[])
      AND extract(year FROM election.election_date)::integer=link.election_year AND link.office_name=office.canonical_name
      AND (SELECT count(*) FROM public.denver_candidate_finance_links sibling WHERE sibling.link_status='active' AND
        ((sibling.candidate_id=link.candidate_id AND sibling.election_id=link.election_id) OR
         (sibling.filer_id=link.filer_id AND sibling.election_year=link.election_year)))=1
    ORDER BY link.candidate_id,link.election_id,donor.amount_cents DESC NULLS LAST,donor.committee_key`,
  [JSON.stringify(requested), [DENVER_2026_VACANCY_ELECTION_DATE]]);
  const candidates = new Map<string, Row[]>();
  for (const row of result.rows) {
    const key = candidateElectionKey(row.candidate_id, row.election_id);
    candidates.set(key, [...(candidates.get(key) ?? []), row]);
  }
  for (const [key, rows] of candidates) {
    const first = rows[0]!, expected = cents(first.amount_cents), seen = new Set<string>();
    const seat = parseDenverAtLargeSeatLetter(first.official_ballot_title);
    let invalid = seat !== "B" ||
      normalizeDenverTextKey(first.candidate_name) !== first.candidate_name_normalized ||
      first.transaction_through !== null && !/^\d{4}-\d{2}-\d{2}$/.test(first.transaction_through) || !Number.isFinite(Date.parse(first.observed_at));
    let total = 0, gifts = 0;
    const interests = new Map<string, BallotLookupFinancePacInterest>();
    const totals = new Map<string, number>();
    for (const row of rows) {
      if (row.committee_key === null) continue;
      const amount = row.donor_cents === null ? null : cents(row.donor_cents);
      if (amount === null || amount <= 0 || !row.committee_name || seen.has(row.committee_key) ||
        row.committee_key !== normalizeDenverTextKey(row.committee_name) ||
        !Number.isSafeInteger(row.donor_count) || row.donor_count! <= 0) { invalid = true; continue; }
      seen.add(row.committee_key); total += amount; gifts += row.donor_count!;
      const stored = row.industry_slug && isPacInterestSlug(row.industry_slug) && (row.classification_source === "manual" ||
        row.confidence === "high" && ["rule", "ai"].includes(row.classification_source ?? "")) ? row.industry_slug : null;
      const interest = stored ?? classifyPacInterest({ committeeName: row.committee_name, committeeType: null,
        designation: null, organizationType: null, connectedOrganization: null }).interestSlug ?? UNCLASSIFIED_PAC_INTEREST;
      if ((PAC_INTERESTS_NOT_LISTED as readonly string[]).includes(interest)) continue;
      const group = interests.get(interest) ?? { interest, interest_name: pacInterestDisplayName(interest), amount: 0, pac_count: 0, pacs: [] };
      totals.set(interest, (totals.get(interest) ?? 0) + amount); group.amount = totals.get(interest)! / 100; group.pac_count++;
      group.pacs.push({ committee_id: `reported:${row.committee_key}`, committee_name: row.committee_name, amount: amount / 100, source_url: SOURCE_URL });
      interests.set(interest, group);
    }
    if (invalid || expected === null || !Number.isSafeInteger(total) || !Number.isSafeInteger(gifts) || total !== expected ||
      gifts !== first.contribution_count || seen.size !== first.group_count || total > 0 && interests.size === 0) continue;
    const summary = summaries.get(key);
    if (!summary) continue;
    summary.direct_campaign.pac_money_by_interest = [...interests.values()].map(group => ({ ...group,
      pacs: group.pacs.sort((a, b) => b.amount - a.amount || a.committee_name.localeCompare(b.committee_name)).slice(0, 5) }))
      .sort((a, b) => b.amount - a.amount || a.interest.localeCompare(b.interest)).slice(0, 5);
    summary.direct_campaign.pac_money_basis = "reported_itemized_committee_cash_contributions";
    summary.direct_campaign.pac_money_coverage_note = "Gross positive monetary receipts identified by reported Committee contact type or explicit political Organization names with blank occupations. " +
      "Generic organizations, in-kind gifts, loans and public matching are excluded. Reported labels are not registry identities; this is not a net position or all PAC money. " +
      (first.transaction_through ? `Transaction feed dated through ${first.transaction_through}. ` : "") +
      `Observed ${new Date(first.observed_at).toISOString().slice(0, 10)}; other totals may cover different reports.`;
  }
}
