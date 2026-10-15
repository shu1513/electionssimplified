import type { Pool, PoolClient } from "pg";
import {
  candidateElectionKey, parseFinanceAmount,
  type BallotLookupFinancePacInterest, type BallotLookupFinanceSummary, type StateFinanceSummaryRequest,
} from "../address/ballotLookupFinanceShared.js";
import { classifyFinanceLabel } from "../finance/financeLabelClassifier.js";
import { PAC_INTERESTS_NOT_LISTED, PAC_INTEREST_SLUGS, UNCLASSIFIED_PAC_INTEREST, pacInterestDisplayName } from "../finance/pacInterestClassifier.js";

type CashRow = {
  candidate_id: string; election_id: string; election_year: number;
  receiving_committee_id: string; source_observed_at: string;
  excluded_unknown_class_row_count: string | number;
  reported_committee_id: string | null; reported_committee_name: string | null;
  amount: string | number | null; source_url: string;
  industry_slug: string | null; classification_source: string | null; confidence: string | null;
};

/** Existing interest taxonomy, applied only after the native source supplies the role. */
export function groupMinnesotaCommitteeCashByInterest(rows: readonly CashRow[]): Map<string, BallotLookupFinancePacInterest[]> {
  const grouped = new Map<string, Map<string, BallotLookupFinancePacInterest>>();
  for (const row of rows) {
    if (!row.reported_committee_id || !row.reported_committee_name) continue;
    const amount = parseFinanceAmount(row.amount);
    if (amount === null || amount <= 0) continue;
    const rule = classifyFinanceLabel({ rawLabel: row.reported_committee_name, labelType: "committee" });
    const trusted = row.industry_slug && (row.classification_source === "manual" ||
      (row.confidence === "high" && ["rule", "ai"].includes(row.classification_source ?? ""))) ? row.industry_slug : null;
    const proposed = trusted ?? (rule.classificationSource === "rule" && rule.confidence === "high" ? rule.industrySlug : null);
    const interest = proposed && (PAC_INTEREST_SLUGS as readonly string[]).includes(proposed) &&
      !(PAC_INTERESTS_NOT_LISTED as readonly string[]).includes(proposed) ? proposed : UNCLASSIFIED_PAC_INTEREST;
    const key = candidateElectionKey(row.candidate_id, row.election_id);
    const interests = grouped.get(key) ?? new Map<string, BallotLookupFinancePacInterest>();
    const group = interests.get(interest) ?? { interest, interest_name: pacInterestDisplayName(interest), amount: 0, pac_count: 0, pacs: [] };
    group.amount = Math.round((group.amount + amount) * 100) / 100;
    const existing = group.pacs.find((donor) => donor.committee_id === row.reported_committee_id &&
      donor.committee_name === row.reported_committee_name);
    if (existing) existing.amount = Math.round((existing.amount + amount) * 100) / 100;
    else {
      group.pac_count += 1;
      group.pacs.push({ committee_id: row.reported_committee_id, committee_name: row.reported_committee_name,
        amount, source_url: row.source_url });
    }
    interests.set(interest, group);
    grouped.set(key, interests);
  }
  return new Map([...grouped].map(([key, interests]) => [key, [...interests.values()].map((group) => ({ ...group,
    pacs: group.pacs.sort((a, b) => b.amount - a.amount || a.committee_id.localeCompare(b.committee_id) ||
      a.committee_name.localeCompare(b.committee_name)).slice(0, 5),
  })).sort((a, b) => b.amount - a.amount || a.interest.localeCompare(b.interest))]));
}

export async function addMinnesotaCommitteeCashToSummaries(
  db: Pick<Pool | PoolClient, "query">, requests: readonly StateFinanceSummaryRequest[],
  summaries: Map<string, BallotLookupFinanceSummary>,
): Promise<Map<string, BallotLookupFinanceSummary>> {
  if (!requests.length) return summaries;
  const result = await db.query<CashRow>(`
    WITH requested AS (
      SELECT candidate_id::uuid, election_id::uuid FROM jsonb_to_recordset($1::jsonb)
      x(candidate_id text,election_id text)
    ), positions AS (
      SELECT requested.candidate_id::text, requested.election_id::text, link.election_year,
        link.committee_id AS receiving_committee_id, source.source_observed_at::text,
        source.excluded_unknown_class_row_count, donor.reported_committee_id, donor.reported_committee_name,
        donor.amount, source.source_url
      FROM requested
      JOIN public.mn_candidate_finance_links link ON link.candidate_id=requested.candidate_id
        AND link.election_id=requested.election_id AND link.link_status='active'
      JOIN public.mn_candidate_finance_pac_sources source ON source.link_id=link.id
        AND source.election_year=link.election_year
        AND source.basis='reported_itemized_committee_cash_contributions'
      LEFT JOIN public.mn_candidate_finance_pac_donors donor ON donor.link_id=source.link_id
        AND donor.election_year=source.election_year AND donor.source_sha256=source.source_sha256
        AND donor.reported_type='Political Committee/Fund'
    ) SELECT positions.*, classification.industry_slug, classification.classification_source, classification.confidence
    FROM positions LEFT JOIN public.finance_label_classifications classification
      ON classification.label_type='committee'
      AND classification.normalized_label=public.normalize_finance_label(positions.reported_committee_name)
    ORDER BY candidate_id,election_id,amount DESC,reported_committee_name`, [JSON.stringify(requests)]);
  const interests = groupMinnesotaCommitteeCashByInterest(result.rows);
  const sources = new Map<string, Map<string, CashRow>>();
  for (const row of result.rows) {
    const key = candidateElectionKey(row.candidate_id, row.election_id);
    const receivers = sources.get(key) ?? new Map<string, CashRow>();
    receivers.set(row.receiving_committee_id, row);
    sources.set(key, receivers);
  }
  for (const [key, receivers] of sources) {
    const rows = [...receivers.values()];
    const row = rows[0]!;
    const observations = [...new Set(rows.map((source) => new Date(source.source_observed_at).toISOString()))].sort();
    // Without a headline snapshot, the card's displayed update reflects the
    // source observation. Replaying cached bytes must not imply fresher money;
    // the source table separately retains the actual writer last_synced_at.
    const summary = summaries.get(key) ?? {
      source: "MINNESOTA_CFB", cycle: row.election_year, fec_candidate_id: null,
      controlled_committee_id: rows.length === 1 ? row.receiving_committee_id : null,
      last_synced_at: observations[0]!,
      direct_campaign: { total_raised: null, total_spent: null, cash_on_hand: null, debts_owed: null,
        top_occupations: [], top_employers: [], top_industries: [], contribution_size_buckets: [] },
      outside_spending: { support_total: null, oppose_total: null, top_supporting_groups: [], top_opposing_groups: [],
        top_supporting_industries: [], top_opposing_industries: [] },
      backing_summary: { top_direct_donor_occupations: [], top_outside_supporting_industries: [] },
    } satisfies BallotLookupFinanceSummary;
    summary.direct_campaign.pac_money_by_interest = interests.get(key) ?? [];
    summary.direct_campaign.pac_money_basis = "reported_itemized_committee_cash_contributions";
    // One sentence, like direct_coverage_note. Row counts and acquisition times stay in the source table.
    summary.direct_campaign.pac_money_coverage_note =
      `Itemized cash from Minnesota political committees and funds reported for ${row.election_year - 1}–${row.election_year}; ` +
      "other donors, unitemized gifts, in-kind gifts and later returns are not included.";
    summaries.set(key, summary);
  }
  return summaries;
}
