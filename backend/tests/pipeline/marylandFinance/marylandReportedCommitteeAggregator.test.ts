import { describe, expect, it } from "vitest";
import { aggregateMarylandReportedCommitteePositions as aggregate } from "../../../src/pipeline/marylandFinance/marylandNativePacAggregator.js";
type Input = Parameters<typeof aggregate>[0];
const uuid = (n: number) => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
const labels = {TCC:"Candidate Committee",TFED:"Federal Committee",TPAC:"Political Action Committee",
  TPCC:"Party Central Committee",TPCLB:"Political Club",TPOC:"Participating Organization Committee",
  TRNFC:"Registered Out-of-State (Non-Federal) Committee",TSLATE:"Slate Committee",TUNFC:"Unregistered Out-of-State (Non-Federal) Committee",
  TBSN:"Business/Group/Organization",TIND:"Individual",TSPDC:"Spouse",TLAB:"Labor Union",TNPO:"Non-Profit Organization"};
function gift(id: number, code: keyof typeof labels = "TPAC", overrides: Record<string, unknown> = {}) {
  return {transactionId:id,transactionGuid:uuid(id),filerRegistrationGuid:uuid(99),electionCycleId:12023,
    isActive:true,isReturn:false,transactionTypeCode:"TCON",contributionTypeCode:"CMONT",
    contributorTypeCode:code,contributorType:labels[code],contributorName:`Reported ${code}`,
    transactionAmount:1000,transactionDate:"2023-02-01T00:00:00",parentTransactionId:null,parentTransactionGuid:null,
    reportGuid:uuid(90),reportVersionId:1,transactionVersionID:1,...overrides};
}
function refund(id: number, parent: number, overrides: Record<string, unknown> = {}) {
  return gift(id,"TPOC",{isReturn:true,transactionTypeCode:"TRCON",contributorName:"Reported TPAC",
    parentTransactionId:parent,parentTransactionGuid:uuid(parent),transactionDate:"2023-02-02T00:00:00",...overrides});
}
const receivingContext = {filerRegistrationGuid:uuid(99),sourceCommitteeName:"Receiving Committee",
  sourceCommitteeLabels:["Receiving Committee","Receiving Source Label"],sourceCycle:{value:"12023"},
  canonical:{committeeName:"Receiving Committee"},sourceMetadata:Array.from({length:5},()=>({}))} as unknown as Input["receivingContext"];
function run(currentRows: Record<string, unknown>[], priorRows: Record<string, unknown>[] = [], overrides: Partial<Input> = {}) {
  return aggregate({receivingGuid:uuid(99),currentCycle:"12023",priorCycle:"12019",currentRows,priorRows,
    declaredCurrentRows:currentRows.length,declaredPriorRows:priorRows.length,receivingContext,...overrides});
}
function comparison(overrides: Record<string, unknown> = {}): NonNullable<Input["legacyReturnComparison"]> {
  return {sourceFacts:{reportsCompared:1,nativeReturns:1,pdfReturns:1,returnCents:66500,eligibleReturns:1,eligibleReturnCents:66500},
    privateBoundReturns:[{transactionId:2,transactionGuid:uuid(2),reportGuid:uuid(90),reportVersionId:1,
      nativeReportGuid:uuid(90),nativeReportVersionId:1,
      originalTransactionId:1,originalTransactionGuid:uuid(1),originalClass:"TFED",originalKind:"CINKIND",
      documentFamily:"cash_outflow",refundCents:66500,pageNumber:1,ordinal:0,...overrides}]} as NonNullable<Input["legacyReturnComparison"]>;
}
function family(overrides: Record<string, unknown> = {}): NonNullable<Input["legacyReturnCashFamilies"]> {
  return {sourceFacts:{reportsCompared:1,nativeReturns:1,pdfReturns:1,returnCents:66500,documentFamily:"cash_outflow"},
    reports:[{report:{reportGuid:uuid(90),reportVersionId:1,reportName:"Published annual report",
      reportVersion:"Original",reportVersionCode:"RPTFLD",reportType:"Campaign Finance Report",reportTypeCode:"FPCFR",
      filingEntityId:1,filerRegistrationGuid:uuid(99),committeeType:"Candidate Committee",committeeTypeCode:"CC",
      officeSought:"Governor",officeSoughtId:40,jurisdiction:"State",jurisdictionId:1,
      reportingCycle:"2023-2026",reportingCycleId:12023,reportingYear:2023,
      startDate:"2023-01-01T00:00:00",endDate:"2023-12-31T00:00:00",dueDate:"2024-01-17T00:00:00",
      filedDate:"2024-01-16T12:00:00",zeroActivity:false,hasChild:false,childResults:null},
      pdfSha256:"a".repeat(64),pdfByteCount:1000,pdfPageCount:10,returnCount:1,returnCents:66500,documentFamily:"cash_outflow",...overrides}]} as NonNullable<Input["legacyReturnCashFamilies"]>;
}
describe("Maryland complete reported committee arithmetic", () => {
  it("includes all nine explicit classes while leaving five other source roles outside the scope", () => {
    const result=run(Object.keys(labels).map((code,i)=>gift(i+1,code as keyof typeof labels)));
    expect(result).toMatchObject({sourceRows:14,giftCount:9,grossCents:900000,netCents:900000});
    expect(new Set(result.positions.map(p=>p.reportedClassCode))).toEqual(new Set(Object.keys(labels).slice(0,9)));
    expect(result.positions.every(p=>p.recognitionMethod==="explicit_reported_class" && p.identityScope==="reported_class_and_name")).toBe(true);
    expect(result).not.toHaveProperty("qualified");expect(result).not.toHaveProperty("totalReceipts");
  });
  it("keeps actual source class namespaces even for an equal literal name", () => {
    const rows=[gift(1,"TPAC"),gift(2,"TBSN",{contributorName:"Reported TPAC"}),gift(3,"TFED",{contributorName:"Reported TPAC"})];
    const result=run(rows);expect(result.giftCount).toBe(2);expect(result.positions).toHaveLength(2);
    expect(result.positions.map(p=>p.reportedClassCode).sort()).toEqual(["TFED","TPAC"]);
  });
  it("keeps anonymous and noncash physical rows without creating committee cash gifts", () => {
    const result=run([gift(1),gift(2,"TFED",{contributionTypeCode:"CINKIND"}),
      gift(3,"TBSN",{contributionTypeCode:"OTHRINCM"}),
      gift(4,"TIND",{contributionTypeCode:"ANYMS",contributorTypeCode:null,contributorType:null,contributorName:null})]);
    expect(result).toMatchObject({sourceRows:4,giftCount:1,grossCents:100000});
    expect(result.positions[0]!.originalGiftKinds).toEqual(["CMONT"]);
  });
  it("folds only case and whitespace, preserving punctuation and Unicode distinctions", () => {
    const rows=[" A  PAC ","a pac","A, PAC","Ａ PAC"].map((name,i)=>gift(i+1,"TPAC",{contributorName:name}));
    const result=run(rows);expect(result.positions).toHaveLength(3);expect(result.positions[0]!.giftCount).toBe(2);
  });
  it("retains signed prior-parent refunds, zero positions and their full signed sum", () => {
    const prior=gift(1,"TFED",{electionCycleId:12019,transactionDate:"2022-01-01T00:00:00"});
    const result=run([refund(2,1,{contributorName:"Reported TFED"}),gift(3),refund(4,3),gift(5,"TCC")],[prior]);
    expect(result).toMatchObject({giftCount:2,refundCount:2,grossCents:200000,refundCents:200000,netCents:0});
    expect(result.positions.map(p=>p.netCents)).toEqual([100000,0,-100000]);
    expect(result.positions[2]!.reportedClassCode).toBe("TFED");
  });
  it("uses original gift class when a TPOC-reported refund belongs to TPAC", () => {
    const result=run([gift(1),refund(2,1)]);expect(result.positions[0]).toMatchObject({reportedClassCode:"TPAC",netCents:0,refundCount:1});
  });
  it("requires the actual mixed-family cash-outflow fact without converting original in-kind into cash gross", () => {
    const prior=gift(1,"TFED",{electionCycleId:12019,contributionTypeCode:"CINKIND",transactionDate:"2022-01-01T00:00:00"});
    const returned=refund(2,1,{contributorName:"Reported TFED",transactionAmount:665});
    expect(()=>run([returned],[prior])).toThrow("missing_return_family");
    const result=run([returned],[prior],{legacyReturnComparison:comparison()});
    expect(result).toMatchObject({giftCount:0,grossCents:0,refundCents:66500,netCents:-66500});
    expect(result.positions[0]!.reportedClassCode).toBe("TFED");
    expect(result.positions[0]).toMatchObject({originalGiftKinds:["CINKIND"],documentBoundCashOutflowRefundCount:1});
  });
  it("consumes whole-report cash family without claiming per-row PDF identity or converting original kind", () => {
    const prior=gift(1,"TFED",{electionCycleId:12019,contributionTypeCode:"CINKIND",transactionDate:"2022-01-01T00:00:00"});
    const rows=[refund(2,1,{contributorName:"Reported TFED",transactionAmount:665})];
    const result=run(rows,[prior],{legacyReturnCashFamilies:family()});
    expect(result).toMatchObject({grossCents:0,refundCents:66500,netCents:-66500});
    expect(result.positions[0]).toMatchObject({originalGiftKinds:["CINKIND"],documentBoundCashOutflowRefundCount:1});
    expect(family().reports[0]).not.toHaveProperty("pageNumber");
    expect(()=>run(rows,[prior],{legacyReturnCashFamilies:family(),legacyReturnComparison:comparison()})).toThrow("invalid_return_fact");
  });
  it("requires the entire report return census, including noneligible classes", () => {
    const rows=[gift(1,"TFED"),refund(2,1,{contributorName:"Reported TFED",transactionAmount:665}),
      gift(3,"TIND"),refund(4,3,{contributorName:"Reported TIND",transactionAmount:5})];
    expect(()=>run(rows,[],{legacyReturnCashFamilies:family()})).toThrow("invalid_return_fact");
    const base=family({returnCount:2,returnCents:67000});
    const proof={...base,sourceFacts:{...base.sourceFacts,nativeReturns:2,pdfReturns:2,returnCents:67000}};
    expect(run(rows,[],{legacyReturnCashFamilies:proof})).toMatchObject({refundCents:66500,resolvedRefunds:2});
  });
  it.each([{returnCount:0},{returnCents:66000},{pdfSha256:"bad"},{pdfByteCount:0},{pdfPageCount:0},{documentFamily:"in_kind"}])("holds incomplete report-family facts %j", overrides => {
    expect(()=>run([gift(1,"TFED"),refund(2,1,{contributorName:"Reported TFED",transactionAmount:665})],[],{legacyReturnCashFamilies:family(overrides)})).toThrow("invalid_return_fact");
  });
  it("binds historical editions to the current report and rejects unknown versions, period and ownership", () => {
    const proof=family(), report=proof.reports[0]!.report;
    const amended={...report,reportVersionId:2,reportVersion:"Amended" as const,reportVersionCode:"RPTAMD" as const,
      hasChild:true,childResults:[1,2].map(v=>({filerReportGuid:uuid(90),filerReportVersionID:v,totalRows:2,
        reportName:report.reportName,reportType:"Disclosure Report",startDate:report.startDate,endDate:report.endDate,
        dueDate:report.dueDate,filedDate:report.filedDate,isCompleted:true,isPaperFile:false,
        generateStatus:"Completed",generateStatusCode:"GRCOMP",reportStatus:`Version ${v}`}))};
    const facts=family({report:amended});
    const rows=[gift(1,"TFED"),refund(2,1,{contributorName:"Reported TFED",transactionAmount:665})];
    expect(run(rows,[],{legacyReturnCashFamilies:facts}).refundCents).toBe(66500);
    for(const overrides of [{reportVersionId:3},{transactionVersionID:0},{transactionDate:"2024-01-01T00:00:00"}])
      expect(()=>run([rows[0]!,{...rows[1]!,...overrides}],[],{legacyReturnCashFamilies:facts})).toThrow("invalid_return_fact");
    expect(()=>run(rows,[],{legacyReturnCashFamilies:family({report:{...report,filerRegistrationGuid:uuid(80)}})})).toThrow("invalid_return_fact");
    expect(()=>run(rows,[],{legacyReturnCashFamilies:{...proof,reports:[...proof.reports,...proof.reports],sourceFacts:{...proof.sourceFacts,reportsCompared:2}}})).toThrow("invalid_return_fact");
  });
  it("holds a conflicting native noncash return mechanism even in a noneligible class", () => {
    expect(()=>run([gift(1,"TIND"),refund(2,1,{contributorName:"Reported TIND",transactionAmount:665,contributionTypeCode:"CINKIND"})],[],{legacyReturnCashFamilies:family()})).toThrow("invalid_return_fact");
  });
  it.each([{transactionGuid:uuid(8)},{nativeReportGuid:uuid(8)},{nativeReportVersionId:2},{originalTransactionId:8},
    {originalTransactionGuid:uuid(8)},{originalClass:"TPAC"},{originalKind:"CMONT"},{documentFamily:"in_kind"},
    {refundCents:66400},{pageNumber:0},{ordinal:-1},{transactionGuid:null},{reportGuid:null},{reportVersionId:0}])("holds mismatched or malformed source return facts %j", override => {
    const prior=gift(1,"TFED",{electionCycleId:12019,contributionTypeCode:"CINKIND",transactionDate:"2022-01-01T00:00:00"});
    expect(()=>run([refund(2,1,{contributorName:"Reported TFED",transactionAmount:665})],[prior],{legacyReturnComparison:comparison(override)})).toThrow("invalid_return_fact");
  });
  it("holds duplicate and extra bound return facts", () => {
    const prior=gift(1,"TFED",{electionCycleId:12019,contributionTypeCode:"CINKIND",transactionDate:"2022-01-01T00:00:00"});
    const facts=comparison();const duplicate={...facts,sourceFacts:{...facts.sourceFacts,eligibleReturns:2,eligibleReturnCents:133000},privateBoundReturns:[...facts.privateBoundReturns,...facts.privateBoundReturns]};
    expect(()=>run([refund(2,1,{contributorName:"Reported TFED",transactionAmount:665})],[prior],{legacyReturnComparison:duplicate})).toThrow("invalid_return_fact");
    expect(()=>run([],[],{legacyReturnComparison:facts})).toThrow("invalid_return_fact");
  });
  it("matches historical native report identity while retaining a distinct current PDF physical identity", () => {
    const prior=gift(1,"TFED",{electionCycleId:12019,contributionTypeCode:"CINKIND",transactionDate:"2022-01-01T00:00:00"});
    const nativeReportGuid="abcdefab-1111-4111-8111-111111111111";
    const returned=refund(2,1,{contributorName:"Reported TFED",transactionAmount:665,reportGuid:nativeReportGuid,reportVersionId:1});
    const result=run([returned],[prior],{legacyReturnComparison:comparison({nativeReportGuid:nativeReportGuid.toUpperCase(),nativeReportVersionId:1,reportGuid:uuid(90),reportVersionId:2})});
    expect(result.netCents).toBe(-66500);
  });
  it("does not reuse one canonical PDF physical occurrence through GUID case differences", () => {
    const prior=[gift(1,"TFED",{electionCycleId:12019,contributionTypeCode:"CINKIND",transactionDate:"2022-01-01T00:00:00"}),
      gift(3,"TFED",{electionCycleId:12019,contributionTypeCode:"CINKIND",transactionDate:"2022-01-01T00:00:00"})];
    const rows=[refund(2,1,{contributorName:"Reported TFED",transactionAmount:665}),refund(4,3,{contributorName:"Reported TFED",transactionAmount:665})];
    const base=comparison({reportGuid:"abcdefab-1111-4111-8111-111111111111"});
    const first=base.privateBoundReturns[0]!;
    const facts={...base,sourceFacts:{...base.sourceFacts,nativeReturns:2,pdfReturns:2,returnCents:133000,eligibleReturns:2,eligibleReturnCents:133000},
      privateBoundReturns:[first,{...first,transactionId:4,transactionGuid:uuid(4),originalTransactionId:3,originalTransactionGuid:uuid(3),reportGuid:first.reportGuid.toUpperCase()}]};
    expect(()=>run(rows,prior,{legacyReturnComparison:facts})).toThrow("invalid_return_fact");
  });
  it("applies lifetime bounds across prior and current without promoting the separate individual anomaly", () => {
    const prior=gift(1,"TFED",{electionCycleId:12019,transactionDate:"2022-01-01T00:00:00"});
    const old=refund(2,1,{electionCycleId:12019,contributorName:"Reported TFED",transactionDate:"2022-02-01T00:00:00",transactionAmount:500});
    expect(()=>run([refund(3,1,{contributorName:"Reported TFED",transactionAmount:600})],[prior,old])).toThrow("refund_exceeds_gift");
    const person=gift(4,"TIND",{transactionAmount:1});
    expect(run([gift(1),person,refund(5,4,{contributorName:"Reported TIND",transactionAmount:1}),refund(6,4,{contributorName:"Reported TIND",transactionAmount:1})])).toMatchObject({nonCommitteeOverRefundParentCount:1,netCents:100000});
  });
  it.each(["Receiving Committee"," receiving  source label "])("holds source-bound same-label self ambiguity: %s", name => {
    expect(()=>run([gift(1,"TCC",{contributorName:name})])).toThrow("ambiguous_self");
  });
  it.each([{contributorType:"Political Club"},{contributorTypeCode:"UNKNOWN"},{transactionAmount:1.001},
    {transactionDate:"2023-02-30T00:00:00"},{isActive:false},{filerRegistrationGuid:uuid(80)}])("validates every source row %j", override => {
    expect(()=>run([gift(1),gift(2,"TBSN",override)])).toThrow("invalid_row");
  });
  it("holds incomplete scope, duplicate identities, unresolved parents and unsafe signed sums", () => {
    expect(()=>run([gift(1)],[],{declaredCurrentRows:2})).toThrow("incomplete_collection");
    expect(()=>run([gift(1),gift(1)])).toThrow("duplicate_identity");
    expect(()=>run([refund(2,1)])).toThrow("unresolved_parent");
    expect(()=>run([gift(1, "TPAC",{transactionAmount:80000000000000}),gift(2,"TFED",{transactionAmount:80000000000000})])).toThrow("unsafe_total");
    expect(()=>run([],[],{receivingContext:{...receivingContext,sourceCycle:{...receivingContext.sourceCycle,value:"12019"}}})).toThrow("invalid_receiving_context");
  });
});
