import { describe, expect, it } from "vitest";
import { fingerprintArkansasVerifiedRawRows } from "../../../src/pipeline/arkansasFinance/arkansasVerifiedSourceClient.js";
import { fingerprintArkansasFinancialRawRow, verifyArkansasCurrentOriginalCashSource, verifyArkansasCurrentOriginalIeSource, type ArkansasCurrentOriginalFinancialInput } from "../../../src/pipeline/arkansasFinance/arkansasCurrentOriginalFinancialSource.js";

const H="a".repeat(64),REG="11111111-1111-1111-1111-111111111111",REPORT="22222222-2222-2222-2222-222222222222",ROW="33333333-3333-3333-3333-333333333333";
const url="https://api-ethics-disclosures.sos.arkansas.gov/api/";
function request(endpoint:string,body:Record<string,unknown>,second:number){return{url:url+endpoint,method:"POST" as const,requestBody:body,startedAt:`2026-10-11T10:00:${String(second).padStart(2,"0")}Z`,endedAt:`2026-10-11T10:00:${String(second+1).padStart(2,"0")}Z`,status:200,contentType:"application/json",bytes:100,sha256:H};}
function fixture(ie=false):ArkansasCurrentOriginalFinancialInput{
 const sourceName=ie?"Example IE Committee":"Jane Doe",reportName="2026 June Monthly Report";
 const reportRaw={filerReportGuid:REPORT,filerReportVersionID:1,reportName,reportStatus:"Original",reportVersion:"Original",startDate:"2026-06-01T00:00:00",endDate:"2026-06-30T00:00:00",filedDate:"2026-07-20T10:00:00",filePath:"Reports\\example.pdf",hasChild:false,isPaperFile:false};
 const report={registrationGuid:REG,filerReportGuid:REPORT,filerReportVersionId:1,reportName,reportType:"Scheduled Financial Report",reportStatus:"Original",reportVersion:"Original",startDate:reportRaw.startDate,endDate:reportRaw.endDate,dueDate:"2026-07-20T00:00:00",filedDate:reportRaw.filedDate,filerFilingCalendarGuid:null,electionTypeCode:ie?"NOELEC":"GRNELEC",reportElectionType:null,filePath:reportRaw.filePath,isPaperFile:false,hasChild:false,rawFields:reportRaw};
 const nativeRaw={guid:ROW,filerRegistrationGuid:REG,filerName:ie?sourceName:"Doe, Jane",transactionAmount:100,transactionDate:"06/15/2026",sourceName:ie?"Example Vendor":"Example PAC",sourceAddress:"PO Box 1, Little Rock, AR, 72201",transactionSource:ie?"Business/Organization/Unlisted PAC":"Political Action Committee",reportName,transactionSubTypeDesc:"Itemized Monetary",transactionCategory:null,hasChild:false};
 const native={guid:ROW,filerName:nativeRaw.filerName,filerRegistrationGuid:REG,transactionAmount:100,transactionDate:nativeRaw.transactionDate,sourceName:nativeRaw.sourceName,sourceAddress:nativeRaw.sourceAddress,transactionSource:nativeRaw.transactionSource,reportName,transactionSubTypeDescription:"Itemized Monetary",hasChild:false,employerName:null,occupation:null,transactionCategory:null,rawFields:nativeRaw};
 const detailRaw={guid:ROW,transactionID:123,transactionVersionID:1,transactionTypeCode:ie?"TEXP":"TCON",transactionSubTypeCode:"ITMY",transactionSourceTypeCode:ie?"TBSN":"TPAC",transactionDate:"2026-06-15T00:00:00",contributor:nativeRaw.sourceName,filerName:sourceName,comments:ie?"PRINTING IN SUPPORT OF JANE DOE AR SD 7":null,valueOfNonMoneyItem:100,electionYear:"2026",electionTypeCode:"PRMELEC"};
 const detail={guid:ROW,transactionId:123,transactionVersionId:1,transactionTypeCode:detailRaw.transactionTypeCode,transactionSubTypeCode:"ITMY",transactionSourceTypeCode:detailRaw.transactionSourceTypeCode,transactionDate:detailRaw.transactionDate,contributor:detailRaw.contributor,filerName:sourceName,comments:detailRaw.comments,valueOfNonMoneyItem:100,electionYear:2026,electionTypeCode:"PRMELEC",rawFields:detailRaw};
 const occurrence={section:ie?19:15,pageNumber:2,ordinal:0,date:"2026-06-15",nameAddress:`${nativeRaw.sourceName} PO Box 1, Little Rock, AR 72201`,description:detailRaw.comments??"",employment:"",election:"General",amountCents:10000,cumulativeCents:10000,rawCells:[]};
 const parsed={sha256:H,byteCount:100,kind:ie?"independent" as const:"candidate" as const,ownerName:sourceName,filerId:"7",officeName:ie?null:"State Senate",district:ie?null:"7",reportLabel:ie?reportName:reportName+" - General",periodStart:"2026-06-01",periodEnd:"2026-06-30",filedAt:"2026-07-20T10:00:00",electionTypeRaw:ie?"No Election":"General",electionYear:ie?null:2026,electionDateRaw:ie?"11/05/2024":null,currentCashCents:ie?0:10000,currentLoanCents:0,currentExpenseCents:ie?10000:0,noActivity:"unchecked" as const,amendment:"unchecked" as const,returnedCashCents:0,cashRows:ie?[]:[occurrence],nonmoneyRows:[],expenseRows:ie?[occurrence]:[],sectionTotals:ie?{"20":10000,"21":0,"22":10000}:{"14":0,"16":10000,"17":0,"18":10000},sections:ie?[10,11,13,17,19]:[11,13,15,19,23],pages:[]};
 const reportCollection=(second:number)=>({rows:[structuredClone(report)],complete:true as const,totalItems:1,fingerprint:fingerprintArkansasVerifiedRawRows([report]),requests:[request("PublicFilerDetails/GetPublicFilerProfileFiling",{filerRegistrationGuid:REG},second)]});
 const nativeCollection=(second:number)=>({rows:[structuredClone(native)],complete:true as const,totalItems:1,fingerprint:fingerprintArkansasVerifiedRawRows([native]),requests:[request("PublicTransactionDetails/GetTransactionDetails",{filerRegistrationGuid:REG,transactionTypeCode:ie?"TEXP":"TCON"},second)]});
 return{identity:{entityId:"7",registrationGuid:REG,sourceName,electionYear:2026,officeName:ie?null:"State Senate",district:ie?null:"7"},windowStart:"2026-01-01",windowEnd:"2026-12-31",reportsBefore:reportCollection(0),nativeBefore:nativeCollection(2),reportsAfter:reportCollection(10),nativeAfter:nativeCollection(12),details:[{row:detail,fingerprint:fingerprintArkansasVerifiedRawRows([detail]),request:request("PublicTransactionDetails/GetTransactionDetailsByGuid",{transactionGuid:ROW},4)}],pdfs:[{reportGuid:REPORT,parsed,request:request("PublicFiledReportAndDownload/DownloadDocument",{filerReportGuid:REPORT,fileName:reportName+" V1",openInNewTab:true},6)}]};
}
function rehash(input:ArkansasCurrentOriginalFinancialInput){for(const c of[input.reportsBefore,input.reportsAfter,input.nativeBefore,input.nativeAfter])c.fingerprint=fingerprintArkansasVerifiedRawRows(c.rows);for(const d of input.details)d.fingerprint=fingerprintArkansasVerifiedRawRows([d.row]);}
function bothNative(input:ArkansasCurrentOriginalFinancialInput,key:string,value:unknown){for(const c of[input.nativeBefore,input.nativeAfter]){(c.rows[0] as any)[key]=value;const rawKey=key==="transactionSubTypeDescription"?"transactionSubTypeDesc":key;(c.rows[0]!.rawFields as any)[rawKey]=value;}rehash(input);}

describe("Arkansas original financial source closure (synthetic provenance policy)",()=>{
 it("accepts complete typed cash only as a subset of unchanged source cash",()=>{const x=fixture();const r=verifyArkansasCurrentOriginalCashSource(x);expect(r.diagnostics).toEqual([]);expect(r.proof?.cashRows).toHaveLength(1);expect(r.proof?.monetaryCashCents).toBe(10000);expect(r.proof?.cashRows[0]?.transactionSourceTypeCode).toBe("TPAC");expect(r.proof?.reports[0]?.returnProof).toBe("explicit_section19_zero");});
 it("accepts raw comma owner display in either direction without changing stored rawname",()=>{for(const name of["Jane Doe","Doe, Jane"]){const x=fixture();x.identity.sourceName=name;const r=verifyArkansasCurrentOriginalCashSource(x);expect(r.proof?.receiver.sourceName).toBe(name);}});
 it("does not expand multi-comma owner formats or drop middle/suffix words",()=>{for(const name of["Doe, Jane, Jr","Jane Other Doe","Janey Doe"]){const x=fixture();x.identity.sourceName=name;expect(verifyArkansasCurrentOriginalCashSource(x).proof).toBeUndefined();}});
 it("retains earlier source cash electionYear inside a verified current candidate cycle",()=>{const x=fixture();x.details[0]!.row.electionYear=2025;(x.details[0]!.row.rawFields as any).electionYear="2025";rehash(x);expect(verifyArkansasCurrentOriginalCashSource(x).proof?.cashRows[0]?.sourceElectionYear).toBe(2025);});
 it.each(["wrong_receiving_request","native_changed","report_changed","partial","duplicate","missing_pdf","wrong_pdf_hash","outside_bracket","boundary","wrong_office","wrong_stamp","wrong_report_label","unchecked_empty","positive_return","missing_return","unknown_source","nonitemized","negative","unsafe_precision","missing_detail","wrong_detail_type","detail_version","same_money_rename","extra_pdf_row"])("preserves all cash for %s",reason=>{
  const x=fixture(),p=x.pdfs[0]!.parsed;
  switch(reason){
   case"wrong_receiving_request":x.nativeAfter.requests[0]!.requestBody={filerRegistrationGuid:REPORT,transactionTypeCode:"TCON"};break;
   case"native_changed":(x.nativeAfter.rows[0]!.rawFields as any).sourceAddress="Different street";rehash(x);break;
   case"report_changed":(x.reportsAfter.rows[0]!.rawFields as any).filePath="Reports\\changed.pdf";rehash(x);break;
   case"partial":x.nativeBefore.totalItems=2;break;
   case"duplicate":for(const c of[x.nativeBefore,x.nativeAfter]){c.rows.push(structuredClone(c.rows[0]!));c.totalItems=2;}rehash(x);break;
   case"missing_pdf":x.pdfs=[];break;
   case"wrong_pdf_hash":p.sha256="b".repeat(64);break;
   case"outside_bracket":x.pdfs[0]!.request.startedAt="2026-10-11T09:00:00Z";break;
   case"boundary":x.windowStart="2026-06-10";break;
   case"wrong_office":p.officeName="State House";break;
   case"wrong_stamp":p.filedAt="2026-07-20T10:00:01";break;
   case"wrong_report_label":p.reportLabel="2026 July Monthly Report - General";break;
   case"unchecked_empty":p.returnedCashCents=null;p.noActivity="unchecked";break;
   case"positive_return":p.returnedCashCents=100;break;
   case"missing_return":p.returnedCashCents=null;break;
   case"unknown_source":bothNative(x,"transactionSource","Future Unknown Class");break;
   case"nonitemized":bothNative(x,"transactionSubTypeDescription","Non-Itemized Monetary");break;
   case"negative":bothNative(x,"transactionAmount",-100);break;
   case"unsafe_precision":bothNative(x,"transactionAmount",100.001);break;
   case"missing_detail":x.details=[];break;
   case"wrong_detail_type":x.details[0]!.row.transactionSourceTypeCode="TBSN";(x.details[0]!.row.rawFields as any).transactionSourceTypeCode="TBSN";rehash(x);break;
   case"detail_version":x.details[0]!.row.transactionVersionId=2;(x.details[0]!.row.rawFields as any).transactionVersionID=2;rehash(x);break;
   case"same_money_rename":bothNative(x,"sourceName","Other PAC");break;
   case"extra_pdf_row":p.cashRows=[...p.cashRows,structuredClone(p.cashRows[0]!)];break;
  }
  expect(verifyArkansasCurrentOriginalCashSource(x).proof).toBeUndefined();expect(verifyArkansasCurrentOriginalCashSource(x).diagnostics.length).toBeGreaterThan(0);
 });
 it("preserves same-dollar donor/address changes even when before/after are stable",()=>{const x=fixture();bothNative(x,"sourceAddress","PO Box 2, Little Rock, AR 72201");expect(verifyArkansasCurrentOriginalCashSource(x).diagnostics[0]).toContain("identity mismatch");});
 it("keeps equal gifts with separate stable GUIDs and current typed IDs",()=>{const x=fixture();const newGuid="44444444-4444-4444-4444-444444444444";for(const c of[x.nativeBefore,x.nativeAfter]){const r=structuredClone(c.rows[0]!);r.guid=newGuid;(r.rawFields as any).guid=newGuid;c.rows.push(r);c.totalItems=2;}const d=structuredClone(x.details[0]!);d.row.guid=newGuid;d.row.transactionId=124;(d.row.rawFields as any).guid=newGuid;(d.row.rawFields as any).transactionID=124;d.request.requestBody={transactionGuid:newGuid};x.details=[...x.details,d];const p=x.pdfs[0]!.parsed;p.currentCashCents=20000;p.cashRows=[...p.cashRows,structuredClone(p.cashRows[0]!)];rehash(x);expect(verifyArkansasCurrentOriginalCashSource(x).proof?.cashRows).toHaveLength(2);});
 it("uses whole cover Line7 across elections instead of election-specific cash totals",()=>{const x=fixture();x.pdfs[0]!.parsed.sectionTotals={"14":0,"16":5000,"17":0,"18":5000};expect(verifyArkansasCurrentOriginalCashSource(x).proof?.monetaryCashCents).toBe(10000);});
 it("requires whole current overlapping reports to preserve rather than choose latest",()=>{const x=fixture();for(const c of[x.reportsBefore,x.reportsAfter]){const r=structuredClone(c.rows[0]!);r.filerReportGuid="55555555-5555-5555-5555-555555555555";(r.rawFields as any).filerReportGuid=r.filerReportGuid;c.rows.push(r);c.totalItems=2;}rehash(x);expect(verifyArkansasCurrentOriginalCashSource(x).diagnostics[0]).toContain("overlapping");});
 it("allows synthetic complete zero only with a current certified report",()=>{const x=fixture();for(const c of[x.nativeBefore,x.nativeAfter]){c.rows=[];c.totalItems=0;}x.details=[];const p=x.pdfs[0]!.parsed;p.currentCashCents=0;p.cashRows=[];p.sectionTotals={"14":0,"17":0};p.returnedCashCents=null;p.noActivity="checked_vector";rehash(x);expect(verifyArkansasCurrentOriginalCashSource(x).proof?.reports[0]?.returnProof).toBe("checked_no_activity_zero");});
});

describe("Arkansas IE whole report before target filtering",()=>{
 it("retains explicit raw cover contradiction with full monetary closure",()=>{const x=fixture(true),r=verifyArkansasCurrentOriginalIeSource(x);expect(r.proof?.expenditureCents).toBe(10000);expect(r.proof?.expenseRows[0]?.purpose).toContain("SUPPORT");expect(r.proof?.coverElectionConflicts[0]?.electionDateRaw).toBe("11/05/2024");});
 it("retains a blank unallocated purpose only for explicit native/detail Bank Fee concordance",()=>{
  for(const comment of [null,"Bank Fee"]){
   const x=fixture(true);x.pdfs[0]!.parsed.expenseRows=[{...x.pdfs[0]!.parsed.expenseRows[0]!,description:""}];
   bothNative(x,"transactionCategory","Other(list)(Bank Fee)");
   x.details[0]!.row.comments=comment;Object.assign(x.details[0]!.row.rawFields,{comments:comment,otherCategory:"Bank Fee"});rehash(x);
   const result=verifyArkansasCurrentOriginalIeSource(x);expect(result.proof?.expenseRows[0]).toMatchObject({purpose:"",nativeCategory:"Other(list)(Bank Fee)",detailOtherCategory:"Bank Fee"});
  }
 });
 it.each(["missing_detail_category","different_native_category","unproved_target_comment"])("preserves whole IE report for blank purpose with %s",reason=>{
  const x=fixture(true);x.pdfs[0]!.parsed.expenseRows=[{...x.pdfs[0]!.parsed.expenseRows[0]!,description:""}];bothNative(x,"transactionCategory","Other(list)(Bank Fee)");
  x.details[0]!.row.comments=null;Object.assign(x.details[0]!.row.rawFields,{comments:null,otherCategory:"Bank Fee"});
  if(reason==="missing_detail_category")delete (x.details[0]!.row.rawFields as any).otherCategory;
  if(reason==="different_native_category")bothNative(x,"transactionCategory","Other(list)(Printing)");
  if(reason==="unproved_target_comment"){x.details[0]!.row.comments="SUPPORT JANE DOE";(x.details[0]!.row.rawFields as any).comments="SUPPORT JANE DOE";}
  rehash(x);expect(verifyArkansasCurrentOriginalIeSource(x).proof).toBeUndefined();
 });
 it("rejects a parsed native category that contradicts its retained raw source category",()=>{
  const x=fixture(true);for(const c of[x.nativeBefore,x.nativeAfter])c.rows[0]!.transactionCategory="Other(list)(Bank Fee)";
  expect(verifyArkansasCurrentOriginalIeSource(x).diagnostics[0]).toContain("DTO/raw identity differs");
 });
 it("rejects a parsed allocation election type that contradicts raw source detail",()=>{
  const x=fixture(true);(x.details[0]!.row.rawFields as any).electionTypeCode="NOELEC";rehash(x);
  expect(verifyArkansasCurrentOriginalIeSource(x).diagnostics[0]).toContain("DTO/raw identity differs");
 });
 it.each(["missing_rowyear","unsupported_type","changed_purpose","missing_fee","same_money_payee","nonitemized"])("preserves report for %s",reason=>{const x=fixture(true);switch(reason){case"missing_rowyear":x.details[0]!.row.electionYear=null;(x.details[0]!.row.rawFields as any).electionYear=null;rehash(x);break;case"unsupported_type":x.details[0]!.row.electionTypeCode="NOELEC";(x.details[0]!.row.rawFields as any).electionTypeCode="NOELEC";rehash(x);break;case"changed_purpose":x.pdfs[0]!.parsed.expenseRows=[{...x.pdfs[0]!.parsed.expenseRows[0]!,description:"PRINTING IN OPPOSITION TO JANE DOE"}];break;case"missing_fee":x.pdfs[0]!.parsed.currentExpenseCents=20000;break;case"same_money_payee":bothNative(x,"sourceName","Different Vendor");break;case"nonitemized":x.pdfs[0]!.parsed.sectionTotals={"20":9000,"21":1000,"22":10000};break;}expect(verifyArkansasCurrentOriginalIeSource(x).proof).toBeUndefined();});
});


describe("Arkansas persisted semantic row fingerprints",()=>{
 it("ignores only top-level transport count while full collection hash changes",()=>{
  const a={rawFields:{guid:ROW,totalRows:1,amount:100,details:{totalRows:1}}};const b=structuredClone(a);b.rawFields.totalRows=2;
  expect(fingerprintArkansasFinancialRawRow(a)).toBe(fingerprintArkansasFinancialRawRow(b));
  expect(fingerprintArkansasVerifiedRawRows([a])).not.toBe(fingerprintArkansasVerifiedRawRows([b]));
  b.rawFields.details.totalRows=2;expect(fingerprintArkansasFinancialRawRow(a)).not.toBe(fingerprintArkansasFinancialRawRow(b));
 });
 it.each(["amount","sourceName","sourceAddress","filedDate","filePath"])("preserves material identity change for %s",field=>{
  const a={rawFields:{guid:ROW,totalRows:1,amount:100,sourceName:"Example PAC",sourceAddress:"PO Box 1",filedDate:"2026-07-20T00:00:00",filePath:"Reports/example.pdf"}};
  const b=structuredClone(a);(b.rawFields as any)[field]="changed";expect(fingerprintArkansasFinancialRawRow(a)).not.toBe(fingerprintArkansasFinancialRawRow(b));
 });
});
