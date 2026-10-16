import type { Pool, PoolClient } from "pg";
import { GEORGIA_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./georgiaFinanceEligibleOffices.js";
import type { GeorgiaReportedCommitteeComponent, GeorgiaReportedIeComponent } from "./georgiaReportedFinanceTypes.js";
import type { GeorgiaReportedSourceFacts } from "./georgiaReportedFinanceSourceCache.js";

type Kind = "committee" | "ie";
type Db = Pick<Pool, "connect">;
type Row = Record<string, unknown>;
export type GeorgiaReportedFinanceWriteResult = { sourceWritten: true; groupCount: number; idempotent: boolean };
export class GeorgiaReportedFinanceWriteError extends Error {
  constructor(public readonly code: "invalid_component" | "receiving_context_changed" | "stale_source" | "equal_source_conflict") {
    super(`Georgia reported finance write unavailable: ${code}`);
    this.name = "GeorgiaReportedFinanceWriteError";
  }
}
function fail(code: GeorgiaReportedFinanceWriteError["code"] = "invalid_component"): never { throw new GeorgiaReportedFinanceWriteError(code); }
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const SOURCE = "https://ethics.ga.gov/records-search-all/";
const MAX_COUNT = 2147483647;
const clean = (s: string) => s.normalize("NFC").trim().replace(/\s+/gu, " ");
const text = (v: unknown): v is string => typeof v === "string" && v.trim() !== "" && !/[\u0000-\u001f\u007f]/u.test(v);
const count = (v: unknown, minimum = 0): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= minimum && v <= MAX_COUNT;
const cents = (v: unknown, minimum = 0): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= minimum;
const year = (v: unknown): v is number => count(v, 2026) && v <= 2100;
const guid = (v: unknown): v is string => typeof v === "string" && UUID.test(v) && v !== "00000000-0000-0000-0000-000000000000";
const nativeId = (v: unknown): v is string => typeof v === "string" && /^[1-9]\d*$/.test(v) && Number.isSafeInteger(Number(v));
function iso(v: unknown): string | null {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : null;
  if (typeof v !== "string" || !Number.isFinite(Date.parse(v))) return null;
  return new Date(v).toISOString();
}
const exactIso = (v: unknown): v is string => typeof v === "string" && iso(v) === v && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v);
function sum(values: readonly number[]): number {
  const n = values.reduce((total, value) => total + BigInt(value), 0n);
  return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : fail();
}
function canonical(value: unknown): string {
  const order = (v: unknown): unknown => Array.isArray(v) ? v.map(order) : v && typeof v === "object"
    ? Object.fromEntries(Object.entries(v as Row).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, order(x)])) : v;
  return JSON.stringify(order(value));
}

/** Pure provenance validation, also usable by the read path. Original-byte and
 * native-source qualification remain the immutable cache reader's authority. */
export function validateGeorgiaReportedSourceFacts(input: {
  source: GeorgiaReportedSourceFacts; kind: Kind; electionYear: number; syncedAt: Date;
}): void {
  const s = input.source;
  const writeTime = input.syncedAt instanceof Date ? input.syncedAt.getTime() : NaN;
  if (!s || !year(input.electionYear) || !year(s.filingYear) || s.electionYear !== input.electionYear ||
    !count(s.sourceRowCount, 1) || !cents(s.sourceByteSize, 1) ||
    s.sourceByteSize > (input.kind === "ie" ? 32 : 160) * 1024 * 1024 || s.sourceUrl !== SOURCE ||
    typeof s.sourceManifestSha256 !== "string" || !HASH.test(s.sourceManifestSha256) ||
    !exactIso(s.sourceRetrievedAt) || !exactIso(s.sourceCompletedAt) || !Number.isFinite(writeTime) ||
    Date.parse(s.sourceRetrievedAt) > Date.parse(s.sourceCompletedAt) || Date.parse(s.sourceCompletedAt) > writeTime ||
    Date.parse(s.sourceCompletedAt) > Date.now() || writeTime > Date.now() || !Array.isArray(s.sourceControls) ||
    (input.kind === "committee" ? s.sourceControls.length !== 1 : s.sourceControls.length < 2 || s.sourceControls.length > 64)) fail();
  let previousEnd = -Infinity;
  let generation: string | null = null;
  const sizes: number[] = [];
  for (const [index, c] of s.sourceControls.entries()) {
    if (!c || canonical(Object.keys(c).sort()) !== canonical(["byteSize", "completedAt", "contentType", "file", "sha256", "startedAt", "status"]) ||
      typeof c.file !== "string" || typeof c.sha256 !== "string" || !HASH.test(c.sha256) || !cents(c.byteSize, 1) ||
      c.byteSize > (input.kind === "ie" ? 2 : 160) * 1024 * 1024 || c.status !== 200 || !exactIso(c.startedAt) || !exactIso(c.completedAt) ||
      Date.parse(c.completedAt) < Date.parse(c.startedAt) || Date.parse(c.startedAt) < previousEnd ||
      typeof c.contentType !== "string" || c.contentType.length > 256 ||
      !(input.kind === "ie" ? /^application\/(?:[a-z0-9.+-]+\+)?json(?:;|$)/i : /^(?:text\/csv|application\/(?:csv|octet-stream|vnd\.ms-excel))(?:;|$)/i).test(c.contentType)) fail();
    const slash = c.file.lastIndexOf("/");
    const prefix = c.file.slice(0, slash);
    if (slash < 0 || !/^generation-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(prefix) ||
      c.file.slice(slash + 1) !== `${String(index + 1).padStart(4, "0")}.raw` || (generation !== null && generation !== prefix)) fail();
    generation = prefix;
    previousEnd = Date.parse(c.completedAt);
    sizes.push(c.byteSize);
  }
  if (sum(sizes) !== s.sourceByteSize || s.sourceRetrievedAt !== s.sourceControls[0]!.startedAt ||
    s.sourceCompletedAt !== s.sourceControls.at(-1)!.completedAt) fail();
}

type Component = GeorgiaReportedCommitteeComponent | GeorgiaReportedIeComponent;
type Prepared = { kind: Kind; input: Component; syncedAt: Date; source: Row; groups: Row[]; keys: Row; sourceTable: string; groupTable: string };
function prepare(kind: Kind, input: Component & { db: Db; syncedAt?: Date }): Prepared {
  if (!input || !input.db || typeof input.db.connect !== "function" || !input.receiver || !input.context || !input.aggregation || input.aggregation.status !== "qualified") fail();
  const r = input.receiver, c = input.context;
  if (![r.linkId, r.candidateId, r.electionId].every(guid) || !year(r.electionYear) || !nativeId(r.committeeId) ||
    c.receivingCommitteeId !== r.committeeId || !guid(c.registrationGuid) ||
    !["manual", "peachfile_api"].includes(r.linkSource) || !text(r.officeScope) || !text(r.officeName) ||
    (r.district !== null && !text(r.district)) || typeof r.electionDate !== "string" ||
    !/^\d{4}-\d\d-\d\d$/.test(r.electionDate) || iso(`${r.electionDate}T00:00:00.000Z`) !== `${r.electionDate}T00:00:00.000Z` ||
    Number(r.electionDate.slice(0, 4)) !== r.electionYear) fail();
  const syncedAt = input.syncedAt ?? new Date();
  validateGeorgiaReportedSourceFacts({ source: input.source, kind, electionYear: r.electionYear, syncedAt });
  if (!Array.isArray(input.aggregation.groups)) fail();
  const keys: Row = kind === "committee" ? { link_id: r.linkId, election_year: r.electionYear }
    : { candidate_id: r.candidateId, election_id: r.electionId, election_year: r.electionYear };
  const source: Row = { ...keys, ...(kind === "ie" ? { link_id: r.linkId } : {}), filing_year: input.source.filingYear,
    receiving_committee_id: c.receivingCommitteeId, registration_guid: c.registrationGuid,
    source_row_count: input.source.sourceRowCount, source_url: input.source.sourceUrl,
    source_retrieved_at: input.source.sourceRetrievedAt, source_completed_at: input.source.sourceCompletedAt,
    source_manifest_sha256: input.source.sourceManifestSha256, source_byte_size: input.source.sourceByteSize,
    source_controls: input.source.sourceControls, last_synced_at: syncedAt.toISOString() };
  const groups: Row[] = [];
  const identities = new Set<string>();
  if (kind === "committee") {
    const value = input as GeorgiaReportedCommitteeComponent;
    const a = value.aggregation;
    if (!count(a.contributionCount) || !cents(a.totalAmountCents) || !count(value.heldReceivingCount) ||
      value.heldReceivingCount > input.source.sourceRowCount || a.contributionCount > input.source.sourceRowCount || a.groups.length > a.contributionCount) fail();
    for (const g of a.groups) {
      if (!g || !["Non-Candidate Committee", "Candidate / Candidate Committee"].includes(g.reportedClass) ||
        !text(g.reportedName) || g.reportedName !== clean(g.reportedName) || g.reportedNameKey !== g.reportedName.toUpperCase() ||
        !cents(g.amountCents, 1) || !count(g.contributionCount, 1)) fail();
      const key = `${g.reportedClass}\0${g.reportedNameKey}`;
      if (identities.has(key)) fail(); identities.add(key);
      groups.push({ ...keys, reported_contributor_type: g.reportedClass, reported_name: g.reportedName,
        reported_name_key: g.reportedNameKey, amount_cents: g.amountCents, contribution_count: g.contributionCount });
    }
    if (sum(groups.map(g => g.amount_cents as number)) !== a.totalAmountCents ||
      sum(groups.map(g => g.contribution_count as number)) !== a.contributionCount ||
      (groups.length === 0) !== (a.contributionCount === 0) || (a.contributionCount === 0) !== (a.totalAmountCents === 0)) fail();
    Object.assign(source, { total_amount_cents: a.totalAmountCents, contribution_count: a.contributionCount,
      group_count: groups.length, held_receiving_count: value.heldReceivingCount });
  } else {
    const a = (input as GeorgiaReportedIeComponent).aggregation;
    if (!count(a.sourceRowCount, 1) || a.sourceRowCount !== input.source.sourceRowCount || !count(a.candidateTargetRowCount) ||
      a.candidateTargetRowCount > a.sourceRowCount || !count(a.expenditureCount) || !count(a.otherAllocationYearRowCount) ||
      !count(a.multiTargetRowCount) || !cents(a.multiTargetAmountCents) || !cents(a.supportTotalCents) || !cents(a.opposeTotalCents) ||
      sum([a.expenditureCount, a.otherAllocationYearRowCount, a.multiTargetRowCount]) !== a.candidateTargetRowCount ||
      a.groups.length > a.expenditureCount || (a.multiTargetRowCount === 0) !== (a.multiTargetAmountCents === 0)) fail();
    for (const g of a.groups) {
      if (!g || !text(g.reportedSpenderId) || g.reportedSpenderId !== g.reportedSpenderId.trim().toLowerCase() ||
        !text(g.reportedSpenderName) || g.reportedSpenderName !== clean(g.reportedSpenderName) ||
        !["support", "oppose"].includes(g.supportOppose) || !cents(g.amountCents, 1) || !count(g.expenditureCount, 1)) fail();
      const key = `${g.reportedSpenderId}\0${g.supportOppose}`;
      if (identities.has(key)) fail(); identities.add(key);
      groups.push({ ...keys, reported_spender_id: g.reportedSpenderId, reported_spender_name: g.reportedSpenderName,
        support_oppose: g.supportOppose, amount_cents: g.amountCents, expenditure_count: g.expenditureCount });
    }
    if (sum(groups.filter(g => g.support_oppose === "support").map(g => g.amount_cents as number)) !== a.supportTotalCents ||
      sum(groups.filter(g => g.support_oppose === "oppose").map(g => g.amount_cents as number)) !== a.opposeTotalCents ||
      sum(groups.map(g => g.expenditure_count as number)) !== a.expenditureCount ||
      (groups.length === 0) !== (a.expenditureCount === 0) ||
      (a.expenditureCount === 0) !== (sum([a.supportTotalCents, a.opposeTotalCents]) === 0)) fail();
    Object.assign(source, { support_total_cents: a.supportTotalCents, oppose_total_cents: a.opposeTotalCents,
      group_count: groups.length, expenditure_count: a.expenditureCount, candidate_target_row_count: a.candidateTargetRowCount,
      other_year_row_count: a.otherAllocationYearRowCount, multi_target_row_count: a.multiTargetRowCount, multi_target_amount_cents: a.multiTargetAmountCents });
  }
  return { kind, input, syncedAt, keys, source, groups, sourceTable: kind === "committee" ? "ga_reported_committee_sources" : "ga_reported_ie_sources",
    groupTable: kind === "committee" ? "ga_reported_committee_groups" : "ga_reported_ie_groups" };
}

async function lockReceiver(db: PoolClient, p: Prepared): Promise<void> {
  const r = p.input.receiver;
  const context = await db.query<Row>(`SELECT c.id::text AS candidate_id, e.id::text AS election_id,
      e.election_date::text AS election_date, EXTRACT(YEAR FROM e.election_date)::int AS election_year,
      c.deleted_at, ce.status AS candidate_election_status, d.state AS district_state, e.race_type,
      o.scope AS office_scope, o.canonical_name AS office_canonical_name
    FROM public.candidates c JOIN public.candidate_elections ce ON ce.candidate_id = c.id
    JOIN public.elections e ON e.id = ce.election_id JOIN public.districts d ON d.id = e.district_id
    JOIN public.offices o ON o.id = e.office_id
    WHERE c.id = $1::uuid AND e.id = $2::uuid FOR UPDATE OF c, e, ce, d, o`, [r.candidateId, r.electionId]);
  const current = context.rows[0];
  if (context.rows.length !== 1 || !current || current.candidate_id !== r.candidateId || current.election_id !== r.electionId ||
    current.deleted_at !== null || typeof current.candidate_election_status !== "string" || ["withdrawn", "lost"].includes(current.candidate_election_status) ||
    current.district_state !== "GA" || current.race_type !== "office" || current.election_date !== r.electionDate ||
    current.election_year !== r.electionYear || current.office_scope !== r.officeScope ||
    !GEORGIA_FINANCE_ELIGIBLE_OFFICE_KEYS.includes(`${current.office_scope}::${current.office_canonical_name}` as typeof GEORGIA_FINANCE_ELIGIBLE_OFFICE_KEYS[number])) fail("receiving_context_changed");
  const links = await db.query<Row>(`SELECT id::text AS link_id, candidate_id::text AS candidate_id, election_id::text AS election_id,
      election_year, committee_id, link_source, link_status, office_name, district
    FROM public.ga_candidate_finance_links
    WHERE candidate_id = $1::uuid AND election_id = $2::uuid AND election_year = $3 AND link_status = 'active'
    ORDER BY id FOR UPDATE`, [r.candidateId, r.electionId, r.electionYear]);
  const link = links.rows[0];
  if (links.rows.length !== 1 || !link || link.link_id !== r.linkId || link.candidate_id !== r.candidateId || link.election_id !== r.electionId ||
    link.election_year !== r.electionYear || link.committee_id !== p.input.context.receivingCommitteeId || link.link_source !== r.linkSource ||
    link.link_status !== "active" || link.office_name !== r.officeName || link.district !== r.district) fail("receiving_context_changed");
}
function normalizedStored(value: unknown, expected: unknown, key: string): unknown {
  if (key === "source_retrieved_at" || key === "source_completed_at") return iso(value);
  if (typeof expected === "number") {
    if (typeof value === "string" && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))) return Number(value);
    return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
  }
  if (key === "source_controls" && typeof value === "string") {
    try { return JSON.parse(value); } catch { return null; }
  }
  return value;
}
function matchingStored(stored: Row, expected: Row): boolean {
  return Object.entries(expected).every(([key, value]) => key === "last_synced_at" || canonical(normalizedStored(stored[key], value, key)) === canonical(value));
}
function equalGroups(stored: Row[], expected: Row[]): boolean {
  if (stored.length !== expected.length) return false;
  const values = (rows: Row[], expectedRows: Row[]) => rows.map(row => {
    const shape = expectedRows[0];
    return shape ? canonical(Object.fromEntries(Object.entries(shape).map(([key, value]) => [key, normalizedStored(row[key], value, key)]))) : "";
  }).sort();
  return canonical(values(stored, expected)) === canonical(values(expected, expected));
}
function where(keys: Row, offset = 0): string { return Object.keys(keys).map((key, i) => `${key} = $${offset + i + 1}`).join(" AND "); }
async function perform(db: Db, p: Prepared): Promise<GeorgiaReportedFinanceWriteResult> {
  const client = await db.connect();
  let begun = false;
  try {
    await client.query("BEGIN"); begun = true;
    await lockReceiver(client, p);
    const old = await client.query<Row>(`SELECT * FROM public.${p.sourceTable} WHERE ${where(p.keys)} FOR UPDATE`, Object.values(p.keys));
    if (old.rows.length > 1) fail("equal_source_conflict");
    if (old.rows.length === 1) {
      const prior = old.rows[0]!;
      const oldClock = iso(prior.source_retrieved_at);
      if (oldClock === null) fail("equal_source_conflict");
      if (oldClock > p.source.source_retrieved_at!) fail("stale_source");
      if (oldClock === p.source.source_retrieved_at) {
        const storedGroups = await client.query<Row>(`SELECT * FROM public.${p.groupTable} WHERE ${where(p.keys)} FOR UPDATE`, Object.values(p.keys));
        if (!matchingStored(prior, p.source) || !equalGroups(storedGroups.rows, p.groups)) fail("equal_source_conflict");
        const values = [...Object.values(p.keys), p.syncedAt.toISOString(), p.source.source_retrieved_at];
        const updated = await client.query(`UPDATE public.${p.sourceTable} SET last_synced_at = GREATEST(last_synced_at, $${values.length - 1}::timestamptz)
          WHERE ${where(p.keys)} AND source_retrieved_at = $${values.length}::timestamptz RETURNING 1`, values);
        if (updated.rows.length !== 1) fail("stale_source");
        await client.query("COMMIT"); begun = false;
        return { sourceWritten: true, groupCount: p.groups.length, idempotent: true };
      }
    }
    const columns = Object.keys(p.source);
    const values = columns.map(key => key === "source_controls" ? JSON.stringify(p.source[key]) : p.source[key]);
    const assignments = columns.filter(key => !(key in p.keys)).map(key => `${key} = EXCLUDED.${key}`).join(", ");
    const saved = await client.query(`INSERT INTO public.${p.sourceTable} (${columns.join(", ")})
      VALUES (${columns.map((key, i) => `$${i + 1}${key === "source_controls" ? "::jsonb" : ""}`).join(", ")})
      ON CONFLICT (${Object.keys(p.keys).join(", ")}) DO UPDATE SET ${assignments}
      WHERE ${p.sourceTable}.source_retrieved_at < EXCLUDED.source_retrieved_at RETURNING 1`, values);
    if (saved.rows.length !== 1) fail("stale_source");
    await client.query(`DELETE FROM public.${p.groupTable} WHERE ${where(p.keys)}`, Object.values(p.keys));
    if (p.groups.length) {
      const columns = Object.keys(p.groups[0]!);
      await client.query(`INSERT INTO public.${p.groupTable} (${columns.join(", ")})
        SELECT ${columns.map(key => `item.${key}`).join(", ")} FROM jsonb_to_recordset($1::jsonb) AS item(
          ${columns.map(key => `${key} ${key === "election_year" || key.endsWith("_count") ? "integer" : key === "amount_cents" ? "bigint" : key.endsWith("_id") && ["link_id", "candidate_id", "election_id"].includes(key) ? "uuid" : "text"}`).join(", ")})`, [JSON.stringify(p.groups)]);
    }
    await client.query("COMMIT"); begun = false;
    return { sourceWritten: true, groupCount: p.groups.length, idempotent: false };
  } catch (error) {
    if (begun) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}

export async function writeGeorgiaReportedCommitteeComponent(input: GeorgiaReportedCommitteeComponent & { db: Db; syncedAt?: Date }): Promise<GeorgiaReportedFinanceWriteResult> {
  return perform(input.db, prepare("committee", input));
}
export async function writeGeorgiaReportedIeComponent(input: GeorgiaReportedIeComponent & { db: Db; syncedAt?: Date }): Promise<GeorgiaReportedFinanceWriteResult> {
  return perform(input.db, prepare("ie", input));
}
