import type { Pool } from "pg";
import { ohioCommitteeHold, ohioCommitteeTextKey } from "./ohioCommitteeReceipts.js";
import { isVerifiedOhioCommitteeSource, ohioCommitteeCanonical, ohioCommitteeSourceCandidates, ohioCommitteeSourceComponent,
  validateOhioCommitteeSourceFacts, type OhioCommitteeSourceFacts, type OhioCommitteeSourcePacket } from "./ohioCommitteeSource.js";
import { loadOhioCommitteeReceiver, qualifyOhioCommitteeReceiver, type OhioCommitteeReceiver } from "./ohioCommitteeReceiver.js";
import type { OhioSosCandidateCommitteeListRow } from "./ohioSosBulkFiles.js";

type Row = Record<string,unknown>;
export type OhioCommitteeAggregation = ReturnType<typeof ohioCommitteeSourceComponent>;
const same = (a: unknown,b: unknown) => ohioCommitteeCanonical(a) === ohioCommitteeCanonical(b);
export function ohioCommitteeInteger(v: unknown,min = 0): number {
  const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n < min) ohioCommitteeHold("invalid_stored_integer"); return n;
}
export function ohioCommitteeObject(v: unknown): Row { if (!v || typeof v !== "object" || Array.isArray(v)) ohioCommitteeHold("invalid_stored_object"); return v as Row; }
const iso = (v: unknown) => v instanceof Date ? v.toISOString() : typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : ohioCommitteeHold("invalid_stored_clock");
const sum = (ns: number[]) => ohioCommitteeInteger(Number(ns.reduce((a,b)=>a+BigInt(b),0n)),Number.MIN_SAFE_INTEGER);
export function validateOhioCommitteeAggregation(a: OhioCommitteeAggregation,cycleYear: number) {
  for (const n of [a.totalCents,a.selectedRows,a.receivingRows,a.positiveCents,a.canceledGroupCount,a.canceledRowCount]) ohioCommitteeInteger(n);
  ohioCommitteeInteger(a.negativeCents,Number.MIN_SAFE_INTEGER);
  if (a.negativeCents > 0 || sum([a.positiveCents,a.negativeCents]) !== a.totalCents || a.selectedRows > a.receivingRows ||
    a.canceledGroupCount > a.canceledRowCount || (a.canceledGroupCount===0)!==(a.canceledRowCount===0) || !Array.isArray(a.groups) || !Array.isArray(a.reports) || !a.reports.length)
    ohioCommitteeHold("invalid_aggregation_controls");
  const keys = new Set<string>(), periods = new Set<string>();
  for (const r of a.reports) {
    if (!r || typeof r.reportKey !== "string" || !/^[1-9]\d*$/.test(r.reportKey) || keys.has(r.reportKey) || typeof r.year !== "number" || ![cycleYear-1,cycleYear].includes(r.year) ||
      typeof r.description !== "string" || !r.description.trim() || periods.has(`${r.year}|${r.description}`) || typeof r.filedAt !== "string" || !Number.isFinite(Date.parse(r.filedAt)))
      ohioCommitteeHold("invalid_report_controls");
    keys.add(r.reportKey); periods.add(`${r.year}|${r.description}`);
    ohioCommitteeInteger(r.cashCents,Number.MIN_SAFE_INTEGER); ohioCommitteeInteger(r.inKindCents,Number.MIN_SAFE_INTEGER);
    ohioCommitteeInteger(r.receiptRows); ohioCommitteeInteger(r.selectedRows); if (r.selectedRows>r.receiptRows) ohioCommitteeHold("invalid_report_controls");
  }
  if (sum(a.reports.map(r=>r.receiptRows))!==a.receivingRows || sum(a.reports.map(r=>r.selectedRows))!==a.selectedRows) ohioCommitteeHold("report_count_closure");
  keys.clear();
  for (const g of a.groups) {
    if (!g || typeof g.key!=="string" || keys.has(g.key) || typeof g.name!=="string" || !g.name.trim() || /[\u0000-\u001f\u007f-\u009f]/u.test(g.name)) ohioCommitteeHold("invalid_reported_group");
    keys.add(g.key); ohioCommitteeInteger(g.cents,1); ohioCommitteeInteger(g.rowCount,1);
    if (g.nativeCommitteeId !== null ? !/^[1-9]\d*$/.test(g.nativeCommitteeId) || g.key!==`committee:${g.nativeCommitteeId}` :
      !g.key.startsWith("reported:") || !g.key.endsWith(`|${ohioCommitteeTextKey(g.name)}`)) ohioCommitteeHold("invalid_reported_group_identity");
  }
  if (sum(a.groups.map(g=>g.cents))!==a.totalCents || sum([a.canceledRowCount,...a.groups.map(g=>g.rowCount)])!==a.selectedRows ||
    (a.groups.length===0)!==(a.totalCents===0)) ohioCommitteeHold("stored_group_closure_mismatch");
}
export function readStoredOhioCommitteeComponent(source: Row,groups: Row[],receiver: OhioCommitteeReceiver) {
  if (source.link_id!==receiver.link_id || source.candidate_id!==receiver.candidate_id || source.election_id!==receiver.election_id ||
    ohioCommitteeInteger(source.election_year)!==receiver.election_year || source.receiving_committee_id!==receiver.committee_id) ohioCommitteeHold("stored_receiver_mismatch");
  const facts=ohioCommitteeObject(source.source_facts), native=facts.candidateRows;
  if (!Array.isArray(native) || !native.length || native.length>100) ohioCommitteeHold("invalid_stored_native_context");
  for (const value of native) {
    const r=ohioCommitteeObject(value);
    for(const k of ["masterKey","committeeName","office"]) if(typeof r[k]!=="string" || !(r[k] as string).trim()) ohioCommitteeHold("invalid_stored_native_context");
    for(const k of ["candidateFirstName","candidateLastName","district"]) if(r[k]!==null && typeof r[k]!=="string") ohioCommitteeHold("invalid_stored_native_context");
    if(r.masterKey!==receiver.committee_id) ohioCommitteeHold("stored_native_receiver_mismatch");
  }
  qualifyOhioCommitteeReceiver(receiver,receiver.election_year,native as OhioSosCandidateCommitteeListRow[]);
  const sourceRetrievedAt=iso(source.source_retrieved_at),sourceCompletedAt=iso(source.source_completed_at);
  validateOhioCommitteeSourceFacts({cycleYear:receiver.election_year,nativeFingerprint:facts.nativeFingerprint,
    sourceControls:facts.sourceControls,sourceRetrievedAt,sourceCompletedAt,sourceManifestSha256:source.source_manifest_sha256,
    sourceByteSize:ohioCommitteeInteger(source.source_byte_size)} as OhioCommitteeSourceFacts);
  if(Date.parse(sourceCompletedAt)>Date.parse(iso(source.last_synced_at)) || Date.parse(iso(source.last_synced_at))>Date.now()) ohioCommitteeHold("invalid_stored_clock");
  const aggregation={...ohioCommitteeObject(source.aggregation_controls),groups:groups.map(g=>{
    if(g.link_id!==receiver.link_id || ohioCommitteeInteger(g.election_year)!==receiver.election_year) ohioCommitteeHold("stored_group_receiver_mismatch");
    return {key:g.reported_source_key,name:g.reported_name,nativeCommitteeId:g.native_committee_id,cents:ohioCommitteeInteger(g.amount_cents),rowCount:ohioCommitteeInteger(g.source_row_count)};
  }).sort((a,b)=>b.cents-a.cents||String(a.key).localeCompare(String(b.key)))} as OhioCommitteeAggregation;
  validateOhioCommitteeAggregation(aggregation,receiver.election_year);
  if(ohioCommitteeInteger(source.total_cents)!==aggregation.totalCents || ohioCommitteeInteger(source.group_count)!==groups.length ||
    ohioCommitteeInteger(source.source_row_count)!==aggregation.selectedRows) ohioCommitteeHold("stored_source_total_mismatch");
  return {aggregation,facts,sourceRetrievedAt,sourceCompletedAt};
}
/** Financial rows and clocks can only come from a branded original-byte replay. */
export async function writeOhioCommitteeReceipts(input:{db:Pick<Pool,"connect">;receiver:OhioCommitteeReceiver;source:OhioCommitteeSourcePacket}) {
  const {receiver:expected,source:p}=input;
  if(!isVerifiedOhioCommitteeSource(p)) ohioCommitteeHold("unverified_source_packet"); validateOhioCommitteeSourceFacts(p);
  const candidates=ohioCommitteeSourceCandidates(p); qualifyOhioCommitteeReceiver(expected,p.cycleYear,candidates);
  const a=ohioCommitteeSourceComponent(p,expected.committee_id); validateOhioCommitteeAggregation(a,p.cycleYear);
  const {groups,...controls}=a, facts={nativeFingerprint:p.nativeFingerprint,sourceControls:p.sourceControls,
    candidateRows:candidates.filter(r=>r.masterKey===expected.committee_id).map(r=>({masterKey:r.masterKey,committeeName:r.committeeName,
      candidateFirstName:r.candidateFirstName,candidateLastName:r.candidateLastName,office:r.office,district:r.district}))};
  const c=await input.db.connect();
  try {
    await c.query("BEGIN"); const receiver=await loadOhioCommitteeReceiver(c,expected.link_id,true);
    if(!receiver || !same(receiver,expected)) ohioCommitteeHold("receiving_context_changed"); qualifyOhioCommitteeReceiver(receiver,p.cycleYear,candidates);
    const params=[receiver.link_id,receiver.election_year],where="link_id=$1::uuid AND election_year=$2::int";
    const old=(await c.query<Row>(`SELECT * FROM public.oh_reported_committee_sources WHERE ${where} FOR UPDATE`,params)).rows[0],at=new Date().toISOString();
    if(old) {
      const previous=Date.parse(iso(old.source_completed_at)),next=Date.parse(p.sourceCompletedAt);
      if(next<previous) ohioCommitteeHold("stale_source");
      if(next===previous) {
        const saved=await c.query<Row>(`SELECT * FROM public.oh_reported_committee_groups WHERE ${where} FOR UPDATE`,params),component=readStoredOhioCommitteeComponent(old,saved.rows,receiver);
        if(old.source_manifest_sha256!==p.sourceManifestSha256 || ohioCommitteeInteger(old.source_byte_size)!==p.sourceByteSize ||
          component.sourceRetrievedAt!==p.sourceRetrievedAt || !same(component.facts,facts) || !same(component.aggregation,a)) ohioCommitteeHold("equal_source_conflict");
        await c.query(`UPDATE public.oh_reported_committee_sources SET last_synced_at=GREATEST(last_synced_at,$3::timestamptz) WHERE ${where}`,[...params,at]);
        await c.query("COMMIT"); return {totalCents:a.totalCents,groupCount:groups.length,idempotent:true};
      }
    }
    await c.query(`INSERT INTO public.oh_reported_committee_sources
      (link_id,election_year,candidate_id,election_id,receiving_committee_id,total_cents,group_count,source_row_count,
       source_retrieved_at,source_completed_at,source_manifest_sha256,source_byte_size,source_facts,aggregation_controls,last_synced_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15)
      ON CONFLICT(link_id,election_year) DO UPDATE SET candidate_id=EXCLUDED.candidate_id,election_id=EXCLUDED.election_id,
       receiving_committee_id=EXCLUDED.receiving_committee_id,total_cents=EXCLUDED.total_cents,group_count=EXCLUDED.group_count,source_row_count=EXCLUDED.source_row_count,
       source_retrieved_at=EXCLUDED.source_retrieved_at,source_completed_at=EXCLUDED.source_completed_at,source_manifest_sha256=EXCLUDED.source_manifest_sha256,
       source_byte_size=EXCLUDED.source_byte_size,source_facts=EXCLUDED.source_facts,aggregation_controls=EXCLUDED.aggregation_controls,last_synced_at=EXCLUDED.last_synced_at`,
    [...params,receiver.candidate_id,receiver.election_id,receiver.committee_id,a.totalCents,groups.length,a.selectedRows,
      p.sourceRetrievedAt,p.sourceCompletedAt,p.sourceManifestSha256,p.sourceByteSize,JSON.stringify(facts),JSON.stringify(controls),at]);
    await c.query(`DELETE FROM public.oh_reported_committee_groups WHERE ${where}`,params);
    if(groups.length) await c.query(`INSERT INTO public.oh_reported_committee_groups
      (link_id,election_year,reported_source_key,reported_name,native_committee_id,amount_cents,source_row_count)
      SELECT $1::uuid,$2::int,g.key,g.name,g."nativeCommitteeId",g.cents,g."rowCount" FROM jsonb_to_recordset($3::jsonb)
      AS g(key text,name text,"nativeCommitteeId" text,cents bigint,"rowCount" integer)`,[...params,JSON.stringify(groups)]);
    await c.query("COMMIT"); return {totalCents:a.totalCents,groupCount:groups.length,idempotent:false};
  }catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}
}
