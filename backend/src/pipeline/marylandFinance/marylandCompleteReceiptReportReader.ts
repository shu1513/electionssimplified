import {
  createMarylandModernReceiptParser, readMarylandReportPdfGeometry,
  type MarylandPdfPage, type MarylandPdfReceiptOccurrence,
} from "./marylandReportPdfGeometry.js";
import {
  createMarylandLegacyReceiptObservationParser,
  type MarylandLegacyReceiptOccurrence,
} from "./marylandLegacyReportPdfParser.js";
import { parseMarylandModernFinancialControls } from "./marylandReportFinancialControls.js";
import { parseMarylandLegacyFinancialControls } from "./marylandLegacyReportFinancialControls.js";

export class MarylandCompleteReceiptReportError extends Error {
  constructor(public readonly code: "page_order" | "section" | "receipt_reopening" | "receipt_family" | "incomplete_document",public readonly pageNumber?:number) {
    super(`Maryland complete receipt report: ${code}`);
  }
}
const fail=(code:MarylandCompleteReceiptReportError["code"]):never=>{throw new MarylandCompleteReceiptReportError(code);};
const clean=(s:string)=>s.trim().replace(/\s+/g," ");

/** Every modern schedule page declares its physical section. The entire
 * document must be fed in order, including every page after receipts close.
 * No supplied page range or caller success flag selects the financial extent. */
export function createMarylandModernReceiptDocumentParser() {
  const parser=createMarylandModernReceiptParser();
  let lastPage=0,lastSection=0,firstReceiptPage:number|undefined,lastReceiptPage:number|undefined;
  let firstExpensePage:number|undefined,receiptPages=0,amendmentStatementPages=0;
  const sectionPageCounts=[0,0,0,0,0,0];
  return {
    parsePage(page:MarylandPdfPage):MarylandPdfReceiptOccurrence[] {
      const fail=(code:MarylandCompleteReceiptReportError["code"]):never=>{throw new MarylandCompleteReceiptReportError(code,page.pageNumber);};
      if(page.pageNumber!==lastPage+1)fail("page_order");lastPage=page.pageNumber;
      if(page.pageNumber<=3){if(page.cells.some(c=>clean(c.text)==="Contributor Details"))fail("receipt_family");return [];}
      const receiptCaptions=new Set(["Contributor Details","Monetary Contributions","In-Kind Contributions",
        "Returned Monetary Contributions","Returned Transfer Contributions","Returned In-Kind Contributions"]);
      const captions=page.cells.filter(c=>/^Section\s+\d+$/.test(clean(c.text)));
      const statements=page.cells.filter(c=>clean(c.text)==="AMENDMENT STATEMENT");
      if(statements.length){const title=statements[0]!;
        if(statements.length!==1 || captions.length || lastSection!==6 || Math.abs(title.left-23)>.01 || Math.abs(title.baselineTop-55.54)>.01 ||
          Math.abs(title.height-16)>.01 || page.width!==595 || page.height!==842)fail("section");
        if(page.cells.some(c=>receiptCaptions.has(clean(c.text))))fail("receipt_reopening");
        amendmentStatementPages++;return [];
      }
      if(captions.length!==1)fail("section");
      const caption=captions[0]!,match=/^Section ([1-6])$/.exec(clean(caption.text));
      if(!match || Math.abs(caption.left-25)>.01 || Math.abs(caption.baselineTop-55.54)>.01 || Math.abs(caption.height-16)>.01 ||
        page.width!==595 || page.height!==842)fail("section");
      const section=Number(match![1]);
      if(amendmentStatementPages)fail(section<=2?"receipt_reopening":"section");
      if(section<lastSection)fail(section<=2?"receipt_reopening":"section");
      if(page.pageNumber===4 && section!==1)fail("section");
      lastSection=section;sectionPageCounts[section-1]!++;
      if(section<=2) {
        firstReceiptPage??=page.pageNumber;lastReceiptPage=page.pageNumber;receiptPages++;
        const rows=parser.parsePage(page);
        if(rows.some(r=>(section===1)!==(r.role==="gift")))fail("receipt_family");
        return rows;
      }
      firstExpensePage??=page.pageNumber;
      // Later schedules cannot hide a reopened receipt table under a different
      // section number. Exact receipt table/section captions remain reserved.
      if(page.cells.some(c=>receiptCaptions.has(clean(c.text))))fail("receipt_reopening");
      return [];
    },
    finish() {
      if(lastPage<5 || firstReceiptPage!==4 || !lastReceiptPage || !firstExpensePage ||
        firstExpensePage!==lastReceiptPage+1 || !sectionPageCounts[0] || !sectionPageCounts[1] || !sectionPageCounts[2])fail("incomplete_document");
      return {pageCount:lastPage,firstReceiptPage,lastReceiptPage,firstExpensePage,receiptPages,sectionPageCounts:[...sectionPageCounts],amendmentStatementPages};
    },
  };
}

/** Original-byte source facts only. Capture integrity, actual report binding,
 * complete native collections, identity comparison and acceptance stay with
 * the ordinary packet reader. Private physical rows must remain in memory. */
export async function readMarylandCompleteReceiptReport(bytes:Uint8Array) {
  let format:"modern"|"legacy"|undefined;
  const modern=createMarylandModernReceiptDocumentParser(),legacy=createMarylandLegacyReceiptObservationParser();
  const modernRows:MarylandPdfReceiptOccurrence[]=[],legacyRows:MarylandLegacyReceiptOccurrence[]=[];
  const controlsPages:MarylandPdfPage[]=[];
  const geometry=await readMarylandReportPdfGeometry(bytes,page=>{
    if(page.pageNumber===1)format=page.width===612?"legacy":"modern";
    if(page.pageNumber<=3)controlsPages.push(page);
    if(format==="legacy")legacyRows.push(...legacy.parsePage(page));
    else modernRows.push(...modern.parsePage(page));
  });
  if(format==="legacy") {
    legacyRows.push(...legacy.flushPending());
    const facts=legacy.finish(),controls=parseMarylandLegacyFinancialControls({page1:controlsPages[0]!,page2:controlsPages[1]!});
    const observations={...geometry,sourceFacts:facts,privateUnknownContinuations:legacy.privateUnknownContinuations(),
      privateInKindFinancialOccurrences:legacy.privateInKindFinancialOccurrences(),
      privateInKindDescriptionUncertainty:legacy.privateInKindDescriptionUncertainty(),privateInKindScheduleTotals:legacy.privateInKindScheduleTotals()};
    return {format:"legacy" as const,sourceFacts:{...geometry,...facts},controls,observations,privateOccurrences:legacyRows};
  }
  const document=modern.finish(),controls=parseMarylandModernFinancialControls(controlsPages[2]!);
  return {format:"modern" as const,sourceFacts:{...geometry,...document},controls,privateOccurrences:modernRows};
}
