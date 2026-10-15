import type { Pool, PoolClient } from "pg";
import { isMissouriCommitteeReceiptsEnabled } from "../../config/featureFlags.js";
import {
  candidateElectionKey,
  type BallotLookupFinancePacInterest,
  type BallotLookupFinanceSummary,
  type StateFinanceSummaryRequest,
} from "../address/ballotLookupFinanceShared.js";
import {
  classifyPacInterest, PAC_INTERESTS_NOT_LISTED, pacInterestDisplayName, UNCLASSIFIED_PAC_INTEREST,
} from "../finance/pacInterestClassifier.js";

export type MissouriCommitteeMonetaryReceiptReaderRow = {
  candidate_id: string; election_id: string; link_id: string; election_year: number;
  committee_id: string; active_link_count: number;
  source_link_id: string | null; source_year: number | null; receiving_committee_id: string | null;
  cycle_start: string | null; cycle_end: string | null;
  total_amount_cents: string | null; group_count: number | null; receipt_count: number | null;
  source_row_count: number | null; in_cycle_row_count: number | null; outside_cycle_row_count: number | null;
  canonical_row_count: number | null; matched_committee_row_count: number | null;
  excluded_noncommittee_row_count: number | null; in_kind_row_count: number | null; zero_monetary_row_count: number | null;
  source_url: string | null; source_retrieved_at: string | null; last_synced_at: string | null;
  source_sha256: string | null; source_byte_size: string | null; report_inventory_sha256: string | null;
  reported_committee_name: string | null; reported_name_key: string | null;
  amount_cents: string | null; group_receipt_count: number | null;
};
type Row = MissouriCommitteeMonetaryReceiptReaderRow;
const SOURCE_URL = "https://www.mec.mo.gov/MEC/Campaign_Finance/CF12_ContrExpend.aspx";
const fail = (): never => { throw new Error("invalid_missouri_stored_committee_receipts"); };
const clean = (value: string) => value.normalize("NFC").trim().replace(/\s+/gu, " ");
const name = (value: unknown): value is string => typeof value === "string" && value.trim() !== "" && !/[\u0000-\u001f\u007f]/u.test(value);
const count = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 2_147_483_647;
const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function integer(value: string | null): number {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return fail();
  const n = Number(value); return Number.isSafeInteger(n) ? n : fail();
}
function add(a: number, b: number): number { const n = a + b; return Number.isSafeInteger(n) ? n : fail(); }
function instant(value: string | null): number {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return fail();
  return Date.parse(value);
}
function date(value: string | null): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return fail();
  const n = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(n) || new Date(n).toISOString().slice(0, 10) !== value) return fail();
  return value;
}
function officialSource(value: string | null): boolean {
  if (typeof value !== "string") return false;
  try {
    const u = new URL(value);
    return u.origin === "https://www.mec.mo.gov" && !u.username && !u.password && !u.search && !u.hash &&
      u.pathname.toLowerCase() === "/mec/campaign_finance/cf12_contrexpend.aspx";
  } catch { return false; }
}
const metadataFields = ["candidate_id", "election_id", "link_id", "election_year", "committee_id", "active_link_count",
  "source_link_id", "source_year", "receiving_committee_id", "cycle_start", "cycle_end", "total_amount_cents",
  "group_count", "receipt_count", "source_row_count", "in_cycle_row_count", "outside_cycle_row_count", "canonical_row_count",
  "matched_committee_row_count", "excluded_noncommittee_row_count", "in_kind_row_count", "zero_monetary_row_count",
  "source_url", "source_retrieved_at", "last_synced_at", "source_sha256", "source_byte_size", "report_inventory_sha256"] as const;

function emptySummary(first: Row, oldest: number, linkCount: number): BallotLookupFinanceSummary {
  return { source: "MISSOURI_MEC", cycle: first.election_year, fec_candidate_id: null,
    controlled_committee_id: linkCount === 1 ? first.committee_id : null, last_synced_at: new Date(oldest).toISOString(),
    direct_campaign: { total_raised: null, total_spent: null, cash_on_hand: null, debts_owed: null,
      top_occupations: [], top_employers: [], top_industries: [], contribution_size_buckets: [] },
    outside_spending: { support_total: null, oppose_total: null, top_supporting_groups: [], top_opposing_groups: [],
      top_supporting_industries: [], top_opposing_industries: [] },
    backing_summary: { top_direct_donor_occupations: [], top_outside_supporting_industries: [] } };
}

function attachCandidate(rowsByLink: Map<string, Row[]>, existing?: BallotLookupFinanceSummary): BallotLookupFinanceSummary {
  const first = [...rowsByLink.values()][0]![0]!;
  if (!count(first.active_link_count) || first.active_link_count < 1 || rowsByLink.size !== first.active_link_count ||
    !Number.isInteger(first.election_year) || first.election_year < 2024 || first.election_year > 2100 ||
    (existing && existing.cycle !== first.election_year)) return fail();
  const groups = new Map<string, { name: string; cents: number }>();
  const receiving = new Set<string>();
  let oldest = Infinity, overallCents = 0, overallReceipts = 0;
  for (const rows of rowsByLink.values()) {
    const src = rows[0]!;
    if (src.source_link_id !== src.link_id || src.source_year !== src.election_year || src.election_year !== first.election_year ||
      src.active_link_count !== first.active_link_count || !/^[A-Z]\d{6}$/.test(src.committee_id) ||
      receiving.has(src.committee_id) || src.receiving_committee_id !== src.committee_id ||
      rows.some(row => metadataFields.some(field => row[field] !== src[field]))) return fail();
    receiving.add(src.committee_id);
    const start = date(src.cycle_start), end = date(src.cycle_end);
    if (start > end || Number(end.slice(0, 4)) !== src.election_year || start !== first.cycle_start || end !== first.cycle_end ||
      !officialSource(src.source_url) || !hash(src.source_sha256) || !hash(src.report_inventory_sha256) || integer(src.source_byte_size) === 0 ||
      instant(src.source_retrieved_at) > instant(src.last_synced_at)) return fail();
    oldest = Math.min(oldest, instant(src.source_retrieved_at));
    if (![src.group_count, src.receipt_count, src.source_row_count, src.in_cycle_row_count, src.outside_cycle_row_count,
      src.canonical_row_count, src.matched_committee_row_count, src.excluded_noncommittee_row_count, src.in_kind_row_count,
      src.zero_monetary_row_count].every(count) ||
      src.source_row_count !== src.in_cycle_row_count! + src.outside_cycle_row_count! || src.canonical_row_count! > src.in_cycle_row_count! ||
      src.canonical_row_count !== src.matched_committee_row_count! + src.excluded_noncommittee_row_count! ||
      src.matched_committee_row_count !== src.in_kind_row_count! + src.zero_monetary_row_count! + src.receipt_count! ||
      src.group_count! > src.receipt_count!) return fail();
    const keys = new Set<string>(); let cents = 0, receipts = 0;
    for (const row of rows) {
      if (row.reported_name_key === null) {
        if (rows.length !== 1 || src.group_count !== 0 || row.reported_committee_name !== null ||
          row.amount_cents !== null || row.group_receipt_count !== null) return fail();
        continue;
      }
      if (!name(row.reported_committee_name) || clean(row.reported_committee_name) !== row.reported_committee_name ||
        row.reported_name_key !== row.reported_committee_name.toUpperCase() || keys.has(row.reported_name_key) ||
        !count(row.group_receipt_count) || row.group_receipt_count === 0) return fail();
      const amount = integer(row.amount_cents); if (amount === 0) return fail();
      keys.add(row.reported_name_key); cents = add(cents, amount); receipts = add(receipts, row.group_receipt_count);
      const group = groups.get(row.reported_name_key);
      groups.set(row.reported_name_key, { name: group?.name ?? row.reported_committee_name,
        cents: add(group?.cents ?? 0, amount) });
    }
    if (keys.size !== src.group_count || cents !== integer(src.total_amount_cents) || receipts !== src.receipt_count ||
      (keys.size === 0) !== (receipts === 0) || (keys.size === 0) !== (cents === 0)) return fail();
    overallCents = add(overallCents, cents); overallReceipts = add(overallReceipts, receipts);
  }
  const interests = new Map<string, { cents: number; pacs: BallotLookupFinancePacInterest["pacs"] }>();
  for (const [key, group] of groups) {
    const proposed = classifyPacInterest({ committeeName: group.name, committeeType: null, designation: null,
      organizationType: null, connectedOrganization: null }).interestSlug;
    // A native reported committee remains in scope even when a federal card rule would hide its interest.
    const interest = proposed && !(PAC_INTERESTS_NOT_LISTED as readonly string[]).includes(proposed)
      ? proposed : UNCLASSIFIED_PAC_INTEREST;
    const entry = interests.get(interest) ?? { cents: 0, pacs: [] };
    entry.cents = add(entry.cents, group.cents);
    entry.pacs.push({ committee_id: `mo-reported:${key}`,
      committee_name: group.name, amount: group.cents / 100, source_url: SOURCE_URL });
    interests.set(interest, entry);
  }
  // All component and candidate sums have been checked before either display cap.
  if ([...interests.values()].reduce((sum, group) => add(sum, group.cents), 0) !== overallCents || overallReceipts < groups.size) return fail();
  const grouped = [...interests].map(([interest, group]) => ({ interest, interest_name: pacInterestDisplayName(interest),
    amount: group.cents / 100, pac_count: group.pacs.length,
    pacs: group.pacs.sort((a, b) => b.amount - a.amount || a.committee_id.localeCompare(b.committee_id)).slice(0, 5) }))
    .sort((a, b) => b.amount - a.amount || a.interest.localeCompare(b.interest)).slice(0, 5);
  const summary = existing ?? emptySummary(first, oldest, rowsByLink.size);
  const note = `Gross itemized monetary receipts reported from committees during ${first.cycle_start} through ${first.cycle_end}; source observed ${new Date(oldest).toISOString().slice(0, 10)}. May include loans; before separately reported returns. Excludes individual and in-kind receipts. Reported names do not establish legal PAC identity. These receipts do not represent all money raised.`;
  return { ...summary, direct_campaign: { ...summary.direct_campaign, pac_money_by_interest: grouped,
    pac_money_basis: "reported_committee_monetary_receipts", pac_money_coverage_note: note } };
}

/** A complete qualified source is required for every active receiving link.
 * Missing or invalid components leave that candidate's existing summary intact. */
export async function attachMissouriCommitteeMonetaryReceipts(input: {
  db: Pick<Pool | PoolClient, "query">; requests: readonly StateFinanceSummaryRequest[];
  summaries: Map<string, BallotLookupFinanceSummary>;
}): Promise<Map<string, BallotLookupFinanceSummary>> {
  if (!isMissouriCommitteeReceiptsEnabled() || input.requests.length === 0) return input.summaries;
  const result = await input.db.query<Row>(`WITH selected AS (
    SELECT candidate_id, election_id FROM jsonb_to_recordset($1::jsonb) AS req(candidate_id uuid, election_id uuid)
  ), active AS (
    SELECT link.*, count(*) OVER (PARTITION BY link.candidate_id, link.election_id)::integer AS active_link_count
    FROM selected JOIN public.mo_candidate_finance_links AS link USING (candidate_id, election_id)
    WHERE link.link_status = 'active'
  ) SELECT link.candidate_id::text, link.election_id::text, link.id::text AS link_id,
      link.election_year, link.committee_id, link.active_link_count,
      src.link_id::text AS source_link_id, src.election_year AS source_year, src.receiving_committee_id,
      src.cycle_start::text, src.cycle_end::text, src.total_amount_cents::text, src.group_count, src.receipt_count,
      src.source_row_count, src.in_cycle_row_count, src.outside_cycle_row_count, src.canonical_row_count,
      src.matched_committee_row_count, src.excluded_noncommittee_row_count, src.in_kind_row_count, src.zero_monetary_row_count,
      src.source_url, src.source_retrieved_at::text, src.last_synced_at::text, src.source_sha256,
      src.source_byte_size::text, src.report_inventory_sha256,
      receipt.reported_committee_name, receipt.reported_name_key, receipt.amount_cents::text,
      receipt.receipt_count AS group_receipt_count
    FROM active AS link LEFT JOIN public.mo_candidate_finance_committee_receipt_sources AS src
      ON src.link_id = link.id AND src.election_year = link.election_year
    LEFT JOIN public.mo_candidate_finance_committee_receipts AS receipt
      ON receipt.link_id = src.link_id AND receipt.election_year = src.election_year
    ORDER BY link.candidate_id, link.election_id, link.id, receipt.amount_cents DESC, receipt.reported_name_key`,
  [JSON.stringify(input.requests)]);
  const byCandidate = new Map<string, Map<string, Row[]>>();
  const requested = new Set(input.requests.map(row => candidateElectionKey(row.candidate_id, row.election_id)));
  for (const row of result.rows) {
    const key = candidateElectionKey(row.candidate_id, row.election_id);
    if (!requested.has(key)) continue;
    const links = byCandidate.get(key) ?? new Map<string, Row[]>();
    const rows = links.get(row.link_id) ?? []; rows.push(row); links.set(row.link_id, rows); byCandidate.set(key, links);
  }
  const output = new Map(input.summaries);
  for (const [key, links] of byCandidate) {
    if ([...links.values()].some(rows => rows[0]!.source_link_id === null)) continue;
    try { output.set(key, attachCandidate(links, output.get(key))); }
    catch { /* Reject only this candidate's malformed stored component; never fabricate a zero. */ }
  }
  return output;
}
