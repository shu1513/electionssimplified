import {describe,expect,it} from "vitest";
import {createMarylandModernReceiptDocumentParser as createParser} from "../../../src/pipeline/marylandFinance/marylandCompleteReceiptReportReader.js";
import type {MarylandPdfPage} from "../../../src/pipeline/marylandFinance/marylandReportPdfGeometry.js";
const page=(pageNumber:number,section?:number):MarylandPdfPage=>({pageNumber,width:595,height:842,borders:[],
  cells:section===undefined?[]:[{text:`Section ${section}`,left:25,right:95,baselineTop:55.54,height:16}]});
function started(){const parser=createParser();for(let n=1;n<=3;n++)parser.parsePage(page(n));return parser;}
describe("complete modern Maryland receipt document extent",()=>{
  it("holds a receipt table on reserved cover/control pages",()=>{
    for(const n of [1,2,3]){const parser=createParser();for(let p=1;p<n;p++)parser.parsePage(page(p));const source=page(n);
      source.cells=[{text:"Contributor Details",left:249,right:340,baselineTop:100,height:10}];
      expect(()=>parser.parsePage(source)).toThrow("receipt_family");}
  });
  it("derives receipt extent from every original page and checks later schedule pages",()=>{
    const parser=started();for(const [n,s]of [[4,1],[5,1],[6,2],[7,3],[8,4],[9,5],[10,6]])expect(parser.parsePage(page(n!,s))).toEqual([]);
    expect(parser.finish()).toEqual({pageCount:10,firstReceiptPage:4,lastReceiptPage:6,firstExpensePage:7,receiptPages:3,sectionPageCounts:[2,1,1,1,1,1],amendmentStatementPages:0});
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
