import type { Pool, PoolClient } from "pg";
import type { BallotLookupFinanceSummary, BallotLookupFinancePacInterest } from "../address/ballotLookupFinanceShared.js";
import { classifyPacInterest, isPacInterestSlug, pacInterestDisplayName, UNCLASSIFIED_PAC_INTEREST, PAC_INTERESTS_NOT_LISTED } from "../finance/pacInterestClassifier.js";
import { WISCONSIN_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./wisconsinFinanceEligibleOffices.js";
import { WI_CASH_SOURCE_MATCH_SQL } from "./wisconsinReportedCashSql.js";

type Row = {
  candidate_id: string; election_id: string; election_year: number; observed_at: string;
  regular_coverage_through: string; group_count: number; cash_cents: string;
  committee_id: string | null; committee_name: string | null; amount_cents: string | null;
  contribution_count: number | null; evidence_type: string | null; source_url: string;
  industry_slug: string | null; classification_source: string | null; confidence: string | null;
};
export const WISCONSIN_UNVERIFIED_IE_NOTE = "Wisconsin candidate-specific independent-expenditure allocations and current filing versions have not been verified. Outside-spending coverage remains unknown.";
function integer(value: unknown): number | null {
  if ((typeof value !== "string" && typeof value !== "number") || !/^-?(?:0|[1-9]\d*)$/.test(String(value))) return null;
  const n = Number(value); return Number.isSafeInteger(n) ? n : null;
}
/** Reader admission checks the complete stored snapshot before display limits.
 * Missing or inconsistent rows leave any existing summary unchanged. */
export async function appendWisconsinCommitteeCashSummaries(
  db: Pick<Pool | PoolClient,"query">, requests: readonly { candidate_id: string; election_id: string }[],
  summaries: Map<string,BallotLookupFinanceSummary>,
): Promise<void> {
  if (!requests.length) return;
  const result = await db.query<Row>(`WITH requested AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(candidate_id uuid,election_id uuid)
    ) SELECT ce.candidate_id::text,ce.election_id::text,s.election_year,s.observed_at::text,
      s.regular_coverage_through::text,s.group_count,s.cash_cents::text,
      cash.committee_id,cash.committee_name,cash.amount_cents::text,cash.contribution_count,cash.evidence_type,
      COALESCE(cash.source_url,s.source_url) source_url,
      label.industry_slug,label.classification_source,label.confidence
    FROM requested r JOIN public.candidate_elections ce ON ce.candidate_id=r.candidate_id AND ce.election_id=r.election_id
    JOIN public.candidates c ON c.id=ce.candidate_id
    JOIN public.elections e ON e.id=ce.election_id
    JOIN public.districts d ON d.id=e.district_id
    JOIN public.offices o ON o.id=e.office_id
    JOIN public.wi_candidate_finance_reported_cash_sources s ON s.candidate_id=ce.candidate_id AND s.election_id=ce.election_id
      AND (${WI_CASH_SOURCE_MATCH_SQL})
    LEFT JOIN public.wi_candidate_finance_reported_cash_donors cash ON cash.candidate_id=s.candidate_id AND cash.election_id=s.election_id
    LEFT JOIN public.finance_label_classifications label ON label.label_type='committee'
      AND label.normalized_label=public.normalize_finance_label(cash.committee_name)
    WHERE c.deleted_at IS NULL AND ce.status NOT IN ('withdrawn','lost')
      AND d.state='WI' AND e.race_type='office' AND e.election_stage='general'
      AND (o.scope||'::'||o.canonical_name)=ANY($2::text[])
    ORDER BY ce.candidate_id,ce.election_id,cash.amount_cents DESC,cash.committee_name`,
    [JSON.stringify(requests),WISCONSIN_FINANCE_ELIGIBLE_OFFICE_KEYS]);
  const candidates = new Map<string,Row[]>();
  for (const row of result.rows) {
    const key = `${row.candidate_id}\u0000${row.election_id}`, group = candidates.get(key) ?? [];
    group.push(row); candidates.set(key,group);
  }
  for (const [key, rows] of candidates) {
    const first = rows[0]!, expectedCount = integer(first.group_count), expectedTotal = integer(first.cash_cents), stamp = Date.parse(first.observed_at);
    if (expectedCount === null || expectedCount < 0 || expectedTotal === null || !Number.isFinite(stamp)) continue;
    const donors = rows.filter(r => r.committee_id !== null), ids = new Set(donors.map(r => r.committee_id));
    if (donors.length !== expectedCount || ids.size !== donors.length) continue;
    let total = 0, valid = true;
    for (const row of rows) {
      if (integer(row.group_count) !== expectedCount || integer(row.cash_cents) !== expectedTotal || row.observed_at !== first.observed_at) valid = false;
    }
    for (const row of donors) {
      const cents = integer(row.amount_cents), count = integer(row.contribution_count);
      if (cents === null || count === null || count < 0 || !row.committee_name?.trim()
        || !["native_registry_class","reported_pac_name"].includes(row.evidence_type??"")) { valid = false; break; }
      total += cents; if (!Number.isSafeInteger(total)) valid = false;
    }
    if (!valid || total !== expectedTotal) continue;
    const groups = new Map<string,{ cents: number; group: BallotLookupFinancePacInterest }>();
    for (const row of donors) {
      const trusted = row.industry_slug && isPacInterestSlug(row.industry_slug)
        && (row.classification_source === "manual" || (row.confidence === "high" && ["rule","ai"].includes(row.classification_source??""))) ? row.industry_slug : null;
      const interest = trusted ?? classifyPacInterest({ committeeName: row.committee_name!,committeeType: null,
        designation: null,organizationType: null,connectedOrganization: null }).interestSlug ?? UNCLASSIFIED_PAC_INTEREST;
      if ((PAC_INTERESTS_NOT_LISTED as readonly string[]).includes(interest)) continue;
      const group = groups.get(interest) ?? { cents: 0,group: { interest,interest_name: pacInterestDisplayName(interest),amount: 0,pac_count: 0,pacs: [] } };
      group.cents += integer(row.amount_cents)!;
      if (!Number.isSafeInteger(group.cents)) { valid = false; break; }
      group.group.pac_count++;
      group.group.pacs.push({ committee_id: row.committee_id!,committee_name: row.committee_name!,amount: integer(row.amount_cents)!/100,source_url: row.source_url });
      groups.set(interest,group);
    }
    if (!valid) continue;
    const clock = new Date(stamp).toISOString();
    const summary: BallotLookupFinanceSummary = summaries.get(key) ?? {
      source: "WISCONSIN_SUNSHINE",cycle: first.election_year,fec_candidate_id: null,last_synced_at: clock,
      direct_campaign: { total_raised: null,total_spent: null,cash_on_hand: null,debts_owed: null,top_occupations: [],top_employers: [],top_industries: [] },
      outside_spending: { support_total: null,oppose_total: null,top_supporting_groups: [],top_opposing_groups: [],top_supporting_industries: [],top_opposing_industries: [] },
      backing_summary: { top_direct_donor_occupations: [],top_outside_supporting_industries: [] },
    } satisfies BallotLookupFinanceSummary;
    summary.direct_campaign.pac_money_by_interest = [...groups.values()].map(({ cents,group }) => ({ ...group,amount: cents/100,pacs: group.pacs.slice(0,5) }))
      .sort((a,b) => b.amount-a.amount || a.interest.localeCompare(b.interest)).slice(0,5);
    summary.direct_campaign.pac_money_basis = "reported_committee_monetary_positions";
    summary.direct_campaign.pac_money_coverage_note = `Reported ${first.election_year-1}–${first.election_year} committee cash, net of reported returns. Recognized registry classes and explicit PAC names form a limited subset, not all PAC money or proof of legal registration. In-kind gifts, loans and other income are excluded. Regular reports end ${first.regular_coverage_through}; later filed notices are included. Observed ${clock.slice(0,10)}; other totals may cover different reports.`;
    if (summary.outside_spending.support_total === 0 && !summary.outside_spending.top_supporting_groups.length) summary.outside_spending.support_total = null;
    if (summary.outside_spending.oppose_total === 0 && !summary.outside_spending.top_opposing_groups.length) summary.outside_spending.oppose_total = null;
    summary.outside_spending.outside_coverage_note = WISCONSIN_UNVERIFIED_IE_NOTE;
    summaries.set(key,summary);
  }
}
