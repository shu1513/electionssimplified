import { describe,expect,it } from "vitest";
import { compareMarylandReceiptOccurrences } from "../../../src/pipeline/marylandFinance/marylandReceiptOccurrenceComparison.js";
import type { MarylandPdfReceiptOccurrence } from "../../../src/pipeline/marylandFinance/marylandReportPdfGeometry.js";
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
