import type { Pool } from "pg";
import { mtCommitteeCanonical as canonical, mtCommitteeHold as hold, mtCommitteeText, mtCommitteeObject,
  type MontanaReportedCommitteeAggregation } from "./montanaReportedCommitteeSource.js";
import { montanaCommitteePacketData, type MontanaCommitteePacket } from "./montanaReportedCommitteeCache.js";
import { loadMontanaCommitteeReceiver, qualifyMontanaCommitteeReceiver, type MontanaCommitteeReceiver } from "./montanaReportedCommitteeReceiver.js";
import type { MontanaCersCandidateSearchRow } from "./montanaCersParsers.js";

type Row=Record<string,unknown>;
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
export function mtStoredInteger(value:unknown,min=0):number {
  const n=typeof value==="number"?value:typeof value==="string"&&/^-?\d+$/.test(value)?Number(value):NaN;
  if(!Number.isSafeInteger(n)||n<min)hold("invalid_stored_integer");return n;
}
const sum=(ns:number[])=>mtStoredInteger(Number(ns.reduce((a,b)=>a+BigInt(b),0n)),Number.MIN_SAFE_INTEGER);
const iso=(value:unknown)=>value instanceof Date?value.toISOString():typeof value==="string"&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():hold("invalid_stored_clock");
export function validateMontanaCommitteeAggregation(a:MontanaReportedCommitteeAggregation){
  for(const n of [a.totalCents,a.receivingRows,a.selectedRows,a.positiveCents,a.canceledGroupCount,a.canceledRowCount])mtStoredInteger(n);
  mtStoredInteger(a.negativeCents,Number.MIN_SAFE_INTEGER);
  if(a.negativeCents>0||sum([a.positiveCents,a.negativeCents])!==a.totalCents||a.selectedRows>a.receivingRows||a.canceledGroupCount>a.canceledRowCount||
    (a.canceledGroupCount===0)!==(a.canceledRowCount===0)||!Array.isArray(a.groups)||!Array.isArray(a.reports)||!a.reports.length)hold("invalid_stored_controls");
  const ids=new Set<number>();
  for(const r of a.reports){
    mtStoredInteger(r.reportId,1);if(ids.has(r.reportId)||r.form!=="C5"||!["FILED","AMEND","PENDA"].includes(r.status))hold("invalid_stored_report");ids.add(r.reportId);
    for(const d of [r.from,r.to])if(typeof d!=="string"||!/^\d{2}\/\d{2}\/\d{4}$/.test(d))hold("invalid_stored_report");
    mtStoredInteger(r.receivedAt,1);if(r.amendedAt!==null)mtStoredInteger(r.amendedAt,1);
    for(const n of [r.primaryCashBeginningCents,r.generalCashBeginningCents])if(n!==null)mtStoredInteger(n,Number.MIN_SAFE_INTEGER);
    mtStoredInteger(r.committeeRows);for(const n of [r.cashCents,r.inKindCents,r.totalCents])mtStoredInteger(n,Number.MIN_SAFE_INTEGER);
    if(sum([r.cashCents,r.inKindCents])!==r.totalCents)hold("stored_report_money_composition");
  }
  if(sum(a.reports.map(r=>r.committeeRows))!==a.selectedRows||sum(a.reports.map(r=>r.totalCents))!==a.totalCents)hold("stored_report_closure");
  ids.clear();for(const g of a.groups){
    mtStoredInteger(g.sourceEntityId,1);if(ids.has(g.sourceEntityId)||g.key!==`entity:${g.sourceEntityId}`||mtCommitteeText(g.name)!==g.name)hold("invalid_stored_group");ids.add(g.sourceEntityId);
    mtStoredInteger(g.cents,1);mtStoredInteger(g.rowCount,1);
    if(!Array.isArray(g.committeeTypes)||!g.committeeTypes.length||new Set(g.committeeTypes).size!==g.committeeTypes.length||
      g.committeeTypes.some(t=>!["PA","FA","PP","FP","IN","IL","JF","BI","DB","DP","MP","UN"].includes(t)))hold("invalid_stored_committee_type");
  }
  if(sum(a.groups.map(g=>g.cents))!==a.totalCents||sum([a.canceledRowCount,...a.groups.map(g=>g.rowCount)])!==a.selectedRows||
    (a.groups.length===0)!==(a.totalCents===0))hold("stored_group_closure");
}
export function readStoredMontanaCommitteeComponent(source:Row,groups:Row[],receiver:MontanaCommitteeReceiver){
  if(source.link_id!==receiver.link_id||source.candidate_id!==receiver.candidate_id||source.election_id!==receiver.election_id||
    mtStoredInteger(source.election_year)!==receiver.election_year||source.receiving_committee_id!==receiver.committee_id)hold("stored_receiver_mismatch");
  const facts=mtCommitteeObject(source.source_facts),native=facts.candidates;
  if(!Array.isArray(native)||!native.length||native.length>5000)hold("invalid_stored_candidate_graph");
  for(const v of native){const r=mtCommitteeObject(v);mtStoredInteger(r.candidateId,1);if(r.electionYear!==null)mtStoredInteger(r.electionYear,2020);
    mtCommitteeText(r.lastName);
    for(const k of ["firstName","middleInitial","officeTitle","officeCode","partyDescr","candidateStatusDescr","resCountyDescr"])
      if(r[k]!==null&&typeof r[k]!=="string")hold("invalid_stored_candidate_graph");
  }
  if(new Set(native.map(r=>(r as Row).candidateId)).size!==native.length)hold("duplicate_stored_candidate");
  qualifyMontanaCommitteeReceiver(receiver,native as MontanaCersCandidateSearchRow[]);
  const sourceRetrievedAt=iso(source.source_retrieved_at),sourceCompletedAt=iso(source.source_completed_at),synced=iso(source.last_synced_at);
  if(!/^[a-f0-9]{64}$/.test(String(source.source_manifest_sha256))||mtStoredInteger(source.source_byte_size,1)>256*1024*1024||
    sourceRetrievedAt>sourceCompletedAt||sourceCompletedAt>synced||Date.parse(synced)>Date.now())hold("invalid_stored_provenance");
  const captures=facts.captures;if(!Array.isArray(captures)||captures.length<12||captures.length>400)hold("invalid_stored_capture_controls");
  let bytes=0;for(const raw of captures){const c=mtCommitteeObject(raw);bytes+=mtStoredInteger(c.bytes);mtCommitteeText(c.role);
    if(![200,302].includes(mtStoredInteger(c.status))||!/^[a-f0-9]{64}$/.test(String(c.sha256))||iso(c.capturedAt)<sourceRetrievedAt||iso(c.capturedAt)>sourceCompletedAt)hold("invalid_stored_capture_controls");}
  if(bytes!==mtStoredInteger(source.source_byte_size)||iso(captures[0].capturedAt)!==sourceRetrievedAt||iso(captures.at(-1).capturedAt)!==sourceCompletedAt)hold("stored_byte_clock_closure");
  const aggregation={...mtCommitteeObject(source.aggregation_controls),groups:groups.map(g=>{
    if(g.link_id!==receiver.link_id||mtStoredInteger(g.election_year)!==receiver.election_year)hold("stored_group_receiver_mismatch");
    const id=mtStoredInteger(g.source_entity_id,1);return {key:`entity:${id}`,sourceEntityId:id,name:g.reported_name as string,
      cents:mtStoredInteger(g.amount_cents,1),rowCount:mtStoredInteger(g.source_row_count,1),committeeTypes:g.committee_types as string[]};
  }).sort((a,b)=>b.cents-a.cents||a.key.localeCompare(b.key))} as MontanaReportedCommitteeAggregation;
  validateMontanaCommitteeAggregation(aggregation);
  if(mtStoredInteger(source.total_cents)!==aggregation.totalCents||mtStoredInteger(source.group_count)!==groups.length||mtStoredInteger(source.source_row_count)!==aggregation.selectedRows)hold("stored_source_closure");
  return {aggregation,facts,sourceRetrievedAt,sourceCompletedAt};
}
export async function writeMontanaCommitteeReceipts(input:{db:Pick<Pool,"connect">;receiver:MontanaCommitteeReceiver;source:MontanaCommitteePacket}){
  const {source:p,receiver:expected}=input,data=montanaCommitteePacketData(p),a=data.aggregation;
  if(p.scope.nativeCandidateId!==Number(expected.committee_id)||p.scope.electionYear!==expected.election_year)hold("packet_receiver_mismatch");
  qualifyMontanaCommitteeReceiver(expected,data.candidates);validateMontanaCommitteeAggregation(a);
  const {groups,...controls}=a,facts={candidates:data.candidates,captures:data.manifest.captures.map(({role,status,capturedAt,bytes,sha256})=>({role,status,capturedAt,bytes,sha256}))};
  const c=await input.db.connect();try{
    await c.query("BEGIN");const current=await loadMontanaCommitteeReceiver(c,expected.link_id,true);
    if(!current||!same(current,expected))hold("canonical_receiving_context_changed");qualifyMontanaCommitteeReceiver(current,data.candidates);
    const params=[current.link_id,current.election_year],where="link_id=$1::uuid AND election_year=$2::int";
    const old=(await c.query<Row>(`SELECT * FROM public.mt_reported_committee_sources WHERE ${where} FOR UPDATE`,params)).rows[0];
    if(old){
      const previous=iso(old.source_completed_at);if(p.sourceCompletedAt<previous)hold("older_source");
      if(p.sourceCompletedAt===previous){
        const priorGroups=await c.query<Row>(`SELECT * FROM public.mt_reported_committee_groups WHERE ${where} FOR UPDATE`,params),saved=readStoredMontanaCommitteeComponent(old,priorGroups.rows,current);
        if(old.source_manifest_sha256!==p.sourceManifestSha256||saved.sourceRetrievedAt!==p.sourceRetrievedAt||!same(saved.aggregation,a)||!same(saved.facts,facts))hold("equal_source_conflict");
        await c.query("COMMIT");return {totalCents:a.totalCents,groupCount:groups.length,idempotent:true};
      }
    }
    const at=new Date().toISOString();if(p.sourceCompletedAt>at)hold("future_source");
    await c.query(`INSERT INTO public.mt_reported_committee_sources
      (link_id,election_year,candidate_id,election_id,receiving_committee_id,total_cents,group_count,source_row_count,
       source_retrieved_at,source_completed_at,source_manifest_sha256,source_byte_size,source_facts,aggregation_controls,last_synced_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15)
      ON CONFLICT(link_id,election_year) DO UPDATE SET candidate_id=EXCLUDED.candidate_id,election_id=EXCLUDED.election_id,
       receiving_committee_id=EXCLUDED.receiving_committee_id,total_cents=EXCLUDED.total_cents,group_count=EXCLUDED.group_count,source_row_count=EXCLUDED.source_row_count,
       source_retrieved_at=EXCLUDED.source_retrieved_at,source_completed_at=EXCLUDED.source_completed_at,source_manifest_sha256=EXCLUDED.source_manifest_sha256,
       source_byte_size=EXCLUDED.source_byte_size,source_facts=EXCLUDED.source_facts,aggregation_controls=EXCLUDED.aggregation_controls,last_synced_at=EXCLUDED.last_synced_at`,
    [...params,current.candidate_id,current.election_id,current.committee_id,a.totalCents,groups.length,a.selectedRows,p.sourceRetrievedAt,p.sourceCompletedAt,p.sourceManifestSha256,p.sourceByteSize,JSON.stringify(facts),JSON.stringify(controls),at]);
    await c.query(`DELETE FROM public.mt_reported_committee_groups WHERE ${where}`,params);
    if(groups.length)await c.query(`INSERT INTO public.mt_reported_committee_groups
      (link_id,election_year,source_entity_id,reported_name,amount_cents,source_row_count,committee_types)
      SELECT $1::uuid,$2::int,g."sourceEntityId",g.name,g.cents,g."rowCount",g."committeeTypes" FROM jsonb_to_recordset($3::jsonb)
      AS g("sourceEntityId" bigint,name text,cents bigint,"rowCount" integer,"committeeTypes" jsonb)`,[...params,JSON.stringify(groups)]);
    await c.query("COMMIT");return {totalCents:a.totalCents,groupCount:groups.length,idempotent:false};
  }catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}
}
