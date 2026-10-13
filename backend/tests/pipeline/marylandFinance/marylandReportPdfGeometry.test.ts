import { describe, expect, it } from "vitest";
import { inspectMarylandPdfBorders, parseMarylandModernReceiptPage,
  type MarylandPdfPage, type MarylandPdfCell } from "../../../src/pipeline/marylandFinance/marylandReportPdfGeometry.js";

const cell = (text: string, left: number, baselineTop: number, width=35): MarylandPdfCell =>
  ({text,left,right:left+width,baselineTop,height:10});
function table(kind: "money" | "in_kind" | "return" | "return_in_kind"="money", offset=0): MarylandPdfPage {
  const columns = kind === "money" ? [20,80,180,245,435,505,575] :
    kind === "in_kind" ? [20,110,200,435,505,575] : [20,93,200,390,485,575];
  const headers = kind === "money" ? [cell("Date",24,100,22),cell("Payment Method",84,100,80),
    cell("Fund Type",184,100,51),cell("Contributor Details",249,100,91),
    cell("Amount",463,100,38),cell("Aggregate",521,100,50)] : kind === "in_kind" ?
    [cell("Date",24,100,22),cell("Fund Type",114,100,51),cell("Contributor Details",204,100,91),
      cell("Fair Market",447,94.18,54),cell("Value",474,105.82,27),cell("Aggregate",521,100,50)] :
    [cell("Return Date",24,100,57),cell("Contribution Date",97,100,85),
      cell("Contributor Details",204,100,91),cell(kind === "return" ? "Contribution Amount" : "Fair Market Value",395,100,86),
      cell("Return Amount",498,100,73)];
  const donorLeft=kind === "money" ? 249 : 204;
  const amountLeft=kind.startsWith("return") ? 510 : 450;
  const cells=[...headers,cell("06/01/2026",24,151,50),cell("Example PAC",donorLeft,132,80),
    cell("12 Example St",donorLeft,143,85),cell("City, MD 12345 -",donorLeft,154,100),
    cell("6789",donorLeft,165,25),cell("$500.00",amountLeft,151,46),
    cell(kind.startsWith("return") ? "$900.00" : "$9,000.00",kind.startsWith("return")?405:515,151,55)];
  const borders=columns.map(x=>({x1:x,y1:120,x2:x,y2:180}));
  borders.push({x1:20,y1:120,x2:575,y2:120},{x1:20,y1:180,x2:575,y2:180});
  return {pageNumber:4,width:595,height:842,cells:cells.map(c=>({...c,baselineTop:c.baselineTop+offset})),
    borders:borders.map(b=>({...b,y1:b.y1+offset,y2:b.y2+offset}))};
}
describe("Maryland physical receipt page parsing", () => {
  it("uses Amount, preserves wrapped full identity and excludes Aggregate", () => {
    expect(parseMarylandModernReceiptPage(table())).toEqual([{pageNumber:4,ordinal:0,role:"gift",
      schedule:"gift_monetary",date:"2026-06-01",amountCents:50000,
      nameAddress:"Example PAC 12 Example St City, MD 12345-6789"}]);
  });
  it("binds a mid-page in-kind transition to its own header and borders", () => {
    const a=table(), b=table("in_kind",300);
    const result=parseMarylandModernReceiptPage({...a,cells:[...a.cells,...b.cells],borders:[...a.borders,...b.borders]});
    expect(result.map(r=>[r.schedule,r.amountCents])).toEqual([["gift_monetary",50000],["gift_in_kind",50000]]);
    expect(result[1]!.nameAddress).toBe(result[0]!.nameAddress);
  });
  it.each(["return","return_in_kind"] as const)("uses Return Amount instead of original gift value: %s",kind=>{
    expect(parseMarylandModernReceiptPage(table(kind))[0]).toMatchObject({role:"return",amountCents:50000,
      schedule:kind === "return" ? "return_monetary" : "return_in_kind"});
  });
  it("preserves equal occurrence multiplicity in separate printed rows",()=>{
    const p=table(); const second=p.cells.filter(c=>c.baselineTop>120).map(c=>({...c,baselineTop:c.baselineTop+60}));
    const extra=p.borders.filter(b=>b.x1===b.x2).map(b=>({...b,y1:180,y2:240}));
    extra.push({x1:20,y1:240,x2:575,y2:240});
    expect(parseMarylandModernReceiptPage({...p,cells:[...p.cells,...second],borders:[...p.borders,...extra]})).toHaveLength(2);
  });
  it("holds a valid positive row beside a changed header",()=>{
    const a=table(), b=table("money",300);b.cells=b.cells.map(c=>c.text==="Amount"?{...c,text:"Total"}:c);
    expect(()=>parseMarylandModernReceiptPage({...a,cells:[...a.cells,...b.cells],borders:[...a.borders,...b.borders]})).toThrow("header");
  });
  it("does not substitute monetary columns when wrapped Fair Market Value is absent",()=>{
    const p=table("in_kind");p.cells=p.cells.filter(c=>c.text!=="Value");
    expect(()=>parseMarylandModernReceiptPage(p)).toThrow("header");
  });
  it("requires physical borders instead of date-line grouping",()=>{
    const p=table();p.borders=[];
    expect(()=>parseMarylandModernReceiptPage(p)).toThrow("row_border");
  });
  it("requires a full-height contributor border",()=>{
    const p=table();p.borders=p.borders.map(b=>b.x1===245?{...b,y2:150}:b);
    expect(()=>parseMarylandModernReceiptPage(p)).toThrow("column_border");
  });
  it("binds the complete date token to the actual first ruled column",()=>{
    const p=table();p.cells=p.cells.map(c=>c.text==="06/01/2026"?{...c,right:100}:c);
    expect(()=>parseMarylandModernReceiptPage(p)).toThrow("column_border");
    p.cells=p.cells.map(c=>c.text==="06/01/2026"?{...c,left:-70,right:-20}:c);
    expect(()=>parseMarylandModernReceiptPage(p)).toThrow("invalid_page");
  });
  it("holds ambiguous amount cells",()=>{
    const p=table();p.cells=[...p.cells,cell("$100.00",450,165,46)];
    expect(()=>parseMarylandModernReceiptPage(p)).toThrow("amount");
  });
  it.each(["$1,00.00","$5e2","$500.001","$0.00"])("rejects malformed/nonpositive receipt %s",value=>{
    const p=table();p.cells=p.cells.map(c=>c.text==="$500.00"?{...c,text:value}:c);
    expect(()=>parseMarylandModernReceiptPage(p)).toThrow("amount");
  });
  it("rejects an impossible calendar date",()=>{
    const p=table();p.cells=p.cells.map(c=>c.text==="06/01/2026"?{...c,text:"02/30/2026"}:c);
    expect(()=>parseMarylandModernReceiptPage(p)).toThrow("date");
  });
  it("holds two date cells within one printed row",()=>{
    const p=table();p.cells=[...p.cells,cell("06/02/2026",24,165,50)];
    expect(()=>parseMarylandModernReceiptPage(p)).toThrow("duplicate_date_cell");
  });
  it("rejects a dated page with no exact header",()=>{
    const p=table();p.cells=p.cells.filter(c=>c.baselineTop>120);
    expect(()=>parseMarylandModernReceiptPage(p)).toThrow("header");
  });
  it("does not invent rows or publication authority on a subtotal-only page",()=>{
    const p=table();p.cells=[cell("Total",24,100)];
    expect(parseMarylandModernReceiptPage(p)).toEqual([]);
  });
  it("keeps literal punctuation, name order and nonterminal ZIP text",()=>{
    const p=table();p.cells=p.cells.map(c=>c.text==="Example PAC"?{...c,text:"Doe, Example"}:c);
    expect(parseMarylandModernReceiptPage(p)[0]!.nameAddress).toContain("Doe, Example");
  });
});
const codes={save:10,restore:11,transform:12,constructPath:91,moveTo:13,lineTo:14,rectangle:19,
  closePath:18,stroke:20,closeStroke:21,fill:22,eoFill:23,fillStroke:24,eoFillStroke:25,
  closeFillStroke:26,closeEOFillStroke:27,endPath:28};
describe("Maryland painted PDF border extraction",()=>{
  it("transforms rectangles through save/restore and uses top-origin coordinates",()=>{
    const borders=inspectMarylandPdfBorders({fnArray:[10,12,91,20,11],
      argsArray:[[],[2,0,0,2,10,20],[[19],[5,10,30,-15]],[],[]]},codes,842);
    expect(borders).toHaveLength(4);
    expect(borders[0]).toEqual({x1:20,y1:802,x2:80,y2:802});
    expect(borders[2]).toEqual({x1:80,y1:832,x2:20,y2:832});
  });
  it("accepts typed-array axis rules but does not grant unpainted paths authority",()=>{
    const args=[new Uint8Array([13,14]),new Float32Array([20,100,80,100])];
    expect(inspectMarylandPdfBorders({fnArray:[91,20],argsArray:[args,[]]},codes,842)).toHaveLength(1);
    expect(inspectMarylandPdfBorders({fnArray:[91,28],argsArray:[args,[]]},codes,842)).toEqual([]);
  });
  it("preserves the current point across pdfjs constructPath chunks before painting",()=>{
    expect(inspectMarylandPdfBorders({fnArray:[91,91,20],
      argsArray:[[[13],[19.5,486]],[[14],[574.5,486]],[]]},codes,842))
      .toEqual([{x1:19.5,y1:356,x2:574.5,y2:356}]);
  });
  it("does not use fill-only open lines or zero-area rectangles as printed borders",()=>{
    expect(inspectMarylandPdfBorders({fnArray:[91,22],argsArray:[[[13,14],[20,100,80,100]],[]]},codes,842)).toEqual([]);
    expect(inspectMarylandPdfBorders({fnArray:[91,22],argsArray:[[[19],[20,100,60,0]],[]]},codes,842)).toEqual([]);
    expect(inspectMarylandPdfBorders({fnArray:[91,22],argsArray:[[[19],[20,100,60,-20]],[]]},codes,842)).toHaveLength(4);
  });
  it("drops diagonal/curved decorations instead of projecting guessed borders",()=>{
    expect(inspectMarylandPdfBorders({fnArray:[91,20],argsArray:[[[13,14],[20,100,80,105]],[]]},codes,842)).toEqual([]);
  });
  it("holds invalid graphics state",()=>{
    expect(()=>inspectMarylandPdfBorders({fnArray:[11],argsArray:[[]]},codes,842)).toThrow("graphics_state");
    expect(()=>inspectMarylandPdfBorders({fnArray:[10],argsArray:[[]]},codes,842)).toThrow("graphics_state");
  });
});
