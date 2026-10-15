import {
  createMarylandModernReceiptParser, readMarylandReportPdfGeometry,
  type MarylandPdfPage, type MarylandPdfReceiptOccurrence,
} from "./marylandReportPdfGeometry.js";
import {
  createMarylandLegacyReceiptObservationParser,
  type MarylandLegacyReceiptOccurrence,
} from "./marylandLegacyReportPdfParser.js";
import { parseMarylandModernFinancialControls,type MarylandModernFinancialControls } from "./marylandReportFinancialControls.js";
import { parseMarylandLegacyFinancialControls } from "./marylandLegacyReportFinancialControls.js";

export class MarylandCompleteReceiptReportError extends Error {
  constructor(public readonly code: "page_order" | "section" | "receipt_reopening" | "receipt_family" | "incomplete_document",public readonly pageNumber?:number) {
    super(`Maryland complete receipt report: ${code}`);
  }
}
const fail=(code:MarylandCompleteReceiptReportError["code"]):never=>{throw new MarylandCompleteReceiptReportError(code);};
const clean=(s:string)=>s.trim().replace(/\s+/g," ");
const near=(a:number,b:number)=>Math.abs(a-b)<.02;
function sectionFourTotalsSpill(page:MarylandPdfPage) {
  if(page.width!==595||page.height!==842||page.cells.length!==6||page.borders.length!==10)return null;
  const labels=[
    ["Total Returned Expenditures",364.31,49.64],
    ["(Transfer to Detailed Summary, page 3, line 8)",295.37,63.28],
    ["Total Returned In-Kind Expenditures",327.09,89.64],
    // The publisher prints line 24 here; retain its literal caption. The
    // actual summary label for returned in-kind expenditures is control 25.
    ["(Transfer to Detailed Summary, page 3, line 24)",289.81,103.28],
  ] as const;
  const selected=new Set<unknown>();
  for(const [text,left,y]of labels){const matches=page.cells.filter(c=>c.text===text&&near(c.left,left)&&near(c.right,501)&&near(c.baselineTop,y)&&near(c.height,10));
    if(matches.length!==1)return null;selected.add(matches[0]);}
  const values:number[]=[];
  for(const y of [54.46,94.46]){const matches=page.cells.filter(c=>!selected.has(c)&&near(c.baselineTop,y)&&near(c.height,10)&&c.left>505&&c.left<571&&near(c.right,571));
    if(matches.length!==1)return null;const c=matches[0]!,m=/^\$((?:\d{1,3}(?:,\d{3})+|\d+))\.(\d{2})$/.exec(c.text);
    if(!m)return null;const cents=Number(m[1]!.replaceAll(",",""))*100+Number(m[2]);if(!Number.isSafeInteger(cents))return null;
    values.push(cents);selected.add(c);}
  if(selected.size!==6)return null;
  const expected=[31,71].flatMap(top=>[
    {x1:505,y1:top,x2:505,y2:top+40},{x1:19,y1:top,x2:576,y2:top},
    {x1:20,y1:top-1,x2:20,y2:top+41},{x1:19,y1:top+40,x2:576,y2:top+40},
    {x1:575,y1:top-1,x2:575,y2:top+41},
  ]);
  const remaining=[...page.borders];
  for(const e of expected){const index=remaining.findIndex(b=>near(b.x1,e.x1)&&near(b.y1,e.y1)&&near(b.x2,e.x2)&&near(b.y2,e.y2));if(index<0)return null;remaining.splice(index,1);}
  return {pageNumber:page.pageNumber,cashReturnedExpenditureCents:values[0]!,inKindReturnedExpenditureCents:values[1]!};
}

/** Every modern schedule page declares its physical section. The entire
 * document must be fed in order, including every page after receipts close.
 * No supplied page range or caller success flag selects the financial extent. */
export function createMarylandModernReceiptDocumentParser() {
  const parser=createMarylandModernReceiptParser();
  let lastPage=0,lastSection=0,firstReceiptPage:number|undefined,lastReceiptPage:number|undefined;
  let firstExpensePage:number|undefined,receiptPages=0,amendmentStatementPages=0;
  let spillRequiresSectionFive=false;
  const sectionFourTotalsSpills:NonNullable<ReturnType<typeof sectionFourTotalsSpill>>[]=[];
  const sectionPageCounts=[0,0,0,0,0,0];
  return {
    parsePage(page:MarylandPdfPage):MarylandPdfReceiptOccurrence[] {
      const fail=(code:MarylandCompleteReceiptReportError["code"]):never=>{throw new MarylandCompleteReceiptReportError(code,page.pageNumber);};
      if(page.pageNumber!==lastPage+1)fail("page_order");lastPage=page.pageNumber;
      if(page.pageNumber<=3){if(page.cells.some(c=>clean(c.text)==="Contributor Details"))fail("receipt_family");return [];}
      const receiptCaptions=new Set(["Contributor Details","Monetary Contributions","In-Kind Contributions",
        "Returned Monetary Contributions","Returned Transfer Contributions","Returned In-Kind Contributions"]);
      const captions=page.cells.filter(c=>/^Section\s+\d+$/.test(clean(c.text)));
      if(!captions.length&&lastSection===4&&!sectionFourTotalsSpills.length){const totals=sectionFourTotalsSpill(page);
        if(totals){sectionFourTotalsSpills.push(totals);sectionPageCounts[3]!++;spillRequiresSectionFive=true;return [];}}
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
      if(spillRequiresSectionFive&&section!==5)fail("section");spillRequiresSectionFive=false;
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
    finish(controls?:MarylandModernFinancialControls) {
      if(lastPage<5 || firstReceiptPage!==4 || !lastReceiptPage || !firstExpensePage ||
        firstExpensePage!==lastReceiptPage+1 || !sectionPageCounts[0] || !sectionPageCounts[1] || !sectionPageCounts[2] || spillRequiresSectionFive)fail("incomplete_document");
      for(const spill of sectionFourTotalsSpills){const cash=controls?.controls.filter(c=>c.number===8),inKind=controls?.controls.filter(c=>c.number===25);
        if(controls?.schema!=="modern_numbered_26"||cash?.length!==1||inKind?.length!==1||
          cash[0]!.amountCents!==spill.cashReturnedExpenditureCents||inKind[0]!.amountCents!==spill.inKindReturnedExpenditureCents)fail("section");}
      return {pageCount:lastPage,firstReceiptPage,lastReceiptPage,firstExpensePage,receiptPages,sectionPageCounts:[...sectionPageCounts],amendmentStatementPages,sectionFourTotalsSpills:[...sectionFourTotalsSpills]};
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
  const controls=parseMarylandModernFinancialControls(controlsPages[2]!),document=modern.finish(controls);
  return {format:"modern" as const,sourceFacts:{...geometry,...document},controls,privateOccurrences:modernRows};
}
