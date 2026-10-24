import {describe,expect,it} from 'vitest';
import {requireIndianaNativeOccurrenceClosure} from '../../../src/pipeline/indianaFinance/indianaNativeFinancialEvidence.js';
const row=(name:string,cents:number)=>({day:'2026-10-01',kind:'Direct',name,cents});
describe('Indiana full receiving occurrence closure',()=>{
 it('rejects swapped donor amounts even when count and total money still match',()=>{
  expect(()=>requireIndianaNativeOccurrenceClosure([row('Synthetic A',10000),row('Synthetic B',20000)],[row('Synthetic A',20000),row('Synthetic B',10000)])).toThrow('native_receipt_occurrence_conflict');
 });
 it('preserves repeated same-day gifts and signed credits without deduplication',()=>{
  const rows=[row('Synthetic A',10000),row('Synthetic A',10000),row('Synthetic A',-5000)];
  expect(()=>requireIndianaNativeOccurrenceClosure(rows,[...rows].reverse())).not.toThrow();
  expect(()=>requireIndianaNativeOccurrenceClosure(rows,rows.slice(1))).toThrow('native_receipt_occurrence_conflict');
 });
});


// Synthetic values reproduce the native small-history shape without retaining
// a real filing, contributor or source selector.
describe("Indiana complete unpaged filing inventories", () => {
 const receiver = {linkId:"synthetic-link",candidateId:"synthetic-candidate",electionId:"synthetic-election",electionYear:2026,electionDate:"2026-11-03",firstName:"Bill",lastName:"Example",candidateAliases:["Bill Example"],receivingId:"900000001",committeeName:"Synthetic Committee",officeScope:"state_lower",officeName:"State Lower Chamber Legislator",linkOfficeName:"State Lower Chamber Legislator",district:"99",canonicalDistrictName:"State House District 99; Indiana",canonicalDistrictType:"state_lower",activeOwnerCount:1};
 function page(count=8, changed=false) {
  return `<form><input name="__VIEWSTATE" value="synthetic-state"><input name="__EVENTVALIDATION" value="synthetic-validation">${Object.entries({lblCommitteeID:receiver.receivingId,lblCommName:receiver.committeeName,lblCandidateName:"Example, Bill",lblCandidateOffice:"State Representative",lblDistrict:"99",lblCommitteeType:"Candidate",lblCommStatus:"Active"}).map(([key,value])=>`<span id="_ctl0_Content_${key}">${value}</span>`).join("")}<table id="_ctl0_Content_dgdFilingHistory"><tr>${["Description","Period Begin","Period End","Due Date","Filed Date","Amended?","Status"].map(v=>`<th>${v}</th>`).join("")}</tr>${Array.from({length:count},(_,i)=>`<tr><td><a href="javascript:__doPostBack('synthetic${i}','')">${changed&&i===0?"Changed Synthetic Report":"Synthetic Report"}</a></td><td>1/1/2025</td><td>12/31/2025</td><td>1/20/2026</td><td>1/19/2026</td><td>No</td><td>Filed</td></tr>`).join("")}</table></form>`;
 }
 it("requires two independent full native observations and unchanged rows", async () => {
  const {closeIndianaNativeInventory}=await import("../../../src/pipeline/indianaFinance/indianaNativeFinancialEvidence.js");
  const {inHash}=await import("../../../src/pipeline/indianaFinance/indianaNativeOriginals.js");
  const make=(index:number,body=page())=>{const raw=Buffer.from(body),time=new Date(Date.now()-3000+index*1000).toISOString();return {directory:"/synthetic-originals",raw,request:null,meta:{url:"https://campaignfinance.in.gov/PublicSite/SearchPages/CommitteeDetail.aspx?Synthetic=one",file:`${index}.original`,requestFile:null,requestSha256:null,method:"GET" as const,status:200,contentType:"text/html",startedAt:time,completedAt:time,bytes:raw.length,sha256:inHash(raw),eof:true}};};
  const rows=[make(0),make(1)];
  expect(closeIndianaNativeInventory(rows,receiver)[1]!.rows).toHaveLength(8);
  expect(()=>closeIndianaNativeInventory(rows.slice(0,1),receiver)).toThrow("independent_filing_inventory_missing");
  const lookup=make(0),request="__VIEWSTATE=synthetic&__EVENTVALIDATION=synthetic";
  const search={...lookup,raw:Buffer.alloc(0),request,meta:{...lookup.meta,url:"https://campaignfinance.in.gov/PublicSite/SearchPages/CommitteeSearch.aspx",file:"search.original",method:"POST" as const,status:302,location:lookup.meta.url,requestFile:"search.request",requestSha256:inHash(request),bytes:0,sha256:inHash(Buffer.alloc(0)),startedAt:new Date(Date.now()-4000).toISOString(),completedAt:new Date(Date.now()-4000).toISOString()}};
  expect(()=>closeIndianaNativeInventory([search,...rows],receiver)).toThrow("independent_filing_inventory_missing");
  expect(closeIndianaNativeInventory([search,...rows,make(2)],receiver)[1]!.rows).toHaveLength(8);
  // An identity lookup reached through an intermediate redirect hop is still excluded.
  const http=lookup.meta.url.replace("https:","http:"),hopTime=new Date(Date.now()-3500).toISOString();
  const hop={...search,request:null,meta:{...search.meta,url:http,file:"hop.original",method:"GET" as const,location:lookup.meta.url,requestFile:null,requestSha256:null,startedAt:hopTime,completedAt:hopTime}};
  const hoppedSearch={...search,meta:{...search.meta,location:http}};
  expect(()=>closeIndianaNativeInventory([hoppedSearch,hop,...rows],receiver)).toThrow("independent_filing_inventory_missing");
  expect(closeIndianaNativeInventory([hoppedSearch,hop,...rows,make(2)],receiver)[1]!.rows).toHaveLength(8);
  // A redirect hop without a committee-search origin does not exclude a genuine inventory.
  expect(closeIndianaNativeInventory([hop,...rows],receiver)[1]!.rows).toHaveLength(8);
  expect(()=>closeIndianaNativeInventory([rows[0]!,make(1,page(8,true))],receiver)).toThrow("filing_inventory_changed");
  expect(()=>closeIndianaNativeInventory(rows,{...receiver,activeOwnerCount:2})).toThrow("independent_filing_inventory_missing");
 });
 it("rejects oversized or empty histories without a native pager", async () => {
  const {inHtml,parseIndianaNativeFilingPage}=await import("../../../src/pipeline/indianaFinance/indianaNativeProtocol.js");
  for(const count of [0,11]){const d=inHtml(Buffer.from(page(count)),"https://campaignfinance.in.gov");try{expect(()=>parseIndianaNativeFilingPage(d)).toThrow();}finally{d.defaultView?.close();}}
 });
});
