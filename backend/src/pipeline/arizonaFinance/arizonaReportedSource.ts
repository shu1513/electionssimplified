import { buildArizonaSpotlightAdvancedSearchUrl, buildArizonaSpotlightDataTablesBody, type ArizonaSpotlightAdvancedSearchInput } from "./arizonaSpotlightClient.js";
import { AZ_NATIVE_IE_CLASSES, AZ_NATIVE_INCOME_CLASSES, aggregateArizonaReportedCommittee, aggregateArizonaReportedIe, type ArizonaReportedAggregation } from "./arizonaReportedAggregation.js";
import { AZ_REPORTED_REVISION, ArizonaReportedHold, azCanonical, azFinancialKey, azFreeze, azHash, azHold, azId, azInteger, azSameBag, parseArizonaReportedTable, type ArizonaReportedKind, type ArizonaReportedNativeRow } from "./arizonaReportedCore.js";
import { azReportedCache, AZ_NATIVE_ORIGIN, createArizonaOriginalCapture, savedArizonaOriginals, type ArizonaOriginal } from "./arizonaReportedOriginals.js";
import { azNormalizeLabel, validateArizonaReportedReceiver, type ArizonaReportedReceiver } from "./arizonaReportedReceiver.js";

export type ArizonaReportedSourceFacts = {
  revision:string;kind:ArizonaReportedKind;electionYear:number;sourceAt:string;oldestBodyAt:string;newestBodyAt:string;
  sourceHash:string;sourceRows:number;reportCount:number;parentRows:number;windowStart:string;windowEnd:string;
};
export type ArizonaReportedPacket = Readonly<{
  receiver:ArizonaReportedReceiver;kind:ArizonaReportedKind;facts:ArizonaReportedSourceFacts;
  rows:readonly ArizonaReportedNativeRow[];support:readonly ArizonaReportedNativeRow[];oppose:readonly ArizonaReportedNativeRow[];
}>;
const sealed=new WeakSet<object>();
export const isArizonaReportedPacket=(p:unknown):p is ArizonaReportedPacket=>typeof p==="object" && p!==null && sealed.has(p);
export function aggregateArizonaReported(r:ArizonaReportedReceiver,p:ArizonaReportedPacket):ArizonaReportedAggregation {
  if(!isArizonaReportedPacket(p) || azCanonical(r)!==azCanonical(p.receiver)) azHold("unverified_source");
  return p.kind==="committee"?aggregateArizonaReportedCommittee(p.rows):aggregateArizonaReportedIe(p.support,p.oppose);
}
const tableBody=()=>{const b=buildArizonaSpotlightDataTablesBody({categoryType:"Income",length:1000,draw:1});b.set("length","20000");return b;};
export function parseArizonaReportCatalog(o:ArizonaOriginal,id:string):any[] {
  const v=o.value;
  if(!v || azCanonical(Object.keys(v).sort())!==azCanonical(["data","draw","recordsFiltered","recordsTotal"]) ||
    !Array.isArray(v.data) || azInteger(v.draw,false)!==1 || azInteger(v.recordsTotal)>20000 ||
    azInteger(v.recordsTotal)!==azInteger(v.recordsFiltered) || v.data.length!==azInteger(v.recordsTotal)) azHold("incomplete_report_catalog");
  const ids=new Set<string>();
  for(const r of v.data){
    if(!r || azId(r.FilerId)!==id || azInteger(r.CycleYear,false)!==2026 || typeof r.FilerName!=="string" || !r.FilerName.trim() ||
      typeof r.ReportInstanceName!=="string" || typeof r.ReportingPeriod!=="string" ||
      typeof r.OriginalFilingDate!=="string" || typeof r.LastAmendedDate!=="string" ||
      typeof r.Status!=="string" || typeof r.ReportFileUrl!=="string") azHold("native_report_parent");
    const report=azId(r.CommitteeReportId);if(ids.has(report))azHold("duplicate_report_parent");ids.add(report);
  }
  return v.data;
}
export function reconcileArizonaReportedParents(rows:readonly ArizonaReportedNativeRow[],children:readonly ArizonaReportedNativeRow[],kind:ArizonaReportedKind):void {
  const codes=kind==="committee"?AZ_NATIVE_INCOME_CLASSES:AZ_NATIVE_IE_CLASSES;
  const filtered=children.filter(r=>Object.hasOwn(codes,r.typeId));
  // Income uses signed returns; native parent views expose expense magnitudes.
  // Compare full financial occurrences by magnitude, then retain the original
  // signed income view as authority for classification and net receipts.
  const signedOutflowCodes=new Set(["42","43","56","57","59","60","128"]);
  const key=(r:ArizonaReportedNativeRow)=>azFinancialKey(r,kind==="committee"&&signedOutflowCodes.has(r.typeId));
  if(!azSameBag(rows.map(key),filtered.map(key))) azHold("parent_occurrence_closure");
}

/** One ordinary batch shares only native global/payer controls in RAM. Target
 * responses omit receiving IDs, so every target direction is acquired live.
 * A cached target body can never establish which candidate it describes. */
export async function createArizonaReportedSource(options:{cacheDir?:string;refresh?:boolean;allowLive:boolean}) {
  const cache=azReportedCache(options.cacheDir),saved=await savedArizonaOriginals(cache);
  const cap=await createArizonaOriginalCapture(cache);
  const payerControls=new Map<string,Promise<{originals:ArizonaOriginal[];reports:number;children:number}>>();
  let globalPromise:Promise<{originals:ArizonaOriginal[];rows:ArizonaReportedNativeRow[]}>|undefined;
  async function request(role:string,input:ArizonaSpotlightAdvancedSearchInput):Promise<ArizonaOriginal>{
    if(!options.allowLive)azHold("live_scope_unavailable");
    return cap.capture(role,buildArizonaSpotlightAdvancedSearchUrl({...input,electionYear:2026}),tableBody());
  }
  async function profile(r:ArizonaReportedReceiver,role:string):Promise<ArizonaOriginal>{
    if(!options.allowLive)azHold("live_scope_unavailable");
    const url=new URL("/Reporting/GetDetailedInformation",AZ_NATIVE_ORIGIN);
    for(const [k,v]of Object.entries({Page:11,startYear:2025,endYear:2026,JurisdictionId:0,Name:"1~"+r.entityId}))url.searchParams.set(k,String(v));
    const p=await cap.capture(role,url.href,new URLSearchParams());validateArizonaReportedReceiver(r,p.value);return p;
  }
  async function catalog(id:string,role:string):Promise<ArizonaOriginal>{
    if(!options.allowLive)azHold("live_scope_unavailable");
    const url=new URL(buildArizonaSpotlightAdvancedSearchUrl({categoryType:"Reports",electionYear:2026,filerId:id}));url.pathname="/Reporting/ReportSearch/";
    const o=await cap.capture(role,url.href,tableBody());parseArizonaReportCatalog(o,id);return o;
  }
  async function parents(id:string,name:string):Promise<{originals:ArizonaOriginal[];reports:number;children:ArizonaReportedNativeRow[]}>{
    const open=await catalog(id,"report_catalog_opening"),reports=parseArizonaReportCatalog(open,id),originals=[open],children:ArizonaReportedNativeRow[]=[];
    if(!reports.length)azHold("missing_current_reports");
    for(const [i,r]of reports.entries()){
      if(azNormalizeLabel(r.FilerName)!==azNormalizeLabel(name))azHold("report_filer_context");
      const c=await request("report_children_"+i,{categoryType:"Reports",filerId:id,commiteeReportId:azId(r.CommitteeReportId)});
      const rows=parseArizonaReportedTable(c.value,c.meta.completedAt);
      if(rows.some(x=>x.committeeId!=="0" || azNormalizeLabel(x.committeeName)!==azNormalizeLabel(name)))azHold("report_child_context");
      originals.push(c);children.push(...rows);
    }
    const close=await catalog(id,"report_catalog_closing");originals.push(close);
    if(!azSameBag(reports,parseArizonaReportCatalog(close,id)))azHold("report_catalog_changed");
    return {originals,reports:reports.length,children};
  }
  function savedIncome(id:string,name:string):{o:ArizonaOriginal;rows:ArizonaReportedNativeRow[]}|undefined{
    if(options.refresh)return;
    for(const o of saved){try{
      // Reject unrelated bodies before constructing financial/date objects.
      // Full native schema, count, cent and clock checks still follow.
      if(!Array.isArray(o.value?.data) || !o.value.data.length || !o.value.data.every((r:any)=>
        String(r.CommitteeID)===id && typeof r.CommitteeName==="string" && azNormalizeLabel(r.CommitteeName)===azNormalizeLabel(name) &&
        AZ_NATIVE_INCOME_CLASSES[String(r.TransactionTypeId)]===r.TransactionType)) continue;
      const rows=parseArizonaReportedTable(o.value,o.meta.completedAt);
      if(rows.length && rows.every(r=>r.committeeId===id && azNormalizeLabel(r.committeeName)===azNormalizeLabel(name) && AZ_NATIVE_INCOME_CLASSES[r.typeId]===r.typeName))return{o,rows};
    }catch{/* Not a complete receiving ledger for this scope. */}}
  }
  async function globalIe(){
    if(!globalPromise)globalPromise=(async()=>{
      let opening:ArizonaOriginal|undefined,rows:ArizonaReportedNativeRow[]=[];
      if(!options.refresh)for(const o of saved){try{
        if(!Array.isArray(o.value?.data) || !o.value.data.length || o.value.data.length<=rows.length ||
          !o.value.data.every((r:any)=>AZ_NATIVE_IE_CLASSES[String(r.TransactionTypeId)]===r.TransactionType)) continue;
        const r=parseArizonaReportedTable(o.value,o.meta.completedAt);
        if(r.length && r.every(x=>AZ_NATIVE_IE_CLASSES[x.typeId]===x.typeName) && (!opening || r.length>rows.length)){opening=o;rows=r;}
      }catch{/* A saved role alone never grants global scope. */}}
      const closing=await request("global_ie_closing",{categoryType:"IndependentExpenditures",position:"Both"}),current=parseArizonaReportedTable(closing.value,closing.meta.completedAt);
      if(!opening || !azSameBag(rows.map(r=>r.raw),current.map(r=>r.raw))){
        opening=closing;rows=current;
        const end=await request("global_ie_confirmation",{categoryType:"IndependentExpenditures",position:"Both"});
        if(!azSameBag(rows.map(r=>r.raw),parseArizonaReportedTable(end.value,end.meta.completedAt).map(r=>r.raw)))azHold("global_ie_changed");
        return{originals:[opening,end],rows};
      }
      return{originals:[opening,closing],rows};
    })();
    return globalPromise;
  }
  async function payer(id:string,name:string){
    const key=id+":"+name;
    if(!payerControls.has(key))payerControls.set(key,(async()=>{
      const g=await globalIe(),rows=g.rows.filter(r=>r.committeeId===id);
      if(!rows.length || rows.some(r=>r.committeeName!==name))azHold("global_ie_payer_context");
      const p=await parents(id,name);reconcileArizonaReportedParents(rows,p.children,"ie");
      return{originals:[...g.originals,...p.originals],reports:p.reports,children:p.children.length};
    })());
    return payerControls.get(key)!;
  }
  async function load(receiver:ArizonaReportedReceiver,kind:ArizonaReportedKind):Promise<ArizonaReportedPacket>{
    const first=await profile(receiver,"receiving_context_opening"),p=validateArizonaReportedReceiver(receiver,first.value),originals=[first];
    let rows:ArizonaReportedNativeRow[]=[],support:ArizonaReportedNativeRow[]=[],oppose:ArizonaReportedNativeRow[]=[],reportCount=0,parentRows=0;
    if(kind==="committee"){
      const bound=savedIncome(receiver.entityId,p.CommitteeName);
      let income=bound?.o??await request("receiving_income_complete",{categoryType:"Income",filerId:receiver.entityId});
      rows=bound?.rows??parseArizonaReportedTable(income.value,income.meta.completedAt);
      const parentsPacket=await parents(receiver.entityId,p.CommitteeName);
      try{reconcileArizonaReportedParents(rows,parentsPacket.children,"committee");}
      catch(e){
        if(!bound || !(e instanceof ArizonaReportedHold))throw e;
        income=await request("receiving_income_complete",{categoryType:"Income",filerId:receiver.entityId});rows=parseArizonaReportedTable(income.value,income.meta.completedAt);
        reconcileArizonaReportedParents(rows,parentsPacket.children,"committee");
      }
      if(rows.some(r=>r.committeeId!==receiver.entityId || azNormalizeLabel(r.committeeName)!==azNormalizeLabel(p.CommitteeName)))azHold("income_receiving_context");
      originals.push(income,...parentsPacket.originals);reportCount=parentsPacket.reports;parentRows=parentsPacket.children.length;
      aggregateArizonaReportedCommittee(rows);
    }else{
      const opening=await request("target_ie_opening",{categoryType:"IndependentExpenditures",candidateFilerId:receiver.entityId,position:"Both"});
      const all=parseArizonaReportedTable(opening.value,opening.meta.completedAt);originals.push(opening);
      const s=await request("target_ie_support",{categoryType:"IndependentExpenditures",candidateFilerId:receiver.entityId,position:"Support"}),
        o=await request("target_ie_oppose",{categoryType:"IndependentExpenditures",candidateFilerId:receiver.entityId,position:"Oppose"});
      support=parseArizonaReportedTable(s.value,s.meta.completedAt);oppose=parseArizonaReportedTable(o.value,o.meta.completedAt);originals.push(s,o);
      if(!azSameBag(all.map(r=>r.raw),[...support,...oppose].map(r=>r.raw)))azHold("target_ie_direction_union");
      aggregateArizonaReportedIe(support,oppose);
      const groups=new Map<string,string>();for(const row of all){const old=groups.get(row.committeeId);if(old && old!==row.committeeName)azHold("payer_name_changed");groups.set(row.committeeId,row.committeeName);}
      for(const [id,name]of groups){
        const g=await globalIe(),globalRows=g.rows.filter(r=>r.committeeId===id);
        // The target is an occurrence sub-bag of its full payer population.
        const source=all.filter(r=>r.committeeId===id),remaining=[...globalRows];
        for(const row of source){const key=azCanonical(row.raw),i=remaining.findIndex(r=>azCanonical(r.raw)===key);if(i<0)azHold("target_global_occurrence");remaining.splice(i,1);}
        const proof=await payer(id,name);originals.push(...proof.originals);reportCount+=proof.reports;parentRows+=proof.children;
      }
      const closing=await request("target_ie_closing",{categoryType:"IndependentExpenditures",candidateFilerId:receiver.entityId,position:"Both"});originals.push(closing);
      if(!azSameBag(all.map(r=>r.raw),parseArizonaReportedTable(closing.value,closing.meta.completedAt).map(r=>r.raw)))azHold("target_ie_changed");
    }
    const last=await profile(receiver,"receiving_context_closing");originals.push(last);
    if(azCanonical(first.value.ReportFilerInfo)!==azCanonical(last.value.ReportFilerInfo))azHold("receiving_profile_changed");
    const unique=[...new Map(originals.map(o=>[o.meta.sha256+":"+o.meta.completedAt,o])).values()],clocks=unique.map(o=>o.meta.completedAt).sort();
    const facts:ArizonaReportedSourceFacts={revision:AZ_REPORTED_REVISION,kind,electionYear:2026,sourceAt:last.meta.completedAt,
      oldestBodyAt:unique.map(o=>o.meta.startedAt).sort()[0]!,newestBodyAt:clocks.at(-1)!,
      sourceHash:azHash(azCanonical(unique.map(o=>o.meta).sort((a,b)=>a.completedAt.localeCompare(b.completedAt)))),
      sourceRows:kind==="committee"?rows.length:support.length+oppose.length,reportCount,parentRows,windowStart:"2025-01-01",windowEnd:"2026-12-31"};
    const packet={receiver:{...receiver},kind,facts,rows,support,oppose};azFreeze(packet);sealed.add(packet);return packet;
  }
  return{load};
}
