import { describe, expect, it } from "vitest";
import { inForm, inHtml } from "../../../src/pipeline/indianaFinance/indianaNativeProtocol.js";
import { inHash, type IndianaNativeOriginal } from "../../../src/pipeline/indianaFinance/indianaNativeOriginals.js";
import { readIndianaNativeReceiptRuns } from "../../../src/pipeline/indianaFinance/indianaNativeReceiptEvidence.js";

const base="https://campaignfinance.in.gov/PublicSite/SearchPages/ContributionSearch.aspx";
const field=(id:string,type="text",value="")=>`<input id="_ctl0_Content_${id}" name="${id}" type="${type}" value="${value}">`;
const state=(v:string)=>`<input name="__VIEWSTATE" type="hidden" value="${v}"><input name="__EVENTVALIDATION" type="hidden" value="synthetic-validation">`;
const form=`<form>${state("synthetic-form")}${field("txtLastName")}${field("rblLastNameSearchType_0","radio","contains")}${field("ucCommitteeCandidateSearch_txtCommitteeName")}${field("ucCommitteeCandidateSearch_rblCommitteeNameSearchType_0","radio","contains")}${field("ucCommitteeCandidateSearch_txtCommitteeID")}${field("txtContributionDateBegin")}${field("txtContributionDateEnd")}${field("ucCommitteeCandidateSearch_rblCommitteeCandidateSelection_0","radio","committee")}<select id="_ctl0_Content_ddlContributorType" name="donor"><option value="Select all contributor types...">Select all contributor types...</option><option value="10">Political Action Committee</option></select><select id="_ctl0_Content_ucCommitteeCandidateSearch_ddlCommitteeType" name="recipient"><option value="candidate">Candidate</option></select>${field("btnSearch","submit","Search")}</form>`;
function result(rows=1,size=10) {
 return `<form>${state("synthetic-result")}<span id="_ctl0_Content_lblRecordsFound">${rows} records found</span><span id="_ctl0_Content_lblTotalContributions">$${rows*100}.00</span><table id="_ctl0_Content_dgdSearchResults"><tr>${["Contributor","City, State","Type","Amount","Date","Candidate/Committee Name","In Kind?","Large?",""] .map(v=>`<th>${v}</th>`).join("")}</tr>${Array.from({length:rows},(_,i)=>`<tr><td>Synthetic PAC ${i}</td><td>Example, IN</td><td>Direct</td><td>$100.00</td><td>10/1/2026</td><td>Synthetic Committee</td><td></td><td></td><td><a onclick="window.open('/PublicSite/SearchPages/ContributionDetail.aspx?Synthetic=${i}')">View</a></td></tr>`).join("")}<tr><td colspan="9"><span>1</span><select name="synthetic_size" onchange="__doPostBack('synthetic_size','')">${[10,25,50].map(n=>`<option value="${n}" ${n===size?"selected":""}>${n}</option>`).join("")}</select></td></tr></table></form>`;
}
function original(index:number,url:string,raw:string,request:string|null=null,location:string|null=null):IndianaNativeOriginal {
 const bytes=Buffer.from(raw),time=new Date(Date.now()-20000+index*1000).toISOString();
 return {directory:"/synthetic-originals",raw:bytes,request,meta:{role:"synthetic",url,file:`${index}.original`,method:request===null?"GET":"POST",requestFile:request===null?null:`${index}.request`,requestSha256:request===null?null:inHash(request),status:location?302:200,location,contentType:"text/html",startedAt:time,completedAt:time,bytes:bytes.length,sha256:inHash(bytes),eof:true}};
}
function walk() {
 const d=inHtml(Buffer.from(form),base),p=inForm(d);
 p.set("ucCommitteeCandidateSearch_txtCommitteeID","synthetic-file");p.set("txtContributionDateBegin","1/1/2026");p.set("txtContributionDateEnd","10/21/2026");p.set("ucCommitteeCandidateSearch_rblCommitteeCandidateSelection_0","committee");p.set("donor","10");p.set("btnSearch","Search");d.defaultView?.close();
 const u=new URL(base);for(const [k,v]of Object.entries({CommitteeID:"synthetic-file",FinanceCategoryID:"10",ContributionDateBegin:"1/1/2026",ContributionDateEnd:"10/21/2026"}))u.searchParams.set(k,v);
 const first=inHtml(Buffer.from(result()),u.href),post=inForm(first);post.set("synthetic_size","50");post.set("__EVENTTARGET","synthetic_size");post.set("__EVENTARGUMENT","");first.defaultView?.close();
 return [original(0,base,form),original(1,base,"",p.toString(),u.href),original(2,u.href,result()),original(3,u.href,result(1,50),post.toString())];
}

describe("Indiana genuine receipt-walk provenance",()=>{
 it("accepts a real scoped search/postback chain when results omit search controls",()=>{
  const runs=readIndianaNativeReceiptRuns(walk());expect(runs).toHaveLength(1);expect(runs[0]!.scope.kind).toBe("pac");expect(runs[0]!.pages[0]!.rows).toHaveLength(1);
 });
 it("rejects a saved result URL without its fresh form/search submission",()=>{
  expect(readIndianaNativeReceiptRuns(walk().slice(2))).toEqual([]);
 });
 it("rejects a page that broadens the initial scoped count or money",()=>{
  const source=walk(),old=source[3]!;source[3]=original(3,old.meta.url,result(2,50),old.request);const diagnostics:Record<string,number>={};
  expect(readIndianaNativeReceiptRuns(source,diagnostics)).toEqual([]);expect(diagnostics.receipt_paging_scope_changed).toBe(1);
 });
 it("rejects a postback with unrelated native viewstate",()=>{
  const source=walk(),old=source[3]!,p=new URLSearchParams(old.request!);p.set("__VIEWSTATE","different-synthetic-state");source[3]=original(3,old.meta.url,result(1,50),p.toString());const diagnostics:Record<string,number>={};
  expect(readIndianaNativeReceiptRuns(source,diagnostics)).toEqual([]);expect(diagnostics.receipt_postback_state_conflict).toBe(1);
 });
 it("rejects a redirect that drops the selected literal PAC class",()=>{
  const source=walk(),old=source[1]!,u=new URL(old.meta.location!);u.searchParams.set("FinanceCategoryID","-32768");source[1]=original(1,base,"",old.request,u.href);const diagnostics:Record<string,number>={};
  expect(readIndianaNativeReceiptRuns(source,diagnostics)).toEqual([]);expect(diagnostics.receipt_query_redirect_scope).toBe(1);
 });
});
