import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MarylandPdfPage } from "../../../src/pipeline/marylandFinance/marylandReportPdfGeometry.js";
const harness=vi.hoisted(()=>({pages:[] as MarylandPdfPage[], bytes:[] as number[], pause:undefined as undefined|(()=>Promise<void>)}));
const controls=vi.hoisted(()=>({expenseControls:[{schedule:"2",column:"Z",printedLabel:"Returned Contribution – Schd 2, Col Z",amountCents:66500}],receiptControls:[],cashSummary:{priorBalanceCents:100000,totalReceiptsCents:0,totalExpendituresCents:66500,cashBalanceCents:33500},equations:{cashBalance:true,expensesSum:true,receiptsSum:true}}));
vi.mock("../../../src/pipeline/marylandFinance/marylandReportPdfGeometry.js",()=>({readMarylandReportPdfGeometry:async(bytes:Uint8Array,onPage:(p:MarylandPdfPage)=>void)=>{if(harness.pause)await harness.pause();harness.bytes=[...bytes];for(const p of harness.pages)await onPage(p);return {sha256:"a".repeat(64),byteCount:bytes.length,pageCount:harness.pages.length,textItemCount:0};}}));
vi.mock("../../../src/pipeline/marylandFinance/marylandLegacyReportFinancialControls.js",()=>({parseMarylandLegacyFinancialControls:()=>structuredClone(controls)}));
import {readMarylandLegacyReturnedContributionFacts,readMarylandLegacyReturnedContributionObservations,compareMarylandLegacyCommitteeReturnOccurrences} from "../../../src/pipeline/marylandFinance/marylandLegacyReturnedContributionFacts.js";
import {buildMarylandPublicReportInventoryRequest} from "../../../src/pipeline/marylandFinance/marylandPublicReportClient.js";

const owner="11111111-1111-4111-8111-111111111111",reportGuid="22222222-2222-4222-8222-222222222222";
const id=(n:number)=>`${String(n).padStart(8,"0")}-3333-4333-8333-333333333333`;
const request=buildMarylandPublicReportInventoryRequest({filerRegistrationGuid:owner,electionCycleId:"12023",pageNumber:1});
const report={reportGuid,reportVersionId:1,reportName:"2023 Annual",reportVersion:"Original" as const,reportVersionCode:"RPTFLD" as const,reportType:"Campaign Finance Report",reportTypeCode:"FPCFR",filingEntityId:1,filerRegistrationGuid:owner,committeeType:"Candidate Committee",committeeTypeCode:"CC",officeSought:"Governor",officeSoughtId:40,jurisdiction:"State",jurisdictionId:1,reportingCycle:"2023-2026",reportingCycleId:12023,reportingYear:2023,startDate:"2023-01-01T00:00:00",endDate:"2023-12-31T00:00:00",dueDate:"2024-01-20T00:00:00",filedDate:"2024-01-18T12:00:00",zeroActivity:false,hasChild:false,childResults:null};
const cell=(text:string,left:number,right:number,baselineTop:number)=>({text,left,right,baselineTop,height:9});
const empty=(pageNumber:number):MarylandPdfPage=>({pageNumber,width:612,height:792,cells:[],borders:[]});
function page():MarylandPdfPage {
 const columns=[17.56,89.31,161.31,305.31,446.627,503.31,593.06];
 return {...empty(3),cells:[cell("Expenditures",267,330,102),cell("Z - Returned Contribution",232,380,115),cell("Date",19.296,40,168),cell("Name and Address of Payee",163.296,290,168),cell("Special",456.12,485,168),cell("Amount",505.296,540,168),cell("06/01/2023",37.224,87.259,202),cell("Example Federal Committee",163.296,300,202),cell("$665.00",550,591,202)],borders:[...columns.map(x=>({x1:x,x2:x,y1:154,y2:230})),{x1:17.56,x2:593.06,y1:154,y2:154},{x1:17.56,x2:593.06,y1:180,y2:180},{x1:17.56,x2:593.06,y1:230,y2:230}]};
}
function ending(pageNumber:number,cents=66500):MarylandPdfPage {
 const top=78.606,bottom=96.356;
 return {...empty(pageNumber),cells:[cell("Total",477.36,501.24,89.448),cell("$"+(cents/100).toFixed(2),550,591,89.448)],borders:[...[17.56,503.31,593.06].map(x=>({x1:x,x2:x,y1:top,y2:bottom})),...[top,bottom].map(y=>({x1:17.56,x2:593.06,y1:y,y2:y}))]};
}

function gift(n=1,extra:Record<string,unknown>={}) {return {filerRegistrationGuid:owner,electionCycleId:12023,transactionId:n,transactionGuid:id(n),isActive:true,isReturn:false,transactionTypeCode:"TCON",contributionTypeCode:"CINKIND",contributorTypeCode:"TFED",contributorName:"Example Federal Committee",contributorFullAddress:"Synthetic native address",transactionAmount:1000,transactionDate:"2023-02-01T00:00:00",reportGuid,reportVersionId:1,transactionVersionID:1,parentTransactionId:null,parentTransactionGuid:null,...extra};}
function refund(n=2,extra:Record<string,unknown>={}) {return gift(n,{isReturn:true,transactionTypeCode:"TRCON",contributionTypeCode:"CMONT",transactionAmount:665,transactionDate:"2023-06-01T00:00:00",parentTransactionId:1,parentTransactionGuid:id(1),...extra});}

function observedContinuation(){
 const columns=[17.56,89.31,161.31,305.31,446.627,503.31,593.06];
 harness.pages=[empty(1),empty(2),page(),{...empty(4),cells:[cell("Unknown payment fragment",91.296,169.088,107.448),cell("06/02/2023",37.224,87.259,125.448),cell("Example Federal Committee",165,300,125.448),cell("$665.00",550,591,125.448)],borders:[...[17.56,161.31,503.31,593.06].map(x=>({x1:x,x2:x,y1:78.61,y2:96.356})),...[17.56,89.31,503.31,593.06].map(x=>({x1:x,x2:x,y1:96.356,y2:114.356})),...columns.map(x=>({x1:x,x2:x,y1:114.356,y2:180})),...[78.61,96.356,114.356,180].map(y=>({x1:17.56,x2:593.06,y1:y,y2:y}))]},ending(5,133000)];
 controls.expenseControls[0]!.amountCents=133000;
 controls.cashSummary.totalExpendituresCents=133000;
 controls.cashSummary.cashBalanceCents=-33000;
}

async function facts(){return readMarylandLegacyReturnedContributionFacts(new Uint8Array([1,2,3]));}
async function compare(extra:Record<string,unknown>={}){const f=await facts();return compareMarylandLegacyCommitteeReturnOccurrences({reports:[report],inventoryRequest:request,currentRows:[gift(),refund()],priorRows:[],pdfReports:[{report,facts:f}],...extra});}
beforeEach(()=>{Object.assign(controls.cashSummary,{totalExpendituresCents:66500,cashBalanceCents:33500});harness.pages=[empty(1),empty(2),page(),ending(4)];harness.pause=undefined;controls.expenseControls[0]!.amountCents=66500;});
describe("legacy whole returned-contribution facts",()=>{
 it("reads every page, retains right-aligned dates, exposes safe ordinary totals",async()=>{const r=await facts();expect(r.sourceFacts).toMatchObject({pageCount:4,returnCount:1,returnCents:66500});expect(JSON.stringify(r.sourceFacts)).not.toContain("Example Federal");expect(Object.isFrozen(r.privateOccurrences)).toBe(true);});
 it("snapshots bytes before await",async()=>{let resume!:()=>void;harness.pause=()=>new Promise<void>(resolve=>resume=resolve);const bytes=new Uint8Array([1,2,3]),pending=readMarylandLegacyReturnedContributionFacts(bytes);bytes.fill(9);resume();await pending;expect(harness.bytes).toEqual([1,2,3]);});
 it.each(["unknown heading","omitted heading","malformed date","omitted date","missing amount","crossed identity","overlapping identity","missing rule","duplicate date"])("holds %s",async kind=>{const p=page();let cells=[...p.cells],borders=[...p.borders];if(kind==="unknown heading")cells[0]={...cells[0]!,text:"Unknown Heading"};if(kind==="omitted heading")cells=cells.filter(c=>c.text!=="Expenditures");if(kind==="malformed date")cells[6]={...cells[6]!,text:"06/40/2023"};if(kind==="omitted date")cells.splice(6,1);if(kind==="missing amount")cells=cells.filter(c=>!c.text.startsWith("$"));if(kind==="crossed identity")cells[7]={...cells[7]!,right:310};if(kind==="overlapping identity")cells.push({...cells[7]!});if(kind==="missing rule")borders=borders.filter(b=>b.x1!==305.31);if(kind==="duplicate date")cells.push({...cells[6]!});harness.pages[2]={...p,cells,borders};await expect(facts()).rejects.toThrow();});
 it("holds missing following-page proof",async()=>{harness.pages.pop();await expect(facts()).rejects.toThrow("continuation");});
 it("holds following-page identity continuation",async()=>{harness.pages[3]={...empty(4),cells:[cell("Synthetic continuation",165,280,90)],borders:[...[17.56,161.31,305.31].map(x=>({x1:x,x2:x,y1:78.61,y2:100})),{x1:17.56,x2:593.06,y1:78.61,y2:78.61},{x1:17.56,x2:593.06,y1:100,y2:100}]};await expect(facts()).rejects.toThrow("continuation");});
 it("holds section-control mismatch",async()=>{controls.expenseControls[0]!.amountCents=66000;await expect(facts()).rejects.toThrow("control");});
 it("requires consecutive complete pages",async()=>{harness.pages[3]=empty(5);await expect(facts()).rejects.toThrow("geometry");});
});
describe("legacy committee economic occurrence comparison",()=>{
 it("proves reported cash outflow while preserving original in-kind role",async()=>{const r=await compare();expect(r.sourceFacts).toMatchObject({nativeReturns:1,pdfReturns:1,eligibleReturns:1,eligibleReturnCents:66500});expect(r.privateBoundReturns[0]).toMatchObject({originalClass:"TFED",originalKind:"CINKIND",documentFamily:"cash_outflow",refundCents:66500});expect(JSON.stringify(r.sourceFacts)).not.toContain(owner);});
 it.each(["TCC","TFED","TPAC","TPCC","TPOC","TRNFC","TUNFC","TSLATE","TPCLB"])("recognizes original explicit %s class",async contributorTypeCode=>{const r=await compare({currentRows:[gift(1,{contributorTypeCode}),refund(2,{contributorTypeCode:"TPOC"})]});expect(r.sourceFacts.eligibleReturns).toBe(1);expect(r.privateBoundReturns[0]!.originalClass).toBe(contributorTypeCode);});
 it("uses prior originals without inventing prior report-period authority",async()=>{const r=await compare({currentRows:[refund()],priorRows:[gift(1,{electionCycleId:12019,reportGuid:undefined,reportVersionId:undefined})]});expect(r.sourceFacts.eligibleReturns).toBe(1);});
 it.each([{parentTransactionGuid:id(9)},{parentTransactionId:99},{contributorName:"Different Example"},{transactionDate:"2023-01-01T00:00:00"}])("holds parent identity/order conflict",async change=>{await expect(compare({currentRows:[gift(),refund(2,change)]})).rejects.toThrow();});
 it("holds lifetime refunds above original across prior/current collections",async()=>{await expect(compare({currentRows:[gift(),refund()],priorRows:[refund(3,{electionCycleId:12019,transactionAmount:400,transactionDate:"2023-03-01T00:00:00"})]})).rejects.toThrow("over_refund");});
 it("holds eligible cohort ambiguity",async()=>{const f=await facts();const a={...f,sourceFacts:{...f.sourceFacts,returnCount:2,returnCents:133000,controls:{...f.sourceFacts.controls,expenseControls:[{...f.sourceFacts.controls.expenseControls[0]!,amountCents:133000}]}},privateOccurrences:[...f.privateOccurrences,{...f.privateOccurrences[0]!,ordinal:1}]};expect(()=>compareMarylandLegacyCommitteeReturnOccurrences({reports:[report],inventoryRequest:request,currentRows:[gift(),refund(),refund(3)],priorRows:[],pdfReports:[{report,facts:a}]})).toThrow();});
 it("holds omitted whole occurrence, duplicate physical row and altered name",async()=>{const f=await facts();for(const altered of [{...f,privateOccurrences:[]},{...f,privateOccurrences:[{...f.privateOccurrences[0]!,nameAddress:"Different Example"}]},{...f,privateOccurrences:[...f.privateOccurrences,...f.privateOccurrences]}])expect(()=>compareMarylandLegacyCommitteeReturnOccurrences({reports:[report],inventoryRequest:request,currentRows:[gift(),refund()],priorRows:[],pdfReports:[{report,facts:altered}]})).toThrow();});
 it("holds a printed conflicting eligible address",async()=>{const f=await facts(),altered={...f,privateOccurrences:[{...f.privateOccurrences[0]!,nameAddress:"Example Federal Committee Different printed address"}]};expect(()=>compareMarylandLegacyCommitteeReturnOccurrences({reports:[report],inventoryRequest:request,currentRows:[gift(),refund()],priorRows:[],pdfReports:[{report,facts:altered}]})).toThrow("identity");});
 it("holds current report-period mismatch and duplicate native identity",async()=>{await expect(compare({currentRows:[gift(),refund(2,{transactionDate:"2024-01-01T00:00:00"})]})).rejects.toThrow();await expect(compare({currentRows:[gift(),refund(),refund()]})).rejects.toThrow("duplicate");});

  it("retains duplicate noneligible whole cohorts with exact multiplicity",async()=>{
    const f=await facts(),second={...f.privateOccurrences[0]!,ordinal:1,rowTop:230,rowBottom:280};
    const controls2={...f.sourceFacts.controls,expenseControls:[{...f.sourceFacts.controls.expenseControls[0]!,amountCents:133000}],cashSummary:{...f.sourceFacts.controls.cashSummary,totalExpendituresCents:133000,cashBalanceCents:-33000}};
    const doubled={...f,privateScheduleTotal:{...f.privateScheduleTotal!,amountCents:133000},sourceFacts:{...f.sourceFacts,scheduleTotalCents:133000,returnCount:2,returnCents:133000,controls:controls2},privateOccurrences:[...f.privateOccurrences,second]};
    const r=compareMarylandLegacyCommitteeReturnOccurrences({reports:[report],inventoryRequest:request,currentRows:[gift(1,{contributorTypeCode:"TIND",transactionAmount:2000}),refund(),refund(3)],priorRows:[],pdfReports:[{report,facts:doubled}]});
    expect(r.sourceFacts).toMatchObject({nativeReturns:2,pdfReturns:2,eligibleReturns:0,returnCents:133000});
  });
  it("requires the complete noneligible contact field in a mixed eligible fiscal cohort",async()=>{
    const f=await facts();
    const controls2={...f.sourceFacts.controls,expenseControls:[{...f.sourceFacts.controls.expenseControls[0]!,amountCents:133000}],cashSummary:{...f.sourceFacts.controls.cashSummary,totalExpendituresCents:133000,cashBalanceCents:-33000}};
    const source=(nameAddress:string)=>({...f,privateScheduleTotal:{...f.privateScheduleTotal!,amountCents:133000},sourceFacts:{...f.sourceFacts,scheduleTotalCents:133000,returnCount:2,returnCents:133000,controls:controls2},privateOccurrences:[...f.privateOccurrences,{...f.privateOccurrences[0]!,ordinal:1,rowTop:230,rowBottom:280,nameAddress}]});
    const other={contributorName:"Other Example",contributorTypeCode:"TIND",contributorAddressLine1:"100 Example Road",contributorFullAddress:"100 Example Road Syntheticville MD 00000"};
    const input={reports:[report],inventoryRequest:request,currentRows:[gift(),refund(),gift(4,other),refund(3,{...other,parentTransactionId:4,parentTransactionGuid:id(4)})],priorRows:[]};
    expect(compareMarylandLegacyCommitteeReturnOccurrences({...input,pdfReports:[{report,facts:source("Other Example 100 Example Road Syntheticville MD 00000")}]}).sourceFacts).toMatchObject({eligibleReturns:1,noneligibleUnknownIdentityOccurrences:0});
    for(const printed of ["Other Example 100 Example Road Conflicting locality","Other Example 100 Example Road","Other Example 100 Example Road Syntheticville MD 00000 Extra suffix"])
      expect(()=>compareMarylandLegacyCommitteeReturnOccurrences({...input,pdfReports:[{report,facts:source(printed)}]})).toThrow("identity");
  });
  it("preserves native historical edition alongside the canonical PDF report",async()=>{
    const f=await facts(),amended={...report,reportVersionId:2,reportVersion:"Amended" as const,reportVersionCode:"RPTAMD" as const,hasChild:true,childResults:[1,2].map(v=>({filerReportGuid:reportGuid,filerReportVersionID:v,totalRows:2,reportName:report.reportName,reportType:"Disclosure Report",startDate:report.startDate,endDate:report.endDate,dueDate:report.dueDate,filedDate:report.filedDate,isCompleted:true,generateStatus:"Complete",generateStatusCode:"CMP",reportStatus:"Filed",isPaperFile:false}))};
    const r=compareMarylandLegacyCommitteeReturnOccurrences({reports:[amended],inventoryRequest:request,currentRows:[gift(),refund()],priorRows:[],pdfReports:[{report:amended,facts:f}]});
    expect(r.privateBoundReturns[0]).toMatchObject({reportVersionId:2,nativeReportVersionId:1,nativeReportGuid:reportGuid});
  });
  it("holds unruled text-only following pages and damaged continuation borders",async()=>{
    for(const borders of [[],[{x1:17.56,x2:17.56,y1:78.61,y2:100},{x1:161.31,x2:161.31,y1:78.61,y2:100}]]){
      harness.pages[3]={...empty(4),cells:[cell("Unknown identity fragment",165,280,90)],borders};
      await expect(facts()).rejects.toThrow("continuation");
    }
  });
  it("holds apparent money in a partial return row even with unchanged control totals",async()=>{
    const p=page(),columns=[17.56,89.31,161.31,446.627,503.31,593.06];
    harness.pages[2]={...p,cells:[...p.cells,cell("Malformed",37,85,260),cell("Unknown fragment",165,280,260),cell("$9.00",550,591,260)],borders:[...p.borders,...columns.map(x=>({x1:x,x2:x,y1:230,y2:280})),{x1:17.56,x2:593.06,y1:280,y2:280}]};
    await expect(facts()).rejects.toThrow("border");
  });
  it("does not trust caller-mutated cash equations",async()=>{
    const f=await facts(),altered={...f,sourceFacts:{...f.sourceFacts,controls:{...f.sourceFacts.controls,cashSummary:{...f.sourceFacts.controls.cashSummary,totalExpendituresCents:1}}}};
    expect(()=>compareMarylandLegacyCommitteeReturnOccurrences({reports:[report],inventoryRequest:request,currentRows:[gift(),refund()],priorRows:[],pdfReports:[{report,facts:altered}]})).toThrow("control");
  });

  it("keeps strict unknown holds while observing complete physical nonfinancial strips",async()=>{
    observedContinuation();
    await expect(facts()).rejects.toThrow("continuation");
    const f=await readMarylandLegacyReturnedContributionObservations(new Uint8Array([1,2,3]));
    expect(f.sourceFacts.unknownContinuationCount).toBe(1);
    expect(f.privateOccurrences[0]!.followingPageIdentityCells).toBe(1);
    expect(f.privateUnknownContinuations[0]).toMatchObject({predecessorPageNumber:3,predecessorOrdinal:0,pageNumber:4});
  });
  it("isolates only an entire known noneligible fiscal cohort",async()=>{
    observedContinuation();
    const f=await readMarylandLegacyReturnedContributionObservations(new Uint8Array([1,2,3]));
    const input={reports:[report],inventoryRequest:request,currentRows:[gift(1,{contributorTypeCode:"TIND",transactionAmount:2000}),refund(),refund(3,{transactionDate:"2023-06-02T00:00:00"})],priorRows:[],pdfReports:[{report,facts:f}]};
    expect(compareMarylandLegacyCommitteeReturnOccurrences(input).sourceFacts).toMatchObject({eligibleReturns:0,noneligibleUnknownIdentityOccurrences:1,nativeReturns:2});
    expect(()=>compareMarylandLegacyCommitteeReturnOccurrences({...input,currentRows:[gift(1,{transactionAmount:2000}),refund(),refund(3,{transactionDate:"2023-06-02T00:00:00"})]})).toThrow("continuation");
  });
  it("holds a mixed eligible fiscal cohort even when the uncertain printed name is noneligible",async()=>{
    observedContinuation();
    const f=await readMarylandLegacyReturnedContributionObservations(new Uint8Array([1,2,3]));
    const altered={...f,privateOccurrences:[f.privateOccurrences[0]!,{...f.privateOccurrences[1]!,date:"2023-06-01",nameAddress:"Other Example Committee"}]};
    expect(()=>compareMarylandLegacyCommitteeReturnOccurrences({reports:[report],inventoryRequest:request,currentRows:[gift(1,{contributorTypeCode:"TIND",transactionAmount:2000}),gift(4,{contributorName:"Other Example Committee"}),refund(),refund(3,{contributorName:"Other Example Committee",parentTransactionId:4,parentTransactionGuid:id(4)})],priorRows:[],pdfReports:[{report,facts:altered}]})).toThrow("continuation");
  });
  it("holds absent, duplicated and malformed private continuation ownership",async()=>{
    observedContinuation();
    const f=await readMarylandLegacyReturnedContributionObservations(new Uint8Array([1,2,3]));
    for(const unknowns of [[],[...f.privateUnknownContinuations,...f.privateUnknownContinuations],[{...f.privateUnknownContinuations[0]!,predecessorOrdinal:99}],[{...f.privateUnknownContinuations[0]!,cells:[{...f.privateUnknownContinuations[0]!.cells[0]!,text:"$1.00"}]}]]){
      const altered={...f,sourceFacts:{...f.sourceFacts,unknownContinuationCount:unknowns.length},privateUnknownContinuations:unknowns};
      expect(()=>compareMarylandLegacyCommitteeReturnOccurrences({reports:[report],inventoryRequest:request,currentRows:[gift(1,{contributorTypeCode:"TIND",transactionAmount:2000}),refund(),refund(3,{transactionDate:"2023-06-02T00:00:00"})],priorRows:[],pdfReports:[{report,facts:altered}]})).toThrow("continuation");
    }
  });
  it("does not observe financial or damaged continuation strips",async()=>{
    for(const variant of ["money","border","unruled"]){
      observedContinuation();
      const p=harness.pages[3]!;
      harness.pages[3]=variant==="money"?{...p,cells:p.cells.map(c=>c.left===91.296?{...c,text:"$1.00"}:c)}:variant==="border"?{...p,borders:p.borders.filter(b=>b.x1!==305.31)}:{...empty(4),cells:[cell("Unknown identity",165,280,90)]};
      await expect(readMarylandLegacyReturnedContributionObservations(new Uint8Array([1,2,3]))).rejects.toThrow();
    }
  });

  it.each(["9.00","1/1/2023","1-1-23","$1.00"])("holds apparent financial ambiguity %s in both normal observation and comparison",async text=>{
    observedContinuation();
    const f=await readMarylandLegacyReturnedContributionObservations(new Uint8Array([1,2,3]));
    const unknown={...f.privateUnknownContinuations[0]!,cells:[{...f.privateUnknownContinuations[0]!.cells[0]!,text}]};
    expect(()=>compareMarylandLegacyCommitteeReturnOccurrences({reports:[report],inventoryRequest:request,currentRows:[gift(1,{contributorTypeCode:"TIND",transactionAmount:2000}),refund(),refund(3,{transactionDate:"2023-06-02T00:00:00"})],priorRows:[],pdfReports:[{report,facts:{...f,privateUnknownContinuations:[unknown]}}]})).toThrow("continuation");
    const p=harness.pages[3]!;harness.pages[3]={...p,cells:p.cells.map(c=>c.left===91.296?{...c,text}:c)};
    await expect(readMarylandLegacyReturnedContributionObservations(new Uint8Array([1,2,3]))).rejects.toThrow("continuation");
  });
  it("reconciles only the exact painted source Total footer",async()=>{
    const p=page();harness.pages[2]={...p,cells:[...p.cells,cell("Total",477.36,501.24,241.1),cell("$665.00",550,591,241.1)],borders:[...p.borders,...[17.56,503.31,593.06].map(x=>({x1:x,x2:x,y1:230,y2:247.75})),{x1:17.56,x2:593.06,y1:247.75,y2:247.75}]};
    harness.pages[3]=empty(4);
    expect((await facts()).sourceFacts.scheduleTotalCents).toBe(66500);
    const footer=harness.pages[2]!;harness.pages[2]={...footer,cells:footer.cells.map(c=>c.baselineTop===241.1&&c.text.startsWith("$")?{...c,text:"$660.00"}:c)};
    await expect(facts()).rejects.toThrow("control");
  });

  it("does not use a late Amendment Summary caption as identity absence proof",async()=>{
    harness.pages[3]={...empty(4),cells:[cell("Unknown continuation",165,280,140),cell("Amendment Summary",66.168,170,510.72)]};
    await expect(facts()).rejects.toThrow("continuation");
    await expect(readMarylandLegacyReturnedContributionObservations(new Uint8Array([1,2,3]))).rejects.toThrow("continuation");
  });
  it("retains the entire multiplicity of identity-held noneligible fiscal cohorts",async()=>{
    const f=await facts();
    const doubled={...f,privateScheduleTotal:{...f.privateScheduleTotal!,amountCents:133000},sourceFacts:{...f.sourceFacts,scheduleTotalCents:133000,returnCount:2,returnCents:133000,controls:{...f.sourceFacts.controls,expenseControls:[{...f.sourceFacts.controls.expenseControls[0]!,amountCents:133000}],cashSummary:{...f.sourceFacts.controls.cashSummary,totalExpendituresCents:133000,cashBalanceCents:-33000}}},privateOccurrences:[{...f.privateOccurrences[0]!,nameAddress:"Unresolved source identity"},{...f.privateOccurrences[0]!,ordinal:1,rowTop:230,rowBottom:280}]};
    const input={reports:[report],inventoryRequest:request,currentRows:[gift(1,{contributorTypeCode:"TIND",transactionAmount:2000}),refund(),refund(3)],priorRows:[],pdfReports:[{report,facts:doubled}]};
    expect(compareMarylandLegacyCommitteeReturnOccurrences(input).sourceFacts).toMatchObject({noneligibleUnknownIdentityOccurrences:2,eligibleReturns:0,nativeReturns:2,pdfReturns:2});
    expect(()=>compareMarylandLegacyCommitteeReturnOccurrences({...input,currentRows:[gift(1,{contributorTypeCode:"TIND",transactionAmount:2000}),gift(4),refund(),refund(3,{parentTransactionId:4,parentTransactionGuid:id(4)})]})).toThrow("identity");
  });

  it("observes only the exact same-page merged pair between two physical financial rows",async()=>{
    const p=page(),cols=[17.56,89.31,161.31,305.31,446.627,503.31,593.06];
    harness.pages=[empty(1),empty(2),{...p,cells:[...p.cells,cell("Unknown merged field",19.296,123.2,241),cell("Unknown wide field",91.296,169.088,259),cell("06/02/2023",37.224,87.259,277),cell("Example Federal Committee",165,300,277),cell("$665.00",550,591,277)],borders:[...p.borders,...[17.56,161.31,503.31,593.06].map(x=>({x1:x,x2:x,y1:230,y2:248})),...[17.56,89.31,503.31,593.06].map(x=>({x1:x,x2:x,y1:248,y2:266})),...cols.map(x=>({x1:x,x2:x,y1:266,y2:326})),...[248,266,326].map(y=>({x1:17.56,x2:593.06,y1:y,y2:y}))]},ending(4,133000)];
    controls.expenseControls[0]!.amountCents=133000;controls.cashSummary.totalExpendituresCents=133000;controls.cashSummary.cashBalanceCents=-33000;
    await expect(facts()).rejects.toThrow("continuation");
    const f=await readMarylandLegacyReturnedContributionObservations(new Uint8Array([1,2,3]));
    expect(f.privateUnknownContinuations[0]).toMatchObject({predecessorPageNumber:3,pageNumber:3,predecessorOrdinal:0});
    const input={reports:[report],inventoryRequest:request,currentRows:[gift(1,{contributorTypeCode:"TIND",transactionAmount:2000}),refund(),refund(3,{transactionDate:"2023-06-02T00:00:00"})],priorRows:[],pdfReports:[{report,facts:f}]};
    expect(compareMarylandLegacyCommitteeReturnOccurrences(input).sourceFacts.noneligibleUnknownIdentityOccurrences).toBe(1);
    for(const change of [{rowBottom:229},{rowTop:181}]){
      const altered={...f,privateOccurrences:[{...f.privateOccurrences[0]!,...change},f.privateOccurrences[1]!]};
      if("rowBottom"in change)expect(()=>compareMarylandLegacyCommitteeReturnOccurrences({...input,pdfReports:[{report,facts:altered}]})).toThrow("continuation");
    }
    const badNext={...f,privateOccurrences:[f.privateOccurrences[0]!,{...f.privateOccurrences[1]!,rowTop:267}]};
    expect(()=>compareMarylandLegacyCommitteeReturnOccurrences({...input,pdfReports:[{report,facts:badNext}]})).toThrow("continuation");
  });

  it.each(["samepage","nextpage"])("binds an observed merged tail to the exact reconciled Total on %s",async mode=>{
    const start=mode==="samepage"?230:78.61,middle=start+18,end=middle+18,footerBottom=end+17.75;
    const tail={...empty(mode==="samepage"?3:4),cells:[cell("Unknown merged field",19.296,123.2,start+11),cell("Unknown wide field",91.296,169.088,middle+11),cell("Total",477.36,501.24,end+11),cell("$665.00",550,591,end+11)],borders:[...[17.56,161.31,503.31,593.06].map(x=>({x1:x,x2:x,y1:start,y2:middle})),...[17.56,89.31,503.31,593.06].map(x=>({x1:x,x2:x,y1:middle,y2:end})),...[17.56,503.31,593.06].map(x=>({x1:x,x2:x,y1:end,y2:footerBottom})),...[start,middle,end,footerBottom].map(y=>({x1:17.56,x2:593.06,y1:y,y2:y}))]};
    const p=page();harness.pages=mode==="samepage"?[empty(1),empty(2),{...p,cells:[...p.cells,...tail.cells],borders:[...p.borders,...tail.borders]}]:[empty(1),empty(2),p,tail];
    await expect(facts()).rejects.toThrow("continuation");
    const f=await readMarylandLegacyReturnedContributionObservations(new Uint8Array([1,2,3]));
    expect(f.sourceFacts).toMatchObject({returnCount:1,scheduleTotalCents:66500,unknownContinuationCount:1});
    const input={reports:[report],inventoryRequest:request,currentRows:[gift(1,{contributorTypeCode:"TIND"}),refund()],priorRows:[],pdfReports:[{report,facts:f}]};
    expect(compareMarylandLegacyCommitteeReturnOccurrences(input).sourceFacts.noneligibleUnknownIdentityOccurrences).toBe(1);
    const altered={...f,privateScheduleTotal:{...f.privateScheduleTotal!,top:f.privateScheduleTotal!.top+1}};
    expect(()=>compareMarylandLegacyCommitteeReturnOccurrences({...input,pdfReports:[{report,facts:altered}]})).toThrow("continuation");
    expect(()=>compareMarylandLegacyCommitteeReturnOccurrences({...input,currentRows:[gift(),refund()]})).toThrow("continuation");
  });
  it.each(["row","footer"])("retains a page-tail pair only through the immediate nextpage first %s boundary",async mode=>{
    const p=page(),cols=[17.56,89.31,161.31,305.31,446.627,503.31,593.06];
    const tail={...p,cells:[...p.cells,cell("Unknown merged field",19.296,123.2,241),cell("Unknown wide field",91.296,169.088,259)],borders:[...p.borders,...[17.56,161.31,503.31,593.06].map(x=>({x1:x,x2:x,y1:230,y2:248})),...[17.56,89.31,503.31,593.06].map(x=>({x1:x,x2:x,y1:248,y2:266})),...[248,266].map(y=>({x1:17.56,x2:593.06,y1:y,y2:y}))]};
    const next={...empty(4),cells:mode==="row"?[cell("06/02/2023",37.224,87.259,125),cell("Example Federal Committee",165,300,125),cell("$665.00",550,591,125)]:[cell("Total",477.36,501.24,125),cell("$665.00",550,591,125)],borders:[...[17.56,593.06].map(x=>({x1:x,x2:x,y1:78.606,y2:114})),...(mode==="row"?cols:[17.56,503.31,593.06]).map(x=>({x1:x,x2:x,y1:114,y2:150})),...[78.606,114,150].map(y=>({x1:17.56,x2:593.06,y1:y,y2:y}))]};
    harness.pages=[empty(1),empty(2),tail,next,mode==="row"?ending(5,133000):empty(5)];
    if(mode==="row"){controls.expenseControls[0]!.amountCents=133000;controls.cashSummary.totalExpendituresCents=133000;controls.cashSummary.cashBalanceCents=-33000;}
    await expect(facts()).rejects.toThrow("continuation");
    const f=await readMarylandLegacyReturnedContributionObservations(new Uint8Array([1,2,3]));
    expect(f.privateUnknownContinuations[0]).toMatchObject({pageNumber:3,followingPageNumber:4,followingTop:114,ledgerBottom:266,followingPrefix:{top:78.606,bottom:114,cells:[]}});
    const input={reports:[report],inventoryRequest:request,currentRows:[gift(1,{contributorTypeCode:"TIND",transactionAmount:2000}),refund(),...(mode==="row"?[refund(3,{transactionDate:"2023-06-02T00:00:00"})]:[])],priorRows:[],pdfReports:[{report,facts:f}]};
    expect(compareMarylandLegacyCommitteeReturnOccurrences(input).sourceFacts.noneligibleUnknownIdentityOccurrences).toBe(1);
    const unknown=f.privateUnknownContinuations[0]!;
    for(const change of [{followingPageNumber:5},{ledgerBottom:267},{followingPrefix:{...unknown.followingPrefix!,cells:[cell("Unclassified prefix",165,280,100)]}},{followingPrefix:{...unknown.followingPrefix!,borders:[]}}]){
      expect(()=>compareMarylandLegacyCommitteeReturnOccurrences({...input,pdfReports:[{report,facts:{...f,privateUnknownContinuations:[{...unknown,...change}]}}]})).toThrow("continuation");
    }
    harness.pages[3]={...next,cells:[...next.cells,cell("Unclassified leading text",165,280,100)]};
    await expect(readMarylandLegacyReturnedContributionObservations(new Uint8Array([1,2,3]))).rejects.toThrow("continuation");
    harness.pages=[empty(1),empty(2),tail];
    await expect(readMarylandLegacyReturnedContributionObservations(new Uint8Array([1,2,3]))).rejects.toThrow("continuation");
  });

  it.each(["samepage","nextpage","splitpair","tailpair"])("classifies only the exact printed Expenditure Purpose block on %s",async mode=>{
    const cols=[17.56,89.31,161.31,305.31,446.627,503.31,593.06];
    const rule=(xs:number[],top:number,bottom:number)=>xs.map(x=>({x1:x,x2:x,y1:top,y2:bottom}));
    const lines=(ys:number[])=>ys.map(y=>({x1:17.56,x2:593.06,y1:y,y2:y}));
    const p=page();let a={...p,cells:[...p.cells],borders:[...p.borders]},b={...empty(4),cells:[] as ReturnType<typeof cell>[],borders:[] as MarylandPdfPage["borders"][number][]};
    const labelTop=mode==="nextpage"?78.606:230,labelBottom=labelTop+18;
    const labelPage=mode==="nextpage"?b:a;
    labelPage.cells.push(cell("Expenditure Purpose:",19.296,123.2,labelTop+11));labelPage.borders.push(...rule([17.56,161.31,503.31,593.06],labelTop,labelBottom),...lines([labelTop,labelBottom]));
    const valueTop=mode==="splitpair"?78.606:labelBottom,valueBottom=valueTop+18;
    const valuePage=mode==="splitpair"?b:labelPage;
    valuePage.cells.push(cell("Synthetic purpose value",91.296,210,valueTop+11));valuePage.borders.push(...rule([17.56,89.31,503.31,593.06],valueTop,valueBottom),...lines([valueTop,valueBottom]));
    const rowTop=mode==="tailpair"?114:valueBottom,rowPage=mode==="tailpair"?b:valuePage;
    if(mode==="tailpair")b.borders.push(...rule([17.56,593.06],78.606,114),...lines([78.606,114]));
    rowPage.cells.push(cell("06/02/2023",37.224,87.259,rowTop+11),cell("Example Federal Committee",165,300,rowTop+11),cell("$665.00",550,591,rowTop+11));rowPage.borders.push(...rule(cols,rowTop,rowTop+60),...lines([rowTop,rowTop+60]));
    harness.pages=[empty(1),empty(2),a,mode==="samepage"?ending(4,133000):b,mode==="samepage"?empty(5):ending(5,133000)];controls.expenseControls[0]!.amountCents=133000;controls.cashSummary.totalExpendituresCents=133000;controls.cashSummary.cashBalanceCents=-33000;
    const f=await facts();expect(f.sourceFacts).toMatchObject({returnCount:2,purposeContinuationCount:1,unknownContinuationCount:0});
    const input={reports:[report],inventoryRequest:request,currentRows:[gift(1,{transactionAmount:2000}),refund(),refund(3,{transactionDate:"2023-06-02T00:00:00"})],priorRows:[],pdfReports:[{report,facts:f}]};
    expect(compareMarylandLegacyCommitteeReturnOccurrences(input).sourceFacts).toMatchObject({eligibleReturns:2,noneligibleUnknownIdentityOccurrences:0});
    const purpose=f.privatePurposeContinuations[0]!;
    const purposeValue=purpose.cells.find(c=>c.text==="Synthetic purpose value")!;
    for(const text of ["Expenditure Purpose:","$9.00","1/1/2023"]){
      const altered={...f,privatePurposeContinuations:[{...purpose,cells:purpose.cells.map(c=>c===purposeValue?{...c,text}:c)}]};
      expect(()=>compareMarylandLegacyCommitteeReturnOccurrences({...input,pdfReports:[{report,facts:altered}]})).toThrow("continuation");
      const original=valuePage.cells.find(c=>c.text==="Synthetic purpose value")!;
      const index=valuePage.cells.indexOf(original);valuePage.cells[index]={...original,text};await expect(facts()).rejects.toThrow("continuation");valuePage.cells[index]=original;
    }
    for(const change of [{cells:purpose.cells.map(c=>c.text==="Expenditure Purpose:"?{...c,text:"Unknown source label"}:c)},{strips:purpose.strips.map((strip,j)=>j===1?{...strip,borders:[]}:strip)},{strips:purpose.strips.map((strip,j)=>j===1?{...strip,pageNumber:99}:strip)}]){
      expect(()=>compareMarylandLegacyCommitteeReturnOccurrences({...input,pdfReports:[{report,facts:{...f,privatePurposeContinuations:[{...purpose,...change}]}}]})).toThrow("continuation");
    }
    labelPage.cells[labelPage.cells.findIndex(c=>c.text==="Expenditure Purpose:")]={...labelPage.cells.find(c=>c.text==="Expenditure Purpose:")!,text:"Unknown source label"};
    await expect(facts()).rejects.toThrow("continuation");
    if(mode==="splitpair"){
      labelPage.cells[labelPage.cells.findIndex(c=>c.text==="Unknown source label")]={...labelPage.cells.find(c=>c.text==="Unknown source label")!,text:"Expenditure Purpose:"};
      b.cells.push(cell("Unclassified leading cell",165,280,77));await expect(facts()).rejects.toThrow("continuation");
    }
  });

  it("requires the exact reconciled source Total even when a blank page and cash controls agree",async()=>{
    harness.pages[3]=empty(4);await expect(facts()).rejects.toThrow("control");
    harness.pages[3]=ending(4);const f=await facts();
    for(const altered of [{...f,privateScheduleTotal:null},{...f,sourceFacts:{...f.sourceFacts,scheduleTotalCents:null}}])expect(()=>compareMarylandLegacyCommitteeReturnOccurrences({reports:[report],inventoryRequest:request,currentRows:[gift(),refund()],priorRows:[],pdfReports:[{report,facts:altered}]})).toThrow("control");
  });

});
