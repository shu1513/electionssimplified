import { isDeepStrictEqual } from "node:util";
import {
  inAdd,inCheck,inDay,inForm,inHtml,inKey,inPublicUrl,parseIndianaNativeCommittee,
  parseIndianaNativeFilingPage,parseIndianaNativeMonetaryReport,
  parseIndianaNativeContributionSchedule,closeIndianaNativeContributionSchedule,
  requireIndianaNativeNoReturns,selectIndianaNativeFilingVersion,qualifyIndianaNativePeriods,
  type IndianaNativeFiling,type IndianaNativeMonetaryReport,type IndianaNativeContributionSchedule,
} from "./indianaNativeProtocol.js";
import {inFreshOriginal,inSuccessfulOriginal,type IndianaNativeOriginal} from "./indianaNativeOriginals.js";
import {readIndianaNativeReceiptEvidence} from "./indianaNativeReceiptEvidence.js";
import {qualifyIndianaNativeReceiver,type IndianaNativeReceiver} from "./indianaNativeReceiver.js";

const sameUrl=(a:string,b:string)=>{const x=new URL(a),y=new URL(b);x.searchParams.sort();y.searchParams.sort();return x.href===y.href;};
const usable=(o:IndianaNativeOriginal)=>inSuccessfulOriginal(o,"html")&&inFreshOriginal(o);
const path=(o:IndianaNativeOriginal)=>new URL(o.meta.url).pathname;
const redirectsTo=(o:IndianaNativeOriginal,target:string)=>{if(!o.meta.location)return false;try{return sameUrl(inPublicUrl(o.meta.location,o.meta.url),target);}catch{return false;}};
const state=(d:Document)=>{const f=inForm(d);return [f.get("__VIEWSTATE"),f.get("__EVENTVALIDATION")];};
const request=(o:IndianaNativeOriginal)=>{inCheck(o.request!==null&&o.meta.method==="POST","financial_original_request");return new URLSearchParams(o.request);};
function follows(o:IndianaNativeOriginal,expected:[string,string],s:(string|null)[]):boolean {
  if(o.meta.method!=="POST"||!o.request)return false;const f=request(o);
  return f.get("__EVENTTARGET")===expected[0]&&f.get("__EVENTARGUMENT")===expected[1]&&f.get("__VIEWSTATE")===s[0]&&f.get("__EVENTVALIDATION")===s[1];
}
function parsed<T>(o:IndianaNativeOriginal,fn:(d:Document)=>T):T {
  inCheck(usable(o),"financial_original_unavailable");const d=inHtml(o.raw,o.meta.url);try{return fn(d);}finally{d.defaultView?.close();}
}
type InventoryPage={original:IndianaNativeOriginal; rows:IndianaNativeFiling[]; state:(string|null)[]};
type Inventory={pages:InventoryPage[];rows:IndianaNativeFiling[];originals:IndianaNativeOriginal[];start:string;end:string};
function inventories(originals:readonly IndianaNativeOriginal[],receiver:IndianaNativeReceiver):Inventory[] {
  const dirs=new Map<string,IndianaNativeOriginal[]>(),out:Inventory[]=[];
  for(const o of originals){const a=dirs.get(o.directory)??[];a.push(o);dirs.set(o.directory,a);}
  for(const records of dirs.values()){
    records.sort((a,b)=>a.meta.startedAt.localeCompare(b.meta.startedAt)||a.meta.file.localeCompare(b.meta.file));
    for(let index=0;index<records.length;index++){
      const first=records[index]!;if(first.meta.method!=="GET"||path(first)!=="/PublicSite/SearchPages/CommitteeDetail.aspx"||!usable(first))continue;
      let d:Document|null=null;
      try{
        d=inHtml(first.raw,first.meta.url);const c=parseIndianaNativeCommittee(d);
        if(c.file!==receiver.receivingId)continue;qualifyIndianaNativeReceiver(receiver,c);
        let p=parseIndianaNativeFilingPage(d);
        if (!p.pager) {
          // The committee-search redirect identifies the filer; it is not a
          // second inventory walk before the collector's opening observation.
          // Walk back through any intermediate redirect hops the collector
          // followed so the identity observation is excluded even when the
          // search redirect did not land on this page directly.
          let k=index-1,target=first.meta.url;
          while(k>=0){const hop=records[k]!;if(hop.meta.method!=="GET"||![301,302,303,307,308].includes(hop.meta.status)||!redirectsTo(hop,target))break;target=hop.meta.url;k--;}
          const start=records[k];
          if(start?.meta.method==="POST"&&path(start)==="/PublicSite/SearchPages/CommitteeSearch.aspx"&&start.meta.status===302&&redirectsTo(start,target))continue;
          out.push({pages:[{original:first,rows:p.rows,state:state(d)}],rows:p.rows,originals:[first],start:first.meta.startedAt,end:first.meta.completedAt});
          continue;
        }
        inCheck(p.pager.page===1,"inventory_initial_page");
        const pages:InventoryPage[]=[],used=[first];let resize=true,complete=false;
        for(let j=index+1;j<records.length;j++){
          const o=records[j]!;if(o.meta.method==="GET"&&sameUrl(o.meta.url,first.meta.url))break;
          if(o.meta.method!=="POST"||!sameUrl(o.meta.url,first.meta.url)||!usable(o))continue;
          const pager=p.pager;inCheck(pager,"inventory_paging_missing");
          const callback=resize?pager.resize:pager.next;
          inCheck(callback&&follows(o,callback,state(d)),"inventory_postback_conflict");
          inCheck(request(o).get(pager.sizeName)===pager.size50Value,"inventory_page_size");
          d.defaultView?.close();d=inHtml(o.raw,o.meta.url);
          qualifyIndianaNativeReceiver(receiver,parseIndianaNativeCommittee(d));p=parseIndianaNativeFilingPage(d);
          inCheck(p.pager!==null&&p.pager.page===pages.length+1,"inventory_page_sequence");
          pages.push({original:o,rows:p.rows,state:state(d)});used.push(o);resize=false;
          inCheck(pages.length<=100,"inventory_resource_limit");
          if(!p.pager.next){complete=true;break;}
        }
        inCheck(complete,"inventory_incomplete");out.push({pages,rows:pages.flatMap(p=>p.rows),originals:used,start:first.meta.startedAt,end:used.at(-1)!.meta.completedAt});
      }catch{/* An incomplete cached walk never establishes an empty inventory. */}
      finally{d?.defaultView?.close();}
    }
  }
  return out.sort((a,b)=>a.end.localeCompare(b.end));
}
export function closeIndianaNativeInventory(originals:readonly IndianaNativeOriginal[],receiver:IndianaNativeReceiver){
  const selected=inventories(originals,receiver).slice(-2);
  inCheck(selected.length===2&&selected[0]!.end<=selected[1]!.start,"independent_filing_inventory_missing");
  inCheck(isDeepStrictEqual(selected[0]!.rows,selected[1]!.rows),"filing_inventory_changed");return selected;
}
function family(originals:readonly IndianaNativeOriginal[],inventory:Inventory,filing:IndianaNativeFiling,used:IndianaNativeOriginal[]){
  const pages=inventory.pages.filter(p=>p.rows.some(r=>isDeepStrictEqual(r,filing)));
  inCheck(pages.length===1,"filing_inventory_row_ambiguous");const p=pages[0]!;
  const openings=originals.filter(o=>o.meta.status===302&&o.meta.eof&&inFreshOriginal(o)&&sameUrl(o.meta.url,p.original.meta.url)&&follows(o,filing.callback,p.state)&&o.meta.location);
  inCheck(openings.length>0,"filing_family_action_missing");const opened=openings.at(-1)!,url=inPublicUrl(opened.meta.location!,opened.meta.url);
  inCheck(new URL(url).pathname==="/PublicSite/SearchPages/FilingAmendmentSelect.aspx","filing_family_redirect");
  const source=originals.filter(o=>o.meta.method==="GET"&&sameUrl(o.meta.url,url)&&usable(o)).at(-1);
  inCheck(source,"filing_family_original_missing");
  const version=parsed(source,d=>({selected:selectIndianaNativeFilingVersion(d,filing.kind,filing.amended),state:state(d)}));
  const actions=originals.filter(o=>sameUrl(o.meta.url,url)&&o.meta.eof&&inFreshOriginal(o)&&follows(o,version.selected.callback,version.state));
  inCheck(actions.length>0,"latest_filing_selection_missing");const action=actions.at(-1)!;
  used.push(opened,source,action);return {version:version.selected,action,url};
}
function schedulePair(originals:readonly IndianaNativeOriginal[],published:string,used:IndianaNativeOriginal[]):[IndianaNativeOriginal,IndianaNativeOriginal]{
  let url=published;
  if(new URL(url).protocol==="http:"){
    const redirects=originals.filter(o=>o.meta.method==="GET"&&sameUrl(o.meta.url,url)&&[301,302,303,307,308].includes(o.meta.status)&&o.meta.eof&&inFreshOriginal(o)&&o.meta.location);
    inCheck(redirects.length>0,"published_schedule_redirect_missing");const r=redirects.at(-1)!;url=inPublicUrl(r.meta.location!,r.meta.url);
    inCheck(new URL(url).protocol==="https:"&&new URL(url).pathname===new URL(published).pathname&&new URL(url).search===new URL(published).search,"schedule_redirect_conflict");used.push(r);
  }
  const selected=originals.filter(o=>o.meta.method==="GET"&&sameUrl(o.meta.url,url)&&usable(o)).slice(-2);
  inCheck(selected.length===2&&selected[0]!.meta.completedAt<=selected[1]!.meta.startedAt,"independent_schedule_closing_missing");used.push(...selected);return selected as [IndianaNativeOriginal,IndianaNativeOriginal];
}
export function requireIndianaNativeOccurrenceClosure(actual:readonly {day:string;kind:string;name:string;cents:number}[],expected:readonly {day:string;kind:string;name:string;cents:number}[]):void {
  const multiset=(rows:typeof actual)=>{const values=new Map<string,number>();for(const r of rows){const k=JSON.stringify([r.day,r.kind,inKey(r.name),r.cents]);values.set(k,(values.get(k)??0)+1);}return values;};
  inCheck(isDeepStrictEqual(multiset(actual),multiset(expected)),"native_receipt_occurrence_conflict");
}
export type IndianaNativeQualifiedReport={period:{begin:string;end:string;filed:string};report:IndianaNativeMonetaryReport;rows:IndianaNativeContributionSchedule};
/** Complete receiving evidence, still separate from protected storage. Every
 * financial observation comes from immutable originals; no role-name control
 * or source-provided payer name is treated as a candidate allocation. */
export function readIndianaNativeFinancialEvidence(originals:readonly IndianaNativeOriginal[],receiver:IndianaNativeReceiver,through:string){
  const inv=closeIndianaNativeInventory(originals,receiver),latest=inv[1]!,used=inv.flatMap(i=>i.originals),year=receiver.electionYear;
  const kinds=new Set([`${year-1} Annual Report`,`${year} PrePrimary Report`,`${year} PreElect Report`,`${year} Annual Report`]);
  const relevant=latest.rows.filter(r=>kinds.has(r.kind)||r.kind==="Large Contribution Report"&&new RegExp(`/(?:${year-1}|${year})$`).test(r.end));
  inCheck(relevant.length>0,"current_financial_families_missing");
  inCheck(!latest.rows.some(r=>new RegExp(`^(?:${year-1}|${year}) .*Report$`).test(r.kind)&&!kinds.has(r.kind)),"unknown_current_financial_family");
  const reports:IndianaNativeQualifiedReport[]=[],supplements=[];
  for(const filing of relevant){
    const f=family(originals,latest,filing,used),period={begin:inDay(filing.begin),end:inDay(filing.end),filed:f.version.filed};
    if(filing.kind==="Large Contribution Report"){inCheck(f.action.meta.status===200,"supplemental_selection_unavailable");supplements.push(period);continue;}
    inCheck(f.action.meta.status===302&&f.action.meta.location,"monetary_selection_unavailable");
    const url=inPublicUrl(f.action.meta.location,f.action.meta.url),u=new URL(url);
    inCheck(u.pathname==="/PublicSite/SearchPages/FilingDetail.aspx"&&u.searchParams.get("FilingID")===new URL(f.url).searchParams.get("FilingID")&&u.searchParams.has("SeqID"),"monetary_selection_scope");
    const parents=originals.filter(o=>o.meta.method==="GET"&&sameUrl(o.meta.url,url)&&usable(o)).slice(-2);
    inCheck(parents.length===2,"independent_monetary_parent_missing");
    const values=parents.map(o=>parsed(o,d=>parseIndianaNativeMonetaryReport(d,o.meta.url)));
    inCheck(isDeepStrictEqual(values[0],values[1]),"monetary_parent_changed");const report=values[1]!;
    inCheck(report.file===receiver.receivingId&&inKey(report.committee)===inKey(receiver.committeeName)&&report.committeeClass==='Candidate',"monetary_receiving_identity");used.push(...parents);
    const receipts=schedulePair(originals,report.contributionsUrl,used).map(o=>parsed(o,parseIndianaNativeContributionSchedule));
    closeIndianaNativeContributionSchedule(receipts[0]!,receipts[1]!,report);
    inCheck(receipts[0]!.every(r=>r.day>=period.begin&&r.day<=period.end),"receipt_outside_parent_period");
    for(const o of schedulePair(originals,report.returnsUrl,used))parsed(o,requireIndianaNativeNoReturns);
    reports.push({period,report,rows:receipts[0]!});
  }
  qualifyIndianaNativePeriods(reports.map(r=>r.period),supplements,`${year-1}-01-01`,through);
  const receipts=readIndianaNativeReceiptEvidence(originals,{file:receiver.receivingId,committee:receiver.committeeName,year,through});used.push(...receipts.originals);
  const scheduleRows=reports.flatMap(r=>r.rows),all=receipts.periods.flatMap(p=>p.all);
  requireIndianaNativeOccurrenceClosure(all,scheduleRows);
  inCheck(reports.every(r=>r.report.unitemizedReceipts===0),"unqualified_nonzero_unitemized_control");
  inCheck(all.reduce((n,r)=>inAdd(n,r.cents),0)===reports.reduce((n,r)=>inAdd(n,r.report.itemizedReceipts),0),"native_parent_query_money_conflict");
  return {receiver,reports,supplements,receipts,originals:[...new Set(used)]};
}
