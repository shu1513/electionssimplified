import type { Pool } from "pg";
import type { IdahoCandidateRegistrationRow } from "./idahoCfsClient.js";
import { isVerifiedIdahoPacSource, validateIdahoPacSourceFacts, type IdahoPacSourcePacket } from "./idahoReportedPacCache.js";
import { loadIdahoPacReceiver, qualifyIdahoPacReceiver, type IdahoPacReceiver } from "./idahoReportedPacReceiver.js";
import { aggregateIdahoPacRows, idPacCanonical, idPacCents, idPacGuid, idPacHold, idPacObject, idPacText,
  validateIdahoPacNativeProfile, type IdahoPacAggregation, type IdahoPacScope, IDAHO_REPORTED_PAC_SOURCE_URL } from "./idahoReportedPacSource.js";

type Row = Record<string, unknown>;
const same = (a: unknown, b: unknown) => idPacCanonical(a) === idPacCanonical(b);
export function idPacStoredInteger(v: unknown, min = 0): number {
  const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n < min) idPacHold("invalid_stored_integer"); return n;
}
const iso = (v: unknown) => v instanceof Date ? v.toISOString() : typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : idPacHold("invalid_stored_clock");
const sum = (n: number[]) => idPacStoredInteger(Number(n.reduce((a, b) => a + BigInt(b), 0n)), Number.MIN_SAFE_INTEGER);
export function validateIdahoPacAggregation(a: IdahoPacAggregation): void {
  for (const n of [a.totalCents, a.positiveCents, a.positiveRows, a.negativeRows, a.zeroRows, a.selectedRowCount,
    a.receivingRowCount, a.excludedPacUnitemizedRows, a.canceledGroupCount, a.canceledRowCount]) idPacStoredInteger(n);
  idPacStoredInteger(a.negativeCents, Number.MIN_SAFE_INTEGER); idPacStoredInteger(a.excludedPacUnitemizedCents, Number.MIN_SAFE_INTEGER);
  if (a.negativeCents > 0 || a.receivingRowCount > 10000 || a.selectedRowCount + a.excludedPacUnitemizedRows > a.receivingRowCount ||
    sum([a.positiveRows, a.negativeRows, a.zeroRows]) !== a.selectedRowCount || sum([a.positiveCents, a.negativeCents]) !== a.totalCents ||
    (a.positiveRows === 0) !== (a.positiveCents === 0) || (a.negativeRows === 0) !== (a.negativeCents === 0) || !Array.isArray(a.groups) ||
    a.canceledGroupCount > a.canceledRowCount || (a.canceledGroupCount === 0) !== (a.canceledRowCount === 0)) idPacHold("invalid_aggregation_controls");
  const keys = new Set<string>();
  for (const g of a.groups) {
    if (!g || typeof g.key !== "string" || !/^source:[1-9]\d*$/.test(g.key) || !Number.isSafeInteger(Number(g.key.slice(7))) ||
      idPacText(g.name) !== g.name || keys.has(g.key)) idPacHold("invalid_reported_group");
    keys.add(g.key); idPacStoredInteger(g.cents, 1); idPacStoredInteger(g.rowCount, 1);
  }
  if (sum(a.groups.map(g => g.cents)) !== a.totalCents || sum([a.canceledRowCount, ...a.groups.map(g => g.rowCount)]) !== a.selectedRowCount ||
    (a.groups.length === 0) !== (a.totalCents === 0)) idPacHold("stored_group_closure_mismatch");
}
export function idahoPacFacts(p: IdahoPacSourcePacket) {
  // Contacts remain only in private original files; stored financial facts
  // carry the receiving identity needed by the production read guard.
  const keys = ["filerRegistrationID", "entityID", "electionYear", "filerTypeCode", "registrationStatus", "officeSought", "fullName", "officeDistrictTypeZone", "jurisdictionName"];
  return { scope: p.scope, registration: p.registration, profile: Object.fromEntries(keys.map(k => [k, p.profile[k]])),
    sourceUrl: IDAHO_REPORTED_PAC_SOURCE_URL, sourceControls: p.sourceControls, categoryCents: p.categoryCents,
    categories: p.categories, searchRowCount: p.searchRowCount, nativeGridRegistrationCount: p.registrations.length };
}
function nativeRegistration(value: unknown): IdahoCandidateRegistrationRow {
  const r = idPacObject(value); idPacGuid(r.registrationGuid); idPacGuid(r.entityGuid);
  for (const k of ["filerEntityId", "filerRegistrationId", "filingCycleId"]) idPacStoredInteger(r[k], 1);
  idPacText(r.filerName); idPacText(r.office); idPacText(r.status); idPacText(r.statusCode);
  for (const k of ["firstName", "middleName", "lastName", "districtType", "district", "jurisdiction", "seatZone"])
    if (r[k] !== null && typeof r[k] !== "string") idPacHold("invalid_stored_registration");
  for (const k of ["totalRaised", "totalSpent", "balanceOfFunds"]) idPacCents(r[k]);
  idPacStoredInteger(r.electionYear, 2026); if (Number(r.electionYear) > 2100 || r.isLegacyRecord !== false) idPacHold("invalid_stored_registration");
  return r as unknown as IdahoCandidateRegistrationRow;
}
/** Stored money is accepted only after full uncapped source/group closure. */
export function readStoredIdahoPacComponent(source: Row, groups: Row[], receiver: IdahoPacReceiver) {
  if (source.candidate_id !== receiver.candidate_id || source.election_id !== receiver.election_id || source.link_id !== receiver.link_id ||
    idPacStoredInteger(source.election_year) !== receiver.election_year || source.receiving_registration_guid !== receiver.registration_guid) idPacHold("stored_receiver_mismatch");
  const facts = idPacObject(source.source_facts), registration = nativeRegistration(facts.registration), scope = idPacObject(facts.scope) as unknown as IdahoPacScope;
  if (facts.sourceUrl !== IDAHO_REPORTED_PAC_SOURCE_URL || idPacStoredInteger(facts.nativeGridRegistrationCount, 1) > 5000 ||
    idPacStoredInteger(facts.searchRowCount) > 10000 || idPacStoredInteger(source.native_entity_id, 1) !== registration.filerEntityId ||
    idPacStoredInteger(source.native_registration_id, 1) !== registration.filerRegistrationId) idPacHold("stored_native_identity_mismatch");
  qualifyIdahoPacReceiver(receiver, scope, registration); validateIdahoPacNativeProfile(idPacObject(facts.profile), registration);
  const sourceRetrievedAt = iso(source.source_retrieved_at), sourceCompletedAt = iso(source.source_completed_at);
  validateIdahoPacSourceFacts({ sourceRetrievedAt, sourceCompletedAt, sourceManifestSha256: String(source.source_manifest_sha256),
    sourceByteSize: idPacStoredInteger(source.source_byte_size), sourceControls: facts.sourceControls as IdahoPacSourcePacket["sourceControls"] });
  if (Date.parse(sourceCompletedAt) > Date.parse(iso(source.last_synced_at)) || Date.parse(iso(source.last_synced_at)) > Date.now()) idPacHold("invalid_stored_clock");
  const aggregation = { ...idPacObject(source.aggregation_controls), groups: groups.map(g => {
    if (g.link_id !== receiver.link_id || idPacStoredInteger(g.election_year) !== receiver.election_year) idPacHold("stored_group_receiver_mismatch");
    return { key: String(g.reported_source_key), name: String(g.reported_name), cents: idPacStoredInteger(g.amount_cents), rowCount: idPacStoredInteger(g.source_row_count) };
  }).sort((a, b) => b.cents - a.cents || a.key.localeCompare(b.key)) } as IdahoPacAggregation;
  validateIdahoPacAggregation(aggregation);
  if (!Array.isArray(facts.categories) || facts.categories.length > 20) idPacHold("invalid_stored_categories");
  const codes = new Set<string>(); let pacCents = 0;
  for (const value of facts.categories) {
    const c = idPacObject(value), code = idPacText(c.code), cents = idPacStoredInteger(c.cents, Number.MIN_SAFE_INTEGER);
    if (!["TIND", "TBSN", "TPAC", "TCENC", "TCAN", "TSELF"].includes(code) || codes.has(code)) idPacHold("invalid_stored_categories");
    codes.add(code); if (code === "TPAC") pacCents = cents;
  }
  if (pacCents !== aggregation.totalCents || idPacStoredInteger(facts.categoryCents) !== pacCents ||
    idPacStoredInteger(source.total_cents) !== aggregation.totalCents || idPacStoredInteger(source.group_count) !== groups.length ||
    idPacStoredInteger(source.source_row_count) !== aggregation.selectedRowCount || aggregation.receivingRowCount > idPacStoredInteger(facts.searchRowCount)) idPacHold("stored_source_total_mismatch");
  return { aggregation, sourceRetrievedAt, sourceCompletedAt, facts };
}

/** A caller cannot provide money or a financial clock. Only an immutable
 * original-byte replay can reach this pinned canonical transaction. */
export async function writeIdahoReportedPacReceipts(input: { db: Pick<Pool, "connect">; receiver: IdahoPacReceiver; source: IdahoPacSourcePacket }) {
  const { receiver: expected, source: p } = input;
  if (!isVerifiedIdahoPacSource(p)) idPacHold("unverified_source_packet");
  validateIdahoPacSourceFacts(p); qualifyIdahoPacReceiver(expected, p.scope, p.registration, p.registrations);
  const a = aggregateIdahoPacRows(p.rows); validateIdahoPacAggregation(a);
  if (a.totalCents !== p.categoryCents) idPacHold("reported_pac_category_mismatch");
  const { groups, ...controls } = a, facts = idahoPacFacts(p), client = await input.db.connect();
  try {
    await client.query("BEGIN"); const receiver = await loadIdahoPacReceiver(client, expected.link_id, true);
    if (!receiver || !same(receiver, expected)) idPacHold("receiving_context_changed");
    qualifyIdahoPacReceiver(receiver, p.scope, p.registration, p.registrations);
    const params = [receiver.link_id, receiver.election_year], where = "link_id=$1::uuid AND election_year=$2::int";
    const old = await client.query<Row>(`SELECT * FROM public.id_reported_pac_sources WHERE ${where} FOR UPDATE`, params), prior = old.rows[0], at = new Date().toISOString();
    if (prior) {
      const previous = Date.parse(iso(prior.source_retrieved_at)), next = Date.parse(p.sourceRetrievedAt);
      if (next < previous) idPacHold("stale_source");
      if (next === previous) {
        const saved = await client.query<Row>(`SELECT * FROM public.id_reported_pac_groups WHERE ${where} FOR UPDATE`, params), component = readStoredIdahoPacComponent(prior, saved.rows, receiver);
        if (prior.source_manifest_sha256 !== p.sourceManifestSha256 || idPacStoredInteger(prior.source_byte_size) !== p.sourceByteSize ||
          component.sourceCompletedAt !== p.sourceCompletedAt || !same(component.facts, facts) || !same(component.aggregation, a)) idPacHold("equal_source_conflict");
        await client.query(`UPDATE public.id_reported_pac_sources SET last_synced_at=GREATEST(last_synced_at,$3::timestamptz) WHERE ${where}`, [...params, at]);
        await client.query("COMMIT"); return { groupCount: groups.length, totalCents: a.totalCents, idempotent: true };
      }
    }
    await client.query(`INSERT INTO public.id_reported_pac_sources
      (link_id,election_year,candidate_id,election_id,receiving_registration_guid,native_entity_id,native_registration_id,total_cents,group_count,source_row_count,
       source_retrieved_at,source_completed_at,source_manifest_sha256,source_byte_size,source_facts,aggregation_controls,last_synced_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17)
      ON CONFLICT(link_id,election_year) DO UPDATE SET candidate_id=EXCLUDED.candidate_id,election_id=EXCLUDED.election_id,
       receiving_registration_guid=EXCLUDED.receiving_registration_guid,native_entity_id=EXCLUDED.native_entity_id,native_registration_id=EXCLUDED.native_registration_id,
       total_cents=EXCLUDED.total_cents,group_count=EXCLUDED.group_count,source_row_count=EXCLUDED.source_row_count,
       source_retrieved_at=EXCLUDED.source_retrieved_at,source_completed_at=EXCLUDED.source_completed_at,source_manifest_sha256=EXCLUDED.source_manifest_sha256,
       source_byte_size=EXCLUDED.source_byte_size,source_facts=EXCLUDED.source_facts,aggregation_controls=EXCLUDED.aggregation_controls,last_synced_at=EXCLUDED.last_synced_at`,
    [...params, receiver.candidate_id, receiver.election_id, receiver.registration_guid, p.registration.filerEntityId, p.registration.filerRegistrationId,
      a.totalCents, groups.length, a.selectedRowCount, p.sourceRetrievedAt, p.sourceCompletedAt, p.sourceManifestSha256, p.sourceByteSize, JSON.stringify(facts), JSON.stringify(controls), at]);
    await client.query(`DELETE FROM public.id_reported_pac_groups WHERE ${where}`, params);
    if (groups.length) await client.query(`INSERT INTO public.id_reported_pac_groups
      (link_id,election_year,reported_source_key,reported_name,amount_cents,source_row_count)
      SELECT $1::uuid,$2::int,g.key,g.name,g.cents,g."rowCount" FROM jsonb_to_recordset($3::jsonb) AS g(key text,name text,cents bigint,"rowCount" integer)`, [...params, JSON.stringify(groups)]);
    await client.query("COMMIT"); return { groupCount: groups.length, totalCents: a.totalCents, idempotent: false };
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
}
