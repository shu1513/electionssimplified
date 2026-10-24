import type { Pool, PoolClient } from "pg";
import { candidateElectionKey, type BallotLookupFinancePacInterest, type BallotLookupFinanceSummary } from "../address/ballotLookupFinanceShared.js";
import { classifyPacInterest, isPacInterestSlug, pacInterestDisplayName, PAC_INTERESTS_NOT_LISTED, UNCLASSIFIED_PAC_INTEREST } from "../finance/pacInterestClassifier.js";
import { isSanDiegoCityFinanceEligibleElection, parseSanDiegoCityCouncilSeatNumber } from "./sanDiegoCityFinanceEligibleOffices.js";
import { normalizeSanDiegoCityTextKey } from "./sanDiegoCityCandidateCommitteeResolver.js";
import { sanDiegoCommitteeKey } from "./sanDiegoCityCommitteeCash.js";

const SOURCE_URL = "https://efile.sandiego.gov";
type Row = {
  candidate_id: string; election_id: string; candidate_name: string; candidate_name_normalized: string;
  office_name: string; official_ballot_title: string | null; seat_number: number | null;
  state: string; district_type: string; geoid_compact: string; office_scope: string;
  amount_cents: string; contribution_count: number; group_count: number; reported_through: string | null; observed_at: string;
  committee_key: string | null; committee_id: string | null; contributor_type: string | null; committee_name: string | null; donor_cents: string | null; donor_count: number | null;
  industry_slug: string | null; classification_source: string | null; confidence: string | null;
};
const cents = (raw: string): number | null => /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null;

/** Close every stored reported group against its source counts/cents before
 * classification or display caps. Invalid evidence omits this component.
 */
export async function appendSanDiegoCityCommitteeCash(
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
      office.canonical_name office_name,election.official_ballot_title,source.seat_number,
      district.state,district.district_type,district.geoid_compact,office.scope office_scope,
      source.amount_cents::text,source.contribution_count,source.group_count,source.reported_through::text,source.observed_at::text,
      donor.committee_key,donor.committee_id,donor.contributor_type,donor.committee_name,donor.amount_cents::text donor_cents,donor.contribution_count donor_count,
      label.industry_slug,label.classification_source,label.confidence
    FROM requested JOIN public.sdcity_candidate_finance_links link ON link.candidate_id=requested.candidate_id
      AND link.election_id=requested.election_id AND link.link_status='active'
    JOIN public.candidates candidate ON candidate.id=link.candidate_id
    JOIN public.candidate_elections roster ON roster.candidate_id=link.candidate_id AND roster.election_id=link.election_id
    JOIN public.elections election ON election.id=link.election_id
    JOIN public.districts district ON district.id=election.district_id JOIN public.offices office ON office.id=election.office_id
    JOIN public.sdcity_candidate_finance_pac_sources source ON source.link_id=link.id AND source.election_year=link.election_year
    LEFT JOIN public.sdcity_candidate_finance_pac_donors donor ON donor.link_id=source.link_id AND donor.election_year=source.election_year
    LEFT JOIN public.finance_label_classifications label ON label.label_type='committee'
      AND label.normalized_label=public.normalize_finance_label(donor.committee_name)
    WHERE candidate.deleted_at IS NULL AND roster.status NOT IN ('withdrawn','lost')
      AND district.state='CA' AND district.district_type='place' AND district.geoid_compact='0666000'
      AND office.scope='place' AND office.canonical_name IN ('Mayor','City Council Member')
      AND election.race_type='office' AND extract(year FROM election.election_date)::integer=link.election_year
      AND source.office_name=office.canonical_name AND source.receiving_fppc_id=link.fppc_id
      AND (SELECT count(*) FROM public.sdcity_candidate_finance_links sibling WHERE sibling.link_status='active'
        AND sibling.candidate_id=link.candidate_id AND sibling.election_id=link.election_id)=1
      AND NOT EXISTS (SELECT 1 FROM public.sdcity_candidate_finance_links sibling WHERE sibling.link_status='active'
        AND sibling.election_year=link.election_year AND sibling.candidate_id<>link.candidate_id AND sibling.fppc_id=link.fppc_id)
    ORDER BY link.candidate_id,link.election_id,donor.amount_cents DESC NULLS LAST,donor.committee_key`,
  [JSON.stringify(requested)]);
  const candidates = new Map<string, Row[]>();
  for (const row of result.rows) {
    const key = candidateElectionKey(row.candidate_id, row.election_id);
    candidates.set(key, [...(candidates.get(key) ?? []), row]);
  }
  for (const [key, rows] of candidates) {
    const first = rows[0]!, expected = cents(first.amount_cents), seen = new Set<string>();
    const seat = first.office_name === "City Council Member" ? parseSanDiegoCityCouncilSeatNumber(first.official_ballot_title) : null;
    let invalid = !isSanDiegoCityFinanceEligibleElection({ state:first.state,districtType:first.district_type,geoidCompact:first.geoid_compact,
      officeScope:first.office_scope,officeCanonicalName:first.office_name,officialBallotTitle:first.official_ballot_title }) || seat !== first.seat_number ||
      normalizeSanDiegoCityTextKey(first.candidate_name) !== first.candidate_name_normalized ||
      first.reported_through !== null && !/^\d{4}-\d{2}-\d{2}$/.test(first.reported_through) || !Number.isFinite(Date.parse(first.observed_at));
    let total = 0, gifts = 0;
    const interests = new Map<string, BallotLookupFinancePacInterest>();
    const totals = new Map<string, number>();
    for (const row of rows) {
      if (row.committee_key === null) continue;
      const amount = row.donor_cents === null ? null : cents(row.donor_cents);
      if (amount === null || amount <= 0 || !row.committee_name || seen.has(row.committee_key) ||
        !(["COM","PTY","SCC"] as readonly unknown[]).includes(row.contributor_type) ||
        row.committee_id !== null && !/^\d{4,12}$/.test(row.committee_id) ||
        row.committee_key !== sanDiegoCommitteeKey(row.committee_id,row.committee_name) ||
        !Number.isSafeInteger(row.donor_count) || row.donor_count! <= 0) { invalid = true; continue; }
      seen.add(row.committee_key); total += amount; gifts += row.donor_count!;
      const stored = row.industry_slug && isPacInterestSlug(row.industry_slug) && (row.classification_source === "manual" ||
        row.confidence === "high" && ["rule", "ai"].includes(row.classification_source ?? "")) ? row.industry_slug : null;
      const interest = stored ?? classifyPacInterest({ committeeName: row.committee_name, committeeType: null,
        designation: null, organizationType: null, connectedOrganization: null }).interestSlug ?? UNCLASSIFIED_PAC_INTEREST;
      if ((PAC_INTERESTS_NOT_LISTED as readonly string[]).includes(interest)) continue;
      const group = interests.get(interest) ?? { interest, interest_name: pacInterestDisplayName(interest), amount: 0, pac_count: 0, pacs: [] };
      totals.set(interest, (totals.get(interest) ?? 0) + amount); group.amount = totals.get(interest)! / 100; group.pac_count++;
      group.pacs.push({ committee_id: row.committee_id ?? row.committee_key, committee_name: row.committee_name, amount: amount / 100, source_url: SOURCE_URL });
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
    summary.direct_campaign.pac_money_coverage_note = "Gross positive non-memo Schedule A cash reported as recipient committee (COM), political party (PTY), or small contributor committee (SCC), using the same canonical e-filed reports as direct totals. " +
      "Own committee transfers, memos, unitemized receipts, in-kind gifts, loans, other entity types and standalone Form 497 notices are excluded. Reported names/IDs are not independently verified registry identities; this is not a net position or all PAC money, and paper/late filings may be absent. " +
      (first.reported_through ? `Published ledger through ${first.reported_through}. ` : "") +
      `Observed ${new Date(first.observed_at).toISOString().slice(0,10)}; other totals may cover different reports.`;
  }
}
