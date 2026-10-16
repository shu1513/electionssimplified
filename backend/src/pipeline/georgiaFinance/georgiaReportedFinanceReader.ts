import type { Pool, PoolClient } from "pg";
import { isGeorgiaReportedCommitteeContributionsEnabled, isGeorgiaReportedIeEnabled } from "../../config/featureFlags.js";
import {
  candidateElectionKey,
  type BallotLookupFinancePacInterest,
  type BallotLookupFinanceSummary,
  type StateFinanceSummaryRequest,
} from "../address/ballotLookupFinanceShared.js";
import { classifyPacInterest, PAC_INTERESTS_NOT_LISTED, pacInterestDisplayName, UNCLASSIFIED_PAC_INTEREST } from "../finance/pacInterestClassifier.js";
import { GEORGIA_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./georgiaFinanceEligibleOffices.js";

// These independent source rows own their clocks and complete group controls.
// Reading the legacy summary first must not turn an IE observation into fresh
// campaign receipts, or treat a missing source as a new financial zero.
type Row = Record<string, unknown>;
type Kind = "committee" | "ie";
const SOURCE_URL = "https://ethics.ga.gov/records-search-all/";
const MAX_DISPLAY = 5;
class InvalidStoredComponent extends Error {
  constructor() { super("invalid_georgia_reported_finance_component"); }
}
function fail(): never { throw new InvalidStoredComponent(); }
function integer(value: unknown, minimum = 0): number {
  if (typeof value !== "number" && (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value))) fail();
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < minimum) fail();
  return n;
}
function add(a: number, b: number): number {
  const n = a + b; if (!Number.isSafeInteger(n)) fail(); return n;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || /[\u0000-\u001f\u007f]/u.test(value)) fail();
  return value;
}
function instant(value: unknown): number {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) fail();
  return Date.parse(value);
}
function normalized(value: string): string { return value.normalize("NFC").trim().replace(/\s+/gu, " "); }
const commonFields = ["candidate_id", "election_id", "link_id", "link_year", "calendar_year", "committee_id", "link_source", "active_link_count",
  "source_link_id", "source_election_year", "filing_year", "receiving_committee_id", "registration_guid", "group_count", "source_row_count",
  "source_url", "source_retrieved_at", "source_completed_at", "source_manifest_sha256", "source_byte_size", "source_controls", "last_synced_at"];
function validateSource(rows: Row[], kind: Kind) {
  const first = rows[0];
  if (!first) fail();
  const fields = [...commonFields, ...(kind === "committee" ? ["total_amount_cents", "contribution_count", "held_receiving_count"] :
    ["support_total_cents", "oppose_total_cents", "expenditure_count", "candidate_target_row_count", "other_year_row_count", "multi_target_row_count", "multi_target_amount_cents"])];
  for (const row of rows) for (const field of fields) {
    if (JSON.stringify(row[field]) !== JSON.stringify(first[field])) fail();
  }
  if (integer(first.active_link_count, 1) !== 1 || text(first.link_id) !== text(first.source_link_id)
    || !["manual", "peachfile_api"].includes(text(first.link_source))) fail();
  const year = integer(first.calendar_year, 2026);
  if (year > 2100 || integer(first.link_year) !== year || integer(first.source_election_year) !== year) fail();
  const filingYear = integer(first.filing_year, 2026);
  if (filingYear > 2100) fail();
  const receiver = text(first.committee_id);
  if (!/^[1-9]\d*$/.test(receiver) || !Number.isSafeInteger(Number(receiver)) || first.receiving_committee_id !== receiver) fail();
  const registration = text(first.registration_guid);
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(registration)
    || registration === "00000000-0000-0000-0000-000000000000") fail();
  if (first.source_url !== SOURCE_URL || !/^[a-f0-9]{64}$/.test(text(first.source_manifest_sha256))) fail();
  const retrieved = instant(first.source_retrieved_at), completed = instant(first.source_completed_at);
  if (retrieved > completed || completed > instant(first.last_synced_at) || completed > Date.now() || instant(first.last_synced_at) > Date.now()) fail();
  const sourceRows = integer(first.source_row_count, 1), groupCount = integer(first.group_count);
  const controls = first.source_controls;
  if (!Array.isArray(controls) || (kind === "committee" ? controls.length !== 1 : controls.length < 2 || controls.length > 64)) fail();
  let bytes = 0, lastCompleted = -Infinity, generation: string | null = null;
  for (let index = 0; index < controls.length; index++) {
    const control = controls[index] as Record<string, unknown> | null;
    if (!control || typeof control !== "object" || JSON.stringify(Object.keys(control).sort()) !==
      JSON.stringify(["byteSize", "completedAt", "contentType", "file", "sha256", "startedAt", "status"])) fail();
    const file = text(control.file);
    const match = /^(generation-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\/(\d{4})\.raw$/.exec(file);
    if (!match || match[2] !== String(index + 1).padStart(4, "0") || (generation !== null && generation !== match[1])) fail();
    generation = match[1]!;
    if (control.status !== 200 || !/^[a-f0-9]{64}$/.test(text(control.sha256))) fail();
    const size = integer(control.byteSize, 1);
    if (size > (kind === "committee" ? 160 : 2) * 1024 * 1024) fail();
    bytes = add(bytes, size);
    const start = instant(control.startedAt), end = instant(control.completedAt);
    if (start < lastCompleted || end < start || new Date(start).toISOString() !== control.startedAt || new Date(end).toISOString() !== control.completedAt) fail();
    if (index === 0 && start !== retrieved) fail();
    if (index === controls.length - 1 && end !== completed) fail();
    lastCompleted = end;
    const mime = text(control.contentType);
    if (mime.length > 256) fail();
    if (!(kind === "committee" ? /^(?:text\/csv|application\/(?:csv|octet-stream|vnd\.ms-excel))(?:;|$)/i :
      /^application\/(?:[a-z0-9.+-]+\+)?json(?:;|$)/i).test(mime)) fail();
  }
  if (bytes !== integer(first.source_byte_size, 1) || bytes > (kind === "committee" ? 160 : 32) * 1024 * 1024) fail();
  return { first, year, filingYear, receiver, retrieved, sourceRows, groupCount };
}
function sourceOnlySummary(row: Row, retrieved: number): BallotLookupFinanceSummary {
  return { source: "GEORGIA_ETHICS", cycle: integer(row.calendar_year, 2026), fec_candidate_id: null,
    controlled_committee_id: text(row.committee_id), last_synced_at: new Date(retrieved).toISOString(),
    direct_campaign: { total_raised: null, total_spent: null, cash_on_hand: null, debts_owed: null,
      top_occupations: [], top_employers: [], top_industries: [], contribution_size_buckets: [] },
    outside_spending: { support_total: null, oppose_total: null, top_supporting_groups: [], top_opposing_groups: [],
      top_supporting_industries: [], top_opposing_industries: [] },
    backing_summary: { top_direct_donor_occupations: [], top_outside_supporting_industries: [] } };
}
function clearOutsideBacking(summary: BallotLookupFinanceSummary): BallotLookupFinanceSummary {
  return { ...summary, outside_spending: { ...summary.outside_spending, top_supporting_industries: [], top_opposing_industries: [] },
    backing_summary: { ...summary.backing_summary, top_outside_supporting_industries: [],
      ...(summary.backing_summary.top_pac_backed_industries === undefined ? {} : { top_pac_backed_industries: [] }),
      ...(summary.backing_summary.top_supporting_committee_industries === undefined ? {} : { top_supporting_committee_industries: [] }) } };
}
function retainOutsideWithUnknownDate(summary: BallotLookupFinanceSummary): BallotLookupFinanceSummary {
  const outside = summary.outside_spending;
  const hasContent = outside.support_total !== null || outside.oppose_total !== null || outside.top_supporting_groups.length > 0
    || outside.top_opposing_groups.length > 0 || outside.top_supporting_industries.length > 0 || outside.top_opposing_industries.length > 0
    || summary.backing_summary.top_outside_supporting_industries.length > 0;
  const clean = clearOutsideBacking(summary);
  return hasContent ? { ...clean, outside_spending: { ...clean.outside_spending,
    outside_coverage_note: "Previously stored Georgia independent spending is retained. Its acquisition date is unavailable; the headline update date may reflect campaign receipts. Spending naming multiple candidates or measures and spending reported only to the earlier filing system are excluded." } } : clean;
}
function committeeOverlay(rows: Row[]) {
  const facts = validateSource(rows, "committee");
  const { first, groupCount, sourceRows } = facts;
  if (integer(first.held_receiving_count) > sourceRows) fail();
  const contributionCount = integer(first.contribution_count), total = integer(first.total_amount_cents);
  if (groupCount > contributionCount || contributionCount > sourceRows || (groupCount === 0) !== (contributionCount === 0)
    || (contributionCount === 0) !== (total === 0)) fail();
  const seen = new Set<string>();
  const interests = new Map<string, { cents: number; pacs: BallotLookupFinancePacInterest["pacs"] }>();
  let cents = 0, occurrences = 0, groups = 0;
  for (const row of rows) {
    if (row.group_name === null) {
      if (rows.length !== 1 || groupCount !== 0 || row.group_amount_cents !== null || row.group_occurrence_count !== null
        || row.group_type !== null || row.group_name_key !== null) fail();
      continue;
    }
    const name = text(row.group_name), nameKey = text(row.group_name_key), role = text(row.group_type);
    if (normalized(name) !== name || nameKey !== name.toUpperCase()
      || !["Non-Candidate Committee", "Candidate / Candidate Committee"].includes(role)) fail();
    const key = `${role}\u0000${nameKey}`;
    if (seen.has(key)) fail(); seen.add(key);
    const amount = integer(row.group_amount_cents, 1), count = integer(row.group_occurrence_count, 1);
    cents = add(cents, amount); occurrences = add(occurrences, count); groups++;
    const classified = classifyPacInterest({ committeeName: name, committeeType: null, designation: null, organizationType: null, connectedOrganization: null });
    const interest = classified.interestSlug === null || PAC_INTERESTS_NOT_LISTED.includes(classified.interestSlug)
      ? UNCLASSIFIED_PAC_INTEREST : classified.interestSlug;
    const group = interests.get(interest) ?? { cents: 0, pacs: [] };
    group.cents = add(group.cents, amount);
    // This is an explicit reported class/name presentation key, not a legal
    // donor identity or a hidden hash derived from a donor's name.
    group.pacs.push({ committee_id: `ga-reported:${role}:${nameKey}`, committee_name: name, amount: amount / 100, source_url: SOURCE_URL });
    interests.set(interest, group);
  }
  if (groups !== groupCount || cents !== total || occurrences !== contributionCount) fail();
  const grouped: BallotLookupFinancePacInterest[] = [...interests].map(([interest, group]) => ({ interest,
    interest_name: pacInterestDisplayName(interest), amount: group.cents / 100, pac_count: group.pacs.length,
    pacs: group.pacs.sort((a, b) => b.amount - a.amount || a.committee_id.localeCompare(b.committee_id)).slice(0, MAX_DISPLAY) }))
    .sort((a, b) => b.amount - a.amount || a.interest.localeCompare(b.interest)).slice(0, MAX_DISPLAY);
  return { ...facts, grouped };
}
function ieOverlay(rows: Row[]) {
  const facts = validateSource(rows, "ie");
  const { first, groupCount, sourceRows } = facts;
  const support = integer(first.support_total_cents), oppose = integer(first.oppose_total_cents);
  const total = add(support, oppose), count = integer(first.expenditure_count), targets = integer(first.candidate_target_row_count);
  const otherYear = integer(first.other_year_row_count), multi = integer(first.multi_target_row_count), multiCents = integer(first.multi_target_amount_cents);
  if (groupCount > count || targets > sourceRows || targets !== add(add(count, otherYear), multi)
    || (groupCount === 0) !== (count === 0) || (count === 0) !== (total === 0) || (multi === 0) !== (multiCents === 0)) fail();
  let supportSum = 0, opposeSum = 0, occurrences = 0;
  const seen = new Set<string>();
  const groups: BallotLookupFinanceSummary["outside_spending"]["top_supporting_groups"] = [];
  for (const row of rows) {
    if (row.group_id === null) {
      if (rows.length !== 1 || groupCount !== 0 || row.group_name !== null || row.group_amount_cents !== null
        || row.group_occurrence_count !== null || row.group_stance !== null) fail();
      continue;
    }
    const id = text(row.group_id), name = text(row.group_name);
    if (id !== id.trim().toLowerCase() || name !== normalized(name) || (row.group_stance !== "support" && row.group_stance !== "oppose")) fail();
    const key = `${id}\u0000${row.group_stance}`;
    if (seen.has(key)) fail(); seen.add(key);
    const amount = integer(row.group_amount_cents, 1), n = integer(row.group_occurrence_count, 1);
    occurrences = add(occurrences, n);
    if (row.group_stance === "support") supportSum = add(supportSum, amount); else opposeSum = add(opposeSum, amount);
    groups.push({ committee_id: id, committee_name: name, support_oppose: row.group_stance,
      amount: amount / 100, expenditure_count: n, source_url: SOURCE_URL });
  }
  if (groups.length !== groupCount || supportSum !== support || opposeSum !== oppose || occurrences !== count) fail();
  groups.sort((a, b) => b.amount - a.amount || a.committee_id.localeCompare(b.committee_id) || a.support_oppose.localeCompare(b.support_oppose));
  return { ...facts, support, oppose, supporting: groups.filter(g => g.support_oppose === "support").slice(0, MAX_DISPLAY),
    opposing: groups.filter(g => g.support_oppose === "oppose").slice(0, MAX_DISPLAY) };
}
function query(kind: Kind): string {
  const source = kind === "committee" ? "ga_reported_committee_sources" : "ga_reported_ie_sources";
  const groups = kind === "committee" ? "ga_reported_committee_groups" : "ga_reported_ie_groups";
  const sourceJoin = kind === "committee" ? "src.link_id = link.id AND src.election_year = link.election_year" :
    "src.candidate_id = link.candidate_id AND src.election_id = link.election_id AND src.election_year = link.election_year";
  const groupJoin = kind === "committee" ? "grp.link_id = src.link_id AND grp.election_year = src.election_year" :
    "grp.candidate_id = src.candidate_id AND grp.election_id = src.election_id AND grp.election_year = src.election_year";
  const extra = kind === "committee" ? `src.total_amount_cents::text, src.contribution_count, src.held_receiving_count,
    grp.reported_name AS group_name, grp.reported_name_key AS group_name_key, grp.reported_contributor_type AS group_type,
    grp.contribution_count AS group_occurrence_count` : `src.support_total_cents::text, src.oppose_total_cents::text, src.expenditure_count,
    src.candidate_target_row_count, src.other_year_row_count, src.multi_target_row_count, src.multi_target_amount_cents::text,
    grp.reported_spender_id AS group_id, grp.reported_spender_name AS group_name, grp.support_oppose AS group_stance,
    grp.expenditure_count AS group_occurrence_count`;
  return `WITH selected AS (SELECT candidate_id, election_id FROM jsonb_to_recordset($1::jsonb)
      AS req(candidate_id uuid, election_id uuid)), active AS (
    SELECT link.*, EXTRACT(YEAR FROM election.election_date)::integer AS calendar_year,
      count(*) OVER (PARTITION BY link.candidate_id, link.election_id)::integer AS active_link_count
    FROM selected JOIN public.ga_candidate_finance_links AS link USING (candidate_id, election_id)
    JOIN public.candidates AS candidate ON candidate.id = link.candidate_id
    JOIN public.candidate_elections AS membership ON membership.candidate_id = link.candidate_id AND membership.election_id = link.election_id
    JOIN public.elections AS election ON election.id = link.election_id
    JOIN public.districts AS district ON district.id = election.district_id
    LEFT JOIN public.offices AS office ON office.id = election.office_id
    WHERE link.link_status = 'active' AND candidate.deleted_at IS NULL AND membership.status NOT IN ('withdrawn', 'lost')
      AND district.state = 'GA' AND election.race_type = 'office'
      AND link.election_year = EXTRACT(YEAR FROM election.election_date)::integer
      AND (office.scope || '::' || office.canonical_name) = ANY($2::text[])
  ) SELECT link.candidate_id::text, link.election_id::text, link.id::text AS link_id,
    link.election_year AS link_year, link.calendar_year, link.committee_id, link.link_source, link.active_link_count,
    src.link_id::text AS source_link_id, src.election_year AS source_election_year, src.filing_year,
    src.receiving_committee_id, src.registration_guid, src.group_count, src.source_row_count,
    src.source_url, src.source_retrieved_at::text, src.source_completed_at::text, src.source_manifest_sha256,
    src.source_byte_size::text, src.source_controls, src.last_synced_at::text,
    grp.amount_cents::text AS group_amount_cents, ${extra}
  FROM active AS link LEFT JOIN public.${source} AS src ON ${sourceJoin}
  LEFT JOIN public.${groups} AS grp ON ${groupJoin}
  ORDER BY link.candidate_id, link.election_id, link.id`;
}

/** Missing or inconsistent stored components retain existing money. Each gate
 * queries only its own uncapped source/groups; SQL/programming errors surface. */
export async function attachGeorgiaReportedFinanceComponents(input: {
  db: Pick<Pool | PoolClient, "query">;
  requests: readonly StateFinanceSummaryRequest[];
  summaries: Map<string, BallotLookupFinanceSummary>;
}): Promise<Map<string, BallotLookupFinanceSummary>> {
  const committeeEnabled = isGeorgiaReportedCommitteeContributionsEnabled(), ieEnabled = isGeorgiaReportedIeEnabled();
  if ((!committeeEnabled && !ieEnabled) || input.requests.length === 0) return input.summaries;
  const selected = new Map(input.requests.map(request => [candidateElectionKey(request.candidate_id, request.election_id), request]));
  const output = new Map(input.summaries);
  if (ieEnabled) for (const key of selected.keys()) {
    const summary = output.get(key); if (summary) output.set(key, retainOutsideWithUnknownDate(summary));
  }
  const kinds: Kind[] = [...(committeeEnabled ? ["committee" as const] : []), ...(ieEnabled ? ["ie" as const] : [])];
  const results = await Promise.all(kinds.map(async kind => ({ kind,
    result: await input.db.query<Row>(query(kind), [JSON.stringify([...selected.values()]), [...GEORGIA_FINANCE_ELIGIBLE_OFFICE_KEYS]]) })));
  for (const { kind, result } of results) {
    const byCandidate = new Map<string, Row[]>();
    for (const row of result.rows) {
      if (typeof row.candidate_id !== "string" || typeof row.election_id !== "string") continue;
      const key = candidateElectionKey(row.candidate_id, row.election_id);
      if (!selected.has(key)) continue;
      const rows = byCandidate.get(key) ?? []; rows.push(row); byCandidate.set(key, rows);
    }
    for (const [key, rows] of byCandidate) {
      try {
        const component = kind === "committee" ? committeeOverlay(rows) : ieOverlay(rows);
        const existing = output.get(key);
        if (existing && existing.cycle !== component.year) fail();
        let summary = existing ?? sourceOnlySummary(component.first, component.retrieved);
        if (!input.summaries.has(key)) summary = { ...summary,
          last_synced_at: new Date(Math.min(instant(summary.last_synced_at), component.retrieved)).toISOString() };
        if (kind === "committee" && "grouped" in component) {
          output.set(key, { ...summary, direct_campaign: { ...summary.direct_campaign,
            pac_money_by_interest: component.grouped, pac_money_basis: "reported_committee_itemized_contributions",
            pac_money_coverage_note: `Gross positive itemized contributions from reported non-candidate and candidate committees in Georgia's ${component.filingYear} export, allocated to the ${component.year} election year. Separately reported returns are not subtracted. Excludes loans, in-kind and unitemized contributions, business/unregistered contributors, other election years and receivers with unresolved source records. Data observed ${new Date(component.retrieved).toISOString().slice(0, 10)}.` } });
        } else if (kind === "ie" && "supporting" in component) {
          const clean = clearOutsideBacking(summary);
          output.set(key, { ...clean, outside_spending: { ...clean.outside_spending,
            support_total: component.support / 100, oppose_total: component.oppose / 100,
            top_supporting_groups: component.supporting, top_opposing_groups: component.opposing,
            outside_coverage_note: `Reported single-candidate independent expenditures in Georgia's current filing system, allocated to the ${component.year} election year. Source snapshot observed ${new Date(component.retrieved).toISOString().slice(0, 10)}. Spending naming multiple candidates or measures and spending reported only to the earlier filing system are excluded. Transaction dates may fall outside the election year; the headline update date may reflect campaign receipts.` } });
        }
      } catch (error) { if (!(error instanceof InvalidStoredComponent)) throw error; }
    }
  }
  return output;
}
