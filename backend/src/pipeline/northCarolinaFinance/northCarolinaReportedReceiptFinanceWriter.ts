import type { Pool, PoolClient } from "pg";
import { NORTH_CAROLINA_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./northCarolinaFinanceEligibleOffices.js";
import { NORTH_CAROLINA_SBOEID_PATTERN, NCSBE_NO_TOTAL_REPORT_TYPES, NCSBE_OUTSIDE_LEG_REPORT_TYPES } from "./northCarolinaNcsbeParsers.js";
import { NORTH_CAROLINA_REPORTED_RECEIPT_LIMITS as LIMITS, validateNorthCarolinaReportedReceiptOriginalUrl } from "./northCarolinaReportedReceiptSourceCache.js";
import type { Facts, Qualified, Binding } from "./northCarolinaReportedReceiptSourceTypes.js";
import type { NorthCarolinaReportedCommitteeReceiptClassControl as Control } from "./northCarolinaReportedCommitteeReceiptAggregator.js";
import type { NorthCarolinaReportedReceiptFinanceComponent } from "./northCarolinaReportedReceiptFinanceTypes.js";

type Db = Pick<Pool, "connect">;
type Row = Record<string, unknown>;
export type NorthCarolinaReportedReceiptFinanceWriteResult = { sourceWritten: true; groupCount: number; idempotent: boolean };
export class NorthCarolinaReportedReceiptFinanceWriteError extends Error {
  constructor(readonly code: "invalid_component" | "receiving_context_changed" | "stale_source" | "equal_source_conflict" | "storage_unavailable") {
    super(`North Carolina reported receipt write unavailable: ${code}`);
    this.name = "NorthCarolinaReportedReceiptFinanceWriteError";
  }
}
function fail(code: NorthCarolinaReportedReceiptFinanceWriteError["code"] = "invalid_component"): never { throw new NorthCarolinaReportedReceiptFinanceWriteError(code); }
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const SOURCE = "https://cf.ncsbe.gov/CFOrgLkup/";
const MAX_COUNT = 2147483647;
const record = (v: unknown): v is Row => !!v && typeof v === "object" && !Array.isArray(v);
const count = (v: unknown, min = 0): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= MAX_COUNT;
const cents = (v: unknown, min = 0): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min;
const signed = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const year = (v: unknown): v is number => count(v, 2000) && v <= 2100;
const guid = (v: unknown): v is string => typeof v === "string" && UUID.test(v) && v !== "00000000-0000-0000-0000-000000000000";
const sid = (v: unknown): v is string => typeof v === "string" && NORTH_CAROLINA_SBOEID_PATTERN.test(v) && v.includes("-C-");
const nativeId = (v: unknown): v is string => typeof v === "string" && /^[1-9]\d*$/.test(v) && Number.isSafeInteger(Number(v));
const text = (v: unknown): v is string => typeof v === "string" && /[\p{L}\p{N}]/u.test(v) && !/[\u0000-\u001f\u007f-\u009f]/u.test(v);
const clean = (v: string) => v.normalize("NFC").replace(/\s+/gu, " ").trim();
function canonical(v: unknown): string {
  return JSON.stringify(v, (_, x: unknown) => record(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const keys = (v: object, names: string[]) => same(Object.keys(v).sort(), [...names].sort());
function iso(v: unknown): string | null {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : null;
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
}
const exactIso = (v: unknown): v is string => typeof v === "string" && iso(v) === v && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v);
const date = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d\d-\d\d$/.test(v) && iso(`${v}T00:00:00.000Z`) === `${v}T00:00:00.000Z`;
function sum(values: readonly number[]): number {
  const total = values.reduce((a, v) => a + BigInt(v), 0n);
  return total <= BigInt(Number.MAX_SAFE_INTEGER) && total >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(total) : fail();
}
function originalBinding(o: Facts["sourceControls"][number]): Binding {
  if (o.role === "inventory_open" || o.role === "inventory_close") return { role: o.role };
  if (o.role === "report_cover" || o.role === "native_csv") return { role: o.role, reportId: o.reportId };
  if (o.role === "receipt_page" || o.role === "expenditure_page") return { role: o.role, reportId: o.reportId, page: o.page };
  return fail();
}

/** Pure stored-provenance validation for writer and API reader. The immutable
 * cache reader remains the authority for original bytes and native source rows. */
export function validateNorthCarolinaReportedReceiptSourceFacts(input: {
  source: Readonly<Facts>; receivingCommitteeId: string; electionYear: number; syncedAt: Date;
}): void {
  try {
    const s = input.source, write = input.syncedAt instanceof Date ? input.syncedAt.getTime() : NaN;
    if (!record(s) || !keys(s, ["receivingCommitteeId", "electionYear", "sourceGeneration", "sourceRetrievedAt", "sourceCompletedAt", "sourceUrl", "sourceReceiptOccurrenceCount", "sourceReportCount", "sourceByteSize", "sourceManifestSha256", "sourceControls"])
      || !sid(input.receivingCommitteeId) || !year(input.electionYear) || s.receivingCommitteeId !== input.receivingCommitteeId || s.electionYear !== input.electionYear
      || !guid(s.sourceGeneration) || s.sourceUrl !== SOURCE || !count(s.sourceReceiptOccurrenceCount) || !count(s.sourceReportCount, 1)
      || !cents(s.sourceByteSize, 1) || s.sourceByteSize > LIMITS.maxTotalBytes || typeof s.sourceManifestSha256 !== "string" || !HASH.test(s.sourceManifestSha256)
      || !exactIso(s.sourceRetrievedAt) || !exactIso(s.sourceCompletedAt) || !Number.isFinite(write)
      || Date.parse(s.sourceCompletedAt) > write || Date.parse(s.sourceRetrievedAt) > Date.parse(s.sourceCompletedAt)
      || !Array.isArray(s.sourceControls) || s.sourceControls.length < 6 || s.sourceControls.length > LIMITS.maxRequests) fail();
    const originals = s.sourceControls as Facts["sourceControls"];
    const first = originals[0]!, last = originals.at(-1)!;
    if (first.role !== "inventory_open" || last.role !== "inventory_close") fail();
    const ogidText = new URL(first.url).searchParams.get("OGID");
    if (!nativeId(ogidText)) fail();
    const scope = { receivingCommitteeId: input.receivingCommitteeId, electionYear: input.electionYear, orgGroupId: Number(ogidText) };
    const bindings = new Set<string>(), sizes: number[] = [], reports = new Map<string, { cover: number; receipts: number[]; expenses: number[]; csv?: number }>();
    let previousEnd = -Infinity, lastOrdinary = 1;
    for (const [i, o] of originals.entries()) {
      if (!record(o)) fail();
      const b = originalBinding(o);
      if (!keys(o, [...Object.keys(b), "ordinal", "file", "url", "status", "eof", "byteSize", "sha256", "startedAt", "completedAt"])
        || o.ordinal !== i + 1 || o.file !== `originals/${String(i + 1).padStart(4, "0")}.raw` || o.status !== 200 || o.eof !== true
        || typeof o.sha256 !== "string" || !HASH.test(o.sha256) || !cents(o.byteSize, 1) || o.byteSize > LIMITS.maxBodyBytes
        || !exactIso(o.startedAt) || !exactIso(o.completedAt) || Date.parse(o.startedAt) < previousEnd || Date.parse(o.completedAt) < Date.parse(o.startedAt)
        || Date.parse(o.completedAt) - Date.parse(o.startedAt) > LIMITS.requestTimeoutMs
        || Date.parse(o.startedAt) - Date.parse(s.sourceRetrievedAt) > LIMITS.maxCaptureMs) fail();
      validateNorthCarolinaReportedReceiptOriginalUrl({ scope, binding: b, url: o.url });
      const key = canonical(b); if (bindings.has(key)) fail(); bindings.add(key);
      previousEnd = Date.parse(o.completedAt); sizes.push(o.byteSize);
      if (o.role === "inventory_open" && i !== 0 || o.role === "inventory_close" && i !== s.sourceControls.length - 1) fail();
      if ("reportId" in o) {
        if (!nativeId(o.reportId)) fail();
        if (o.role === "report_cover") { if (reports.has(o.reportId)) fail(); reports.set(o.reportId, { cover: o.ordinal, receipts: [], expenses: [] }); }
        else {
          const r = reports.get(o.reportId); if (!r) return fail();
          if (o.role === "receipt_page") { if (r.expenses.length || r.csv !== undefined) fail(); r.receipts.push(o.page); }
          if (o.role === "expenditure_page") { if (!r.receipts.length || r.csv !== undefined) fail(); r.expenses.push(o.page); }
          if (o.role === "native_csv") { if (r.csv !== undefined) fail(); r.csv = o.ordinal; }
        }
        if (o.role !== "native_csv") lastOrdinary = o.ordinal;
      }
    }
    for (const r of reports.values()) {
      if (!r.receipts.length || !r.expenses.length || r.receipts.some((p, i) => p !== i) || r.expenses.some((p, i) => p !== i)
        || r.csv !== undefined && r.csv <= lastOrdinary) fail();
    }
    if (reports.size < s.sourceReportCount || [...reports.values()].filter(r => r.csv !== undefined).length !== s.sourceReportCount
      || sum(sizes) !== s.sourceByteSize || s.sourceRetrievedAt !== first.startedAt || s.sourceCompletedAt !== last.completedAt) fail();
  } catch (error) { if (error instanceof NorthCarolinaReportedReceiptFinanceWriteError) throw error; fail(); }
}
const CONTROL_KEYS = ["reportedClass", "sourceOccurrenceCount", "signedSourceCents", "coverPeriodCents", "positiveOccurrenceCount", "positiveGrossCents", "zeroOccurrenceCount", "excludedAggregatedOccurrenceCount", "excludedAggregatedSignedCents", "excludedInKindOccurrenceCount", "excludedInKindSignedCents"];
function controls(value: unknown): Control[] {
  if (!Array.isArray(value) || value.length !== 2) return fail();
  const result = value as Control[];
  const seen = new Set<string>();
  for (const c of result) {
    if (!record(c) || !keys(c, CONTROL_KEYS) || !["CPCM", "PPTY"].includes(c.reportedClass) || seen.has(c.reportedClass)) fail();
    seen.add(c.reportedClass);
    for (const k of ["sourceOccurrenceCount", "positiveOccurrenceCount", "zeroOccurrenceCount", "excludedAggregatedOccurrenceCount", "excludedInKindOccurrenceCount"] as const) if (!count(c[k])) fail();
    if (!cents(c.positiveGrossCents) || ![c.signedSourceCents, c.coverPeriodCents, c.excludedAggregatedSignedCents, c.excludedInKindSignedCents].every(signed)
      || sum([c.positiveOccurrenceCount, c.zeroOccurrenceCount, c.excludedAggregatedOccurrenceCount, c.excludedInKindOccurrenceCount]) !== c.sourceOccurrenceCount
      || sum([c.positiveGrossCents, c.excludedAggregatedSignedCents, c.excludedInKindSignedCents]) !== c.signedSourceCents
      || c.signedSourceCents !== c.coverPeriodCents || (c.positiveOccurrenceCount === 0) !== (c.positiveGrossCents === 0)
      || c.excludedAggregatedOccurrenceCount === 0 && c.excludedAggregatedSignedCents !== 0 || c.excludedInKindOccurrenceCount === 0 && c.excludedInKindSignedCents !== 0) fail();
  }
  return result;
}

/** Validate an uncapped full component; it cannot turn a held/missing source
 * into zero. Overlapping reported Periods remain reported occurrences. */
export function validateNorthCarolinaReportedReceiptPacket(input: {
  packet: Qualified; receivingCommitteeId: string; electionYear: number; syncedAt: Date;
}): void {
  try {
    const p = input.packet; if (!record(p) || !keys(p, ["aggregation", "source"])) fail();
    validateNorthCarolinaReportedReceiptSourceFacts({ ...input, source: p.source });
    const a = p.aggregation;
    if (!record(a) || !keys(a, ["status", "receivingCommitteeId", "electionYear", "metric", "positiveGrossCents", "positiveOccurrenceCount", "groups", "classControls", "coveredPeriods", "diagnostics"])
      || a.status !== "qualified" || a.metric !== "reported_itemized_committee_monetary_receipts_before_returns" || a.receivingCommitteeId !== input.receivingCommitteeId
      || a.electionYear !== input.electionYear || !cents(a.positiveGrossCents) || !count(a.positiveOccurrenceCount) || !Array.isArray(a.groups) || !Array.isArray(a.coveredPeriods)) fail();
    const all = controls(a.classControls), d = a.diagnostics;
    const diagnosticKeys = ["inventoryRowCount", "excludedOtherReceiverInventoryRowCount", "duplicateInventoryRowCount", "excludedNoTotalReportRowCount", "excludedOutsideLegReportRowCount", "excludedUndatedOutOfCycleRowCount", "reportCount", "sourceOccurrenceCount", "excludedOtherClassOccurrenceCount", "coverIdentityMetadataDisagreementReportCount", "coverPeriodDisagreementReportCount"];
    if (!record(d) || !keys(d, diagnosticKeys) || diagnosticKeys.some(k => !count((d as unknown as Row)[k]))
      || d.reportCount !== p.source.sourceReportCount || d.sourceOccurrenceCount !== p.source.sourceReceiptOccurrenceCount
      || d.inventoryRowCount < d.reportCount || d.coverIdentityMetadataDisagreementReportCount > d.reportCount || d.coverPeriodDisagreementReportCount > d.reportCount
      || sum([d.excludedOtherClassOccurrenceCount, ...all.map(c => c.sourceOccurrenceCount)]) !== d.sourceOccurrenceCount
      || a.coveredPeriods.length !== d.reportCount) fail();
    const sourceReportIds = new Set(p.source.sourceControls.filter(o => o.role === "native_csv").map(o => "reportId" in o ? o.reportId : ""));
    const seenReports = new Set<string>(), perReport: Control[][] = [];
    for (const r of a.coveredPeriods) {
      if (!record(r) || !keys(r, ["reportId", "reportType", "periodStart", "periodEnd", "sourceOccurrenceCount", "classControls"])
        || !nativeId(r.reportId) || !sourceReportIds.has(r.reportId) || seenReports.has(r.reportId) || !count(r.sourceOccurrenceCount)
        || !date(r.periodStart) || !date(r.periodEnd) || r.periodStart > r.periodEnd || r.periodStart < `${input.electionYear - 1}-01-01` || r.periodEnd > `${input.electionYear}-12-31`
        || r.reportType !== null && (!text(r.reportType) || NCSBE_NO_TOTAL_REPORT_TYPES.has(r.reportType) || NCSBE_OUTSIDE_LEG_REPORT_TYPES.has(r.reportType))) fail();
      seenReports.add(r.reportId);
      const c = controls(r.classControls); if (sum(c.map(x => x.sourceOccurrenceCount)) > r.sourceOccurrenceCount) fail(); perReport.push(c);
    }
    if (sum(a.coveredPeriods.map(r => r.sourceOccurrenceCount)) !== d.sourceOccurrenceCount) fail();
    for (const c of all) for (const k of CONTROL_KEYS.filter(k => k !== "reportedClass") as Array<Exclude<keyof Control, "reportedClass">>)
      if (sum(perReport.map(report => report.find(x => x.reportedClass === c.reportedClass)![k])) !== c[k]) fail();
    const seenGroups = new Set<string>();
    for (const g of a.groups) {
      if (!record(g) || !keys(g, ["reportedClass", "displayName", "normalizedName", "positiveGrossCents", "positiveOccurrenceCount"])
        || !["CPCM", "PPTY"].includes(g.reportedClass) || !text(g.displayName) || g.displayName !== clean(g.displayName) || g.normalizedName !== g.displayName.toUpperCase()
        || !cents(g.positiveGrossCents, 1) || !count(g.positiveOccurrenceCount, 1)) fail();
      const key = canonical([g.reportedClass, g.normalizedName]); if (seenGroups.has(key)) fail(); seenGroups.add(key);
    }
    for (const c of all) {
      const groups = a.groups.filter(g => g.reportedClass === c.reportedClass);
      if (sum(groups.map(g => g.positiveGrossCents)) !== c.positiveGrossCents || sum(groups.map(g => g.positiveOccurrenceCount)) !== c.positiveOccurrenceCount) fail();
    }
    if (sum(all.map(c => c.positiveGrossCents)) !== a.positiveGrossCents || sum(all.map(c => c.positiveOccurrenceCount)) !== a.positiveOccurrenceCount
      || a.positiveOccurrenceCount > d.sourceOccurrenceCount || a.groups.length > a.positiveOccurrenceCount
      || (a.groups.length === 0) !== (a.positiveOccurrenceCount === 0) || (a.positiveOccurrenceCount === 0) !== (a.positiveGrossCents === 0)) fail();
  } catch (error) { if (error instanceof NorthCarolinaReportedReceiptFinanceWriteError) throw error; fail(); }
}

type Prepared = { input: NorthCarolinaReportedReceiptFinanceComponent; syncedAt: Date; source: Row; groups: Row[]; keys: Row };
function prepare(input: NorthCarolinaReportedReceiptFinanceComponent & { db: Db; syncedAt?: Date }): Prepared {
  try {
    if (!input || !input.db || typeof input.db.connect !== "function" || !input.receiver) fail();
    const r = structuredClone(input.receiver), packet = structuredClone(input.packet), syncedAt = input.syncedAt ? new Date(input.syncedAt) : new Date();
    if (![r.linkId, r.candidateId, r.electionId].every(guid) || !year(r.electionYear) || !sid(r.committeeId)
      || !["manual", "ncsbe_portal"].includes(r.linkSource) || !text(r.officeScope) || !text(r.officeName)
      || r.district !== null && !text(r.district) || !date(r.electionDate) || Number(r.electionDate.slice(0, 4)) !== r.electionYear) fail();
    if (!Number.isFinite(syncedAt.getTime()) || syncedAt.getTime() > Date.now()) fail();
    validateNorthCarolinaReportedReceiptPacket({ packet, receivingCommitteeId: r.committeeId, electionYear: r.electionYear, syncedAt });
    const a = packet.aggregation, s = packet.source, { groups: ignored, ...aggregationControls } = a; void ignored;
    const keys: Row = { link_id: r.linkId, election_year: r.electionYear };
    const source: Row = { ...keys, receiving_committee_id: s.receivingCommitteeId, positive_gross_cents: a.positiveGrossCents,
      positive_occurrence_count: a.positiveOccurrenceCount, group_count: a.groups.length, source_report_count: s.sourceReportCount,
      source_receipt_occurrence_count: s.sourceReceiptOccurrenceCount, source_generation: s.sourceGeneration,
      source_retrieved_at: s.sourceRetrievedAt, source_completed_at: s.sourceCompletedAt, source_manifest_sha256: s.sourceManifestSha256,
      source_byte_size: s.sourceByteSize, source_facts: s, aggregation_controls: aggregationControls, last_synced_at: syncedAt.toISOString() };
    const groups = a.groups.map(g => ({ ...keys, reported_class: g.reportedClass, reported_name: g.displayName, reported_name_key: g.normalizedName,
      positive_gross_cents: g.positiveGrossCents, positive_occurrence_count: g.positiveOccurrenceCount }));
    return { input: { receiver: r, packet }, syncedAt, keys, source, groups };
  } catch (error) { if (error instanceof NorthCarolinaReportedReceiptFinanceWriteError) throw error; return fail(); }
}
async function lockReceiver(db: PoolClient, p: Prepared): Promise<void> {
  const r = p.input.receiver;
  const result = await db.query<Row>(`SELECT c.id::text AS candidate_id, e.id::text AS election_id, e.election_date::text AS election_date,
    EXTRACT(YEAR FROM e.election_date)::int AS election_year, c.deleted_at, ce.status AS candidate_election_status,
    d.state AS district_state, e.race_type, o.scope AS office_scope, o.canonical_name AS office_canonical_name
    FROM public.candidates c JOIN public.candidate_elections ce ON ce.candidate_id = c.id
    JOIN public.elections e ON e.id = ce.election_id JOIN public.districts d ON d.id = e.district_id
    JOIN public.offices o ON o.id = e.office_id WHERE c.id = $1::uuid AND e.id = $2::uuid FOR UPDATE OF c, e, ce, d, o`, [r.candidateId, r.electionId]);
  const c = result.rows[0];
  if (result.rows.length !== 1 || !c || c.candidate_id !== r.candidateId || c.election_id !== r.electionId || c.deleted_at !== null
    || typeof c.candidate_election_status !== "string" || ["withdrawn", "lost"].includes(c.candidate_election_status)
    || c.district_state !== "NC" || c.race_type !== "office" || c.election_date !== r.electionDate || c.election_year !== r.electionYear
    || c.office_scope !== r.officeScope || !NORTH_CAROLINA_FINANCE_ELIGIBLE_OFFICE_KEYS.includes(`${c.office_scope}::${c.office_canonical_name}` as typeof NORTH_CAROLINA_FINANCE_ELIGIBLE_OFFICE_KEYS[number])) fail("receiving_context_changed");
  const resultLinks = await db.query<Row>(`SELECT id::text AS link_id, candidate_id::text AS candidate_id, election_id::text AS election_id,
    election_year, committee_id, link_source, link_status, office_name, district FROM public.nc_candidate_finance_links
    WHERE candidate_id = $1::uuid AND election_id = $2::uuid AND election_year = $3 ORDER BY id FOR UPDATE`, [r.candidateId, r.electionId, r.electionYear]);
  // Lock inactive siblings too: activating an existing link does not change
  // its FK keys and would otherwise evade the parent-row locks above.
  const active = resultLinks.rows.filter(link => link.link_status === "active");
  const l = active[0];
  if (active.length !== 1 || !l || l.link_id !== r.linkId || l.candidate_id !== r.candidateId || l.election_id !== r.electionId
    || l.election_year !== r.electionYear || l.committee_id !== r.committeeId || l.link_source !== r.linkSource || l.link_status !== "active"
    || l.office_name !== r.officeName || l.district !== r.district) fail("receiving_context_changed");
}
function normalizedStored(value: unknown, expected: unknown, key: string): unknown {
  if (key === "source_retrieved_at" || key === "source_completed_at") return iso(value);
  if (typeof expected === "number") return typeof value === "string" && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value)
    : typeof value === "number" && Number.isSafeInteger(value) ? value : null;
  if (["source_facts", "aggregation_controls"].includes(key) && typeof value === "string") { try { return JSON.parse(value); } catch { return null; } }
  return value;
}
function matchingStored(stored: Row, expected: Row): boolean {
  return Object.entries(expected).every(([k, v]) => k === "last_synced_at" || same(normalizedStored(stored[k], v, k), v));
}
function equalGroups(stored: Row[], expected: Row[]): boolean {
  if (stored.length !== expected.length) return false;
  const rows = (values: Row[]) => values.map(row => canonical(Object.fromEntries(Object.entries(expected[0] ?? {}).map(([k, v]) => [k, normalizedStored(row[k], v, k)])))).sort();
  return same(rows(stored), rows(expected));
}
const where = "link_id = $1::uuid AND election_year = $2";
export async function writeNorthCarolinaReportedReceiptComponent(input: NorthCarolinaReportedReceiptFinanceComponent & { db: Db; syncedAt?: Date }): Promise<NorthCarolinaReportedReceiptFinanceWriteResult> {
  const p = prepare(input);
  let client: PoolClient | undefined, begun = false;
  try {
    client = await input.db.connect(); await client.query("BEGIN"); begun = true; await lockReceiver(client, p);
    const old = await client.query<Row>(`SELECT * FROM public.nc_reported_receipt_sources WHERE ${where} FOR UPDATE`, Object.values(p.keys));
    if (old.rows.length > 1) fail("equal_source_conflict");
    if (old.rows.length === 1) {
      const prior = old.rows[0]!, clock = iso(prior.source_retrieved_at);
      if (clock === null) fail("equal_source_conflict");
      if (clock! > p.input.packet.source.sourceRetrievedAt) fail("stale_source");
      if (clock === p.input.packet.source.sourceRetrievedAt) {
        const storedGroups = await client.query<Row>(`SELECT * FROM public.nc_reported_receipt_groups WHERE ${where} FOR UPDATE`, Object.values(p.keys));
        if (!matchingStored(prior, p.source) || !equalGroups(storedGroups.rows, p.groups)) fail("equal_source_conflict");
        const changed = await client.query(`UPDATE public.nc_reported_receipt_sources SET last_synced_at = GREATEST(last_synced_at, $3::timestamptz)
          WHERE ${where} AND source_retrieved_at = $4::timestamptz RETURNING 1`, [...Object.values(p.keys), p.syncedAt.toISOString(), p.input.packet.source.sourceRetrievedAt]);
        if (changed.rows.length !== 1) fail("stale_source");
        await client.query("COMMIT"); begun = false; return { sourceWritten: true, groupCount: p.groups.length, idempotent: true };
      }
    }
    const columns = Object.keys(p.source), jsonColumns = ["source_facts", "aggregation_controls"];
    const saved = await client.query(`INSERT INTO public.nc_reported_receipt_sources (${columns.join(", ")})
      VALUES (${columns.map((k, i) => `$${i + 1}${jsonColumns.includes(k) ? "::jsonb" : ""}`).join(", ")})
      ON CONFLICT (link_id, election_year) DO UPDATE SET ${columns.filter(k => !(k in p.keys)).map(k => `${k} = EXCLUDED.${k}`).join(", ")}
      WHERE nc_reported_receipt_sources.source_retrieved_at < EXCLUDED.source_retrieved_at RETURNING 1`,
      columns.map(k => jsonColumns.includes(k) ? JSON.stringify(p.source[k]) : p.source[k]));
    if (saved.rows.length !== 1) fail("stale_source");
    await client.query(`DELETE FROM public.nc_reported_receipt_groups WHERE ${where}`, Object.values(p.keys));
    if (p.groups.length) {
      const insertedGroups = await client.query(`INSERT INTO public.nc_reported_receipt_groups
      (link_id, election_year, reported_class, reported_name, reported_name_key, positive_gross_cents, positive_occurrence_count)
      SELECT item.link_id, item.election_year, item.reported_class, item.reported_name, item.reported_name_key, item.positive_gross_cents, item.positive_occurrence_count
      FROM jsonb_to_recordset($1::jsonb) AS item(link_id uuid, election_year integer, reported_class text, reported_name text,
        reported_name_key text, positive_gross_cents bigint, positive_occurrence_count integer)`, [JSON.stringify(p.groups)]);
      if (insertedGroups.rowCount !== p.groups.length) fail("storage_unavailable");
    }
    await client.query("COMMIT"); begun = false; return { sourceWritten: true, groupCount: p.groups.length, idempotent: false };
  } catch (error) {
    if (begun && client) await client.query("ROLLBACK").catch(() => {});
    if (error instanceof NorthCarolinaReportedReceiptFinanceWriteError) throw error;
    throw new NorthCarolinaReportedReceiptFinanceWriteError("storage_unavailable");
  } finally { client?.release(); }
}
