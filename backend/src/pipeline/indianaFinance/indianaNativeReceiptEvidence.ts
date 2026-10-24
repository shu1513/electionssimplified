import { isDeepStrictEqual } from "node:util";
import {
  INDIANA_NATIVE_ORIGIN, inCheck, inDay, inForm, inHtml, inKey, inPublicUrl,
  parseIndianaNativeReceiptPage, parseIndianaNativeReceiptDetail,
  closeIndianaNativeReceiptPages, qualifyIndianaNativePacSubset,
  type IndianaNativeReceiptPage,
} from "./indianaNativeProtocol.js";
import { inFreshOriginal, inSuccessfulOriginal, type IndianaNativeOriginal } from "./indianaNativeOriginals.js";

type QueryScope = { file: string; begin: string; end: string; kind: "all" | "pac" };
type ReceiptRun = { scope: QueryScope; pages: IndianaNativeReceiptPage[]; originals: IndianaNativeOriginal[]; start: string; end: string };
const BASE = `${INDIANA_NATIVE_ORIGIN}/PublicSite/SearchPages/ContributionSearch.aspx`;
const sameUrl = (a: string, b: string) => {
  const x=new URL(a), y=new URL(b); x.searchParams.sort(); y.searchParams.sort(); return x.href===y.href;
};
function control<T extends Element>(d: Document,id: string): T {
  const nodes=d.querySelectorAll<T>(`#_ctl0_Content_${id}`);
  inCheck(nodes.length===1,"receipt_query_control"); return nodes[0]!;
}
function body(o: IndianaNativeOriginal): URLSearchParams {
  inCheck(o.meta.method==="POST"&&o.request!==null,"receipt_original_request");
  const p=new URLSearchParams(o.request);
  inCheck(new Set(p.keys()).size===p.size,"duplicate_receipt_request_field"); return p;
}
function originalHtml(o: IndianaNativeOriginal): Document {
  inCheck(inSuccessfulOriginal(o,"html")&&inFreshOriginal(o),"receipt_original_unavailable");
  return inHtml(o.raw,o.meta.url);
}
function stateMatches(post: URLSearchParams, d: Document): void {
  const actual=inForm(d);
  for(const key of ["__VIEWSTATE","__EVENTVALIDATION"]) inCheck(actual.has(key)&&post.get(key)===actual.get(key),"receipt_postback_state_conflict");
}
/** Discover complete genuine search walks, rather than replaying a result URL.
 * The portal can broaden a PAC result URL to all contributors in a new session.
 * Every accepted walk starts with a real fresh form/search POST and keeps that
 * initial scoped count/money as its invariant throughout the postbacks. */
export function readIndianaNativeReceiptRuns(originals: readonly IndianaNativeOriginal[], diagnostics?: Record<string, number>): ReceiptRun[] {
  const directories=new Map<string,IndianaNativeOriginal[]>();
  for(const o of originals) { const rows=directories.get(o.directory)??[]; rows.push(o); directories.set(o.directory,rows); }
  const runs:ReceiptRun[]=[];
  for(const values of directories.values()) {
    const records=[...values].sort((a,b)=>a.meta.startedAt.localeCompare(b.meta.startedAt)||a.meta.file.localeCompare(b.meta.file));
    for(let index=0;index<records.length;index++) {
      const search=records[index]!;
      if(search.meta.method!=="POST"||search.meta.url!==BASE||search.meta.status!==302||!search.meta.location)continue;
      let d:Document|null=null;
      try {
        const posted=body(search);
        // Fresh form observation must precede this submission in the same
        // anonymous source session. Filenames and roles are not selectors.
        const form=records.slice(0,index).filter(o=>o.meta.method==="GET"&&o.meta.url===BASE&&inSuccessfulOriginal(o,"html")).at(-1);
        inCheck(form&&records[index-1]===form,"receipt_fresh_form_missing"); d=originalHtml(form);
        const submit=control<HTMLInputElement>(d,"btnSearch");
        if(!posted.has(submit.name))continue;
        stateMatches(posted,d);
        const file=control<HTMLInputElement>(d,"ucCommitteeCandidateSearch_txtCommitteeID"), begin=control<HTMLInputElement>(d,"txtContributionDateBegin"), end=control<HTMLInputElement>(d,"txtContributionDateEnd");
        const cls=control<HTMLSelectElement>(d,"ddlContributorType"), committeeClass=control<HTMLSelectElement>(d,"ucCommitteeCandidateSearch_ddlCommitteeType");
        const candidate=[...committeeClass.options].filter(n=>n.textContent?.trim()==="Candidate"), pac=[...cls.options].filter(n=>n.textContent?.trim()==="Political Action Committee");
        inCheck(candidate.length===1&&pac.length===1&&posted.get(committeeClass.name)===candidate[0]!.value,"receipt_query_recipient_class");
        const mode=control<HTMLInputElement>(d,"ucCommitteeCandidateSearch_rblCommitteeCandidateSelection_0");
        inCheck(posted.get(mode.name)===mode.value,"receipt_query_committee_mode");
        const donor=posted.get(cls.name), kind=donor===pac[0]!.value?"pac":donor===cls.options[0]!.value?"all":null;
        inCheck(kind&&posted.get(file.name),"receipt_query_donor_class");
        const scope:QueryScope={file:posted.get(file.name)!,begin:inDay(posted.get(begin.name)??""),end:inDay(posted.get(end.name)??""),kind};
        inCheck(scope.begin<=scope.end,"receipt_query_date_scope");
        const inactiveNameModes=new Set<string>();
        for(const [modeId,textId]of[["rblLastNameSearchType_0","txtLastName"],["ucCommitteeCandidateSearch_rblCommitteeNameSearchType_0","ucCommitteeCandidateSearch_txtCommitteeName"]]) {
          const nameField=control<HTMLInputElement>(d,textId!),modeField=control<HTMLInputElement>(d,modeId!);
          if(!(posted.get(nameField.name)??"").trim())inactiveNameModes.add(modeField.name);
        }
        const exactFields=[...d.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>("input,select,textarea")].filter(n=>n.name&&!n.disabled&&!inactiveNameModes.has(n.name)&&!["hidden","submit","button","reset","image"].includes(n.type)).map(n=>n.name);
        const url=inPublicUrl(search.meta.location,search.meta.url), u=new URL(url);
        inCheck(u.origin===INDIANA_NATIVE_ORIGIN&&u.pathname===new URL(BASE).pathname&&u.searchParams.get("CommitteeID")===scope.file
          &&u.searchParams.get("FinanceCategoryID")===(kind==="pac"?posted.get(cls.name):"-32768")
          &&inDay(u.searchParams.get("ContributionDateBegin")??"")===scope.begin
          &&inDay(u.searchParams.get("ContributionDateEnd")??"")===scope.end,"receipt_query_redirect_scope");
        const firstIndex=records.findIndex((o,i)=>i>index&&o.meta.method==="GET"&&sameUrl(o.meta.url,url)&&inSuccessfulOriginal(o,"html"));
        inCheck(firstIndex===index+1,"receipt_initial_result_missing");
        const used=[form,search,records[firstIndex]!]; d.defaultView?.close();d=originalHtml(records[firstIndex]!);
        const initial=parseIndianaNativeReceiptPage(d,url), pages:IndianaNativeReceiptPage[]=[];
        if (!initial.pager) {
          runs.push({scope,pages:[initial],originals:used,start:form.meta.startedAt,end:used.at(-1)!.meta.completedAt});
          continue;
        }
        inCheck(initial.pager.page===1,"receipt_initial_page");
        let previous=initial, expectResize=true, complete=false;
        for(let j=firstIndex+1;j<records.length;j++) {
          const o=records[j]!;
          if(o.meta.method==="POST"&&o.meta.url===BASE)break;
          if(o.meta.method!=="POST"||!sameUrl(o.meta.url,url)||!inSuccessfulOriginal(o,"html"))continue;
          const request=body(o);stateMatches(request,d);
          for(const name of exactFields)if((request.get(name)??"")!==(posted.get(name)??"")){
            // The results page omits search controls: its native URL and
            // viewstate carry the already-established scope. Only rendered,
            // enabled controls can be successful postback fields.
            const rendered=[...d.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>("input,select,textarea")].filter(n=>n.name===name&&!n.disabled);
            if(!request.has(name)&&rendered.length===0)continue;
            if(diagnostics&&/^[A-Za-z0-9_:$]+$/.test(name))diagnostics[`filter_control_${name}`]=(diagnostics[`filter_control_${name}`]??0)+1;
            inCheck(false,"receipt_paging_filter_conflict");
          }
          const pager=previous.pager;inCheck(pager,"receipt_paging_missing");
          const expected=expectResize?pager.resize:pager.next;
          inCheck(expected&&request.get("__EVENTTARGET")===expected[0]&&request.get("__EVENTARGUMENT")===expected[1],"receipt_paging_action_conflict");
          const size=request.get(pager.sizeName);
          inCheck(size===pager.size50Value,"receipt_paging_size_conflict");
          d.defaultView?.close();d=originalHtml(o);
          const p=parseIndianaNativeReceiptPage(d,url);
          inCheck(p.count===initial.count&&p.totalCents===initial.totalCents&&p.pager!==null&&p.pager.page===pages.length+1,"receipt_paging_scope_changed");
          pages.push(p);used.push(o);previous=p;expectResize=false;
          const rows=pages.reduce((n,p)=>n+p.rows.length,0);
          inCheck(rows<=initial.count,"receipt_paging_overflow");
          if(rows===initial.count){complete=true;break;}
        }
        inCheck(complete&&pages.length>0,"receipt_walk_incomplete");
        runs.push({scope,pages,originals:used,start:form.meta.startedAt,end:used.at(-1)!.meta.completedAt});
      } catch (error) {
        const code = /^[a-z_]+$/.test((error as {code?:string})?.code??"") ? (error as {code:string}).code : "receipt_walk_unavailable";
        if(diagnostics)diagnostics[code]=(diagnostics[code]??0)+1;
        // Retain failed originals, but never turn an incomplete walk into a
        // zero or substitute a broadened GET. A caller needs two closed runs.
      } finally { d?.defaultView?.close(); }
    }
  }
  return runs.sort((a,b)=>a.end.localeCompare(b.end));
}

/** Receiving-side evidence primitive. Parent/version/period/return controls
 * and canonical identity must also qualify before a writer may admit money. */
export function readIndianaNativeReceiptEvidence(originals: readonly IndianaNativeOriginal[], input: {file:string;committee:string;year:number;through:string}) {
  inCheck(Number.isSafeInteger(input.year)&&input.year>=2026&&input.year<=2100,"receipt_election_year");
  const runs=readIndianaNativeReceiptRuns(originals), used:IndianaNativeOriginal[]=[], periods=[];
  for(const [begin,end]of[[`${input.year-1}-01-01`,`${input.year-1}-12-31`],[`${input.year}-01-01`,input.through]]) {
    const sets=new Map<"all"|"pac",ReturnType<typeof closeIndianaNativeReceiptPages>>();
    for(const kind of ["all","pac"] as const) {
      const selected=runs.filter(r=>r.scope.file===input.file&&r.scope.kind===kind&&r.scope.begin===begin&&r.scope.end===end).slice(-2);
      inCheck(selected.length===2&&selected[0]!.end<=selected[1]!.start,"receipt_independent_closing_search_missing");
      const [opening,closing]=selected;
      inCheck(isDeepStrictEqual(opening!.scope,closing!.scope),"receipt_closing_query_changed");
      sets.set(kind,closeIndianaNativeReceiptPages(opening!.pages,closing!.pages,input.committee));
      used.push(...opening!.originals,...closing!.originals);
    }
    const details=new Map<string,ReturnType<typeof parseIndianaNativeReceiptDetail>>();
    for(const row of sets.get("pac")!) {
      const source=originals.filter(o=>o.meta.method==="GET"&&sameUrl(o.meta.url,row.url)&&inSuccessfulOriginal(o,"html")&&inFreshOriginal(o)).at(-1);
      inCheck(source,"pac_native_detail_missing"); const d=originalHtml(source);
      try {details.set(row.url,parseIndianaNativeReceiptDetail(d));}finally{d.defaultView?.close();} used.push(source);
    }
    const all=sets.get("all")!,pac=sets.get("pac")!;
    inCheck(all.every(r=>r.day>=begin!&&r.day<=end!)&&all.every(r=>inKey(r.committee)===inKey(input.committee)),"receipt_row_outside_scope");
    periods.push({begin:begin!,end:end!,all,pac,...qualifyIndianaNativePacSubset({all,pac,details,file:input.file,committee:input.committee})});
  }
  return {periods,originals:[...new Set(used)]};
}
