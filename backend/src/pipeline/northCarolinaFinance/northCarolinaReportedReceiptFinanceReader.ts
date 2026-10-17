import type { Pool, PoolClient } from "pg";
import { isNorthCarolinaReportedCommitteeReceiptsEnabled } from "../../config/featureFlags.js";
import {
  candidateElectionKey,
  type BallotLookupFinancePacInterest,
  type BallotLookupFinanceSummary,
  type StateFinanceSummaryRequest,
} from "../address/ballotLookupFinanceShared.js";
import { classifyPacInterest, PAC_INTERESTS_NOT_LISTED, pacInterestDisplayName, UNCLASSIFIED_PAC_INTEREST } from "../finance/pacInterestClassifier.js";
import { NORTH_CAROLINA_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./northCarolinaFinanceEligibleOffices.js";
import {
  NorthCarolinaReportedReceiptFinanceWriteError,
  validateNorthCarolinaReportedReceiptPacket,
  validateNorthCarolinaReportedReceiptSourceFacts,
} from "./northCarolinaReportedReceiptFinanceWriter.js";
import type { Qualified } from "./northCarolinaReportedReceiptSourceTypes.js";

type Row = Record<string, unknown>;
const MAX_DISPLAY = 5;
const FUTURE_TOLERANCE_MS = 5 * 60_000;
class InvalidStoredComponent extends Error {}
function fail(): never { throw new InvalidStoredComponent(); }
function integer(value: unknown): number {
  if (typeof value !== "number" && (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value))) fail();
  const n = Number(value); if (!Number.isSafeInteger(n) || n < 0) fail(); return n;
}
function object(value: unknown): Row {
  if (typeof value === "string") { try { value = JSON.parse(value); } catch { fail(); } }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Row;
}
function instant(value: unknown): number {
  const n = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(n)) fail(); return n;
}
function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\d$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}
function exactKeys(value: object, keys: string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys.slice().sort());
}

function component(row: Row): { packet: Qualified; year: number; observed: number } {
  const year = integer(row.calendar_year);
  if (typeof row.link_id !== "string" || row.link_id.trim() === "" || integer(row.active_link_count) !== 1 || row.link_status !== "active" || row.deleted_at !== null
    || typeof row.candidate_election_status !== "string" || ["withdrawn", "lost"].includes(row.candidate_election_status)
    || row.district_state !== "NC" || row.race_type !== "office" || typeof row.office_key !== "string"
    || !NORTH_CAROLINA_FINANCE_ELIGIBLE_OFFICE_KEYS.includes(row.office_key as typeof NORTH_CAROLINA_FINANCE_ELIGIBLE_OFFICE_KEYS[number])
    || !validDate(row.election_date) || Number(row.election_date.slice(0, 4)) !== year
    || !["manual", "ncsbe_portal"].includes(String(row.link_source)) || typeof row.committee_id !== "string"
    || row.source_link_id !== row.link_id || integer(row.link_year) !== year || integer(row.source_election_year) !== year) fail();
  const source = object(row.source_facts), controls = object(row.aggregation_controls);
  if (!exactKeys(controls, ["status", "receivingCommitteeId", "electionYear", "metric", "positiveGrossCents", "positiveOccurrenceCount", "classControls", "coveredPeriods", "diagnostics"])
    || !Array.isArray(row.groups)) fail();
  const groups = row.groups.map(value => {
    const g = object(value);
    if (!exactKeys(g, ["reportedClass", "displayName", "normalizedName", "positiveGrossCents", "positiveOccurrenceCount"])) fail();
    return { ...g, positiveGrossCents: integer(g.positiveGrossCents), positiveOccurrenceCount: integer(g.positiveOccurrenceCount) };
  });
  const packet = { source, aggregation: { ...controls, groups } } as unknown as Qualified;
  const observed = instant(row.source_retrieved_at), completed = instant(row.source_completed_at), written = instant(row.last_synced_at);
  const latest = Date.now() + FUTURE_TOLERANCE_MS;
  if (observed > latest || completed > latest || written > latest) fail();
  // Compare every redundant typed source column with the full JSON packet.
  if (row.receiving_committee_id !== source.receivingCommitteeId || row.committee_id !== source.receivingCommitteeId
    || source.electionYear !== year || row.source_generation !== source.sourceGeneration
    || observed !== instant(source.sourceRetrievedAt) || completed !== instant(source.sourceCompletedAt)
    || row.source_manifest_sha256 !== source.sourceManifestSha256 || integer(row.source_byte_size) !== source.sourceByteSize
    || integer(row.source_report_count) !== source.sourceReportCount || integer(row.source_receipt_occurrence_count) !== source.sourceReceiptOccurrenceCount
    || integer(row.positive_gross_cents) !== controls.positiveGrossCents || integer(row.positive_occurrence_count) !== controls.positiveOccurrenceCount
    || integer(row.group_count) !== groups.length) fail();
  const validation = { receivingCommitteeId: row.committee_id, electionYear: year, syncedAt: new Date(written) };
  validateNorthCarolinaReportedReceiptSourceFacts({ ...validation, source: packet.source });
  validateNorthCarolinaReportedReceiptPacket({ ...validation, packet });
  return { packet, year, observed };
}

function interests(packet: Qualified): BallotLookupFinancePacInterest[] {
  const grouped = new Map<string, { cents: number; pacs: { id: string; name: string; cents: number }[] }>();
  for (const g of packet.aggregation.groups) {
    const proposed = classifyPacInterest({ committeeName: g.displayName, committeeType: null, designation: null, organizationType: null, connectedOrganization: null }).interestSlug;
    const interest = proposed === null || PAC_INTERESTS_NOT_LISTED.includes(proposed) ? UNCLASSIFIED_PAC_INTEREST : proposed;
    const value = grouped.get(interest) ?? { cents: 0, pacs: [] };
    value.cents += g.positiveGrossCents;
    value.pacs.push({ id: `nc-reported:${g.reportedClass}:${g.normalizedName}`, name: g.displayName, cents: g.positiveGrossCents });
    grouped.set(interest, value);
  }
  // Whole-packet controls close before either display cap. Sort exact cents.
  return [...grouped].map(([interest, value]) => ({ interest, ...value }))
    .sort((a, b) => b.cents - a.cents || a.interest.localeCompare(b.interest)).slice(0, MAX_DISPLAY)
    .map(g => ({ interest: g.interest, interest_name: pacInterestDisplayName(g.interest), amount: g.cents / 100, pac_count: g.pacs.length,
      pacs: g.pacs.sort((a, b) => b.cents - a.cents || a.id.localeCompare(b.id)).slice(0, MAX_DISPLAY)
        .map(p => ({ committee_id: p.id, committee_name: p.name, amount: p.cents / 100, source_url: packet.source.sourceUrl })) }));
}
function sourceOnly(row: Row, year: number, observed: number): BallotLookupFinanceSummary {
  return { source: "NORTH_CAROLINA_SBE", cycle: year, fec_candidate_id: null, controlled_committee_id: row.committee_id as string,
    last_synced_at: new Date(observed).toISOString(),
    direct_campaign: { total_raised: null, total_spent: null, cash_on_hand: null, debts_owed: null,
      top_occupations: [], top_employers: [], top_industries: [], contribution_size_buckets: [] },
    outside_spending: { support_total: null, oppose_total: null, top_supporting_groups: [], top_opposing_groups: [], top_supporting_industries: [], top_opposing_industries: [] },
    backing_summary: { top_direct_donor_occupations: [], top_outside_supporting_industries: [] } };
}

const QUERY = `WITH requested AS (
  SELECT DISTINCT candidate_id, election_id FROM jsonb_to_recordset($1::jsonb) AS req(candidate_id uuid, election_id uuid)
), raw_active AS (
  SELECT link.*, count(*) OVER (PARTITION BY link.candidate_id, link.election_id, link.election_year)::integer AS active_link_count
  FROM requested JOIN public.nc_candidate_finance_links AS link USING (candidate_id, election_id)
  WHERE link.link_status = 'active'
), eligible AS (
  SELECT link.*, EXTRACT(YEAR FROM election.election_date)::integer AS calendar_year, election.election_date::text,
    candidate.deleted_at, membership.status AS candidate_election_status, district.state AS district_state,
    election.race_type, (office.scope || '::' || office.canonical_name) AS office_key
  FROM raw_active AS link JOIN public.candidates AS candidate ON candidate.id = link.candidate_id
  JOIN public.candidate_elections AS membership ON membership.candidate_id = link.candidate_id AND membership.election_id = link.election_id
  JOIN public.elections AS election ON election.id = link.election_id JOIN public.districts AS district ON district.id = election.district_id
  JOIN public.offices AS office ON office.id = election.office_id
  WHERE candidate.deleted_at IS NULL AND membership.status NOT IN ('withdrawn', 'lost') AND district.state = 'NC'
    AND election.race_type = 'office' AND link.election_year = EXTRACT(YEAR FROM election.election_date)::integer
    AND link.link_source IN ('manual', 'ncsbe_portal') AND (office.scope || '::' || office.canonical_name) = ANY($2::text[])
) SELECT link.candidate_id::text, link.election_id::text, link.id::text AS link_id, link.election_year AS link_year,
  link.calendar_year, link.election_date, link.committee_id, link.link_source, link.link_status, link.active_link_count,
  link.deleted_at, link.candidate_election_status, link.district_state, link.race_type, link.office_key,
  src.link_id::text AS source_link_id, src.election_year AS source_election_year, src.receiving_committee_id,
  src.positive_gross_cents::text, src.positive_occurrence_count, src.group_count, src.source_report_count,
  src.source_receipt_occurrence_count, src.source_generation::text, src.source_retrieved_at::text, src.source_completed_at::text,
  src.source_manifest_sha256, src.source_byte_size::text, src.source_facts, src.aggregation_controls, src.last_synced_at::text,
  COALESCE(children.groups, '[]'::jsonb) AS groups
FROM eligible AS link JOIN public.nc_reported_receipt_sources AS src ON src.link_id = link.id AND src.election_year = link.election_year
LEFT JOIN LATERAL (
  SELECT jsonb_agg(jsonb_build_object('reportedClass', g.reported_class, 'displayName', g.reported_name,
    'normalizedName', g.reported_name_key, 'positiveGrossCents', g.positive_gross_cents::text,
    'positiveOccurrenceCount', g.positive_occurrence_count)) AS groups
  FROM public.nc_reported_receipt_groups AS g WHERE g.link_id = src.link_id AND g.election_year = src.election_year
) AS children ON true`;

/** A held or absent component cannot erase legacy money or claim a new zero.
 * SQL/programming errors surface; invalid stored packets are isolated per request. */
export async function attachNorthCarolinaReportedReceiptComponent(input: {
  db: Pick<Pool | PoolClient, "query">;
  summaries: Map<string, BallotLookupFinanceSummary>;
  requests: readonly StateFinanceSummaryRequest[];
}): Promise<Map<string, BallotLookupFinanceSummary>> {
  if (!isNorthCarolinaReportedCommitteeReceiptsEnabled() || input.requests.length === 0) return input.summaries;
  const selected = new Map(input.requests.map(r => [candidateElectionKey(r.candidate_id, r.election_id), r]));
  const rows = (await input.db.query<Row>(QUERY, [JSON.stringify([...selected.values()]), [...NORTH_CAROLINA_FINANCE_ELIGIBLE_OFFICE_KEYS]])).rows;
  const byRequest = new Map<string, Row[]>();
  for (const row of rows) {
    if (typeof row.candidate_id !== "string" || typeof row.election_id !== "string") continue;
    const key = candidateElectionKey(row.candidate_id, row.election_id); if (!selected.has(key)) continue;
    const matching = byRequest.get(key) ?? []; matching.push(row); byRequest.set(key, matching);
  }
  const output = new Map(input.summaries);
  for (const [key, matching] of byRequest) {
    if (matching.length !== 1) continue;
    const row = matching[0]!;
    try {
      const { packet, year, observed } = component(row), previous = output.get(key);
      if (previous && (previous.source !== "NORTH_CAROLINA_SBE" || previous.cycle !== year)) fail();
      const summary = previous ?? sourceOnly(row, year, observed);
      output.set(key, { ...summary, direct_campaign: { ...summary.direct_campaign,
        pac_money_by_interest: interests(packet), pac_money_basis: "reported_committee_monetary_receipts",
        pac_money_coverage_note: `Gross positive itemized CPCM/PPTY committee and party monetary receipts on current regular reports' Periods in ${year - 1}–${year}, before separately reported returns. Excludes In Kind, aggregated entries and separate 48-Hour Notices. Source observed ${new Date(observed).toISOString().slice(0, 10)}.` } });
    } catch (error) {
      if (!(error instanceof InvalidStoredComponent) && !(error instanceof NorthCarolinaReportedReceiptFinanceWriteError)) throw error;
    }
  }
  return output;
}
