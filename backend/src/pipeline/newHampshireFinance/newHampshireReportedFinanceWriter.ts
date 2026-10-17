import type { Pool, PoolClient } from "pg";
import { aggregateNewHampshireReportedCommitteeReceipts, aggregateNewHampshireReportedIe } from "./newHampshireReportedFinanceAggregation.js";
import { NEW_HAMPSHIRE_FINANCE_ELIGIBLE_OFFICE_KEYS } from "./newHampshireFinanceEligibleOffices.js";
import { isVerifiedNewHampshireReportedSource, type NewHampshireReportedSourcePacket } from "./newHampshireReportedSourceCache.js";
import { qualifyNewHampshireReportedReceiver, newHampshireAmbiguousSourceTargetAliases, type NewHampshireReportedReceiver } from "./newHampshireReportedReceiver.js";
import { nhReportedIso, validateNewHampshireReportedCounts, validateNewHampshireReportedSourceFacts } from "./newHampshireReportedSourceFacts.js";
import { nhSourceHold } from "./newHampshireReportedSourceGraph.js";

type Row = Record<string, unknown>;
type Input = { db: Pick<Pool, "connect">; receiver: NewHampshireReportedReceiver;
  source: NewHampshireReportedSourcePacket; ambiguousAliases?: ReadonlySet<string>; syncedAt?: Date };
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const canonical = (v: unknown): string => JSON.stringify(v, (_, x) => x && typeof x === "object" && !Array.isArray(x)
  ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);
const aliases = (values: readonly string[]) => [...new Set(values.map(v => v.trim()).filter(Boolean))].sort();
function prepare(input: Input) {
  const r = input.receiver, s = input.source, now = input.syncedAt ?? new Date();
  if (![r.linkId, r.candidateId, r.electionId].every(id => UUID.test(id) && id !== "00000000-0000-0000-0000-000000000000") ||
    !Number.isSafeInteger(r.filingEntityId) || r.filingEntityId < 1 || !["manual", "cfs_registration"].includes(r.linkSource) ||
    !Array.isArray(r.candidateAliases) || !r.candidateAliases.length || !Number.isFinite(now.getTime()) || now.getTime() > Date.now() ||
    !isVerifiedNewHampshireReportedSource(s) || s.electionYear !== r.electionYear ||
    s.kind === "committee" && s.filingEntityId !== r.filingEntityId || s.kind === "ie" && s.filingEntityId !== null) nhSourceHold("invalid_component_input");
  validateNewHampshireReportedSourceFacts(s, now.getTime());
  const context = qualifyNewHampshireReportedReceiver(r, s.base), registrationGuid = context.registrationGuid;
  const keys = { link_id: r.linkId, election_year: r.electionYear, component: s.kind };
  const source: Row = { ...keys, candidate_id: r.candidateId, election_id: r.electionId,
    receiving_entity_id: String(r.filingEntityId), registration_guid: registrationGuid,
    source_row_count: s.sourceRowCount, current_row_count: s.currentRows.length, historical_row_count: s.historicalRowCount,
    source_url: s.sourceUrl, source_base_retrieved_at: s.sourceBaseRetrievedAt, source_retrieved_at: s.sourceRetrievedAt,
    source_completed_at: s.sourceCompletedAt, source_manifest_sha256: s.sourceManifestSha256,
    source_byte_size: s.sourceByteSize, source_controls: s.sourceControls, last_synced_at: now.toISOString() };
  let groups: Row[], totalCents: number, supportCents = 0, opposeCents = 0, occurrenceCount: number,
    excludedCurrentRows: number, nonpositiveRows = 0;
  if (s.kind === "committee") {
    const a = aggregateNewHampshireReportedCommitteeReceipts(s);
    totalCents = a.totalAmountCents; occurrenceCount = a.contributionCount; excludedCurrentRows = a.excludedCurrentRowCount;
    groups = a.groups.map(g => ({ ...keys, reported_group_key: g.reportedNameKey, reported_group_id: null,
      reported_name: g.reportedName, support_oppose: "direct", amount_cents: g.amountCents, occurrence_count: g.contributionCount }));
  } else {
    const ambiguousAliases = new Set([...newHampshireAmbiguousSourceTargetAliases(s.base),...(input.ambiguousAliases??[])]);
    const a = aggregateNewHampshireReportedIe({ source: s, candidateAliases: context.candidateAliases, ambiguousAliases });
    supportCents = a.supportTotalCents; opposeCents = a.opposeTotalCents; totalCents = supportCents + opposeCents;
    occurrenceCount = a.expenditureCount; excludedCurrentRows = s.currentRows.length - a.matchedTargetRowCount; nonpositiveRows = a.nonPositiveRowCount;
    groups = a.groups.map(g => ({ ...keys, reported_group_key: g.reportedSpenderId, reported_group_id: g.reportedSpenderId,
      reported_name: g.reportedSpenderName, support_oppose: g.supportOppose, amount_cents: g.amountCents, occurrence_count: g.expenditureCount }));
  }
  validateNewHampshireReportedCounts({ component: s.kind, sourceRows: s.sourceRowCount, currentRows: s.currentRows.length,
    historicalRows: s.historicalRowCount, occurrenceCount, groupCount: groups.length, excludedCurrentRows, nonpositiveRows,
    totalCents, supportCents, opposeCents });
  Object.assign(source, { total_amount_cents: totalCents, support_total_cents: supportCents, oppose_total_cents: opposeCents,
    occurrence_count: occurrenceCount, group_count: groups.length, excluded_current_row_count: excludedCurrentRows, nonpositive_row_count: nonpositiveRows });
  return { keys, source, groups, now, receiver: r };
}
type Prepared = ReturnType<typeof prepare>;
async function lockReceiver(db: PoolClient, p: Prepared) {
  const r = p.receiver;
  const context = await db.query<Row>(`SELECT c.id::text candidate_id,e.id::text election_id,e.election_date::text election_date,
      EXTRACT(YEAR FROM e.election_date)::int election_year,c.deleted_at,ce.status candidate_status,d.state,e.race_type,e.election_stage,
      o.scope office_scope,o.canonical_name,c.display_name,NULLIF(trim(c.first_name || ' ' || c.last_name),'') structured_name
    FROM public.candidates c JOIN public.candidate_elections ce ON ce.candidate_id=c.id
    JOIN public.elections e ON e.id=ce.election_id JOIN public.districts d ON d.id=e.district_id
    JOIN public.offices o ON o.id=e.office_id WHERE c.id=$1::uuid AND e.id=$2::uuid FOR UPDATE OF c,ce,e,d,o`, [r.candidateId,r.electionId]);
  const current = context.rows[0];
  if (context.rows.length !== 1 || !current || current.deleted_at !== null || typeof current.candidate_status !== "string" || ["lost","withdrawn"].includes(current.candidate_status) ||
    current.state !== "NH" || current.race_type !== "office" || current.election_stage !== "general" || current.election_date !== r.electionDate ||
    current.election_year !== r.electionYear || current.office_scope !== r.officeScope ||
    !NEW_HAMPSHIRE_FINANCE_ELIGIBLE_OFFICE_KEYS.includes(`${current.office_scope}::${current.canonical_name}` as typeof NEW_HAMPSHIRE_FINANCE_ELIGIBLE_OFFICE_KEYS[number])) nhSourceHold("receiving_context_changed");
  const links = await db.query<Row>(`SELECT id::text link_id,filing_entity_id,filer_name,link_source,office_name,district,candidate_name_normalized
    FROM public.nh_candidate_finance_links WHERE candidate_id=$1::uuid AND election_id=$2::uuid AND election_year=$3 AND link_status='active'
    ORDER BY id FOR UPDATE`, [r.candidateId,r.electionId,r.electionYear]);
  const link = links.rows[0];
  if (links.rows.length !== 1 || !link || link.link_id !== r.linkId || link.filing_entity_id !== String(r.filingEntityId) ||
    link.link_source !== r.linkSource || link.office_name !== r.officeName || link.district !== r.district ||
    canonical(aliases([String(current.display_name ?? ""),String(current.structured_name ?? ""),String(link.candidate_name_normalized)])) !== canonical(aliases(r.candidateAliases))) nhSourceHold("receiving_context_changed");
}
const where = "link_id=$1::uuid AND election_year=$2 AND component=$3";
function normalized(value: unknown, expected: unknown, key: string) {
  if (key.endsWith("_at")) return nhReportedIso(value);
  if (typeof expected === "number" && (typeof value === "number" || typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value))) return Number(value);
  return value;
}
function matching(row: Row, expected: Row): boolean {
  return Object.entries(expected).every(([key, value]) => key === "last_synced_at" || canonical(normalized(row[key], value, key)) === canonical(value));
}
function equalGroups(rows: Row[], expected: Row[]) {
  if (rows.length !== expected.length) return false;
  const shape = expected[0];
  if (!shape) return true;
  const values = (input: Row[]) => input.map(row => canonical(Object.fromEntries(Object.entries(shape).map(([key,value]) => [key,normalized(row[key],value,key)])))).sort();
  return canonical(values(rows)) === canonical(values(expected));
}

/** A verified immutable cache packet is aggregated here; callers cannot
 * supply replacement amounts/groups. Only independent component tables change. */
export async function writeNewHampshireReportedComponent(input: Input): Promise<{ groupCount: number; idempotent: boolean }> {
  const p = prepare(input), client = await input.db.connect(), values = Object.values(p.keys);
  let begun = false;
  try {
    await client.query("BEGIN"); begun = true;
    await lockReceiver(client,p);
    const prior = await client.query<Row>(`SELECT * FROM public.nh_reported_finance_components WHERE ${where} FOR UPDATE`,values);
    if (prior.rows.length > 1) nhSourceHold("stored_component_conflict");
    if (prior.rows.length === 1) {
      const old = prior.rows[0]!, clock = nhReportedIso(old.source_retrieved_at);
      if (clock > p.source.source_retrieved_at!) nhSourceHold("stale_source");
      if (clock === p.source.source_retrieved_at) {
        const stored = await client.query<Row>(`SELECT * FROM public.nh_reported_finance_groups WHERE ${where} FOR UPDATE`,values);
        if (!matching(old,p.source) || !equalGroups(stored.rows,p.groups)) nhSourceHold("equal_source_conflict");
        await client.query(`UPDATE public.nh_reported_finance_components SET last_synced_at=GREATEST(last_synced_at,$4::timestamptz) WHERE ${where}`,[...values,p.now.toISOString()]);
        await client.query("COMMIT"); begun=false;
        return { groupCount:p.groups.length,idempotent:true };
      }
    }
    const columns=Object.keys(p.source);
    const saved=await client.query(`INSERT INTO public.nh_reported_finance_components (${columns.join(",")})
      VALUES (${columns.map((key,i)=>`$${i+1}${key==="source_controls"?"::jsonb":""}`).join(",")})
      ON CONFLICT (link_id,election_year,component) DO UPDATE SET ${columns.filter(key=>!(key in p.keys)).map(key=>`${key}=EXCLUDED.${key}`).join(",")}
      WHERE nh_reported_finance_components.source_retrieved_at < EXCLUDED.source_retrieved_at RETURNING 1`,
      columns.map(key=>key==="source_controls"?JSON.stringify(p.source[key]):p.source[key]));
    if (saved.rows.length!==1) nhSourceHold("stale_source");
    await client.query(`DELETE FROM public.nh_reported_finance_groups WHERE ${where}`,values);
    if(p.groups.length)await client.query(`INSERT INTO public.nh_reported_finance_groups
      (link_id,election_year,component,reported_group_key,reported_group_id,reported_name,support_oppose,amount_cents,occurrence_count)
      SELECT link_id,election_year,component,reported_group_key,reported_group_id,reported_name,support_oppose,amount_cents,occurrence_count
      FROM jsonb_to_recordset($1::jsonb) AS item(link_id uuid,election_year integer,component text,reported_group_key text,
        reported_group_id text,reported_name text,support_oppose text,amount_cents bigint,occurrence_count integer)`,[JSON.stringify(p.groups)]);
    await client.query("COMMIT");begun=false;
    return {groupCount:p.groups.length,idempotent:false};
  }catch(error){if(begun)await client.query("ROLLBACK").catch(()=>{});throw error;}
  finally{client.release();}
}
