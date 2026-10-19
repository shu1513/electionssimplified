import { describe,it,expect } from "vitest";
import { parseOklahomaIeReportPdf,oklahomaIePrintedCents,singleOklahomaIeTarget } from "../../../src/pipeline/oklahomaFinance/oklahomaIeReportPdf.js";
import { syntheticOklahomaPdf } from "./oklahomaReportedFixture.js";
describe("Oklahoma native painted IE cells",()=>{
 it("reassembles wrapped amounts and inherits columns on a continuation page",async()=>{
  const r=await parseOklahomaIeReportPdf(syntheticOklahomaPdf({continuation:true}));expect(r).toMatchObject({pages:2,controlsClose:true,declaredCents:20002,parsedCents:20002});expect(r.rows).toHaveLength(2);expect(r.rows.every(r=>r.cents===10001&&r.type==="INDEPENDENTEXPENDITURE"&&r.candidateAndStance==="Jane Example State Senator (Support)")).toBe(true);
 });
 it("retains an unreconciled report's target rows without granting financial closure",async()=>{const r=await parseOklahomaIeReportPdf(syntheticOklahomaPdf({total:"99.00"}));expect(r.controlsClose).toBe(false);expect(r.rows).toHaveLength(1);});
 it.each(["none","amountRightMissing"] as const)("holds a readable amount whose column borders are %s instead of dropping its row",async kind=>{
  await expect(parseOklahomaIeReportPdf(syntheticOklahomaPdf({continuation:true,continuationBorders:kind}))).rejects.toThrow(/pdf_amount_border/);
 });
 it.each([["$1,234.56",123456],["($12.01)",-1201],["−$12.01",-1201],["$100. 01",10001],["1,23.00",null],["NaN",null]])("reads exact signed cents %s",(raw,expected)=>expect(oklahomaIePrintedCents(raw as string)).toBe(expected));
 it("accepts only one explicit stance and target per allocated amount",()=>{expect(singleOklahomaIeTarget("Jane Example (Oppose)")).toEqual({name:"Jane Example",stance:"oppose"});expect(singleOklahomaIeTarget("Jane Example (Support) John Example (Oppose)")).toBeNull();expect(singleOklahomaIeTarget("Jane Example")).toBeNull();});
 it.each(["Jane Example / John Example (Support)","Jane Example and John Example (Support)","Jane Example, John Example (Support)"])("holds joint names with one trailing stance: %s",raw=>expect(singleOklahomaIeTarget(raw)).toBeNull());
});
