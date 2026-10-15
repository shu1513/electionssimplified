import {describe,expect,it} from "vitest";
import {createMarylandModernReceiptDocumentParser as createParser} from "../../../src/pipeline/marylandFinance/marylandCompleteReceiptReportReader.js";
import type {MarylandPdfPage} from "../../../src/pipeline/marylandFinance/marylandReportPdfGeometry.js";
import type {MarylandModernFinancialControls} from "../../../src/pipeline/marylandFinance/marylandReportFinancialControls.js";
const page=(pageNumber:number,section?:number):MarylandPdfPage=>({pageNumber,width:595,height:842,borders:[],
  cells:section===undefined?[]:[{text:`Section ${section}`,left:25,right:95,baselineTop:55.54,height:16}]});
function started(){const parser=createParser();for(let n=1;n<=3;n++)parser.parsePage(page(n));return parser;}
function throughFour(){const parser=started();for(const [n,s]of [[4,1],[5,2],[6,3],[7,4]])parser.parsePage(page(n!,s));return parser;}
function spill():MarylandPdfPage {
  return {pageNumber:8,width:595,height:842,cells:[
    {text:"Total Returned Expenditures",left:364.31,right:501,baselineTop:49.64,height:10},
    {text:"(Transfer to Detailed Summary, page 3, line 8)",left:295.37,right:501,baselineTop:63.28,height:10},
    {text:"Total Returned In-Kind Expenditures",left:327.09,right:501,baselineTop:89.64,height:10},
    {text:"(Transfer to Detailed Summary, page 3, line 24)",left:289.81,right:501,baselineTop:103.28,height:10},
    {text:"$123.45",left:530,right:571,baselineTop:54.46,height:10},{text:"$0.00",left:545.98,right:571,baselineTop:94.46,height:10},
  ],borders:[31,71].flatMap(top=>[
    {x1:505,y1:top,x2:505,y2:top+40},{x1:19,y1:top,x2:576,y2:top},
    {x1:20,y1:top-1,x2:20,y2:top+41},{x1:19,y1:top+40,x2:576,y2:top+40},{x1:575,y1:top-1,x2:575,y2:top+41},
  ])};
}
const controls:MarylandModernFinancialControls={schema:"modern_numbered_26",anonymousTransactionCount:0,
  equations:{cashNet:true,expensesNet:true,loanObligationSubtotal:true,loanObligationEnding:true,inKindNet:true,inKindExpenseNet:true},
  controls:Array.from({length:26},(_,i)=>({number:i+1,printedLabel:"Fixture control",printedOperator:"+",amountCents:i===7?12345:0}))};
describe("complete modern Maryland receipt document extent",()=>{
  it("holds a receipt table on reserved cover/control pages",()=>{
    for(const n of [1,2,3]){const parser=createParser();for(let p=1;p<n;p++)parser.parsePage(page(p));const source=page(n);
      source.cells=[{text:"Contributor Details",left:249,right:340,baselineTop:100,height:10}];
      expect(()=>parser.parsePage(source)).toThrow("receipt_family");}
  });
  it("derives receipt extent from every original page and checks later schedule pages",()=>{
    const parser=started();for(const [n,s]of [[4,1],[5,1],[6,2],[7,3],[8,4],[9,5],[10,6]])expect(parser.parsePage(page(n!,s))).toEqual([]);
    expect(parser.finish()).toEqual({pageCount:10,firstReceiptPage:4,lastReceiptPage:6,firstExpensePage:7,receiptPages:3,sectionPageCounts:[2,1,1,1,1,1],amendmentStatementPages:0,sectionFourTotalsSpills:[]});
  });
  it("recognizes the complete source Section4 totals spill only between Section4 and Section5",()=>{
    const parser=throughFour();expect(parser.parsePage(spill())).toEqual([]);parser.parsePage(page(9,5));parser.parsePage(page(10,6));
    expect(parser.finish(controls)).toMatchObject({sectionPageCounts:[1,1,1,2,1,1],sectionFourTotalsSpills:[{pageNumber:8,cashReturnedExpenditureCents:12345,inKindReturnedExpenditureCents:0}]});
  });
  it.each(["extra_cell","unknown_label","missing_border","changed_border","amount","duplicate_amount","geometry"])("holds an unqualified totals spill: %s",mode=>{
    const parser=throughFour(),p=spill();
    if(mode==="extra_cell")p.cells=[...p.cells,{text:"Unclassified text",left:30,right:100,baselineTop:150,height:10}];
    if(mode==="unknown_label")p.cells=p.cells.map((c,i)=>i===3?{...c,text:"(Transfer elsewhere)"}:c);
    if(mode==="missing_border")p.borders=p.borders.slice(1);
    if(mode==="changed_border")p.borders=p.borders.map((b,i)=>i===0?{...b,x1:504}:b);
    if(mode==="amount")p.cells=p.cells.map((c,i)=>i===4?{...c,text:"$-123.45"}:c);
    if(mode==="duplicate_amount")p.cells=p.cells.map((c,i)=>i===5?{...c,baselineTop:54.46}:c);
    if(mode==="geometry")p.cells=p.cells.map((c,i)=>i===0?{...c,left:363}:c);
    expect(()=>parser.parsePage(p)).toThrow("section");
  });
  it("holds missing/mismatched summary controls, repeated spill, wrong next section and missing final page",()=>{
    for(const mode of ["no_controls","mismatch","repeat","next","incomplete"]){const parser=throughFour();parser.parsePage(spill());
      if(mode==="repeat"){expect(()=>parser.parsePage({...spill(),pageNumber:9})).toThrow("section");continue;}
      if(mode==="next"){expect(()=>parser.parsePage(page(9,4))).toThrow("section");continue;}
      if(mode==="incomplete"){expect(()=>parser.finish(controls)).toThrow("incomplete_document");continue;}
      parser.parsePage(page(9,5));parser.parsePage(page(10,6));
      expect(()=>parser.finish(mode==="no_controls"?undefined:{...controls,controls:controls.controls.map(c=>c.number===8?{...c,amountCents:0}:c)})).toThrow("section");
    }
    const parser=started();parser.parsePage(page(4,1));parser.parsePage(page(5,2));parser.parsePage(page(6,3));
    expect(()=>parser.parsePage({...spill(),pageNumber:7})).toThrow("section");
  });
  it("recognizes only the exact terminal amendment statement after section six",()=>{
    for(const mode of ["valid","early","geometry","late_receipt","same_page_section","reopen"]){const parser=started();
      for(const [n,s]of [[4,1],[5,2],[6,3],[7,4],[8,5],[9,6]]){if(mode==="early"&&n===9)break;parser.parsePage(page(n!,s));}
      const p=page(mode==="early"?9:10);p.cells=[{text:"AMENDMENT STATEMENT",left:23,right:229.208,baselineTop:55.54,height:16}];
      if(mode==="geometry")p.cells=p.cells.map(c=>({...c,left:24}));
      if(mode==="late_receipt")p.cells=[...p.cells,{text:"Contributor Details",left:249,right:340,baselineTop:100,height:10}];
      if(mode==="same_page_section")p.cells=[...p.cells,...page(10,1).cells];
      if(mode==="early"||mode==="geometry"||mode==="late_receipt"||mode==="same_page_section"){expect(()=>parser.parsePage(p)).toThrow();continue;}
      expect(parser.parsePage(p)).toEqual([]);
      if(mode==="reopen")expect(()=>parser.parsePage(page(11,1))).toThrow("receipt_reopening");
      else expect(parser.finish().amendmentStatementPages).toBe(1);
    }
  });
  it.each([0,7,9])("holds unknown section %s",section=>{const parser=started();expect(()=>parser.parsePage(page(4,section))).toThrow("section");});
  it("holds an absent, duplicate or changed section caption",()=>{
    for(const mode of ["absent","duplicate","geometry","width"]){const parser=started(),p=page(4,1);
      if(mode==="absent")p.cells=[];if(mode==="duplicate")p.cells=[...p.cells,...p.cells];
      if(mode==="geometry")p.cells=p.cells.map(c=>({...c,left:26}));if(mode==="width")p.width=612;
      expect(()=>parser.parsePage(p)).toThrow("section");}
  });
  it("holds missing pages and a document beginning after section one",()=>{
    expect(()=>started().parsePage(page(5,1))).toThrow("page_order");
    expect(()=>started().parsePage(page(4,2))).toThrow("section");
  });
  it("holds receipt sections reopened after expenses",()=>{
    for(const section of [1,2]){const parser=started();parser.parsePage(page(4,1));parser.parsePage(page(5,2));parser.parsePage(page(6,3));
      expect(()=>parser.parsePage(page(7,section))).toThrow("receipt_reopening");}
  });
  it("holds a late receipt table under an expense section caption",()=>{
    const parser=started();parser.parsePage(page(4,1));parser.parsePage(page(5,2));
    const p=page(6,3);p.cells=[...p.cells,{text:"Contributor Details",left:249,right:340,baselineTop:100,height:10}];
    expect(()=>parser.parsePage(p)).toThrow("receipt_reopening");
  });
  it("requires the receipt-to-expense transition before document completion",()=>{
    const parser=started();parser.parsePage(page(4,1));parser.parsePage(page(5,2));expect(()=>parser.finish()).toThrow("incomplete_document");
  });
});
