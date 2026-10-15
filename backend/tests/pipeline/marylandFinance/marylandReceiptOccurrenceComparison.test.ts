import { describe,expect,it } from "vitest";
import { compareMarylandReceiptOccurrences, compareMarylandLegacyCommitteeReceiptOccurrences as projectLegacy,
  compareMarylandModernCommitteeReceiptOccurrences as projectModern } from "../../../src/pipeline/marylandFinance/marylandReceiptOccurrenceComparison.js";
import type { MarylandPdfReceiptOccurrence } from "../../../src/pipeline/marylandFinance/marylandReportPdfGeometry.js";
import type { MarylandLegacyReceiptOccurrence, MarylandLegacyUnclassifiedContinuation } from "../../../src/pipeline/marylandFinance/marylandLegacyReportPdfParser.js";
const uuid=(n:number)=>`${String(n).padStart(8,"0")}-1111-4111-8111-111111111111`;
function native(n=1,override:Record<string,unknown>={}) {
  return {transactionGuid:uuid(n),transactionVersionID:1,reportGuid:uuid(99),reportVersionId:2,
    isReturn:false,transactionTypeCode:"TCON",transactionAmount:500,transactionDate:"2026-06-01T00:00:00",
    contributionTypeCode:"CMONT",contributorName:"Example PAC",contributorFullAddress:"12 Example St City, MD 12345-6789",
    contributorZipCode:"12345-6789",...override};
}
function pdf(override:Partial<MarylandPdfReceiptOccurrence>={}):MarylandPdfReceiptOccurrence {
  return {pageNumber:4,ordinal:0,role:"gift",schedule:"gift_monetary",date:"2026-06-01",amountCents:50000,
    nameAddress:"Example PAC 12 Example St City, MD 12345-6789",...override};
}
const compare=(nativeRows:ReturnType<typeof native>[],pdfRows:MarylandPdfReceiptOccurrence[])=>
  compareMarylandReceiptOccurrences({nativeRows,pdfRows});
function modernInput(nativeRows:ReturnType<typeof native>[],pdfRows:MarylandPdfReceiptOccurrence[]) {
  const control=(n:number)=>n===1?nativeRows.filter(r=>r.contributionTypeCode!=="CINKIND"&&r.contributionTypeCode!=="ANYMS").reduce((s,r)=>s+Number(r.transactionAmount)*100,0):
    n===2?nativeRows.filter(r=>r.contributionTypeCode==="ANYMS").reduce((s,r)=>s+Number(r.transactionAmount)*100,0):
      n===19?nativeRows.filter(r=>r.contributionTypeCode==="CINKIND").reduce((s,r)=>s+Number(r.transactionAmount)*100,0):0;
  return {boundReport:{rows:nativeRows,report:{}} as Parameters<typeof projectModern>[0]["boundReport"],pdfRows,
    controls:{schema:"modern_numbered_26",controls:Array.from({length:26},(_,i)=>({number:i+1,amountCents:control(i+1),printedLabel:"",printedOperator:"+"})),anonymousTransactionCount:0,equations:{}} as unknown as Parameters<typeof projectModern>[0]["controls"]};
}
describe("modern whole reported committee receipt facts",()=>{
  it("projects all nine classes after whole gifts and controls reconcile",()=>{
    const codes=["TCC","TFED","TPAC","TPCC","TPCLB","TPOC","TRNFC","TSLATE","TUNFC"];
    const rows=codes.map((code,n)=>native(n+1,{contributorTypeCode:code,contributorName:`Example ${code}`}));
    const result=projectModern(modernInput(rows,codes.map((code,n)=>pdf({ordinal:n,nameAddress:`Example ${code} 12 Example St City, MD 12345-6789`}))));
    expect(result.eligibleGiftComparison).toMatchObject({nativeGifts:9,pdfGifts:9,missingIdentityOccurrences:0,extraIdentityOccurrences:0});
    expect(result).toMatchObject({unresolvedEligibleFiscalPdfOccurrences:0,cashReceiptDifferenceCents:0,inKindDifferenceCents:0});
  });
  it("validates unknown classes and mechanisms before identity selection",()=>{
    for(const override of [{contributorTypeCode:"UNKNOWN"},{contributorTypeCode:"TIND",contributionTypeCode:"UNKNOWN"}])
      expect(()=>projectModern(modernInput([native(1,override)],[]))).toThrow();
  });
  it("keeps unresolved eligible fiscal source occurrences explicit",()=>{
    const result=projectModern(modernInput([native(1,{contributorTypeCode:"TFED"})],[pdf({nameAddress:"Changed identity"})]));
    expect(result.unresolvedEligibleFiscalPdfOccurrences).toBe(1);
    expect(result.eligibleGiftComparison.missingIdentityOccurrences).toBe(1);
  });
  it("holds cash/other and cross-class collisions at an exact whole contact identity",()=>{
    for(const override of [{contributorTypeCode:"TFED",contributionTypeCode:"OTHRINCM"},{contributorTypeCode:"TIND"}]) {
      const rows=[native(1,{contributorTypeCode:"TFED"}),native(2,override)];
      expect(()=>projectModern(modernInput(rows,[pdf(),pdf({ordinal:1})]))).toThrow("ambiguous_identity");
    }
  });
  it("retains in-kind and anonymous controls outside committee cash identities",()=>{
    const rows=[native(1,{contributorTypeCode:"TFED",contributionTypeCode:"CINKIND"}),
      native(2,{contributorTypeCode:null,contributionTypeCode:"ANYMS",contributionType:"Anonymous",contributorName:"Anonymous",contributorFullAddress:null})];
    const result=projectModern(modernInput(rows,[pdf({schedule:"gift_in_kind"})]));
    expect(result).toMatchObject({cashReceiptDifferenceCents:0,anonymousDifferenceCents:0,inKindDifferenceCents:0});
    expect(result.eligibleGiftComparison.nativeGifts).toBe(0);
  });
});
describe("Maryland complete supplied receipt occurrence facts",()=>{
  it("matches literal full identity after case/whitespace assembly only",()=>{
    const result=compare([native()],[pdf({nameAddress:"EXAMPLE PAC  12 Example St\nCity, MD 12345-6789"})]);
    expect(result).toMatchObject({nativeGifts:1,pdfGifts:1,matchedIdentityOccurrences:1,missingIdentityOccurrences:0,
      extraIdentityOccurrences:0,nativeGiftCents:50000,pdfGiftCents:50000});
    expect(result).not.toHaveProperty("qualified");expect(result).not.toHaveProperty("nameAddress");
  });
  it("retains equal gifts as two distinct occurrences",()=>{
    expect(compare([native(1),native(2)],[pdf(),pdf({ordinal:1})])).toMatchObject({matchedIdentityOccurrences:2});
    expect(compare([native(1),native(2)],[pdf()])).toMatchObject({missingIdentityOccurrences:1});
  });
  it("cannot net away changed identity or substitute an Aggregate amount",()=>{
    expect(compare([native()],[pdf({nameAddress:"Other PAC 12 Example St City, MD 12345-6789"})]))
      .toMatchObject({missingIdentityOccurrences:1,extraIdentityOccurrences:1});
    expect(compare([native()],[pdf({amountCents:900000})])).toMatchObject({matchedIdentityOccurrences:0});
  });
  it("does not reorder donor names or discard punctuation/street details",()=>{
    for(const nameAddress of ["PAC, Example 12 Example St City, MD 12345-6789",
      "Example PAC 12 Example St City MD 12345-6789","Example PAC 12 Example St City, MD 12345"])
      expect(compare([native()],[pdf({nameAddress})]).missingIdentityOccurrences).toBe(1);
  });
  it("assembles native terminal ZIP+4 only when its independent raw ZIP agrees exactly",()=>{
    const address="12 Example St City, MD 12345 - 6789";
    expect(compare([native(1,{contributorFullAddress:address})],[pdf()]).matchedIdentityOccurrences).toBe(1);
    expect(compare([native(1,{contributorFullAddress:address,contributorZipCode:"12345-0000"})],[pdf()])
      .missingIdentityOccurrences).toBe(1);
  });
  it("assembles a nonstandard literal postal field only with exact independent source confirmation",()=>{
    const row=native(1,{contributorFullAddress:"12 Example St City, XX 12345-abcd",contributorZipCode:"12345-abcd"});
    const printed=pdf({nameAddress:"Example PAC 12 Example St City, XX 12345- abcd"});
    expect(compare([row],[printed]).matchedIdentityOccurrences).toBe(1);
    expect(compare([{...row,contributorZipCode:"12345-efgh"}],[printed]).missingIdentityOccurrences).toBe(1);
    expect(compare([row],[{...printed,nameAddress:printed.nameAddress.replace("abcd","abce")}]).missingIdentityOccurrences).toBe(1);
  });
  it("preserves raw-postal confirmation multiplicity for otherwise equal source tuples",()=>{
    const fields={contributorFullAddress:"12 Example St City, XX 12345-abcd",contributorZipCode:"12345-abcd"};
    const a=native(1,fields),b=native(2,{...fields,contributorZipCode:"12345-efgh"});
    const wrapped=pdf({nameAddress:"Example PAC 12 Example St City, XX 12345- abcd"});
    expect(compare([a,b],[wrapped,{...wrapped,ordinal:1}])).toMatchObject({matchedIdentityOccurrences:1,
      missingIdentityOccurrences:1,extraIdentityOccurrences:1,literalPostalLayoutAssemblies:1});
    expect(compare([a,native(2,fields)],[wrapped,{...wrapped,ordinal:1}])).toMatchObject({matchedIdentityOccurrences:2});
  });
  it("keeps return dates/amounts and in-kind occurrences distinct",()=>{
    expect(compare([native(1,{isReturn:true,transactionTypeCode:"TRCON",contributionTypeCode:"CINKIND"})],
      [pdf({role:"return",schedule:"return_in_kind"})])).toMatchObject({nativeReturns:1,pdfReturns:1,matchedIdentityOccurrences:1});
    expect(compare([native(1,{isReturn:true,transactionTypeCode:"TRCON"})],[pdf()]).missingIdentityOccurrences).toBe(1);
    expect(compare([native(1,{isReturn:true,transactionTypeCode:"TRCON"})],
      [pdf({role:"return",schedule:"return_in_kind"})]).missingIdentityOccurrences).toBe(1);
    expect(compare([native(1,{contributionTypeCode:"CINKIND"})],[pdf()]).missingIdentityOccurrences).toBe(1);
    expect(()=>compare([native(1,{contributionTypeCode:"UNKNOWN"})],[pdf()])).toThrow("invalid_native");
    expect(compare([native(1,{isReturn:true,transactionTypeCode:"TRCON",contributionTypeCode:"TRFR"})],
      [pdf({role:"return",schedule:"return_transfer"})]).matchedIdentityOccurrences).toBe(1);
    expect(compare([native(1,{isReturn:true,transactionTypeCode:"TRCON",contributionTypeCode:"TRFR"})],
      [pdf({role:"return",schedule:"return_in_kind"})]).missingIdentityOccurrences).toBe(1);
  });
  it("keeps anonymous cash as a separate aggregate without fabricating a PDF row",()=>{
    const result=compare([native(1,{contributionTypeCode:"ANYMS",contributorName:null,transactionAmount:368})],[]);
    expect(result).toMatchObject({anonymousOccurrences:1,anonymousCents:36800,nativeGifts:0,pdfGifts:0});
  });
  it("recognizes the exact published anonymous aggregate display descriptor",()=>{
    const row=native(1,{contributionTypeCode:"ANYMS",contributionType:"Anonymous",contributorName:"Anonymous",
      contributorTypeCode:null,contributorFullAddress:null,transactionAmount:368});
    expect(compare([row],[])).toMatchObject({anonymousOccurrences:1,anonymousCents:36800,nativeGifts:0});
    expect(()=>compare([{...row,contributorTypeCode:"TIND"}],[])).toThrow("invalid_native");
    expect(()=>compare([{...row,contributionType:"Named cash"}],[])).toThrow("invalid_native");
  });
  it("holds duplicate native identities and duplicate physical PDF occurrences",()=>{
    expect(()=>compare([native(),native()],[pdf(),pdf({ordinal:1})])).toThrow("duplicate_native");
    expect(()=>compare([native(1),native(2)],[pdf(),pdf()])).toThrow("duplicate_pdf");
  });
  it.each([500.001,0,Number.NaN])("holds invalid native money %s",transactionAmount=>{
    expect(()=>compare([native(1,{transactionAmount})],[pdf()])).toThrow("invalid_native");
  });
  it("holds invalid calendar/source roles instead of matching corrupted keys",()=>{
    expect(()=>compare([native(1,{transactionDate:"2026-02-30T00:00:00"})],[pdf()])).toThrow("invalid_native");
    expect(()=>compare([native(1,{isReturn:true})],[pdf()])).toThrow("invalid_native");
  });
  it("counts a missing gift beside an otherwise complete positive schedule",()=>{
    expect(compare([native(1),native(2,{transactionAmount:100})],[pdf()]))
      .toMatchObject({matchedIdentityOccurrences:1,missingIdentityOccurrences:1});
  });
  it("does not silently exclude a named ANYMS record",()=>{
    expect(()=>compare([native(1,{contributionTypeCode:"ANYMS"})],[])).toThrow("invalid_native");
  });
});

type LegacyInput = Parameters<typeof projectLegacy>[0];
function legacyPdf(override: Partial<MarylandLegacyReceiptOccurrence> = {}): MarylandLegacyReceiptOccurrence {
  return {pageNumber:1,ordinal:0,role:"gift",tableKind:"contributions",sourceSection:"Contributions",sourceCategory:"A - Monetary",
    paidBy:null,date:"2026-06-01",amountCents:50000,nameAddress:"Example PAC 12 Example St City, MD 12345-6789",...override};
}
function unknownAfter(row: MarylandLegacyReceiptOccurrence): MarylandLegacyUnclassifiedContinuation {
  return {pageNumber:2,top:78.61,bottom:100,parentPageNumber:row.pageNumber,parentOrdinal:row.ordinal,
    date:row.date,amountCents:row.amountCents,tableKind:row.tableKind,sourceSection:row.sourceSection,sourceCategory:row.sourceCategory,cellCount:1};
}
function legacyInput(nativeRows: ReturnType<typeof native>[], pdfRows: MarylandLegacyReceiptOccurrence[], unknown: MarylandLegacyUnclassifiedContinuation[] = []): LegacyInput {
  const counts={contributions:0,transfers_in:0,other_receipts:0,in_kind:0},totalsCents={...counts};
  for(const row of pdfRows){counts[row.tableKind]++;totalsCents[row.tableKind]+=row.amountCents;}
  const cash=totalsCents.contributions+totalsCents.transfers_in+totalsCents.other_receipts;
  const financial=pdfRows.filter(r=>r.tableKind==="in_kind").map(r=>({pageNumber:r.pageNumber,ordinal:r.ordinal,top:210+r.ordinal*40,bottom:250+r.ordinal*40,
    tableKind:"in_kind" as const,sourceSection:r.sourceSection,sourceCategory:r.sourceCategory,date:r.date,amountCents:r.amountCents}));
  return {boundReport:{rows:nativeRows,report:{}} as LegacyInput["boundReport"],pdfRows:pdfRows.filter(r=>r.tableKind!=="in_kind"),
    observations:{sha256:"a".repeat(64),byteCount:1,pageCount:2,sourceFacts:{pageCount:2,headerCount:1,
      scope:"published_receipts",unclassifiedContinuationCount:unknown.length,counts,totalsCents,inKindIdentityScope:"unavailable",inKindFinancialOccurrenceCount:financial.length,inKindDescriptionUncertaintyCount:0},
      privateUnknownContinuations:unknown,privateInKindFinancialOccurrences:financial,privateInKindDescriptionUncertainty:[],
      privateInKindScheduleTotals:financial.length?[{pageNumber:1,top:700,bottom:720,amountCents:totalsCents.in_kind}]:[]} as LegacyInput["observations"],
    controls:{schema:"legacy_parts_3_4_5_6",receiptControls:[{schedule:"1",column:"A",printedLabel:"Contributions",amountCents:cash},
      {schedule:"3",column:"K",printedLabel:"Loans",amountCents:0}],anonymousContributionsCents:null,inKind:{contributionsCents:totalsCents.in_kind,expendituresCents:0}} as LegacyInput["controls"]};
}
describe("Maryland legacy reported committee receipt projection",()=>{
  it("requires the entire printed contact after source-licensed terminal state display",()=>{
    const row=native(1,{contributorTypeCode:"TFED",contributorState:"MD"}),printed="Example PAC 12 Example St City, Maryland 12345-6789";
    const dictionary={sourceFacts:{sha256:"a".repeat(64),byteCount:1,dictionaryEntries:51,originalStartedAt:"2026-01-01",originalCompletedAt:"2026-01-01"},
      privateStateLabels:Object.freeze({MD:"Maryland"})};
    for(const identity of [printed,"Example PAC","Example PAC 12 Example Street City, Maryland 12345-6789"]){
      const input=legacyInput([row],[legacyPdf({nameAddress:identity})]);input.stateDisplayDictionary=dictionary;
      const result=projectLegacy(input);expect(result.stateDisplayProjectionCount).toBe(1);
      expect(result.eligibleGiftComparison.matchedIdentityOccurrences).toBe(identity===printed?1:0);
      expect(result.unresolvedEligibleFiscalPdfOccurrences).toBe(identity===printed?0:1);
    }
    const input=legacyInput([{...row,contributorState:"VA"}],[legacyPdf({nameAddress:printed})]);input.stateDisplayDictionary=dictionary;
    expect(projectLegacy(input)).toMatchObject({stateDisplayProjectionCount:0,unresolvedEligibleFiscalPdfOccurrences:1});
  });
  it("keeps complete family/date/cents closure, transfers/in-kind kinds and Other Receipts separately",()=>{
    const rows=[native(1,{contributorTypeCode:"TPAC"}),native(2,{contributorTypeCode:"TFED",contributionTypeCode:"TRFR",transactionAmount:600}),
      native(3,{contributorTypeCode:"TPCLB",contributionTypeCode:"CINKIND",transactionAmount:700}),
      native(4,{contributorTypeCode:"TBSN",contributionTypeCode:"OTHRINCM",transactionAmount:800})];
    const pdfRows=[legacyPdf(),legacyPdf({ordinal:1,tableKind:"transfers_in",sourceSection:"Transfers in",amountCents:60000}),
      legacyPdf({ordinal:2,tableKind:"in_kind",amountCents:70000}),legacyPdf({ordinal:3,role:"other",tableKind:"other_receipts",amountCents:80000})];
    const result=projectLegacy(legacyInput(rows,pdfRows));
    expect(result).toMatchObject({nativeReportGifts:4,pdfReceiptOccurrences:4,matchedFiscalOccurrences:4,missingFiscalOccurrences:0,extraFiscalOccurrences:0,
      cashReceiptControlCents:190000,cashReceiptOccurrenceCents:190000,cashReceiptDifferenceCents:0,inKindDifferenceCents:0,
      inKindIdentityScope:"unavailable",inKindFinancialOccurrences:1,
      giftComparison:{nativeGifts:2,pdfGifts:2,matchedIdentityOccurrences:2},otherReceiptComparison:{nativeGifts:1,pdfGifts:1,matchedIdentityOccurrences:1},
      eligibleGiftComparison:{nativeGifts:2,pdfGifts:2,matchedIdentityOccurrences:2},eligibleOtherReceiptComparison:{nativeGifts:0,pdfGifts:0}});
    expect(result).not.toHaveProperty("qualified");expect(result).not.toHaveProperty("totalReceipts");
  });
  it("retains the entire noneligible fiscal cohort as identity-held without using names to select a subset",()=>{
    const rows=[native(1,{contributorTypeCode:"TIND"}),native(2,{contributorTypeCode:"TBSN",contributorName:"Other source name"})];
    const printed=[legacyPdf({nameAddress:"Different printed identity"}),legacyPdf({ordinal:1,nameAddress:"Another printed identity"})];
    const result=projectLegacy(legacyInput(rows,printed,[unknownAfter(printed[1]!)]));
    expect(result).toMatchObject({matchedFiscalOccurrences:2,missingFiscalOccurrences:0,extraFiscalOccurrences:0,
      unclassifiedContinuationCount:1,identityHeldFiscalCohorts:1,identityHeldNativeOccurrences:2,identityHeldPdfOccurrences:2,
      giftComparison:{nativeGifts:0,pdfGifts:0},eligibleGiftComparison:{nativeGifts:0,pdfGifts:0},cashReceiptDifferenceCents:0});
  });
  it("tests unknown-field disjointness across every native class/family before name or kind filtering",()=>{
    const printed=legacyPdf();
    const rows=[native(1,{contributorTypeCode:"TIND"}),native(2,{contributorTypeCode:"TFED",contributorName:"Other name",contributionTypeCode:"CINKIND"})];
    expect(()=>projectLegacy(legacyInput(rows,[printed],[unknownAfter(printed)]))).toThrow("ambiguous_continuation");
  });
  it("retains in-kind report-level uncertainty without assigning identities and preserves whole controls",()=>{
    const rows=[native(1,{contributorTypeCode:"TBSN"}),native(2,{contributorTypeCode:"TIND",contributionTypeCode:"CINKIND"})];
    const printed=[legacyPdf(),legacyPdf({ordinal:1,tableKind:"in_kind",sourceSection:"Other Receipts and In-Kind Contributions",sourceCategory:"In-Kind"})];
    const input=legacyInput(rows,printed);
    input.observations.privateInKindDescriptionUncertainty=[{pageNumber:2,top:78.61,bottom:96.37,cellCount:1,sourceSection:"Other Receipts and In-Kind Contributions",sourceCategory:"In-Kind",geometry:"bounded_band"}];
    input.observations.sourceFacts.inKindDescriptionUncertaintyCount=1;
    const result=projectLegacy(input);
    expect(result).toMatchObject({matchedFiscalOccurrences:2,missingFiscalOccurrences:0,extraFiscalOccurrences:0,
      identityHeldFiscalCohorts:0,identityHeldNativeOccurrences:0,identityHeldPdfOccurrences:0,inKindDescriptionUncertaintyCount:1,inKindIdentityScope:"unavailable",
      sourceCounts:{contributions:1,in_kind:1},sourceCents:{contributions:50000,in_kind:50000},
      cashReceiptControlCents:50000,cashReceiptOccurrenceCents:50000,cashReceiptDifferenceCents:0,
      inKindControlCents:50000,inKindOccurrenceCents:50000,inKindDifferenceCents:0,
      eligibleGiftComparison:{nativeGifts:0,pdfGifts:0}});
  });
  it("cannot use in-kind financial closure to hide a missing cash identity at the same date/cents",()=>{
    const rows=[native(1,{contributorTypeCode:"TIND",contributionTypeCode:"CINKIND"}),
      native(2,{contributorTypeCode:"TFED",contributorName:"Other eligible source name"})];
    const printed=[legacyPdf({nameAddress:"Changed monetary identity"}),legacyPdf({ordinal:1,tableKind:"in_kind",sourceSection:"Other Receipts and In-Kind Contributions",sourceCategory:"In-Kind"})];
    expect(projectLegacy(legacyInput(rows,printed))).toMatchObject({matchedFiscalOccurrences:2,inKindDifferenceCents:0,
      eligibleGiftComparison:{nativeGifts:1,pdfGifts:0,matchedIdentityOccurrences:0,missingIdentityOccurrences:1},unresolvedEligibleFiscalPdfOccurrences:1});
  });
  it("does not require any native in-kind identity and never accepts a fabricated printed one",()=>{
    const row=native(1,{contributorTypeCode:"TFED",contributionTypeCode:"CINKIND",contributorName:null,contributorFullAddress:null,contributorZipCode:null});
    const printed=legacyPdf({tableKind:"in_kind"}),input=legacyInput([row],[printed]);
    expect(projectLegacy(input)).toMatchObject({inKindIdentityScope:"unavailable",matchedFiscalOccurrences:1,
      inKindDifferenceCents:0,eligibleGiftComparison:{nativeGifts:0,pdfGifts:0,matchedIdentityOccurrences:0}});
    expect(()=>projectLegacy({...input,pdfRows:[printed]})).toThrow("invalid_pdf");
    const injected={...input.observations.privateInKindFinancialOccurrences[0]!,nameAddress:"Fabricated identity"};
    expect(()=>projectLegacy({...input,observations:{...input.observations,privateInKindFinancialOccurrences:[injected]}})).toThrow("invalid_legacy");
  });
  it("retains all in-kind financial multiplicity and rejects a changed printed Total",()=>{
    const rows=[native(1,{contributorTypeCode:"TPAC",contributionTypeCode:"CINKIND"}),native(2,{contributorTypeCode:"TIND",contributionTypeCode:"CINKIND"})];
    const input=legacyInput(rows,[legacyPdf({tableKind:"in_kind"}),legacyPdf({ordinal:1,tableKind:"in_kind"})]);
    expect(projectLegacy(input)).toMatchObject({matchedFiscalOccurrences:2,inKindFinancialOccurrences:2,inKindScheduleTotalCents:100000,eligibleGiftComparison:{nativeGifts:0}});
    expect(()=>projectLegacy({...input,observations:{...input.observations,privateInKindScheduleTotals:[{...input.observations.privateInKindScheduleTotals[0]!,amountCents:99999}]}})).toThrow("invalid_legacy");
  });
  it("never treats an unknown source class as an excluded donor",()=>{
    expect(()=>projectLegacy(legacyInput([native(1,{contributorTypeCode:"UNKNOWN"})],[legacyPdf()]))).toThrow("unknown_class");
  });
  it("keeps distinct eligible and noneligible full identities in an ordinary fiscal cohort",()=>{
    const rows=[native(1,{contributorTypeCode:"TPAC"}),native(2,{contributorTypeCode:"TBSN",contributorName:"Other source name"})];
    const printed=[legacyPdf(),legacyPdf({ordinal:1,nameAddress:"Other source name 12 Example St City, MD 12345-6789"})];
    expect(projectLegacy(legacyInput(rows,printed))).toMatchObject({matchedFiscalOccurrences:2,
      eligibleGiftComparison:{nativeGifts:1,pdfGifts:1,matchedIdentityOccurrences:1,missingIdentityOccurrences:0,extraIdentityOccurrences:0}});
  });
  it("holds an eligible/noneligible source-class collision at an indistinguishable full identity",()=>{
    const rows=[native(1,{contributorTypeCode:"TPAC"}),native(2,{contributorTypeCode:"TBSN"})];
    expect(()=>projectLegacy(legacyInput(rows,[legacyPdf(),legacyPdf({ordinal:1})]))).toThrow("ambiguous_identity");
  });
  it("reports missing eligible identities instead of allowing equal totals to close them",()=>{
    const result=projectLegacy(legacyInput([native(1,{contributorTypeCode:"TPAC"})],[legacyPdf({nameAddress:"Changed identity"})]));
    expect(result).toMatchObject({matchedFiscalOccurrences:1,cashReceiptDifferenceCents:0,unresolvedEligibleFiscalPdfOccurrences:1,
      eligibleGiftComparison:{nativeGifts:1,pdfGifts:0,matchedIdentityOccurrences:0,missingIdentityOccurrences:1}});
  });
  it("retains whole fiscal mismatch counts even for an excluded identity-held cohort",()=>{
    const rows=[native(1,{contributorTypeCode:"TIND"}),native(2,{contributorTypeCode:"TBSN"})];
    const printed=[legacyPdf(),legacyPdf({pageNumber:2,ordinal:0,date:"2026-06-02"})];
    const result=projectLegacy(legacyInput(rows,printed,[unknownAfter(printed[0]!)]));
    expect(result).toMatchObject({identityHeldNativeOccurrences:2,identityHeldPdfOccurrences:1,matchedFiscalOccurrences:1,
      missingFiscalOccurrences:1,extraFiscalOccurrences:1,cashReceiptDifferenceCents:0});
  });
  it("validates actual physical unknown refs and observation counts",()=>{
    const row=legacyPdf(),input=legacyInput([native(1,{contributorTypeCode:"TIND"})],[row],[unknownAfter(row)]);
    expect(()=>projectLegacy({...input,observations:{...input.observations,privateUnknownContinuations:[{...unknownAfter(row),parentOrdinal:99}]}})).toThrow("invalid_legacy");
    expect(()=>projectLegacy({...input,pdfRows:[row,row]})).toThrow("duplicate_pdf");
    expect(()=>projectLegacy({...input,observations:{...input.observations,sourceFacts:{...input.observations.sourceFacts,counts:{...input.observations.sourceFacts.counts,contributions:2}}}})).toThrow("invalid_legacy");
  });
  it("requires the actual contribution-table continuation bounds and last preceding painted row",()=>{
    const row=legacyPdf(),other=legacyPdf({ordinal:1}),nativeRows=[native(1,{contributorTypeCode:"TIND"}),native(2,{contributorTypeCode:"TIND"})];
    expect(()=>projectLegacy(legacyInput(nativeRows,[row,other],[unknownAfter(row)]))).toThrow("invalid_legacy");
    const outside={...unknownAfter(row),top:74};
    expect(()=>projectLegacy(legacyInput([nativeRows[0]!],[row],[outside]))).toThrow("invalid_legacy");
    const transfer=legacyPdf({tableKind:"transfers_in",sourceSection:"Transfers in"});
    expect(()=>projectLegacy(legacyInput([nativeRows[0]!],[transfer],[unknownAfter(transfer)]))).toThrow("invalid_legacy");
  });
  it("retains control differences and anonymous physical source facts without granting acceptance",()=>{
    const row=native(1,{contributorTypeCode:null,contributionTypeCode:"ANYMS",contributorName:null,contributorFullAddress:null,transactionAmount:368});
    const input=legacyInput([row],[]);input.controls.receiptControls=[{schedule:"1",column:"A",printedLabel:"Contributions",amountCents:36800}];
    expect(projectLegacy(input)).toMatchObject({anonymousOccurrences:1,anonymousCents:36800,itemizedNativeReceiptOccurrences:0,pdfReceiptOccurrences:0,
      missingFiscalOccurrences:0,extraFiscalOccurrences:0,anonymousControlCents:null,uncontrolledAnonymousOccurrences:1,uncontrolledAnonymousCents:36800,
      cashReceiptControlCents:36800,cashReceiptOccurrenceCents:0,cashReceiptDifferenceCents:null});
  });
});
