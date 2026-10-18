import { describe,expect,it } from "vitest";
import { aggregateMontanaReportedCommitteeReceipts as aggregate,mtCommitteeCents,selectMontanaCommitteeReceiptReports } from "../../../src/pipeline/montanaFinance/montanaReportedCommitteeSource.js";

const scope={nativeCandidateId:100,electionYear:2026},date=Date.UTC(2026,2,5),label="Independent Committee Contributions";
const table=(rows:unknown[],count=rows.length)=>({aaData:rows,iTotalRecords:count,iTotalDisplayRecords:count});
const report=(id=10,extra={})=>({reportId:id,entitySubId:100,formTypeCode:"C5",statusCode:"FILED",fromDateStr:"01/01/2026",toDateStr:"03/15/2026",receivedDate:Date.UTC(2026,2,20),amendedDate:null,primCashBeg:0,genCashBeg:0,...extra});
const detail=(amount=100,extra={})=>({entityName:"Synthetic PAC",cashAmt:amount,inKindAmt:0,totalAmt:amount,debtAmt:0,amountTypeDescr:"Primary",datePaid:date,lineItemCompositeDescr:label,...extra});
const transaction=(id=1,amount=100,extra={})=>({...detail(amount),transId:id,reportId:10,transTypeDesr:label,transTypeCode:"5",lineItemCompositeCode:"5,C5,A",previousTransactionInd:"N",entIdFrom:200,committeeTypeCode:"PA",
  entityDTO:{entId:200,entityName:"Synthetic PAC",entityTypeCode:"CM",committeeId:null,committeeTypeCode:null},...extra});
function input(rows=[transaction()],details=rows.map(r=>detail(r.totalAmt,{cashAmt:r.cashAmt,inKindAmt:r.inKindAmt,amountTypeDescr:r.amountTypeDescr,datePaid:r.datePaid,lineItemCompositeDescr:r.lineItemCompositeDescr,entityName:r.entityDTO.entityName}))){
  return {scope,inventory:table([report()]),details:[{reportId:10,rows:details}],pages:[{start:0,body:table(rows)}],resultCount:rows.length};
}
describe("Montana native committee receipt source",()=>{
  it("uses explicit committee types and reported source entities without inventing legal registrations",()=>{
    expect(aggregate(input())).toMatchObject({totalCents:10000,receivingRows:1,selectedRows:1,groups:[{key:"entity:200",name:"Synthetic PAC",sourceEntityId:200,cents:10000,rowCount:1,committeeTypes:["PA"]}]});
  });
  it("preserves identical occurrences with distinct native transaction IDs",()=>{
    expect(aggregate(input([transaction(1),transaction(2)]))).toMatchObject({totalCents:20000,selectedRows:2,groups:[{rowCount:2}]});
  });
  it("includes party and incidental contributions as reported committees",()=>{
    const party=transaction(1,100,{transTypeDesr:"Political Party Committee Contributions",lineItemCompositeDescr:"Political Party Committee Contributions",transTypeCode:"6",lineItemCompositeCode:"6,C5,A",committeeTypeCode:"PP"});
    const incidental=transaction(2,50,{entIdFrom:201,entityDTO:{entId:201,entityName:"Synthetic Association",entityTypeCode:"CM",committeeId:null,committeeTypeCode:null},committeeTypeCode:"IN",transTypeDesr:"Incidental Committee Contributions",lineItemCompositeDescr:"Incidental Committee Contributions",transTypeCode:"7",lineItemCompositeCode:"7,C5,A"});
    const result=aggregate(input([party,incidental]));expect(result.totalCents).toBe(15000);expect(result.groups).toHaveLength(2);
  });
  it("reconciles cash and in-kind on both election sides",()=>{
    const rows=[transaction(1,125,{cashAmt:100,inKindAmt:25}),transaction(2,50,{amountTypeDescr:"General"})];expect(aggregate(input(rows))).toMatchObject({totalCents:17500,reports:[{cashCents:15000,inKindCents:2500,totalCents:17500}]});
  });
  it("accepts native null non-applicable search debt while keeping principal and report money strict",()=>{
    expect(aggregate(input([transaction(1,100,{debtAmt:null})])).totalCents).toBe(10000);
    expect(()=>aggregate(input([transaction(1,100,{cashAmt:null})]))).toThrow();
    expect(()=>aggregate(input([transaction()],[detail(100,{debtAmt:null})]))).toThrow();
  });
  it("retains signed corrections and exact cancellations",()=>{
    const a=aggregate(input([transaction(1,100),transaction(2,-25)]));expect(a).toMatchObject({totalCents:7500,positiveCents:10000,negativeCents:-2500,selectedRows:2});
    expect(aggregate(input([transaction(1,100),transaction(2,-100)]))).toMatchObject({totalCents:0,groups:[],canceledGroupCount:1,canceledRowCount:2});
  });
  it("holds a negative source-entity balance",()=>{expect(()=>aggregate(input([transaction(1,-10)]))).toThrow(/negative_reported_entity_balance/);});
  it("excludes individual/loan rows rather than classifying their names as PACs",()=>{
    const rows=[transaction(),transaction(2,500,{transTypeDesr:"Loans",lineItemCompositeDescr:"Loans",committeeTypeCode:null})];const v=input(rows,[detail()]);expect(aggregate(v)).toMatchObject({totalCents:10000,receivingRows:2,selectedRows:1});
  });
  it("qualifies empty committee scope only with filed reports and complete native empty responses",()=>{
    expect(aggregate(input([],[]))).toMatchObject({totalCents:0,groups:[],selectedRows:0});const v=input([],[]);v.inventory=table([]);expect(()=>aggregate(v)).toThrow(/no_filed_receipt_reports/);
  });
  it("closes every per-report committee multiset before any display cap",()=>{
    const rows=Array.from({length:8},(_,i)=>transaction(i+1,100,{entIdFrom:200+i,entityDTO:{entId:200+i,entityName:`Synthetic PAC ${i}`,entityTypeCode:"CM",committeeId:null,committeeTypeCode:null}})),v=input(rows);
    expect(aggregate(v).groups).toHaveLength(8);v.details[0]!.rows[7]!.cashAmt=99;v.details[0]!.rows[7]!.totalAmt=99;expect(()=>aggregate(v)).toThrow(/report_committee_multiset_mismatch/);
  });
  it.each(["candidate","parent","duplicate","partial","overlap","period"])("holds invalid %s scope",kind=>{
    const v=input();if(kind==="candidate")v.scope={...scope,nativeCandidateId:101};if(kind==="parent")v.pages[0]!.body.aaData[0]!.reportId=11;
    if(kind==="duplicate")v.pages[0]!.body=table([transaction(),transaction()]);if(kind==="partial")v.resultCount=2;
    if(kind==="overlap")v.inventory=table([report(),report(11,{fromDateStr:"03/15/2026",toDateStr:"04/15/2026"})]);
    if(kind==="period")v.inventory=table([report(),report(11)]);expect(()=>aggregate(v)).toThrow();
  });
  it("detects repeated native rows across pages",()=>{
    const v=input();v.resultCount=2;v.pages=[{start:0,body:table([transaction()],2)},{start:1,body:table([transaction()],2)}];expect(()=>aggregate(v)).toThrow(/duplicate_current_transaction/);
  });
  it("requires contiguous complete pages and native count controls",()=>{
    const v=input([transaction(1),transaction(2)]);v.pages=[{start:0,body:table([transaction(1)],2)},{start:1,body:table([transaction(2)],2)}];expect(aggregate(v).totalCents).toBe(20000);
    v.pages[1]!.start=2;expect(()=>aggregate(v)).toThrow(/non_contiguous_receiving_pages/);
  });
  it("keeps current pending amendments and excludes incorporated notices",()=>{
    const selected=selectMontanaCommitteeReceiptReports(table([report(10,{statusCode:"PENDA"}),report(11,{formTypeCode:"C7",statusCode:"INCRP"})]),scope);expect(selected.map(r=>r.reportId)).toEqual([10]);
  });
  it("requires standalone filed rapid receipts to reconcile without double counting",()=>{
    const v=input();v.inventory=table([report(),report(11,{formTypeCode:"C7",fromDateStr:"10/15/2026",toDateStr:"10/15/2026"})]);
    v.details.push({reportId:11,rows:[detail(50)]});v.pages=[{start:0,body:table([transaction(),transaction(2,50,{reportId:11})])}];v.resultCount=2;
    expect(aggregate(v)).toMatchObject({totalCents:15000,selectedRows:2});
  });
  it.each(["entity","type","code","composition","name","side","version","detail"])("holds contradictory %s evidence",kind=>{
    const v=input(),r=v.pages[0]!.body.aaData[0]!;
    if(kind==="entity")r.entityDTO.entId=999;if(kind==="type")r.entityDTO.entityTypeCode="IN";if(kind==="code")r.transTypeCode="9";
    if(kind==="composition")r.inKindAmt=1;if(kind==="name")r.entityDTO.entityName="";if(kind==="side")r.amountTypeDescr="";
    if(kind==="version")r.previousTransactionInd="Y";if(kind==="detail")v.details[0]!.reportId=11;expect(()=>aggregate(v)).toThrow();
  });
  it("never rounds fractional cents or accepts unsafe money",()=>{
    expect(mtCommitteeCents(-12.34)).toBe(-1234);expect(mtCommitteeCents(.01)).toBe(1);
    for(const value of [.145,NaN,Infinity,"10.00",null,9007199254740992])expect(()=>mtCommitteeCents(value)).toThrow();
  });
});
