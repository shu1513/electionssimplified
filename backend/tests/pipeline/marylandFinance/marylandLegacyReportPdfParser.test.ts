import { describe, expect, it } from "vitest";
import { createMarylandLegacyReceiptParser, createMarylandLegacyReceiptObservationParser } from "../../../src/pipeline/marylandFinance/marylandLegacyReportPdfParser.js";
import type {
  MarylandPdfCell,
  MarylandPdfPage,
} from "../../../src/pipeline/marylandFinance/marylandReportPdfGeometry.js";

const cell = (
  text: string,
  left: number,
  baselineTop: number,
  width = 30,
): MarylandPdfCell => ({
  text,
  left,
  right: left + width,
  baselineTop,
  height: 10,
});
const columns = [17.56, 89.31, 269.31, 327.36, 399.36, 507.36, 593.06];
function ruledRow(top = 210, bottom = 250, xs = columns) {
  return [
    { x1: 17.56, x2: 89.435, y1: top, y2: top },
    { x1: 17.56, x2: 89.435, y1: bottom, y2: bottom },
    { x1: 89.31, x2: xs.at(-1)!, y1: top, y2: top },
    { x1: 89.31, x2: xs.at(-1)!, y1: bottom, y2: bottom },
    ...xs.map((x) => ({ x1: x, x2: x, y1: top, y2: bottom })),
  ];
}
function page(pageNumber = 1, withHeader = true): MarylandPdfPage {
  return {
    pageNumber,
    width: 612,
    height: 792,
    cells: [
      ...(withHeader
        ? [
            cell("Contributions", 266.256, 100, 90),
            cell("Date", 19.296, 186),
            cell("Received", 19.296, 197.16),
            cell("Name and Address of Contributor", 91.296, 186, 160),
            cell("Aggregate to", 329.328, 186),
            cell("Date", 329.328, 197.16),
            cell("Paid by", 401.328, 186),
            cell("Contributions", 509.328, 186, 70),
            cell("Amount", 509.328, 197.16),
          ]
        : []),
      cell("01/02/2025", 37.224, 225, 50),
      cell("SYNTHETIC DONOR", 91.296, 225, 120),
      cell("TEST ADDRESS", 91.296, 237, 110),
      cell("$999.00", 329.328, 225, 55),
      cell("Check", 401.328, 225),
      cell("$25.00", 509.328, 225, 50),
    ],
    borders: ruledRow(),
  };
}
function returns(): MarylandPdfPage {
  const p = page();
  p.cells = [
    cell("Expenditures", 267.552, 100, 90),
    cell("Z - Returned Contribution", 232.632, 115, 145),
    cell("Date", 19.296, 186),
    cell("Received", 19.296, 197.16),
    cell("Name and Address of Payee", 163.296, 186, 135),
    cell("Special", 456.12, 186),
    cell("Account", 454.968, 197.16),
    cell("Amount", 505.296, 186),
    cell("01/02/2025", 37.224, 225, 50),
    cell("SYNTHETIC RETURN OWNER", 163.296, 225, 135),
    cell("$25.00", 505.296, 225, 50),
  ];
  p.borders = ruledRow(
    210,
    250,
    [17.56, 89.31, 161.31, 305.31, 446.627, 503.31, 593.06],
  );
  return p;
}

function unknownContinuation() {
  const next = page(2, false);
  next.cells = next.cells.map(c => ({...c, baselineTop: c.baselineTop - 113.64}));
  next.cells.push(cell("SYNTHETIC IDENTITY WRAP", 91.296, 90, 130),
    cell("UNCLASSIFIED SOURCE FIELD", 335, 90, 140));
  next.borders = [...ruledRow(78.61, 96.36, [17.56, 89.31, 269.31, 593.06]),
    ...ruledRow(96.36, 136.36)];
  return next;
}
function inKindPage() {
  const p=page();
  p.cells=[cell("Other Receipts and In-Kind Contributions",187.272,100,200),
    cell("(b) In-Kind Contributions",117.864,114,160),cell("Date",19.296,186),
    cell("Received",19.296,197.16),cell("Complete Name and Address of Payer",91.296,186,200),
    cell("Aggregate to",415.296,186),cell("Special",366.768,186),cell("Amount",505.296,186),
    cell("01/02/2025",37.224,225,50),cell("SYNTHETIC OWNER",91.296,225,100),
    cell("$25.00",505.296,225,50)];
  p.borders=ruledRow(210,250,[17.56,89.31,358.083,413.31,503.31,593.06]);
  return p;
}
function mergedInKindContinuation() {
  const next:MarylandPdfPage={pageNumber:2,width:612,height:792,cells:[
    cell("UNKNOWN MERGED SOURCE FIELD",91.296,90,150),
    cell("01/02/2025",37.224,110,50),cell("SYNTHETIC NEXT OWNER",91.296,110,130),
    cell("$25.00",505.296,110,50)],
    borders:[...ruledRow(78.61,96.36,[17.56,89.31,503.31,593.06]),
      ...ruledRow(96.36,136.36,[17.56,89.31,358.083,413.31,503.31,593.06])]};
  return next;
}
function addInKindTotal(p:MarylandPdfPage,top:number,amount="$25.00") {
  p.borders.push(...ruledRow(top,top+17.75,[17.56,503.31,593.06]));
  p.cells.push(cell("Total",477.36,top+11.078,25),cell(amount,541.224,top+11.078,50));
  return p;
}

describe("legacy Maryland source observations", () => {
  it("retains every in-kind financial row and report-level uncertainty without any donor identity",()=>{
    const parser=createMarylandLegacyReceiptObservationParser();parser.parsePage(inKindPage());
    const result=parser.parsePage(addInKindTotal(mergedInKindContinuation(),136.36,"$50.00"));
    expect(result).toEqual([]);expect(parser.flushPending()).toEqual([]);
    expect(parser.privateInKindFinancialOccurrences()).toHaveLength(2);
    expect(parser.privateInKindFinancialOccurrences()[0]).toMatchObject({date:"2025-01-02",amountCents:2500});
    expect(parser.privateInKindFinancialOccurrences()[0]).not.toHaveProperty("nameAddress");
    expect(parser.privateUnknownContinuations()).toEqual([]);
    expect(parser.privateInKindDescriptionUncertainty()).toEqual([expect.objectContaining({pageNumber:2,cellCount:1})]);
    expect(parser.privateInKindDescriptionUncertainty()[0]).not.toHaveProperty("parentPageNumber");
    expect(parser.finish()).toMatchObject({inKindIdentityScope:"unavailable",counts:{in_kind:2},totalsCents:{in_kind:5000}});
    expect(JSON.stringify(parser.privateInKindFinancialOccurrences())).not.toContain("SYNTHETIC");
    const strict=createMarylandLegacyReceiptParser();strict.parsePage(inKindPage());
    expect(()=>strict.parsePage(mergedInKindContinuation())).toThrow("identity");
  });
  it("holds in-kind descriptions with missing bounds, apparent money/date or cross-row glyphs",()=>{
    for(const mode of ["border","money","date","glyph","unbounded"] as const){
      const parser=createMarylandLegacyReceiptObservationParser();parser.parsePage(inKindPage());
      const next=addInKindTotal(mergedInKindContinuation(),136.36,"$50.00");
      if(mode==="border")next.borders=next.borders.filter(b=>!(b.x1===593.06&&b.y1===78.61));
      if(mode==="money")next.cells[0]!.text="$25.00";
      if(mode==="date")next.cells[0]!.text="01/02/2025";
      if(mode==="glyph")next.cells[0]!.height=20;
      if(mode==="unbounded")next.cells.push(cell("UNBOUNDED FIELD",91.296,170,100));
      expect(()=>parser.parsePage(next)).toThrow();
    }
  });
  it("allows a footer-only in-kind continuation with bounded description and exact reconciled Total",()=>{
    const parser=createMarylandLegacyReceiptObservationParser(),previous=inKindPage();
    previous.borders.push(...ruledRow(250,270,[17.56,89.31,358.083,413.31,503.31,593.06]));
    parser.parsePage(previous);
    const footer=mergedInKindContinuation();footer.cells=footer.cells.slice(0,1);footer.borders=ruledRow(78.61,96.37,[17.56,89.31,503.31,593.06]);
    expect(parser.parsePage(addInKindTotal(footer,96.37))).toEqual([]);
    parser.flushPending();expect(parser.finish()).toMatchObject({counts:{in_kind:1},totalsCents:{in_kind:2500},inKindDescriptionUncertaintyCount:1});
  });
  it("retains only nonfinancial footer glyphs outside a closed in-kind ledger with intersecting partial rules",()=>{
    for(const mode of ["valid","money","date","inside","grid","no_rule"] as const){
      const parser=createMarylandLegacyReceiptObservationParser(),source=inKindPage();
      source.borders.push({x1:20,x2:200,y1:280,y2:280},{x1:20,x2:200,y1:288,y2:288});
      source.cells.push(cell(mode==="money"?"$25.00":mode==="date"?"01/02/2025":"UNCLASSIFIED FOOTER",30,285,130));
      if(mode==="inside")source.cells.at(-1)!.baselineTop=255;
      if(mode==="grid")source.borders.push({x1:503.31,x2:503.31,y1:250,y2:290});
      if(mode==="no_rule")source.borders=source.borders.filter(b=>b.y1!==280&&b.y1!==288);
      if(mode!=="valid"){expect(()=>parser.parsePage(source)).toThrow();continue;}
      expect(parser.parsePage(source)).toEqual([]);
      expect(parser.privateInKindDescriptionUncertainty()).toEqual([expect.objectContaining({geometry:"outside_closed_ledger",cellCount:1,top:275,bottom:285})]);
      const footer:MarylandPdfPage={pageNumber:2,width:612,height:792,cells:[],borders:[]};
      parser.parsePage(addInKindTotal(footer,78.61));parser.flushPending();expect(parser.finish().totalsCents.in_kind).toBe(2500);
    }
  });
  it("requires exact in-kind Total closure and complete dated financial rows",()=>{
    for(const mode of ["missing_total","changed_total","total_border","missing_date","missing_amount","section"] as const){
      const parser=createMarylandLegacyReceiptObservationParser(),source=inKindPage();
      if(mode==="missing_date")source.cells=source.cells.filter(c=>c.text!=="01/02/2025");
      if(mode==="missing_amount")source.cells=source.cells.filter(c=>c.text!=="$25.00");
      if(mode!=="missing_total" && mode!=="section")addInKindTotal(source,250,mode==="changed_total"?"$26.00":"$25.00");
      if(mode==="total_border")source.borders.push({x1:89.31,x2:89.31,y1:250,y2:267.75});
      expect(()=>{parser.parsePage(source);if(mode==="section")parser.parsePage({...returns(),pageNumber:2});parser.flushPending();parser.finish();}).toThrow();
    }
  });
  it("requires a same-page final reconciled Total to close a merged ledger before unknown footer glyphs",()=>{
    for(const mode of ["valid","money","grid","wrong_total","later_rule","prior_total"] as const) {
      const parser=createMarylandLegacyReceiptObservationParser();
      let source=addInKindTotal(inKindPage(),250,mode==="wrong_total"?"$26.00":"$25.00");
      if(mode==="prior_total") {
        parser.parsePage(source);
        source={pageNumber:2,width:612,height:792,cells:[],borders:ruledRow(78.61,96.36,[17.56,503.31,593.06])};
      }
      source.borders.push({x1:20,x2:200,y1:280,y2:280},{x1:20,x2:200,y1:288,y2:288});
      source.cells.push(cell(mode==="money"?"$25.00":"UNKNOWN FOOTER GLYPHS",30,285,130));
      if(mode==="grid")source.borders.push({x1:503.31,x2:503.31,y1:267.75,y2:290});
      if(mode==="later_rule")source.borders.push({x1:17.56,x2:593.06,y1:275,y2:275});
      if(mode!=="valid"){expect(()=>parser.parsePage(source)).toThrow();continue;}
      expect(parser.parsePage(source)).toEqual([]);parser.flushPending();
      expect(parser.finish()).toMatchObject({counts:{in_kind:1},totalsCents:{in_kind:2500},inKindDescriptionUncertaintyCount:1});
      expect(parser.privateInKindDescriptionUncertainty()[0]).toMatchObject({geometry:"outside_closed_ledger",cellCount:1});
    }
  });
  it("does not require or expose an in-kind donor identity in observation mode",()=>{
    const source=inKindPage();source.cells=source.cells.filter(c=>c.text!=="SYNTHETIC OWNER");
    const observed=createMarylandLegacyReceiptObservationParser();observed.parsePage(addInKindTotal(source,250));
    expect(observed.privateInKindFinancialOccurrences()).toHaveLength(1);
    observed.flushPending();expect(observed.finish().totalsCents.in_kind).toBe(2500);
    expect(()=>createMarylandLegacyReceiptParser().parsePage(source)).toThrow("identity");
  });
  it("holds full glyph envelopes crossing either financial-region boundary while allowing exact source titles",()=>{
    const start=createMarylandLegacyReceiptObservationParser(),source=addInKindTotal(inKindPage(),250);
    source.cells.push(cell("UNKNOWN START CROSSING",91.296,199,130));
    expect(()=>start.parsePage(source)).toThrow("row_border");
    for(const crossing of [false,true]){
      const parser=createMarylandLegacyReceiptObservationParser();parser.parsePage(addInKindTotal(inKindPage(),250));
      const next={...returns(),pageNumber:2};if(crossing)next.cells.push({...cell("UNKNOWN END CROSSING",91.296,100,130),height:8});
      if(crossing)expect(()=>parser.parsePage(next)).toThrow("row_border");
      else {expect(parser.parsePage(next)).toEqual([]);parser.flushPending();expect(parser.finish().totalsCents.in_kind).toBe(2500);}
    }
  });
  it("holds in-kind financial rows outside the supported page body instead of skipping them after Total",()=>{
    for(const withDate of [true,false]) {
      const parser=createMarylandLegacyReceiptObservationParser(),source=addInKindTotal(inKindPage(),250);
      source.borders.push(...ruledRow(755,780,[17.56,89.31,358.083,413.31,503.31,593.06]));
      if(withDate)source.cells.push(cell("01/02/2025",37.224,770,50));
      source.cells.push(cell("$25.00",541.224,770,50));
      expect(()=>parser.parsePage(source)).toThrow(withDate?"date":"amount");
    }
    const parser=createMarylandLegacyReceiptObservationParser();parser.parsePage(inKindPage());
    const next:MarylandPdfPage={pageNumber:2,width:612,height:792,cells:[cell("01/02/2025",37.224,50,50),cell("$25.00",541.224,50,50)],
      borders:ruledRow(30,65,[17.56,89.31,358.083,413.31,503.31,593.06])};
    addInKindTotal(next,78.61);expect(()=>parser.parsePage(next)).toThrow("date");
  });
  it("recognizes only the exact labeled report due date in the running header",()=>{
    for(const mode of ["valid","no_label","moved_label","moved_date","no_rule","extra_money"] as const) {
      const parser=createMarylandLegacyReceiptObservationParser();parser.parsePage(inKindPage());
      const source=addInKindTotal({pageNumber:2,width:612,height:792,cells:[],borders:[]},78.61);
      const label={...cell("Report Due Date :",422.784,62.28,64.464),height:7.999};
      const due={...cell("01/02/2025",498.744,62.28,40.027),height:7.999};
      if(mode!=="no_label")source.cells.push(label);
      source.cells.push(due);
      if(mode==="moved_label")label.baselineTop+=1;
      if(mode==="moved_date")due.baselineTop+=1;
      if(mode!=="no_rule")source.borders.push({x1:7.2,x2:604.8,y1:72.36,y2:72.36});
      if(mode==="extra_money")source.cells.push(cell("$25.00",541.224,50,50));
      if(mode!=="valid"){expect(()=>parser.parsePage(source)).toThrow("amount");continue;}
      expect(parser.parsePage(source)).toEqual([]);parser.flushPending();
      expect(parser.finish()).toMatchObject({counts:{in_kind:1},totalsCents:{in_kind:2500}});
    }
  });
  it("retains a continuation-only page until the next occurrence or explicit flush", () => {
    const parser = createMarylandLegacyReceiptObservationParser(); parser.parsePage(page());
    const next = unknownContinuation();
    next.cells = next.cells.filter(c => c.baselineTop < 96);
    next.borders = ruledRow(78.61, 96.36, [17.56, 89.31, 269.31, 593.06]);
    expect(parser.parsePage(next)).toEqual([]);
    expect(parser.privateUnknownContinuations()).toHaveLength(1);
    expect(parser.flushPending()[0]!.nameAddress).toContain("SYNTHETIC IDENTITY WRAP");
    expect(parser.finish().counts.contributions).toBe(1);
  });
  it("processes leading continuation before a new table header", () => {
    const parser = createMarylandLegacyReceiptObservationParser(); parser.parsePage(page());
    const next = page(2);
    next.cells.find(c=>c.text==="Contributions"&&c.left<350)!.baselineTop=110;
    next.cells.push(cell("SYNTHETIC WRAP", 91.296, 90, 100));
    next.borders.push(...ruledRow(78.61, 96.36, [17.56, 89.31, 269.31]));
    expect(parser.parsePage(next)[0]!.nameAddress).toContain("SYNTHETIC WRAP");
  });
  it("recognizes printed schedule furniture before a new exact receipt table", () => {
    const parser = createMarylandLegacyReceiptObservationParser(); parser.parsePage(page());
    const next = page(2);
    next.cells.find(c => c.text === "Contributions" && c.left < 350)!.baselineTop = 106.44;
    next.cells.push(cell("Schedule - 1", 19.296, 100.104, 69.443));
    expect(parser.parsePage(next)).toHaveLength(1);
    const unknown = createMarylandLegacyReceiptObservationParser(); unknown.parsePage(page());
    next.cells.at(-1)!.text = "UNKNOWN FIELD";
    expect(() => unknown.parsePage(next)).toThrow("header");
  });
  it("does not reuse previous page context for the next exact printed header band", () => {
    const parser = createMarylandLegacyReceiptObservationParser(); parser.parsePage(page());
    const next = page(2);
    next.borders.push(...ruledRow(160, 175));
    next.cells.push(cell("HEADER SUMMARY", 509.328, 170, 70));
    expect(parser.parsePage(next)).toHaveLength(1);
  });
  it("holds unknown text without complete outer cell borders or glyph bounds", () => {
    for (const mode of ["vertical", "horizontal", "glyph", "glyph_below"] as const) {
      const parser = createMarylandLegacyReceiptObservationParser(); parser.parsePage(page());
      const next = unknownContinuation();
      if (mode === "vertical") next.borders = next.borders.filter(b => !(b.x1 === 593.06 && b.y1 === 78.61));
      if (mode === "horizontal") next.borders = next.borders.map(b => b.y1 === 78.61 && b.x1 === 89.31 ? {...b, x2:269.31} : b);
      if (mode === "glyph") next.cells.at(-1)!.height = 20;
      if (mode === "glyph_below") next.cells.at(-1)!.baselineTop = 100;
      expect(() => parser.parsePage(next)).toThrow();
    }
  });
  it("holds orphan strips, unruled leading text and missing identity horizontal edges", () => {
    const orphan = unknownContinuation(); orphan.pageNumber = 1;
    orphan.cells = orphan.cells.filter(c => c.baselineTop < 96);
    orphan.borders = ruledRow(78.61, 96.36, [17.56, 89.31, 269.31]);
    expect(() => createMarylandLegacyReceiptObservationParser().parsePage(orphan)).toThrow("header");
    for (const missing of [true, false]) {
      const parser = createMarylandLegacyReceiptObservationParser(); parser.parsePage(page());
      const next = unknownContinuation();
      if (missing) next.borders = next.borders.filter(b => !(b.y1 === b.y2 && b.x1 === 89.31));
      else next.cells.push(cell("UNRULED", 91.296, 79, 80));
      expect(() => parser.parsePage(next)).toThrow("row_border");
    }
  });
  it("retains unknown nonfinancial continuation references without accepting a donor identity", () => {
    const strict = createMarylandLegacyReceiptParser(); strict.parsePage(page());
    expect(() => strict.parsePage(unknownContinuation())).toThrow("identity");
    const parser = createMarylandLegacyReceiptObservationParser(); parser.parsePage(page());
    const rows = parser.parsePage(unknownContinuation());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.nameAddress).toBe("SYNTHETIC DONOR TEST ADDRESS SYNTHETIC IDENTITY WRAP");
    const unknown = parser.privateUnknownContinuations();
    expect(unknown).toEqual([expect.objectContaining({pageNumber: 2, parentPageNumber: 1,
      parentOrdinal: 0, date: "2025-01-02", amountCents: 2500, cellCount: 1})]);
    expect(JSON.stringify(unknown)).not.toContain("UNCLASSIFIED");
    expect(JSON.stringify(unknown)).not.toContain("SYNTHETIC");
    parser.flushPending();
    expect(parser.finish()).toMatchObject({unclassifiedContinuationCount: 1,
      counts: {contributions: 2}, totalsCents: {contributions: 5000}});
    expect(parser.finish()).not.toHaveProperty("qualified");
  });
  it.each(["$25.00", "$1e3", "25.00", "01/02/2025", "01/02/25"])(
    "holds possible financial continuation %s", text => {
      const parser = createMarylandLegacyReceiptObservationParser(); parser.parsePage(page());
      const next = unknownContinuation(); next.cells.at(-1)!.text = text;
      expect(() => parser.parsePage(next)).toThrow("identity");
    });
  it("observes a source split with blank financial cells and a bounded aggregate continuation", () => {
    const parser = createMarylandLegacyReceiptObservationParser(); parser.parsePage(page());
    const next = unknownContinuation();
    Object.assign(next.cells.at(-1)!, {left:329.328,right:383.233});
    next.borders = [...ruledRow(78.61, 96.36), ...ruledRow(96.36, 136.36)];
    expect(parser.parsePage(next)).toHaveLength(1);
    expect(parser.privateUnknownContinuations()).toHaveLength(1);
    const strict = createMarylandLegacyReceiptParser(); strict.parsePage(page());
    expect(() => strict.parsePage(next)).toThrow("identity");
  });
  it("holds full-grid strips without a preceding last painted row or with any financial-field text", () => {
    for (const mode of ["trailing_text", "trailing_rule", "long_rules", "paid_by", "amount", "other_field"] as const) {
      const parser = createMarylandLegacyReceiptObservationParser(), previous = page();
      if (mode === "trailing_text") previous.cells.push(cell("UNCLASSIFIED TRAILER", 91.296, 270, 130));
      if (mode === "trailing_rule") previous.borders.push(...ruledRow(250, 270));
      if (mode === "long_rules") previous.borders = previous.borders.map(b=>b.x1===b.x2?{...b,y2:270}:b);
      parser.parsePage(previous);
      const next = unknownContinuation();
      next.borders = [...ruledRow(78.61, 96.36), ...ruledRow(96.36, 136.36)];
      if (mode === "paid_by") next.cells.push(cell("Check", 401.328, 90, 30));
      if (mode === "amount") next.cells.push(cell("UNREADABLE AMOUNT", 509.328, 90, 70));
      if (mode === "other_field") Object.assign(next.cells.at(-1)!, {left: 455, right: 490});
      expect(() => parser.parsePage(next)).toThrow("date");
    }
  });
  it("keeps partial-rule footer fields outside the closed ledger but holds later financial text", () => {
    for (const financial of [false,true]) {
      const previous = page();
      previous.borders.push({x1:20,x2:200,y1:734,y2:734}, {x1:20,x2:200,y1:745,y2:745});
      previous.cells.push(cell(financial ? "$25.00" : "SOURCE FOOTER FIELD", 30, 742, 100));
      const parser = createMarylandLegacyReceiptObservationParser(); parser.parsePage(previous);
      const next = unknownContinuation(); Object.assign(next.cells.at(-1)!, {left:329.328,right:383.233});
      next.borders = [...ruledRow(78.61,96.36),...ruledRow(96.36,136.36)];
      if (financial) expect(()=>parser.parsePage(next)).toThrow("date");
      else expect(parser.parsePage(next)).toHaveLength(1);
    }
  });
  it("refuses unknown text in the date column or crossing the identity boundary", () => {
    for (const [left, right] of [[20, 80], [260, 300], [590, 620]]) {
      const parser = createMarylandLegacyReceiptObservationParser(); parser.parsePage(page());
      const next = unknownContinuation(); Object.assign(next.cells.at(-1)!, {left, right});
      expect(() => parser.parsePage(next)).toThrow();
    }
  });
  it("does not turn an unknown return caption into an accepted source family", () => {
    const source = returns();
    source.cells.find(c => c.text === "Z - Returned Contribution")!.text = "(g) Returned Contribution";
    expect(() => createMarylandLegacyReceiptObservationParser().parsePage(source)).toThrow("header");
  });
  it("requires complete continuation borders, a pending row and consecutive pages", () => {
    const parser = createMarylandLegacyReceiptObservationParser(); parser.parsePage(page());
    const next = unknownContinuation(); next.borders = next.borders.filter(b => b.x1 !== 269.31);
    expect(() => parser.parsePage(next)).toThrow("column_border");
    expect(() => createMarylandLegacyReceiptObservationParser().parsePage(unknownContinuation())).toThrow("invalid_page");
    const skipped = createMarylandLegacyReceiptObservationParser(); skipped.parsePage(page());
    expect(() => skipped.parsePage({...unknownContinuation(), pageNumber: 3})).toThrow("invalid_page");
  });
});

describe("legacy Maryland receipt geometry", () => {
  it("holds dated identity glyphs extending into adjacent physical rows", () => {
    for(const baseline of [215,255]){
      const source=page();source.cells.push(cell("CROSSED ROW GLYPH",91.296,baseline,100));
      expect(()=>createMarylandLegacyReceiptParser().parsePage(source)).toThrow("row_border");
    }
  });
  it("holds dated identity text crossing either boundary instead of dropping it", () => {
    for (const [left, width] of [[80, 30], [260, 30]]) {
      const source = page(); source.cells.push(cell("UNRESOLVED CROSSING", left, 240, width));
      expect(() => createMarylandLegacyReceiptParser().parsePage(source)).toThrow("identity");
    }
  });
  it("uses monetary cell rather than aggregate and retains literal identity and payment", () => {
    const parser = createMarylandLegacyReceiptParser();
    expect(parser.parsePage(page())).toEqual([]);
    expect(parser.flushPending()).toEqual([
      expect.objectContaining({
        amountCents: 2500,
        date: "2025-01-02",
        nameAddress: "SYNTHETIC DONOR TEST ADDRESS",
        paidBy: "Check",
        tableKind: "contributions",
        role: "gift",
      }),
    ]);
    expect(parser.finish().totalsCents.contributions).toBe(2500);
    expect(JSON.stringify(parser.finish())).not.toContain("SYNTHETIC");
  });
  it("retains header context across sequential continuation pages and equal occurrences", () => {
    const parser = createMarylandLegacyReceiptParser();
    parser.parsePage(page());
    const continuation = page(2, false);
    continuation.cells = continuation.cells.map((c) => ({
      ...c,
      baselineTop: c.baselineTop - 131.39,
    }));
    continuation.borders = ruledRow(78.61, 118.61);
    expect(parser.parsePage(continuation)).toHaveLength(1);
    parser.flushPending();
    expect(parser.finish().counts.contributions).toBe(2);
  });
  it("rejects unknown intervening sections and clears context after empty pages", () => {
    const parser = createMarylandLegacyReceiptParser();
    parser.parsePage(page());
    expect(() => parser.parsePage(page(2, false))).toThrow("header");
    const second = createMarylandLegacyReceiptParser();
    second.parsePage(page());
    expect(() => second.parsePage({
      pageNumber: 2,
      width: 612,
      height: 792,
      cells: [cell("Synthetic subtotal", 200, 150)],
      borders: [],
    })).toThrow();
  });
  it("rejects orphan continuations and missing pages", () => {
    expect(() =>
      createMarylandLegacyReceiptParser().parsePage(page(1, false)),
    ).toThrow("header");
    expect(() =>
      createMarylandLegacyReceiptParser().parsePage(page(2)),
    ).toThrow("invalid_page");
  });
  it("ignores inset background rectangles when binding ruled columns", () => {
    const p = page();
    p.borders = [
      ...p.borders,
      ...ruledRow(220, 230, [20, 80, 95, 250, 520, 585]).filter(b => b.x1 === b.x2),
    ];
    // Insets do not have the observed full date-cell width.
    const parser = createMarylandLegacyReceiptParser();
    parser.parsePage(p);
    expect(parser.flushPending()).toHaveLength(1);
  });
  it("requires each actual ruled column to span the entire physical row", () => {
    const p = page();
    p.borders = p.borders.filter((b) => b.x1 !== 269.31);
    expect(() => createMarylandLegacyReceiptParser().parsePage(p)).toThrow(
      "column_border",
    );
  });
  it("rejects missing row borders, duplicate date cells and malformed money", () => {
    const missing = page();
    missing.borders = [];
    expect(() =>
      createMarylandLegacyReceiptParser().parsePage(missing),
    ).toThrow("row_border");
    const duplicate = page();
    duplicate.cells = [...duplicate.cells, cell("01/02/2025", 37.224, 236, 50)];
    expect(() =>
      createMarylandLegacyReceiptParser().parsePage(duplicate),
    ).toThrow("duplicate_date_cell");
    const bad = page();
    bad.cells = bad.cells.map((c) =>
      c.left === 509.328 && c.baselineTop === 225
        ? { ...c, text: "$25x00" }
        : c,
    );
    expect(() => createMarylandLegacyReceiptParser().parsePage(bad)).toThrow(
      "amount",
    );
  });
  it("rejects impossible days, unknown header and modern dimensions", () => {
    const bad = page();
    bad.cells = bad.cells.map((c) =>
      c.text === "01/02/2025" ? { ...c, text: "02/30/2025" } : c,
    );
    expect(() => createMarylandLegacyReceiptParser().parsePage(bad)).toThrow(
      "date",
    );
    const unknown = page();
    unknown.cells = unknown.cells.map((c) =>
      c.text === "Paid by" ? { ...c, text: "Unverified" } : c,
    );
    expect(() =>
      createMarylandLegacyReceiptParser().parsePage(unknown),
    ).toThrow("header");
    expect(() =>
      createMarylandLegacyReceiptParser().parsePage({
        ...page(),
        width: 595,
        height: 842,
      }),
    ).toThrow("invalid_page");
  });
  it("rejects a missing or malformed date in a ruled monetary row instead of omitting it", () => {
    const p = page();
    p.cells = p.cells.filter((c) => c.text !== "01/02/2025");
    expect(() => createMarylandLegacyReceiptParser().parsePage(p)).toThrow(
      "date",
    );
    const malformed = page();
    malformed.cells = malformed.cells.map((c) =>
      c.text === "01/02/2025" ? { ...c, text: "01/02/25" } : c,
    );
    expect(() =>
      createMarylandLegacyReceiptParser().parsePage(malformed),
    ).toThrow("date");
  });
  it("leaves all expenditure occurrences to the separate return reader", () => {
    const parser = createMarylandLegacyReceiptParser();
    parser.parsePage(returns());
    expect(parser.flushPending()).toEqual([]);
    const shifted=returns();shifted.cells.find(c=>c.text==="Amount")!.left=506.088;
    expect(createMarylandLegacyReceiptParser().parsePage(shifted)).toEqual([]);
    const p = returns();
    p.cells = p.cells.map((c) =>
      c.text === "Z - Returned Contribution"
        ? { ...c, text: "(a) Operating Expenditure" }
        : c,
    );
    expect(createMarylandLegacyReceiptParser().parsePage(p)).toEqual([]);
    const unknown = returns();
    unknown.cells = unknown.cells.map((c) =>
      c.text === "Z - Returned Contribution"
        ? { ...c, text: "Unverified Returned Contribution" }
        : c,
    );
    expect(() =>
      createMarylandLegacyReceiptParser().parsePage(unknown),
    ).toThrow("header");
  });
  it("skips expense details only after known closure and strictly re-enters later receipts",()=>{
    const parser=createMarylandLegacyReceiptParser();parser.parsePage(returns());
    const detail=returns();detail.pageNumber=2;Object.assign(detail.cells.find(c=>c.text==="Amount")!,{left:550,right:580});
    expect(parser.parsePage(detail)).toEqual([]);
    expect(parser.parsePage(page(3))).toEqual([]);
    expect(parser.flushPending()).toHaveLength(1);
    expect(parser.finish().counts.contributions).toBe(1);
    detail.pageNumber=1;
    expect(()=>createMarylandLegacyReceiptParser().parsePage(detail)).toThrow("header");
  });
  it("does not let caller mutation of finish aggregates change internal totals", () => {
    const parser = createMarylandLegacyReceiptParser();
    parser.parsePage(page());
    parser.flushPending();
    parser.finish().totalsCents.contributions = 0;
    expect(parser.finish().totalsCents.contributions).toBe(2500);
  });
  it("joins a physical leading undated continuation before emitting the previous occurrence once", () => {
    const parser = createMarylandLegacyReceiptParser();
    expect(parser.parsePage(page())).toEqual([]);
    const next = page(2, false);
    next.cells = next.cells.map((c) => ({
      ...c,
      baselineTop: c.baselineTop - 113.64,
    }));
    next.cells = [
      ...next.cells,
      cell("POSTAL FRAGMENT", 91.296, 90, 100),
      cell("SYNTHETIC SPECIAL", 271.296, 90, 45),
    ];
    next.borders = [...ruledRow(78.61, 96.36), ...ruledRow(96.36, 136.36)];
    const emitted = parser.parsePage(next);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.nameAddress).toBe(
      "SYNTHETIC DONOR TEST ADDRESS POSTAL FRAGMENT",
    );
    parser.flushPending();
    expect(emitted[0]!.nameAddress).toBe(
      "SYNTHETIC DONOR TEST ADDRESS POSTAL FRAGMENT",
    );
    expect(parser.finish().continuationFragments).toBe(1);
    expect(parser.finish().excludedSpecialAccountContinuationCells).toBe(1);
    expect(JSON.stringify(emitted)).not.toContain("SYNTHETIC SPECIAL");
  });
  it("holds unexpected or crossed continuation columns instead of guessing identity", () => {
    for (const extra of [
      cell("UNKNOWN", 330, 90),
      cell("CROSSED", 271.296, 90, 70),
    ]) {
      const parser = createMarylandLegacyReceiptParser();
      parser.parsePage(page());
      const next = page(2, false);
      next.cells = next.cells.map((c) => ({
        ...c,
        baselineTop: c.baselineTop - 113.64,
      }));
      next.cells = [...next.cells, extra];
      next.borders = [...ruledRow(78.61, 96.36), ...ruledRow(96.36, 136.36)];
      expect(() => parser.parsePage(next)).toThrow("identity");
    }
  });
  it("preserves transfers, other receipts and explicitly printed in-kind as separate source roles", () => {
    for (const kind of ["transfer", "other", "in_kind"] as const) {
      const p = page();
      const xs =
        kind === "transfer"
          ? [17.56, 89.31, 413.31, 503.31, 593.06]
          : kind === "other"
            ? [17.56, 89.31, 446.627, 503.31, 593.06]
            : [17.56, 89.31, 358.083, 413.31, 503.31, 593.06];
      p.cells = [
        cell(
          kind === "transfer"
            ? "Transfers in"
            : "Other Receipts and In-Kind Contributions",
          187.272,
          100,
          200,
        ),
        cell(
          kind === "in_kind" ? "(b) In-Kind Contributions" : "(a) Refunds",
          117.864,
          114,
          160,
        ),
        cell("Date", 19.296, 186),
        cell("Received", 19.296, 197.16),
        ...(kind === "transfer"
          ? [
              cell(
                "Name of the Campaign Finance Entity from which the transfer is",
                91.296,
                186,
                300,
              ),
              cell("received.", 91.296, 197.16),
            ]
          : [cell("Complete Name and Address of Payer", 91.296, 186, 200)]),
        ...(kind !== "other" ? [cell("Aggregate to", 415.296, 186)] : []),
        ...(kind !== "transfer"
          ? [cell("Special", kind === "other" ? 456.12 : 366.768, 186)]
          : []),
        cell("Amount", 505.296, 186),
        cell("01/02/2025", 37.224, 225, 50),
        cell("SYNTHETIC OWNER", 91.296, 225, 100),
        cell("$25.00", 505.296, 225, 50),
      ];
      p.borders = ruledRow(210, 250, xs);
      const parser = createMarylandLegacyReceiptParser();
      parser.parsePage(p);
      const result = parser.flushPending()[0]!;
      expect(result.tableKind).toBe(
        kind === "transfer"
          ? "transfers_in"
          : kind === "other"
            ? "other_receipts"
            : "in_kind",
      );
      expect(result.role).toBe(kind === "other" ? "other" : "gift");
      expect(result.amountCents).toBe(2500);
      {
        p.pageNumber = 2;
        p.cells[0]!.baselineTop = 105.432;
        p.cells.push(cell(kind === "transfer" ? "SCHEDULE - 1A" : "SCHEDULE - 1B", 19.296, 99.096, 76.662));
        const transition = createMarylandLegacyReceiptParser(); transition.parsePage(page());
        expect(transition.parsePage(p)).toHaveLength(1);
        p.cells.at(-1)!.text = "UNKNOWN SOURCE CAPTION";
        const unknown = createMarylandLegacyReceiptParser(); unknown.parsePage(page());
        expect(() => unknown.parsePage(p)).toThrow("header");
      }
    }
  });
});
