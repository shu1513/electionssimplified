import type {Pool} from "pg";
import {mtCommitteeCanonical as canonical,mtCommitteeObject,mtCommitteeCents,mtCommitteeText,mtCommitteeInteger} from "./montanaReportedCommitteeSource.js";
import {mtStoredInteger} from "./montanaReportedCommitteeWriter.js";
import {assertMontanaIePacket,montanaIePacketAggregation,montanaIePacketCandidates,mtIeHold as hold,type MontanaIndependentIePacket} from "./montanaIndependentIeSource.js";
import {loadMontanaCommitteeReceiver,qualifyMontanaCommitteeReceiver,type MontanaCommitteeReceiver} from "./montanaReportedCommitteeReceiver.js";
import type {MontanaCersCandidateSearchRow} from "./montanaCersParsers.js";

type Row=Record<string,unknown>;
export type MontanaIePosition={supportCents:number|null;opposeCents:number|null;totalCents:number;rowCount:number;
  groups:{committeeId:string;name:string;stance:"support"|"oppose";cents:number}[]};
const iso=(v:unknown)=>v instanceof Date?v.toISOString():typeof v==="string"&&Number.isFinite(Date.parse(v))?new Date(v).toISOString():hold("invalid_stored_clock");
const sum=(ns:number[])=>mtStoredInteger(Number(ns.reduce((n,v)=>n+BigInt(v),0n)));
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
export function validateMontanaIePosition(a:MontanaIePosition){
  mtStoredInteger(a.totalCents);mtStoredInteger(a.rowCount);if(!Array.isArray(a.groups))hold("invalid_stored_groups");
  const keys=new Set<string>();for(const g of a.groups){
    if(typeof g.committeeId!=="string"||!/^[1-9]\d*$/.test(g.committeeId)||mtCommitteeText(g.name)!==g.name||!["support","oppose"].includes(g.stance)||keys.has(g.committeeId+"|"+g.stance))hold("invalid_stored_group");
    keys.add(g.committeeId+"|"+g.stance);mtStoredInteger(g.cents,1);
  }
  for(const stance of["support","oppose"] as const){const groups=a.groups.filter(g=>g.stance===stance),total=a[stance==="support"?"supportCents":"opposeCents"];
    if(groups.length?total===null||mtStoredInteger(total,1)!==sum(groups.map(g=>g.cents)):total!==null)hold("stored_stance_closure");}
  if(sum(a.groups.map(g=>g.cents))!==a.totalCents||a.rowCount<a.groups.length||(a.rowCount===0)!==(a.groups.length===0))hold("stored_money_count_closure");
}
function position(p:MontanaIndependentIePacket,r:MontanaCommitteeReceiver):MontanaIePosition{
  const a=montanaIePacketAggregation(p,Number(r.committee_id)),value={supportCents:a.supportTotal===null?null:mtCommitteeCents(a.supportTotal),opposeCents:a.opposeTotal===null?null:mtCommitteeCents(a.opposeTotal),
    totalCents:mtCommitteeCents(a.attributedAmount),rowCount:a.attributedRowCount,groups:a.outsideGroups.map(g=>({committeeId:g.committeeId,name:g.committeeName,stance:g.supportOppose,cents:mtCommitteeCents(g.amount)}))};
  value.groups.sort((a,b)=>b.cents-a.cents||a.committeeId.localeCompare(b.committeeId)||a.stance.localeCompare(b.stance));validateMontanaIePosition(value);return value;
}
export function readStoredMontanaIePosition(source:Row,groups:Row[],r:MontanaCommitteeReceiver){
  if(source.link_id!==r.link_id||source.candidate_id!==r.candidate_id||source.election_id!==r.election_id||mtStoredInteger(source.election_year)!==r.election_year||source.receiving_candidate_id!==r.committee_id)hold("stored_receiver_mismatch");
  const facts=mtCommitteeObject(source.source_facts),native=mtCommitteeObject(facts.nativeCandidate);mtCommitteeInteger(native.candidateId,1);mtCommitteeInteger(native.electionYear,2024);mtCommitteeText(native.lastName);
  for(const k of["firstName","middleInitial","officeTitle","officeCode","partyDescr","candidateStatusDescr","resCountyDescr"])if(native[k]!==null&&typeof native[k]!=="string")hold("invalid_stored_native_identity");
  if(String(native.candidateId)!==r.committee_id)hold("stored_native_identity_mismatch");qualifyMontanaCommitteeReceiver(r,[native as MontanaCersCandidateSearchRow]);
  const retrievedAt=iso(source.source_retrieved_at),completedAt=iso(source.source_completed_at),syncedAt=iso(source.last_synced_at);
  if(retrievedAt>completedAt||completedAt>syncedAt||Date.parse(syncedAt)>Date.now()||mtStoredInteger(source.source_byte_size,1)>128*1024*1024||
    mtStoredInteger(source.source_original_count,3)>2000||![source.source_manifest_sha256,facts.sweepSha256,facts.registrationSha256].every(v=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v)))hold("invalid_stored_source_provenance");
  const a:MontanaIePosition={supportCents:source.support_cents===null?null:mtStoredInteger(source.support_cents,1),opposeCents:source.oppose_cents===null?null:mtStoredInteger(source.oppose_cents,1),
    totalCents:mtStoredInteger(source.total_cents),rowCount:mtStoredInteger(source.attributed_row_count),groups:groups.map(g=>{
      if(g.link_id!==r.link_id||mtStoredInteger(g.election_year)!==r.election_year)hold("stored_group_receiver_mismatch");
      if(typeof g.committee_id!=="string"||typeof g.committee_name!=="string"||typeof g.support_oppose!=="string")hold("invalid_stored_group");
      return {committeeId:g.committee_id as string,name:g.committee_name as string,stance:g.support_oppose as "support"|"oppose",cents:mtStoredInteger(g.amount_cents,1)};
    }).sort((a,b)=>b.cents-a.cents||a.committeeId.localeCompare(b.committeeId)||a.stance.localeCompare(b.stance))};
  validateMontanaIePosition(a);if(mtStoredInteger(source.group_count)!==groups.length)hold("stored_group_count_mismatch");return {position:a,facts,retrievedAt,completedAt};
}
/** Own atomic component; direct snapshots, checked-at stamps and legacy IE
 * rows are never mutated, including when a direct cash chain is held. */
export async function writeMontanaIndependentIe(input:{db:Pick<Pool,"connect">;receiver:MontanaCommitteeReceiver;source:MontanaIndependentIePacket}){
  const {source:p,receiver:expected}=input;assertMontanaIePacket(p);const candidates=montanaIePacketCandidates(p);
  if(p.year!==expected.election_year)hold("wrong_source_cycle");qualifyMontanaCommitteeReceiver(expected,candidates);const a=position(p,expected),native=candidates.filter(c=>String(c.candidateId)===expected.committee_id);
  if(native.length!==1)hold("ambiguous_source_identity");const facts={nativeCandidate:native[0],sweepSha256:p.sweepSha256,registrationSha256:p.registrationSha256};
  const c=await input.db.connect();try{
    await c.query("BEGIN");const r=await loadMontanaCommitteeReceiver(c,expected.link_id,true);if(!r||!same(r,expected))hold("canonical_receiving_context_changed");qualifyMontanaCommitteeReceiver(r,candidates);
    const params=[r.link_id,r.election_year],where="link_id=$1::uuid AND election_year=$2::int",old=(await c.query<Row>(`SELECT * FROM mt_reported_ie_sources WHERE ${where} FOR UPDATE`,params)).rows[0];
    if(old){const previous=iso(old.source_completed_at);if(p.sourceCompletedAt<previous)hold("older_source");if(p.sourceCompletedAt===previous){
      const groups=(await c.query<Row>(`SELECT * FROM mt_reported_ie_groups WHERE ${where} FOR UPDATE`,params)).rows,saved=readStoredMontanaIePosition(old,groups,r);
      if(old.source_manifest_sha256!==p.sourceManifestSha256||saved.retrievedAt!==p.sourceRetrievedAt||!same(saved.position,a)||!same(saved.facts,facts)||mtStoredInteger(old.source_byte_size)!==p.sourceByteSize||mtStoredInteger(old.source_original_count)!==p.sourceOriginalCount)hold("equal_source_conflict");
      await c.query("COMMIT");return {totalCents:a.totalCents,groups:a.groups.length,idempotent:true};
    }}
    const at=new Date().toISOString();if(p.sourceCompletedAt>at)hold("future_source");
    await c.query(`INSERT INTO public.mt_reported_ie_sources
      (link_id,election_year,candidate_id,election_id,receiving_candidate_id,support_cents,oppose_cents,total_cents,group_count,attributed_row_count,
      source_retrieved_at,source_completed_at,source_manifest_sha256,source_byte_size,source_original_count,source_facts,last_synced_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17)
      ON CONFLICT(link_id,election_year) DO UPDATE SET candidate_id=EXCLUDED.candidate_id,election_id=EXCLUDED.election_id,receiving_candidate_id=EXCLUDED.receiving_candidate_id,
      support_cents=EXCLUDED.support_cents,oppose_cents=EXCLUDED.oppose_cents,total_cents=EXCLUDED.total_cents,group_count=EXCLUDED.group_count,attributed_row_count=EXCLUDED.attributed_row_count,
      source_retrieved_at=EXCLUDED.source_retrieved_at,source_completed_at=EXCLUDED.source_completed_at,source_manifest_sha256=EXCLUDED.source_manifest_sha256,
      source_byte_size=EXCLUDED.source_byte_size,source_original_count=EXCLUDED.source_original_count,source_facts=EXCLUDED.source_facts,last_synced_at=EXCLUDED.last_synced_at`,
    [...params,r.candidate_id,r.election_id,r.committee_id,a.supportCents,a.opposeCents,a.totalCents,a.groups.length,a.rowCount,p.sourceRetrievedAt,p.sourceCompletedAt,p.sourceManifestSha256,p.sourceByteSize,p.sourceOriginalCount,JSON.stringify(facts),at]);
    await c.query(`DELETE FROM public.mt_reported_ie_groups WHERE ${where}`,params);
    if(a.groups.length)await c.query(`INSERT INTO public.mt_reported_ie_groups(link_id,election_year,committee_id,committee_name,support_oppose,amount_cents)
      SELECT $1::uuid,$2::int,g."committeeId",g.name,g.stance,g.cents FROM jsonb_to_recordset($3::jsonb) AS g("committeeId" text,name text,stance text,cents bigint)`,[...params,JSON.stringify(a.groups)]);
    await c.query("COMMIT");return {totalCents:a.totalCents,groups:a.groups.length,idempotent:false};
  }catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}
}
