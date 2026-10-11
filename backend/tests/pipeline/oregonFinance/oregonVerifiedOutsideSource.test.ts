import { describe, expect, it } from "vitest";
import { utils, write } from "xlsx";
import { OREGON_VERIFIED_TRANSACTION_HEADERS as headers, hashOregonVerifiedBytes } from "../../../src/pipeline/oregonFinance/oregonVerifiedSourceDecoders.js";
import { verifyOregonVerifiedOutsideSource as verify, validateOregonVerifiedOutsideEvidence as valid,
  type OregonOutsideRawEvidence as Raw, type OregonOutsideSourceSnapshot as Round,
  type OregonVerifiedOutsideInput as Input } from "../../../src/pipeline/oregonFinance/oregonVerifiedOutsideSource.js";
const base = "https://secure.sos.state.or.us/orestar/";
const c = {candidateId:"c04b0788-71ae-44fb-9ecd-37b895ef62a2",electionId:"1fe8de34-d0be-4af9-8bd9-faffc87d407b",
  committeeId:"16508",candidateName:"Paul Evans",electionYear:2026,electionType:"General" as const,officeName:"State Representative",district:"20"};
const query = {cneSearchFilerCommitteeId:"23238",cneSearchTranType:"E",cneSearchIndependentInd:"I",
  cneSearchTranStartDate:"01/01/2025",cneSearchTranEndDate:"12/31/2026"};
const dirFields = {yearActive:"2026",filerType:"CANDALL",discontinuedSOO:"on",approvedSOO:"on",
  pendingApprovalSOO:"on",insufficientSOO:"on",resolvedSOO:"on",rejectedSOO:"on"};
const label = (k:string,v:string)=>'<tr><td class="label">'+k+'</td><td>:</td><td>'+v+'</td></tr>';
function raw(body:string|Uint8Array,path:string,round:number,fields:Record<string,string>={},method:"GET"|"POST"="GET"):Raw {
  const bytes=typeof body==="string"?new TextEncoder().encode(body):body;
  return {bytes,request:{url:base+path,method,requestFields:fields,startedAt:"2026-10-11T18:0"+round+":00.000Z",
    endedAt:"2026-10-11T18:0"+round+":01.000Z",status:200,byteCount:bytes.length,sha256:hashOregonVerifiedBytes(bytes)}};
}
function replacement(e:Raw, body:string):Raw {
  const bytes=new TextEncoder().encode(body);
  return {...e,bytes,request:{...e.request,byteCount:bytes.length,sha256:hashOregonVerifiedBytes(bytes)}};
}
type Row = {id:string;amount:number;date?:string;mechanisms?:string;values?:Record<string,unknown>};
const rows:Row[]=[{id:"5868897",amount:2500,mechanisms:"Independent Expenditure in Opposition- Paul Evans - $2,500.00"},
 {id:"5874824",amount:1380,mechanisms:"Independent Expenditure in Support - Christine Drazan - $1,380.00<br>In-Kind Expenditure - Stephanie for Oregon (24539) - $1,380.00"}];
function workbook(rs:Row[]):Uint8Array {
  const values=rs.map(r=>{const v:Record<string,unknown>={"Tran Id":r.id,"Original Id":r.id,"Tran Date":r.date??"10/07/2026",
    "Tran Status":"Original",Filer:"Evergreen PAC","Filer Id":23238,"Sub Type":"Cash Expenditure",
    "Contributor/Payee":"Vendor","Book Type":"Business Entity",Amount:r.amount,"Addr Line1":"10 Test St",City:"Salem",State:"OR",Zip:"97301",...r.values};
    return headers.map(h=>v[h]??null);});
  const w=utils.book_new();utils.book_append_sheet(w,utils.aoa_to_sheet([[...headers],...values]),"Sheet1");
  return new Uint8Array(write(w,{bookType:"xlsx",type:"buffer"}));
}
function native(rs:Row[],count=rs.length,next=false,internal=false):string {
  return "Search Criteria : Tran Start Date = 01/01/2025, Tran End Date = 12/31/2026, Filer/Committee ID = 23238, Results : "+
    count+" records found for the above search criteria "+(!rs.length?"No data found matching your search criteria":"")+
    '<table><tr>'+["Tran ID","Tran Date","Status","Filer/Committee","Contributor/Payee","Sub Type","Amount"].map(x=>"<th>"+x+"</th>").join("")+"</tr>"+
    rs.map(r=>'<tr><td><a href="gotoPublicTransactionDetail.do?tranRsn='+r.id+'">'+r.id+'</a></td><td>'+(r.date??"10/07/2026")+
      '</td><td>Original</td><td><a href="'+(internal?"displayFiler.do?filerRsn=53853":"sooDetail.do?cneCommitteeId=23238")+
      '">Evergreen PAC</a></td><td>Vendor</td><td>Cash Expenditure</td><td>$'+r.amount.toFixed(2)+"</td></tr>").join("")+"</table>"+
    (next?'<input value="Next">':"");
}
function detail(r:Row):string {
  return '<div id="header2">Evergreen PAC (23238)</div><h5>Transaction Information (Original)</h5><table>'+[
    ["Transaction ID",r.id],["Transaction Date",r.date??"10/07/2026"],["Transaction Type","Expenditure"],
    ["Transaction Sub Type","Cash Expenditure"],["Amount","$"+r.amount.toFixed(2)],["Process Status","Filed"],
    ["Address Book Type","Business Entity"],["Name","Vendor"],["Address","10 Test St<br>Salem, OR 97301"],
    ["Associations",""],["In-Kind/Independent Expenditures",r.mechanisms??"Independent Expenditure in Support- Paul Evans - $"+r.amount.toFixed(2)],
  ].map(([k,v])=>label(k,v)).join("")+"</table>";
}
function history(r:Row):string {
  return '<input name="tranRsn" value="'+r.id+'">Only versions of this transaction that are public record will display.<table><tr><td>'+
    '<a href="transactionHistPubDetail.do?tranRsn='+r.id+'">'+r.id+"</a></td><td>Original</td><td>"+(r.date??"10/07/2026")+
    "</td><td>10/07/2026 07:00 PM</td><td>Cash Expenditure</td><td>Vendor</td><td>Filer</td><td>$"+r.amount.toFixed(2)+"</td></tr></table>";
}
function soo(target=true):string {
  return "<h1>Statement of Organization for "+(target?"Candidate Committee":"Political Action Committee")+
    "</h1><!-- #### Committee Information (b) #### --><table>"+label("Name",target?"Friends of Paul Evans":"Evergreen PAC")+
    label("ID",target?"16508":"23238")+"</table>"+
    (target?"<!-- #### Candidate Information (b) #### --><table>"+label("Name","Paul Evans")+
      label("Election/Office","2026 General Election<br>State Representative, 20th District")+"</table>":"");
}
function context(id="16508",ref="107100",name="Evans, Paul",office="State Representative, 20th District"):string {
  return '<tr><td><input name="committeeName" value="'+name+'&lt;BR /&gt;Friends of Paul Evans"><input name="committeeId" value="'+id+
    '"><input name="sooRsn" value="'+ref+'"><a href="sooDetail.do?sooRsn='+ref+'">'+name+"<br>Friends of Paul Evans</a></td><td>"+id+
    "</td><td>"+office+"<br>Democrat</td><td>History</td></tr>";
}
function directory(extra="",n=1):string {
  return "Search Criteria : Election Year=2026, Candidate Committee (All), Discontinued, Approved, Pending Approval, Pending Insufficient, Pending Resolved, Rejected Filings Results : "+
    n+' found for the above search criteria<table id="committeeSearchResults">'+context()+extra+"</table>";
}
function snapshot(round:number,rs=rows):Round {
  return {independent:{pages:[raw(native(rs), "gotoPublicTransactionSearchResults.do",round,{...query,cneSearchPageIdx:"0",cneSearchButtonName:"search"},"POST")],
    workbook:raw(workbook(rs),"XcelCNESearch",round)},
    financialDetails:rs.map(r=>raw(detail(r),"gotoPublicTransactionDetail.do?tranRsn="+r.id,round)),
    histories:rs.map(r=>raw(history(r),"ceTransactionHistory.do?tranRsn="+r.id,round)),
    payerSoo:raw(soo(false),"sooDetail.do?cneCommitteeId=23238",round),
    candidateDirectory:[raw(directory(),"CommitteeSearchSecondPage.do",round,dirFields,"POST")],
    receivingSoo:raw(soo(),"sooDetail.do?cneCommitteeId=16508",round),
    qualifiedTargetSoo:raw(soo(),"sooDetail.do?sooRsn=107100",round)};
}
function input(rs=rows):Input {return {candidateContext:{...c},payerCommitteeId:"23238",windowStart:"2025-01-01",windowEnd:"2026-12-31",before:snapshot(0,rs),after:snapshot(2,rs)};}
function omitted(i:Input,pattern?:RegExp):void {const r=verify(i);expect(r.evidence).toBeUndefined();expect(r.diagnostics.length).toBeGreaterThan(0);if(pattern)expect(r.diagnostics.join(" ")).toMatch(pattern);}
describe("Oregon scoped Original cash IE evidence",()=>{
 it("accepts explicit Evans2500 opposition, retains every payer identity and omits other beneficiaries/in-kind",()=>{
   const r=verify(input());expect(r.diagnostics).toEqual([]);expect(r.evidence).toMatchObject({supportCents:0,opposeCents:250000,allocationPolicy:"2026_general_rolling_window_2026-09-22_2026-11-03"});
   expect(r.evidence?.transactions).toHaveLength(2);expect(r.evidence?.allocations).toHaveLength(1);expect(valid(r.evidence)).toBe(true);
 });
 it("accepts association display-order changes without dropping duplicate occurrences",()=>{
   const rs=[{id:"5868897",amount:2500,mechanisms:"Independent Expenditure in Support- Paul Evans - $1,250.00<br>Independent Expenditure in Support- Paul Evans - $1,250.00<br>In-Kind Expenditure - Friends of Paul Evans (16508) - $2,500.00"}];
   const i=input(rs),reversed=rs[0].mechanisms.split("<br>").reverse().join("<br>");
   i.after.financialDetails=[replacement(i.after.financialDetails[0],detail({...rs[0],mechanisms:reversed}))];
   const e=verify(i).evidence;expect(e?.supportCents).toBe(250000);expect(e?.allocations).toHaveLength(2);
 });
 it("binds an internal native filerRSN through full name/workbook/public detail, never treating53853 as23238",()=>{
   const i=input();for(const s of [i.before,i.after])s.independent.pages=[replacement(s.independent.pages[0],native(rows,2,false,true))];
   expect(verify(i).evidence?.payer.committeeId).toBe("23238");
   i.after.financialDetails=[replacement(i.after.financialDetails[0],detail(rows[0]).replace("Evergreen PAC (23238)","Evergreen PAC (53853)")),i.after.financialDetails[1]];
   omitted(i,/identity/);
 });
 it("accepts a final enabled Next only when full declared count and workbook match",()=>{
   const i=input();for(const s of [i.before,i.after])s.independent.pages=[replacement(s.independent.pages[0],native(rows,2,true))];
   expect(verify(i).evidence).toBeDefined();
 });
 it("closes multiple current native pages with exact full cardinality and all workbook identities",()=>{
   const i=input();for(const [round,s]of[[0,i.before],[2,i.after]]as const)s.independent.pages=[
     raw(native([rows[0]],2,true),"gotoPublicTransactionSearchResults.do",round,{...query,cneSearchPageIdx:"0",cneSearchButtonName:"search"},"POST"),
     raw(native([rows[1]],2,true),"gotoPublicTransactionSearchResults.do",round,{...query,cneSearchPageIdx:"1",cneSearchButtonName:"next"},"POST")];
   expect(verify(i).evidence).toBeDefined();
   i.after.independent.pages=[i.after.independent.pages[0]];omitted(i,/incomplete/);
 });
 it("requires each candidate's own full target SOO closure for Drazan1380",()=>{
   const i=input();i.candidateContext={...c,committeeId:"19050",candidateName:"Christine Drazan",officeName:"Governor",district:null};
   for(const s of[i.before,i.after]){
     s.candidateDirectory=[replacement(s.candidateDirectory[0],directory(context("19050","107200","Drazan, Christine","Governor").replace(/Friends of Paul Evans/g,"Friends of Christine Drazan"),2))];
     const h=soo().replace(/16508/g,"19050").replace(/Paul Evans/g,"Christine Drazan").replace("State Representative, 20th District","Governor");
     s.receivingSoo=raw(h,"sooDetail.do?cneCommitteeId=19050",s===i.before?0:2);
     s.qualifiedTargetSoo=raw(h,"sooDetail.do?sooRsn=107200",s===i.before?0:2);
   }
   const e=verify(i).evidence;expect(e?.supportCents).toBe(138000);expect(e?.allocations).toHaveLength(1);
 });
 it("does not infer a complete outside zero from explicit empty source",()=>omitted(input([]),/zero/));
 it("omits earlier allocations despite2026activity/election context",()=>omitted(input([{...rows[0],date:"08/21/2026"}]),/bounded/));
 it.each(["Amended","Deleted","Original*"])("preserves unsupported current version %s",status=>{
   const i=input();i.after.independent.workbook=raw(workbook(rows.map(r=>({...r,values:{"Tran Status":status}}))),"XcelCNESearch",2);omitted(i);
 });
 it("preserves expired detail even though process status remains Filed",()=>{
   const i=input();i.after.financialDetails=[replacement(i.after.financialDetails[0],detail(rows[0])+"This is an expired transaction - see History."),i.after.financialDetails[1]];omitted(i);
 });
 it("rejects unknown mechanism and overallocated source cash",()=>{
   omitted(input([{...rows[0],mechanisms:"Independent Expenditure in Unknown- Paul Evans - $2,500.00"}]));
   omitted(input([{...rows[0],mechanisms:"Independent Expenditure in Support- Paul Evans - $3,000.00"}]));
 });
 it("rejects source address mutation without economic deduplication",()=>{
   const i=input();i.after.financialDetails=[replacement(i.after.financialDetails[0],detail(rows[0]).replace("10 Test St","11 Test St")),i.after.financialDetails[1]];omitted(i,/identity/);
 });
 it("retains separate equal-dollar source IDs",()=>{
   const rs=[{...rows[0],amount:100,mechanisms:"Independent Expenditure in Support- Paul Evans - $100.00"},
     {...rows[0],id:"5868898",amount:100,mechanisms:"Independent Expenditure in Support- Paul Evans - $100.00"}];
   const e=verify(input(rs)).evidence;expect(e?.supportCents).toBe(20000);expect(e?.allocations).toHaveLength(2);
 });
 it.each(["hash","bytes","status","foreign","credentials","fragment","duplicate-query","overlap"])("rejects broken raw acquisition %s",bad=>{
   const i=input(),e=i.after.payerSoo;
   if(bad==="hash")e.request.sha256="0".repeat(64);
   if(bad==="bytes")e.request.byteCount++;
   if(bad==="status")e.request.status=500;
   if(bad==="foreign")e.request.url=e.request.url.replace("secure.sos.state.or.us","example.com");
   if(bad==="credentials")e.request.url=e.request.url.replace("https://","https://user@");
   if(bad==="fragment")e.request.url+="#x";
   if(bad==="duplicate-query")e.request.url+="&cneCommitteeId=23238";
   if(bad==="overlap")e.request.startedAt="2026-10-11T18:00:00.000Z";
   omitted(i);
 });
 it.each(["cap","count","repeat","scope","history","closing","criteria"])("preserves incomplete or restrictive current source %s",bad=>{
   const i=input(),s=i.after;
   if(bad==="cap")s.independent.pages=[replacement(s.independent.pages[0],native(rows,5000,true))];
   if(bad==="count")s.independent.pages=[replacement(s.independent.pages[0],native(rows,3))];
   if(bad==="repeat")s.independent.pages=[replacement(s.independent.pages[0],native([rows[0],rows[0]]))];
   if(bad==="scope")s.independent.pages[0].request.requestFields={...s.independent.pages[0].request.requestFields,cneSearchIndependentInd:"K"};
   if(bad==="history")s.histories=s.histories.slice(1);
   if(bad==="closing")s.financialDetails=s.financialDetails.slice(1);
   if(bad==="criteria")s.independent.pages=[replacement(s.independent.pages[0],native(rows).replace("Filer/Committee ID = 23238","Filer/Committee ID = 232380"))];
   omitted(i);
 });
 it.each(["missing-status","partial","same-name-seat","middle-name","wrong-seat","wrong-year","wrong-ref"])("preserves ambiguous target authority %s",bad=>{
   const i=input(),s=i.after;
   if(bad==="missing-status")s.candidateDirectory[0].request.requestFields={...dirFields,rejectedSOO:""};
   if(bad==="partial")s.candidateDirectory=[replacement(s.candidateDirectory[0],directory("",740))];
   if(bad==="same-name-seat")s.candidateDirectory=[replacement(s.candidateDirectory[0],directory(context("16509","107101","Evans, Paul","State Representative, 19th District"),2))];
   if(bad==="middle-name")i.candidateContext.candidateName="Paul James Evans";
   if(bad==="wrong-seat")i.candidateContext.district="19";
   if(bad==="wrong-year")s.receivingSoo=replacement(s.receivingSoo,soo().replace("2026 General","2024 General"));
   if(bad==="wrong-ref")s.qualifiedTargetSoo.request.url=base+"sooDetail.do?sooRsn=107101";
   omitted(i);
 });
 it("preserves prior transaction disappearance/mutation while allowing appended Originals",()=>{
   const p=verify(input()).evidence!;
   const removed=input([rows[0]]);removed.priorProvenance=p;omitted(removed,/disappeared/);
   const changed=input([{...rows[0],amount:2400,mechanisms:"Independent Expenditure in Opposition- Paul Evans - $2,400.00"},rows[1]]);changed.priorProvenance=p;omitted(changed,/changed/);
   const appended=input([...rows,{id:"5880000",amount:50,mechanisms:"Independent Expenditure in Support- Paul Evans - $50.00"}]);appended.priorProvenance=p;
   expect(verify(appended).evidence?.supportCents).toBe(5000);
 });
 it.each([{},[],{version:0},"legacy"])("never promotes malformed prior authority %j",p=>omitted({...input(),priorProvenance:p},/prior/));

 it("binds domestic source ZIP7188 to published07188 without altering raw identity",()=>{
   const rs=[{...rows[0],values:{Country:"United States",Zip:"7188",City:"Newark",State:"NJ"}}];
   const i=input(rs);
   for(const s of[i.before,i.after])s.financialDetails=[replacement(s.financialDetails[0],detail(rs[0]).replace("Salem, OR 97301","Newark, NJ 07188"))];
   expect(verify(i).evidence?.opposeCents).toBe(250000);
   const before=verify(i).evidence!;
   i.after.independent.workbook=raw(workbook([{...rs[0],values:{...rs[0].values,Zip:"07188"}}]),"XcelCNESearch",2);
   omitted(i,/identity changed/);
   expect(valid(before)).toBe(true);
 });
 it.each(["street punctuation","Address2","foreign"])("does not erase financial address identity: %s",bad=>{
   const i=input();
   if(bad==="street punctuation")i.after.financialDetails=[replacement(i.after.financialDetails[0],detail(rows[0]).replace("10 Test St","10 Test-St")),i.after.financialDetails[1]];
   if(bad==="Address2")i.after.independent.workbook=raw(workbook(rows.map(r=>({...r,values:{"Addr Line2":"Suite 2"}}))),"XcelCNESearch",2);
   if(bad==="foreign")i.after.independent.workbook=raw(workbook(rows.map(r=>({...r,values:{Country:"Canada"}}))),"XcelCNESearch",2);
   omitted(i);
 });

 it("binds only source-tagged native name annotations while retaining raw identity",()=>{
   const i=input();
   for(const s of[i.before,i.after])s.independent.pages=[replacement(s.independent.pages[0],
     native(rows).replaceAll("<td>Vendor</td>",'<td><font color="green">Vendor *</font></td>')+
     '<font color="Green">*in-kind expenditure</font>')];
   const e=verify(i).evidence;expect(e?.opposeCents).toBe(250000);
   i.after.independent.pages=[replacement(i.after.independent.pages[0],
     native(rows).replaceAll("<td>Vendor</td>",'<td><font color="green">Vendor *</font></td>')+
     '<font color="Green">*in-kind expenditures</font>')];
   omitted(i,/identity/);
 });
 it("preserves literal name asterisks without the exact source annotation authority",()=>{
   const i=input();
   for(const s of[i.before,i.after])s.independent.pages=[replacement(s.independent.pages[0],
     native(rows).replaceAll("<td>Vendor</td>",'<td>Vendor *</td>'))];
   omitted(i,/identity/);
 });

 it("binds the local canonical lower-chamber office to the exact source seat while retaining local context",()=>{
   const i=input();i.candidateContext.officeName="State Lower Chamber Legislator";
   const e=verify(i).evidence!;expect(e?.opposeCents).toBe(250000);
   expect(e?.candidateContext.officeName).toBe("State Lower Chamber Legislator");
   expect(valid(e,i.candidateContext)).toBe(true);
   expect(valid(e,{...i.candidateContext,district:"19"})).toBe(false);
   expect(valid(e,c)).toBe(false);
 });
 it("accepts the published SOO office/seat line wrap without dropping any field content",()=>{
   const i=input();i.candidateContext.officeName="State Lower Chamber Legislator";
   for(const s of[i.before,i.after]){
     s.receivingSoo=replacement(s.receivingSoo,soo().replace("State Representative, 20th District","State Representative,<br>20th District"));
     s.qualifiedTargetSoo=replacement(s.qualifiedTargetSoo,soo().replace("State Representative, 20th District","State Representative,<br>20th District"));
   }
   expect(verify(i).evidence?.opposeCents).toBe(250000);
 });
 it.each(["receivingSoo","qualifiedTargetSoo"] as const)("preserves a wrong seat in a wrapped %s field",field=>{
   const i=input();
   for(const s of[i.before,i.after])s[field]=replacement(s[field],soo().replace("State Representative, 20th District","State Representative,<br>19th District"));
   omitted(i,/receiving election\/office\/person mismatch/);
 });
 it("keeps the raw SOO line-array bracket authoritative after field comparison",()=>{
   const i=input();
   for(const field of["receivingSoo","qualifiedTargetSoo"] as const)
     i.after[field]=replacement(i.after[field],soo().replace("State Representative, 20th District","State Representative,<br>20th District"));
   omitted(i,/changed/);
 });
 it("does not remove source office punctuation while joining wrapped lines",()=>{
   const i=input();
   for(const s of[i.before,i.after])s.receivingSoo=replacement(s.receivingSoo,soo().replace("State Representative, 20th District","State Representative<br>20th District"));
   omitted(i,/receiving election\/office\/person mismatch/);
 });
 it.each(["State Upper Chamber Legislator","Commissioner of the Bureau of Labor and Industries"])("preserves unproved local office alias %s",officeName=>{
   omitted({...input(),candidateContext:{...c,officeName}},/unsupported/);
 });

 it("validates exact source criteria cell without treating adjacent published legend as a financefilter",()=>{
   const source=(restricted=false)=>{
     const [prefix,rest]=native(rows).split(" Results : "),parts=rest.split("<table>");
     return '<table><tr><td>Search Criteria :</td><td>'+prefix.replace("Search Criteria : ","")+
       (restricted?", Donor Type = Restricted":"")+
       '</td><td><font color="red">**out-of-state contributor</font></td></tr><tr><td>Results :</td><td>'+
       parts[0]+'</td></tr></table><table>'+parts[1];
   };
   const i=input();for(const s of[i.before,i.after])s.independent.pages=[replacement(s.independent.pages[0],source())];
   expect(verify(i).evidence?.opposeCents).toBe(250000);
   i.after.independent.pages=[replacement(i.after.independent.pages[0],source(true))];
   omitted(i,/query mismatch/);
 });
 it("runtime validation rejects falsified totals, occurrence collisions and incompatible local target",()=>{
   const e=verify(input()).evidence!;expect(valid({...e,opposeCents:1})).toBe(false);
   expect(valid({...e,allocations:[...e.allocations,...e.allocations]})).toBe(false);
   expect(valid({...e,candidateContext:{...c,district:"19"}},c)).toBe(false);
 });
});
