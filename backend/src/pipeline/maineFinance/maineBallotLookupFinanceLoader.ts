import type { Pool, PoolClient } from "pg";

import { isMaineCampaignFinanceEnabled } from "../../config/featureFlags.js";
import {
  officeInputFromElectionRow,
  candidateElectionKey,
  firstNonEmptySourceUrl,
  type BallotLookupFinancePacInterest,
  type BallotLookupFinanceOutsideGroup,
  type BallotLookupFinanceSummary,
  type StateFinanceRequestCandidateRow,
  type StateFinanceRequestElectionRow,
} from "../address/ballotLookupFinanceShared.js";
import { loadStandardStateFinanceSummariesByCandidateElection } from "../finance/standardStateFinanceBallotLookupLoader.js";
import { isMaineFinanceEligibleOffice } from "./maineFinanceEligibleOffices.js";
import { classifyFinanceLabel } from "../finance/financeLabelClassifier.js";
import { PAC_INTERESTS_NOT_LISTED, pacInterestDisplayName, isPacInterestSlug, UNCLASSIFIED_PAC_INTEREST } from "../finance/pacInterestClassifier.js";

type Queryable = Pick<Pool | PoolClient, "query">;

const GENERIC_MAINE_CFIS_SOURCE_URL = "https://mainecampaignfinance.com/";
const MAPLIGHT_SOURCE_URL = "https://www.mainecampaignfinancedisclosure.com/public";

type MarkerRow = {
  candidate_id: string; election_id: string; election_year: number;
  component: "committee_donors" | "independent_expenditures";
  source_calendar_year: number;
  period_end: string; observed_at: string; published_source_times: unknown;
};
type DonorRow = {
  candidate_id: string; election_id: string; source_filer_id: string;
  source_calendar_year: number; committee_id: string; committee_name: string;
  source_reported_class: string; amount: string | number; contribution_count: string | number;
  gift_transaction_ids: unknown; returned_transaction_ids: unknown; source_url: string | null;
  industry_slug: string | null; classification_source: string | null; confidence: string | null;
};
type AllocationRow = {
  candidate_id: string; election_id: string; transaction_id: string;
  target_filer_id: string; payer_id: string; payer_name: string;
  support_oppose: "support" | "oppose"; transaction_date: string;
  amount: string | number; whole_amount: string | number; source_url: string | null;
};
function cents(value: string | number): number | null {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) return null;
  const magnitude = BigInt(match[2]) * 100n + BigInt((match[3] ?? "").padEnd(2, "0"));
  if (magnitude > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const result = Number(magnitude) * (match[1] ? -1 : 1);
  const canonical = `${magnitude / 100n}.${String(magnitude % 100n).padStart(2, "0")}`;
  return Math.abs(result / 100).toFixed(2) === canonical ? result : null;
}
function identityIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some(id => typeof id !== "string" || !/^a_[a-z0-9]{26}$/.test(id)) || new Set(value).size !== value.length) return null;
  return [...value].sort();
}
function sourceTimingNote(rows: readonly MarkerRow[]): string {
  const cutoffs = [...new Set(rows.map(row => row.period_end).filter(value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)))].sort();
  const observed = [...new Set(rows.map(row => row.observed_at).filter(value => typeof value === "string" && Number.isFinite(Date.parse(value))))].sort();
  const published = new Set<string>();
  for (const row of rows) {
    if (!row.published_source_times || typeof row.published_source_times !== "object") continue;
    const times = row.published_source_times as Record<string, unknown>;
    for (const [key, label] of [["allFiler", "All-filer publication"], ["independentExpenditures", "Independent-expenditure publication"]]) {
      const value = times[key];
      if (typeof value === "string" && value.trim() && value.length <= 120) published.add(`${label}: ${value}`);
    }
  }
  return [cutoffs.length ? `Published source cutoff: ${cutoffs.join(", ")}.` : "", ...[...published].sort().map(value => `${value}.`), observed.length ? `Source observed: ${observed.join(", ")}.` : ""].filter(Boolean).join(" ");
}
function directNote(year: number, rows: readonly MarkerRow[]): string {
  return `Committee donor entries cover published ${year} itemized cash records only; ${year - 1} coverage is unknown. They are source-reported PAC and party names, not verified legal committee identities. Returns are netted within this subset; it is not the full-cycle Raised total. ${sourceTimingNote(rows)}`.trim();
}
function outsideNote(year: number, rows: readonly MarkerRow[]): string {
  return `Allocated outside entries cover the published ${year} itemized dataset only; ${year - 1} and other unavailable coverage remain unknown. Overall outside-spending totals are unavailable, not zero. Previously stored groups are retained. ${sourceTimingNote(rows)}`.trim();
}
function appendNote(existing: string | null | undefined, note: string): string {
  return existing ? `${existing} ${note}` : note;
}
function requestedKeys(summaries: Map<string, BallotLookupFinanceSummary>) {
  return [...summaries.keys()].map(key => { const [candidate_id, election_id] = key.split("\u0000"); return { candidate_id, election_id }; });
}
function pacInterests(rows: readonly DonorRow[]): Map<string, BallotLookupFinancePacInterest[]> {
  const positions = new Map<string, Map<string, { row: DonorRow; cents: number; fingerprint: string }>>();
  const invalid = new Set<string>();
  for (const row of rows) {
    const key = candidateElectionKey(row.candidate_id, row.election_id);
    const amount = cents(row.amount), gifts = identityIds(row.gift_transaction_ids), returns = identityIds(row.returned_transaction_ids);
    if (amount === null || !gifts || !returns || !["political_action_committee", "political_party_committee"].includes(row.source_reported_class) || row.committee_id !== `reported:${row.committee_name.normalize("NFKC").trim().replace(/\s+/gu, " ").toUpperCase()}` || !Number.isSafeInteger(Number(row.contribution_count)) || Number(row.contribution_count) < 0) { invalid.add(key); continue; }
    const receiverKey = JSON.stringify([row.source_filer_id, row.source_calendar_year, row.committee_id]);
    const fingerprint = JSON.stringify([row.committee_name, row.source_reported_class, amount, Number(row.contribution_count), gifts, returns]);
    const list = positions.get(key) ?? new Map();
    const previous = list.get(receiverKey);
    if (previous && previous.fingerprint !== fingerprint) invalid.add(key);
    else list.set(receiverKey, { row, cents: amount, fingerprint });
    positions.set(key, list);
  }
  const result = new Map<string, BallotLookupFinancePacInterest[]>();
  for (const [key, list] of positions) {
    if (invalid.has(key)) continue;
    const donors = new Map<string, { row: DonorRow; cents: number }>();
    for (const position of list.values()) {
      const old = donors.get(position.row.committee_id), amount = (old?.cents ?? 0) + position.cents;
      if (!Number.isSafeInteger(amount)) { invalid.add(key); break; }
      donors.set(position.row.committee_id, { row: old?.row ?? position.row, cents: amount });
    }
    if (invalid.has(key)) continue;
    const groups = new Map<string, BallotLookupFinancePacInterest>();
    for (const donor of donors.values()) {
      if (donor.cents <= 0) continue;
      const row = donor.row, rule = classifyFinanceLabel({ rawLabel: row.committee_name, labelType: "committee" });
      const stored = row.industry_slug && (row.classification_source === "manual" || row.confidence === "high" && ["rule", "ai"].includes(row.classification_source ?? "")) ? row.industry_slug : null;
      const classified = stored ?? (rule.classificationSource === "rule" && rule.confidence === "high" ? rule.industrySlug : null);
      // Interest-name inference cannot demote an explicitly source-typed committee.
      const interest = !classified || !isPacInterestSlug(classified) || PAC_INTERESTS_NOT_LISTED.includes(classified) ? UNCLASSIFIED_PAC_INTEREST : classified;
      const group = groups.get(interest) ?? { interest, interest_name: pacInterestDisplayName(interest), amount: 0, pac_count: 0, pacs: [] };
      const sum = Math.round(group.amount * 100) + donor.cents;
      if (!Number.isSafeInteger(sum) || cents(sum / 100) !== sum) { invalid.add(key); break; }
      group.amount = sum / 100; group.pac_count += 1;
      group.pacs.push({ committee_id: row.committee_id, committee_name: row.committee_name, amount: donor.cents / 100, source_url: firstNonEmptySourceUrl(row.source_url, MAPLIGHT_SOURCE_URL) });
      groups.set(interest, group);
    }
    if (!invalid.has(key)) result.set(key, [...groups.values()].map(group => ({ ...group, pacs: group.pacs.sort((a,b) => b.amount - a.amount || a.committee_name.localeCompare(b.committee_name)).slice(0,5) })).sort((a,b) => b.amount - a.amount || a.interest.localeCompare(b.interest)).slice(0,5));
  }
  return result;
}
function outsideGroups(rows: readonly AllocationRow[]): Map<string, BallotLookupFinanceOutsideGroup[]> {
  const transactions = new Map<string, Map<string, AllocationRow>>(), invalid = new Set<string>();
  for (const row of rows) {
    const key = candidateElectionKey(row.candidate_id, row.election_id);
    if (cents(row.amount) === null || cents(row.whole_amount) === null || !["support", "oppose"].includes(row.support_oppose)) { invalid.add(key); continue; }
    const identity = JSON.stringify([row.transaction_id, row.target_filer_id, row.support_oppose]);
    const list = transactions.get(key) ?? new Map(), previous = list.get(identity);
    if (previous && JSON.stringify([previous.payer_id, previous.payer_name, previous.transaction_date, cents(previous.amount), cents(previous.whole_amount)]) !== JSON.stringify([row.payer_id, row.payer_name, row.transaction_date, cents(row.amount), cents(row.whole_amount)])) invalid.add(key);
    else list.set(identity, row);
    transactions.set(key, list);
  }
  const result = new Map<string, BallotLookupFinanceOutsideGroup[]>();
  for (const [key, list] of transactions) {
    if (invalid.has(key)) continue;
    const groups = new Map<string, BallotLookupFinanceOutsideGroup>();
    for (const row of list.values()) {
      const groupKey = JSON.stringify([row.payer_id, row.support_oppose]);
      const group = groups.get(groupKey) ?? { committee_id: row.payer_id, committee_name: row.payer_name, support_oppose: row.support_oppose, amount: 0, expenditure_count: 0, source_url: firstNonEmptySourceUrl(row.source_url, MAPLIGHT_SOURCE_URL) };
      const amount = Math.round(group.amount * 100) + cents(row.amount)!;
      if (!Number.isSafeInteger(amount) || cents(amount / 100) !== amount || group.committee_name !== row.payer_name) { invalid.add(key); break; }
      group.amount = amount / 100; group.expenditure_count = (group.expenditure_count ?? 0) + 1;
      groups.set(groupKey, group);
    }
    if (!invalid.has(key)) result.set(key, [...groups.values()].filter(group => group.amount > 0));
  }
  return result;
}

export async function loadMaineCandidateFinanceSummariesByCandidateElection(
  db: Queryable,
  candidateRows: readonly StateFinanceRequestCandidateRow[],
  electionRows: readonly StateFinanceRequestElectionRow[]
): Promise<Map<string, BallotLookupFinanceSummary>> {
  const summaries = await loadStandardStateFinanceSummariesByCandidateElection({
    db,
    candidateRows,
    electionRows,
    state: "ME",
    source: "MAINE_CFIS",
    sourceUrl: GENERIC_MAINE_CFIS_SOURCE_URL,
    enabled: isMaineCampaignFinanceEnabled,
    isEligibleElection: (row) => isMaineFinanceEligibleOffice(officeInputFromElectionRow(row)),
    evidenceLabelTypes: ["donor"],
    tables: {
      links: "me_candidate_finance_links",
      summaries: "me_candidate_finance_summaries",
      directBreakdowns: "me_candidate_finance_direct_breakdowns",
      outsideGroups: "me_candidate_finance_outside_groups",
      outsideGroupBreakdowns: "me_candidate_finance_outside_group_breakdowns",
    },
  });
  if (!summaries.size) return summaries;
  const selected = requestedKeys(summaries);
  const markers = await db.query<MarkerRow>(`
    WITH selected AS (
      SELECT candidate_id::uuid AS candidate_id, election_id::uuid AS election_id
      FROM jsonb_to_recordset($1::jsonb) AS x(candidate_id text, election_id text)
    ) SELECT DISTINCT selected.candidate_id::text AS candidate_id, selected.election_id::text AS election_id,
      marker.election_year, marker.component, marker.source_calendar_year, marker.period_end::text AS period_end,
      marker.observed_at::text AS observed_at, marker.published_source_times
    FROM selected JOIN public.me_candidate_finance_links link
      ON link.candidate_id = selected.candidate_id AND link.election_id = selected.election_id AND link.link_status = 'active'
    JOIN public.me_candidate_finance_source_markers marker
      ON marker.link_id = link.id AND marker.election_year = link.election_year
    WHERE marker.component IN ('committee_donors', 'independent_expenditures') AND marker.source_calendar_year = link.election_year`, [JSON.stringify(selected)]);
  const scoped = markers.rows.filter(row => summaries.get(candidateElectionKey(row.candidate_id, row.election_id))?.cycle === Number(row.election_year) && Number(row.source_calendar_year) === Number(row.election_year));
  const pacKeys = new Set<string>(), outsideKeys = new Set<string>();
  for (const row of scoped) {
    const key = candidateElectionKey(row.candidate_id, row.election_id), summary = summaries.get(key)!;
    // A published-year marker cannot turn a legacy stored zero into candidate-wide authority.
    summary.outside_spending.support_total = null; summary.outside_spending.oppose_total = null;
    summary.outside_spending.outside_coverage_note = outsideNote(summary.cycle, scoped.filter(item => candidateElectionKey(item.candidate_id, item.election_id) === key));
    if (row.component === 'committee_donors') pacKeys.add(key);
    if (row.component === 'independent_expenditures') outsideKeys.add(key);
  }
  if (pacKeys.size) {
    const donorResult = await db.query<DonorRow>(`
      WITH selected AS (
        SELECT candidate_id::uuid AS candidate_id, election_id::uuid AS election_id
        FROM jsonb_to_recordset($1::jsonb) AS x(candidate_id text, election_id text)
      ) SELECT selected.candidate_id::text AS candidate_id, selected.election_id::text AS election_id,
        marker.source_filer_id, donor.source_calendar_year, donor.committee_id, donor.committee_name,
        donor.source_reported_class, donor.amount, donor.contribution_count, donor.gift_transaction_ids,
        donor.returned_transaction_ids, donor.source_url, classification.industry_slug,
        classification.classification_source, classification.confidence
      FROM selected JOIN public.me_candidate_finance_links link
        ON link.candidate_id = selected.candidate_id AND link.election_id = selected.election_id AND link.link_status = 'active'
      JOIN public.me_candidate_finance_source_markers marker
        ON marker.link_id = link.id AND marker.election_year = link.election_year AND marker.component = 'committee_donors' AND marker.source_calendar_year = link.election_year
      JOIN public.me_candidate_finance_pac_donors donor
        ON donor.link_id = marker.link_id AND donor.election_year = marker.election_year AND donor.source_calendar_year = marker.source_calendar_year
      LEFT JOIN public.finance_label_classifications classification
        ON classification.label_type = 'committee' AND classification.normalized_label = public.normalize_finance_label(donor.committee_name)`,
      [JSON.stringify(selected.filter(row => pacKeys.has(candidateElectionKey(row.candidate_id, row.election_id))))]);
    const interests = pacInterests(donorResult.rows);
    for (const key of pacKeys) {
      const summary = summaries.get(key)!;
      summary.direct_campaign.direct_coverage_note = appendNote(summary.direct_campaign.direct_coverage_note, directNote(summary.cycle, scoped.filter(row => row.component === "committee_donors" && candidateElectionKey(row.candidate_id, row.election_id) === key)));
      if (interests.has(key)) summary.direct_campaign.pac_money_by_interest = interests.get(key)!;
    }
  }
  if (outsideKeys.size) {
    const allocationResult = await db.query<AllocationRow>(`
      WITH selected AS (
        SELECT candidate_id::uuid AS candidate_id, election_id::uuid AS election_id
        FROM jsonb_to_recordset($1::jsonb) AS x(candidate_id text, election_id text)
      ) SELECT selected.candidate_id::text AS candidate_id, selected.election_id::text AS election_id,
        allocation.transaction_id, allocation.target_filer_id, allocation.payer_id, allocation.payer_name,
        allocation.support_oppose, allocation.transaction_date::text AS transaction_date,
        allocation.amount, allocation.whole_amount, allocation.source_url
      FROM selected JOIN public.me_candidate_finance_links link
        ON link.candidate_id = selected.candidate_id AND link.election_id = selected.election_id AND link.link_status = 'active'
      JOIN public.me_candidate_finance_source_markers marker
        ON marker.link_id = link.id AND marker.election_year = link.election_year AND marker.component = 'independent_expenditures' AND marker.source_calendar_year = link.election_year
      JOIN public.me_candidate_finance_maplight_allocations allocation
        ON allocation.link_id = marker.link_id AND allocation.election_year = marker.election_year
        AND allocation.source_calendar_year = marker.source_calendar_year AND allocation.target_filer_id = marker.source_filer_id`,
      [JSON.stringify(selected.filter(row => outsideKeys.has(candidateElectionKey(row.candidate_id, row.election_id))))]);
    for (const [key, groups] of outsideGroups(allocationResult.rows)) {
      const summary = summaries.get(key);
      if (!summary) continue;
      for (const stance of ['support', 'oppose'] as const) {
        const property = stance === 'support' ? 'top_supporting_groups' : 'top_opposing_groups';
        const legacy = summary.outside_spending[property];
        // Retain legacy entries on conflicting identities; do not economically merge channels.
        const existing = new Set(legacy.map(group => group.committee_id));
        summary.outside_spending[property] = [...legacy, ...groups.filter(group => group.support_oppose === stance && !existing.has(group.committee_id))]
          .sort((a,b) => b.amount - a.amount || a.committee_name.localeCompare(b.committee_name)).slice(0,5);
      }
    }
  }
  return summaries;
}
