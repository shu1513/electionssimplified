import { normalizeOklahomaCandidateNameKeys as nameKeys,oklahomaCandidateNameMiddleConflict as middleConflict,canonicalOklahomaCandidateOfficeName as officeName,normalizeOklahomaCandidateDistrict as district } from "./oklahomaCandidateCommitteeResolver.js";
import { aggregateOklahomaReportedCommittees,OklahomaReportedCommitteeHold,OKLAHOMA_REPORTED_COMMITTEE_CLASSES } from "./oklahomaReportedCommitteeAggregator.js";
import { isOklahomaReceiverPacket,type OklahomaReceiverPacket } from "./oklahomaReportedSource.js";
import { parseOklahomaIePrintedTargets } from "./oklahomaIeReportPdf.js";
import { okAdd,okHold,okLiteral,type OklahomaReportedKind } from "./oklahomaReportedCore.js";
import type { OklahomaReportedReceiver } from "./oklahomaReportedReceiver.js";

export type OklahomaReportedGroup={key:string;name:string;sourceClass:string;stance:"direct"|"support"|"oppose";cents:number;occurrences:number};
export type OklahomaReportedAggregation={totalCents:number;supportCents:number;opposeCents:number;sourceRows:number;includedRows:number;groups:OklahomaReportedGroup[]};
export function oklahomaReportedPersonMatches(source:string,canonical:string):boolean {
  return [...nameKeys(source)].some(k=>nameKeys(canonical,{expandNicknames:true}).has(k))&&!middleConflict(canonical,source);
}
function exactNativePerson(a:string,b:string):boolean {
  const full=(s:string)=>{const keys=[...nameKeys(s)].map(k=>k.replace(/\s/g,"")),max=Math.max(...keys.map(k=>k.length));return keys.filter(k=>k.length===max);};
  const suffix=(s:string)=>(s.toUpperCase().match(/\b(?:JR|SR|II|III|IV)\b/g)??[]).sort().join(" ");
  const aa=full(a),bb=full(b);return suffix(a)===suffix(b)&&!middleConflict(b,a)&&aa.some(k=>bb.includes(k));
}
/** Relevance is only a veto: any printed surname may refer to this receiver.
 * It never establishes a positive allocation or relaxes native identity. */
function mayReferToPerson(raw:string,...people:string[]):boolean {
  const tokens=(s:string)=>s.normalize("NFKD").replace(/\p{M}/gu,"").toUpperCase().match(/[\p{L}\p{N}]+/gu)??[];
  const printed=tokens(raw),compact=printed.join("");
  return people.some(person=>{const parts=tokens(person).filter(p=>!["JR","SR","II","III","IV"].includes(p));return parts.length===0||compact.includes(parts.at(-1)!);});
}
function date(raw:string):string|null {
  const m=/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:\s*[AP]M)?)?$/.exec(raw.trim());if(!m)return null;
  const d=new Date(Date.UTC(Number(m[3]),Number(m[1])-1,Number(m[2])));if(d.getUTCFullYear()!==Number(m[3])||d.getUTCMonth()+1!==Number(m[1])||d.getUTCDate()!==Number(m[2]))return null;return d.toISOString().slice(0,10);
}
export function oklahomaIeOffice(raw:string):{office:string|null;district:string|null}{
  const m=/\b(?:DISTRICT|DIST\.?|#)\s*[-:]?\s*(\d+)\s*$/i.exec(raw),base=m?raw.slice(0,m.index).trim().replace(/[-,:]\s*$/,""):raw;
  return {office:officeName(base),district:m?district(m[1]):null};
}
export function aggregateOklahomaReported(receiver:OklahomaReportedReceiver,source:OklahomaReceiverPacket):OklahomaReportedAggregation {
  if(!isOklahomaReceiverPacket(source)||receiver.electionYear!==2026||receiver.electionDate!=="2026-11-03")okHold("unverified_source_or_election");
  const {packet,profile}=source,legislative=["state_upper","state_lower"].includes(receiver.officeScope);
  if(profile.organizationId!==receiver.entityId||profile.electionYears.length!==1||profile.electionYears[0]!==2026||!oklahomaReportedPersonMatches(profile.candidateName,receiver.candidateName)||!oklahomaReportedPersonMatches(profile.candidateName,receiver.fullName)||officeName(profile.officeName)!==receiver.canonicalOffice||officeName(receiver.linkOffice)!==receiver.canonicalOffice||(legislative&&(!/^[1-9]\d*$/.test(receiver.canonicalDistrict??"")||district(profile.district)!==receiver.canonicalDistrict||district(receiver.linkDistrict)!==receiver.canonicalDistrict)))okHold("source_receiving_identity");
  if(packet.kind==="committee"){
    const selected=packet.receipts.filter(r=>r["Org ID"].trim()===receiver.entityId);if(!selected.length)okHold("receiving_ledger_missing");
    for(const r of selected){
      // Candidate receivers populate Candidate Name; Committee Name can be
      // blank. The native ID/person/profile establish the receiving identity.
      if(!oklahomaReportedPersonMatches(r["Candidate Name"],profile.candidateName))okHold("receipt_receiving_identity");
      const receiptDate=date(r["Receipt Date"]),filedDate=date(r["Filed Date"]);if(!receiptDate||!filedDate||receiptDate>packet.windowEnd||receiptDate>source.sourceAt.slice(0,10)||filedDate>source.sourceAt.slice(0,10))okHold("receipt_date_or_future_filing");
    }
    try{const a=aggregateOklahomaReportedCommittees({organizationId:receiver.entityId,electionYear:2026,rows:selected});return {totalCents:a.cents,supportCents:0,opposeCents:0,sourceRows:packet.sourceRows,includedRows:a.occurrences,groups:a.groups.map(g=>({...g,stance:"direct"}))};}
    catch(e){if(e instanceof OklahomaReportedCommitteeHold)okHold(e.code);throw e;}
  }
  const groups=new Map<string,OklahomaReportedGroup>();let support=0,oppose=0,included=0;
  for(const document of packet.reports)for(const row of document.report.rows){
    // Match every printed target before applying accounting exclusions. A
    // candidate touched by a joint/corrected/unreconciled family is held whole.
    const rawTargets=[...row.candidateAndStance.matchAll(/(.+?)\(\s*(Support|Oppose)\s*\)/gi)].map(m=>m[1]!.trim());
    if(!rawTargets.length)okHold("unparseable_ie_target");
    if(!mayReferToPerson(row.candidateAndStance,profile.candidateName,receiver.candidateName,receiver.fullName))continue;
    if(rawTargets.some(n=>exactNativePerson(n,profile.candidateName)))okHold("missing_ie_office");
    const targets=parseOklahomaIePrintedTargets(row.candidateAndStance);if(!targets)okHold("unparseable_ie_target");
    const relevant=targets.filter(t=>officeName(t.office)===receiver.canonicalOffice&&mayReferToPerson(t.name,profile.candidateName,receiver.candidateName,receiver.fullName));
    if(!relevant.length)continue;
    const target=relevant[0]!;
    if(targets.length!==1||/[,;&/]|\b(?:AND|OR)\b/i.test(target.name)||document.held)okHold("joint_or_unreconciled_ie_report");
    if(target.district&&target.district!==receiver.canonicalDistrict)okHold("contradictory_ie_district");
    if(!exactNativePerson(target.name,profile.candidateName))okHold("inexact_native_ie_name");
    if(row.type!=="INDEPENDENTEXPENDITURE"){if(!["ELECTIONEERINGCOMMUNICATION","STATEQUESTIONCOMMUNICATION"].includes(row.type))okHold("unknown_communication_type");continue;}
    const dates=row.dates.filter(Boolean).map(date);if(!dates.length||dates.some(d=>!d))okHold("ie_date");
    if(dates.some(d=>d!<packet.windowStart||d!>packet.windowEnd))okHold("ie_window");
    if(row.cents<=0)okHold("ie_correction");
    const name=okLiteral(document.filer),key=JSON.stringify([name.toUpperCase(),target.stance]),g=groups.get(key)??{key,name,sourceClass:"reported independent spender",stance:target.stance,cents:0,occurrences:0};
    g.cents=okAdd(g.cents,row.cents);g.occurrences++;groups.set(key,g);included++;
    if(target.stance==="support")support=okAdd(support,row.cents);else oppose=okAdd(oppose,row.cents);
  }
  return {totalCents:okAdd(support,oppose),supportCents:support,opposeCents:oppose,sourceRows:packet.sourceRows,includedRows:included,groups:[...groups.values()].sort((a,b)=>a.key.localeCompare(b.key))};
}
export function validateOklahomaReportedClosure(a:OklahomaReportedAggregation,kind:OklahomaReportedKind):void {
  const nn=(v:unknown):v is number=>typeof v==="number"&&Number.isSafeInteger(v)&&v>=0;
  if(!a||![a.totalCents,a.supportCents,a.opposeCents,a.sourceRows,a.includedRows].every(nn)||a.includedRows>a.sourceRows||!Array.isArray(a.groups))okHold("stored_controls");
  const seen=new Set<string>();let total=0,support=0,oppose=0,occurrences=0;
  for(const g of a.groups){
    if(!g||![g.key,g.name,g.sourceClass].every(v=>typeof v==="string"&&v===okLiteral(v)&&!!v&&!/[\u0000-\u001f\u007f]/.test(v))||seen.has(g.key)||!nn(g.cents)||g.cents===0||!nn(g.occurrences)||g.occurrences===0)okHold("stored_group");
    let key:unknown;try{key=JSON.parse(g.key);}catch{okHold("stored_group_key");}
    if(!Array.isArray(key)||(kind==="committee"?key.length!==5||!(OKLAHOMA_REPORTED_COMMITTEE_CLASSES as readonly string[]).includes(g.sourceClass)||key[0]!==g.sourceClass||g.stance!=="direct"||!key.slice(1).every(v=>typeof v==="string"&&v===okLiteral(v).toUpperCase())||!(key[1])||g.name.toUpperCase()!==(key.slice(2).some(Boolean)?`${key[1]}, ${key.slice(2).filter(Boolean).join(" ")}`:key[1]):key.length!==2||g.sourceClass!=="reported independent spender"||key[0]!==g.name.toUpperCase()||key[1]!==g.stance||!["support","oppose"].includes(g.stance)))okHold("stored_group_identity");
    seen.add(g.key);total=okAdd(total,g.cents);occurrences=okAdd(occurrences,g.occurrences);if(g.stance==="support")support=okAdd(support,g.cents);if(g.stance==="oppose")oppose=okAdd(oppose,g.cents);
  }
  if(total!==a.totalCents||occurrences!==a.includedRows||support!==a.supportCents||oppose!==a.opposeCents||(kind==="ie"&&okAdd(support,oppose)!==total))okHold("stored_group_closure");
}
