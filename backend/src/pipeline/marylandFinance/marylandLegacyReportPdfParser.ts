import {
  MarylandPdfGeometryError,
  readMarylandReportPdfGeometry,
  type MarylandPdfCell,
  type MarylandPdfPage,
} from "./marylandReportPdfGeometry.js";

export type MarylandLegacyReceiptKind =
  | "contributions"
  | "transfers_in"
  | "other_receipts"
  | "in_kind";

/** Literal identities are transient source facts. Do not persist these rows. */
export type MarylandLegacyReceiptOccurrence = {
  pageNumber: number;
  ordinal: number;
  role: "gift" | "other";
  tableKind: MarylandLegacyReceiptKind;
  sourceSection: string;
  sourceCategory: string;
  paidBy: string | null;
  date: string;
  amountCents: number;
  nameAddress: string;
};

/** Unclassified source fields, attached to their physical preceding row. These
 * references are transient and grant neither identity nor financial authority. */
export type MarylandLegacyUnclassifiedContinuation = Readonly<{
  pageNumber: number;
  top: number;
  bottom: number;
  parentPageNumber: number;
  parentOrdinal: number;
  date: string;
  amountCents: number;
  tableKind: MarylandLegacyReceiptKind;
  sourceSection: string;
  sourceCategory: string;
  cellCount: number;
}>;

/** Financial facts only. No in-kind identity is available in observation scope. */
export type MarylandLegacyInKindFinancialOccurrence = Readonly<{
  pageNumber: number; ordinal: number; top: number; bottom: number; tableKind: "in_kind";
  sourceSection: string; sourceCategory: string; date: string; amountCents: number;
}>;
export type MarylandLegacyInKindDescriptionUncertainty = Readonly<{
  pageNumber: number; top: number; bottom: number; cellCount: number;
  sourceSection: string; sourceCategory: string; geometry: "bounded_band" | "outside_closed_ledger";
}>;
export type MarylandLegacyInKindScheduleTotal = Readonly<{
  pageNumber: number; top: number; bottom: number; amountCents: number;
}>;

type Table = {
  kind: MarylandLegacyReceiptKind | "expense";
  sourceSection: string;
  sourceCategory: string;
  columns: readonly number[];
  identityLeft: number;
  identityRight: number;
  amountLeft: number;
  headerBottom: number;
  sourceTitleBaseline: number;
};
const clean = (s: string) => s.trim().replace(/\s+/g, " ");
const center = (c: MarylandPdfCell) => c.baselineTop - c.height * 0.3;
const near = (a: number, b: number) => Math.abs(a - b) < 0.4;
const datePattern = /^\d{2}\/\d{2}\/\d{4}$/;
const amountPattern = /^\$((?:\d{1,3}(?:,\d{3})+|\d+))\.(\d{2})$/;
const apparentFinancial = /\$|\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b\d[\d,]*\.\d{2}\b/;
function isRunningReportDueDate(p: MarylandPdfPage, c: MarylandPdfCell) {
  // This exact labeled running-header field is report furniture, never a
  // receipt date. Do not exempt other dates or money above the ledger.
  return datePattern.test(clean(c.text)) && near(c.left, 498.744) &&
    near(c.right, 538.771) && near(c.baselineTop, 62.28) && near(c.height, 7.999) &&
    p.cells.some(label => clean(label.text) === "Report Due Date :" &&
      near(label.left, 422.784) && near(label.right, 487.248) &&
      near(label.baselineTop, 62.28) && near(label.height, 7.999)) &&
    p.borders.some(b => near(b.y1, 72.36) && near(b.y2, 72.36) &&
      near(Math.min(b.x1, b.x2), 7.2) && near(Math.max(b.x1, b.x2), 604.8));
}
function horizontal(p:MarylandPdfPage,y:number,left:number,right:number) {
  let end=left;
  const parts=p.borders.filter(b=>Math.abs(b.y1-b.y2)<.001 && near(b.y1,y))
    .map(b=>[Math.min(b.x1,b.x2),Math.max(b.x1,b.x2)] as const).sort((a,b)=>a[0]-b[0]);
  for(const [a,b]of parts){if(b<end)continue;if(a>end+.3)break;end=Math.max(end,b);}
  return end>=right-.3;
}
function fail(
  code: ConstructorParameters<typeof MarylandPdfGeometryError>[0],
): never {
  throw new MarylandPdfGeometryError(code);
}
function civilDate(s: string) {
  if (!datePattern.test(s)) fail("date");
  const [m, d, y] = s.split("/").map(Number);
  const result = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const parsed = new Date(`${result}T00:00:00Z`);
  if (
    y! < 1900 ||
    y! > 2100 ||
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== result
  )
    fail("date");
  return result;
}
function cents(s: string) {
  const match = amountPattern.exec(s);
  if (!match) fail("amount");
  const result = Number(match[1]!.replaceAll(",", "")) * 100 + Number(match[2]);
  if (!Number.isSafeInteger(result) || result < 0) fail("amount");
  return result;
}
function validatePage(p: MarylandPdfPage) {
  if (
    p.width !== 612 ||
    p.height !== 792 ||
    !Number.isSafeInteger(p.pageNumber) ||
    p.pageNumber < 1 ||
    p.cells.length > 40_000 ||
    p.borders.length > 200_000 ||
    p.cells.some(
      (c) =>
        !clean(c.text) ||
        ![c.left, c.right, c.baselineTop, c.height].every(Number.isFinite) ||
        c.right <= c.left ||
        c.height <= 0 ||
        c.left < 0 ||
        c.right > 613 ||
        center(c) < 0 ||
        center(c) > 792,
    ) ||
    p.borders.some((b) => !Object.values(b).every(Number.isFinite))
  )
    fail("invalid_page");
}
function header(p: MarylandPdfPage, anchor: MarylandPdfCell, excludedExpenseScope=false): Table {
  const band = p.cells.filter(
    (c) =>
      c.baselineTop >= anchor.baselineTop - 0.5 &&
      c.baselineTop <= anchor.baselineTop + 12,
  );
  const at = (text: string, x: number) =>
    band.some((c) => clean(c.text) === text && near(c.left, x));
  const titles = p.cells
    .filter(
      (c) =>
        c.baselineTop < anchor.baselineTop - 20 &&
        c.left > 150 &&
        c.left < 350 &&
        [
          "Contributions",
          "Transfers in",
          "Other Receipts and In-Kind Contributions",
          "Expenditures",
        ].includes(clean(c.text)),
    )
    .sort((a, b) => b.baselineTop - a.baselineTop);
  const title = titles[0];
  if (!title) fail("header");
  if (
    titles.some(
      (t) =>
        near(t.baselineTop, title.baselineTop) &&
        clean(t.text) !== clean(title.text),
    )
  )
    fail("header");
  const sourceSection = clean(title.text);
  if (sourceSection !== "Expenditures" && !at("Received", 19.296))
    fail("header");
  // The printed category is the single centered line immediately below the
  // title, not all prose/cells in the region above the table.
  const sourceCategory = p.cells
    .filter(
      (c) =>
        c.baselineTop > title.baselineTop + 1 &&
        c.baselineTop < title.baselineTop + 18 &&
        c.baselineTop < anchor.baselineTop - 20,
    )
    .sort((a, b) => a.baselineTop - b.baselineTop || a.left - b.left)
    .map((c) => clean(c.text))
    .join(" ");
  const common = {
    sourceSection,
    sourceCategory,
    headerBottom: anchor.baselineTop + 12,
    sourceTitleBaseline: title.baselineTop,
  };
  if(sourceSection==="Expenditures" && excludedExpenseScope) return {...common,kind:"expense",
    columns:[],identityLeft:0,identityRight:0,amountLeft:0};
  if (
    sourceSection === "Contributions" &&
    at("Name and Address of Contributor", 91.296) &&
    at("Aggregate to", 329.328) &&
    at("Paid by", 401.328) &&
    at("Contributions", 509.328) &&
    at("Amount", 509.328)
  ) {
    return {
      ...common,
      kind: "contributions",
      columns: [17.56, 89.31, 269.31, 327.36, 399.36, 507.36, 593.06],
      identityLeft: 89.31,
      identityRight: 269.31,
      amountLeft: 507.36,
    };
  }
  if (
    sourceSection === "Transfers in" &&
    at(
      "Name of the Campaign Finance Entity from which the transfer is",
      91.296,
    ) &&
    at("received.", 91.296) &&
    at("Aggregate to", 415.296) &&
    at("Amount", 505.296)
  ) {
    return {
      ...common,
      kind: "transfers_in",
      columns: [17.56, 89.31, 413.31, 503.31, 593.06],
      identityLeft: 89.31,
      identityRight: 413.31,
      amountLeft: 503.31,
    };
  }
  if (
    sourceSection === "Other Receipts and In-Kind Contributions" &&
    at("Complete Name and Address of Payer", 91.296) &&
    at("Amount", 505.296)
  ) {
    if (
      at("Aggregate to", 415.296) &&
      at("Special", 366.768) &&
      /\bIn-Kind\b/i.test(sourceCategory)
    ) {
      return {
        ...common,
        kind: "in_kind",
        columns: [17.56, 89.31, 358.083, 413.31, 503.31, 593.06],
        identityLeft: 89.31,
        identityRight: 358.083,
        amountLeft: 503.31,
      };
    }
    if (
      !band.some((c) => clean(c.text) === "Aggregate to") &&
      at("Special", 456.12) &&
      sourceCategory
    ) {
      return {
        ...common,
        kind: "other_receipts",
        columns: [17.56, 89.31, 446.627, 503.31, 593.06],
        identityLeft: 89.31,
        identityRight: 446.627,
        amountLeft: 503.31,
      };
    }
  }
  // Returns are printed as an expenditure category, not as other-receipt refunds.
  if (
    sourceSection === "Expenditures" &&
    at("Name and Address of Payee", 163.296) &&
    at("Special", 456.12) &&
    (at("Amount", 505.296) || at("Amount",506.088))
  ) {
    const returned = sourceCategory === "Z - Returned Contribution";
    if (/Returned Contribution/i.test(sourceCategory) && !returned)
      fail("header");
    return {
      ...common,
      kind: "expense",
      columns: [17.56, 89.31, 161.31, 305.31, 446.627, 503.31, 593.06],
      identityLeft: 161.31,
      identityRight: 305.31,
      amountLeft: 503.31,
    };
  }
  fail("header");
}

function createInKindFinancialObserver(record: (row: MarylandLegacyInKindFinancialOccurrence) => void) {
  const rows: MarylandLegacyInKindFinancialOccurrence[] = [];
  const uncertainty: MarylandLegacyInKindDescriptionUncertainty[] = [];
  const totals: MarylandLegacyInKindScheduleTotal[] = [];
  let section: {sourceSection: string; sourceCategory: string; cents: number; closed: boolean} | undefined;
  const add = (a: number, b: number) => {const n = a + b; if (!Number.isSafeInteger(n)) fail("amount"); return n;};
  const close = () => {if (section && !section.closed) fail("amount");};
  return {
    region(p: MarylandPdfPage, start: number, end: number, active: Table, newHeader: boolean, furniture: ReadonlySet<MarylandPdfCell>) {
      if (!section || (section.closed && newHeader)) section = {sourceSection: active.sourceSection, sourceCategory: active.sourceCategory, cents: 0, closed: false};
      if (section.sourceSection !== active.sourceSection || section.sourceCategory !== active.sourceCategory) fail("header");
      const cells = p.cells.filter(c => !furniture.has(c) && c.baselineTop>start+.3 && c.baselineTop-c.height<end-.3 && c.right > 17.56 && c.left < 593.06);
      const edges = [...new Set(p.borders.filter(b => Math.abs(b.y1-b.y2)<.001 && b.y1>=start-.3 && b.y1<=end+.3)
        .map(b => b.y1).filter(y => horizontal(p,y,17.56,593.06)))].sort((a,b)=>a-b);
      const covered = new Set<MarylandPdfCell>();
      const vertical = (x: number, top: number, bottom: number) => p.borders.some(b => Math.abs(b.x1-b.x2)<.001 &&
        Math.abs(b.x1-x)<.02 && Math.min(b.y1,b.y2)<=top+.3 && Math.max(b.y1,b.y2)>=bottom-.3);
      let ordinal = rows.filter(r => r.pageNumber === p.pageNumber).length;
      for (let i=0;i<edges.length-1;i++) {
        const top=edges[i]!,bottom=edges[i+1]!;
        const band=cells.filter(c => c.baselineTop>top+.3 && c.baselineTop-c.height<bottom-.3);
        if (!band.length) continue;
        if (band.some(c => c.baselineTop-c.height<top-.3 || c.baselineTop>bottom+.3 || c.left<=17.56 || c.right>593.56)) fail("row_border");
        const totalLabel=band.filter(c=>clean(c.text)==="Total" && near(c.left,477.36));
        if (totalLabel.length) {
          const money=band.filter(c=>c.left>503.31 && c.right<=593.56);
          const interior=p.borders.some(b=>Math.abs(b.x1-b.x2)<.001 && b.x1>17.58 && b.x1<503.29 &&
            Math.min(b.y1,b.y2)<=top+.3 && Math.max(b.y1,b.y2)>=bottom-.3);
          if (section.closed || totalLabel.length!==1 || money.length!==1 || band.length!==2 || interior ||
            ![17.56,503.31,593.06].every(x=>vertical(x,top,bottom)) || Math.abs(totalLabel[0]!.baselineTop-money[0]!.baselineTop)>.8) fail("amount");
          const amountCents=cents(clean(money[0]!.text));if(amountCents!==section.cents)fail("amount");
          totals.push(Object.freeze({pageNumber:p.pageNumber,top,bottom,amountCents}));section.closed=true;
        } else {
          const dateCells=band.filter(c=>c.left>17.56 && c.right<=89.33);
          const money=band.filter(c=>c.left>503.31 && c.right<=593.56);
          if(dateCells.length || money.length) {
            if(section.closed || dateCells.length!==1 || !datePattern.test(clean(dateCells[0]!.text)) ||
              band.filter(c=>c.right>17.56 && c.left<89.31).length!==1 || !active.columns.every(x=>vertical(x,top,bottom)))fail("date");
            if(money.length!==1 || band.filter(c=>c.right>503.31 && c.left<593.06).length!==1)fail("amount");
            const row=Object.freeze({pageNumber:p.pageNumber,ordinal:ordinal++,top,bottom,tableKind:"in_kind" as const,
              sourceSection:active.sourceSection,sourceCategory:active.sourceCategory,date:civilDate(clean(dateCells[0]!.text)),amountCents:cents(clean(money[0]!.text))});
            rows.push(row);record(row);section.cents=add(section.cents,row.amountCents);
          } else {
            if(section.closed || ![17.56,89.31,503.31,593.06].every(x=>vertical(x,top,bottom)) ||
              band.some(c=>c.left<=89.31 || c.right>503.31 || apparentFinancial.test(clean(c.text))))fail("identity");
            uncertainty.push(Object.freeze({pageNumber:p.pageNumber,top,bottom,cellCount:band.length,
              sourceSection:active.sourceSection,sourceCategory:active.sourceCategory,geometry:"bounded_band"}));
          }
        }
        band.forEach(c=>covered.add(c));
      }
      const outside=cells.filter(c=>!covered.has(c));
      if(outside.length) {
        const ledger=edges.at(-1)!,glyphTop=Math.min(...outside.map(c=>c.baselineTop-c.height)),glyphBottom=Math.max(...outside.map(c=>c.baselineTop));
        // An independently validated, reconciled Total merges the date and
        // description cells. Only that same-page final band closes without
        // the interior date-column rule.
        const totalClosed=totals.some(t=>t.pageNumber===p.pageNumber && near(t.bottom,ledger));
        const primaryClosed=(totalClosed?[17.56,503.31,593.06]:[17.56,89.31,503.31,593.06]).every(x=>p.borders.some(b=>Math.abs(b.x1-b.x2)<.001 &&
          Math.abs(b.x1-x)<.02 && Math.min(b.y1,b.y2)<ledger-.3 && Math.abs(Math.max(b.y1,b.y2)-ledger)<.4));
        const laterGrid=p.borders.some(b=>Math.abs(b.x1-b.x2)<.001 && active.columns.some(x=>Math.abs(b.x1-x)<.02) &&
          Math.max(b.y1,b.y2)>ledger+.5 && Math.min(b.y1,b.y2)<end);
        const partialFooter=p.borders.some(b=>Math.abs(b.y1-b.y2)<.001 && b.y1>ledger+.5 &&
          b.y1>=glyphTop-.3 && b.y1<=glyphBottom+.3 && Math.max(b.x1,b.x2)>17.56 && Math.min(b.x1,b.x2)<593.06);
        if(!Number.isFinite(ledger) || !primaryClosed || laterGrid || !partialFooter || glyphTop<ledger-.3 || glyphBottom>end+.3 ||
          outside.some(c=>c.left<=17.56 || c.right>593.56 || apparentFinancial.test(clean(c.text))))fail("row_border");
        uncertainty.push(Object.freeze({pageNumber:p.pageNumber,top:glyphTop,bottom:glyphBottom,cellCount:outside.length,
          sourceSection:active.sourceSection,sourceCategory:active.sourceCategory,geometry:"outside_closed_ledger"}));
      }
    },
    close,
    financialRows: () => Object.freeze([...rows]),
    descriptionUncertainty: () => Object.freeze([...uncertainty]),
    scheduleTotals: () => Object.freeze([...totals]),
  };
}

/** Stateful only for the observed headerless legacy continuation pages.
 * It neither selects current reports nor qualifies a financial component. */
function createLegacyReceiptEngine(observeUnclassified: boolean) {
  let lastPage = 0;
  let table: Table | undefined;
  let headerCount = 0;
  let pending: MarylandLegacyReceiptOccurrence | undefined;
  let pendingPhysical: {pageNumber:number;top:number;bottom:number;lastPaintedRow:boolean} | undefined;
  let continuationFragments = 0;
  let excludedSpecialAccountContinuationCells = 0;
  const unknownContinuations: MarylandLegacyUnclassifiedContinuation[] = [];
  const counts: Record<MarylandLegacyReceiptKind, number> = {
    contributions: 0,
    transfers_in: 0,
    other_receipts: 0,
    in_kind: 0,
  };
  const totals: Record<MarylandLegacyReceiptKind, number> = { ...counts };
  const inKindFinancial = createInKindFinancialObserver(row => {
    counts.in_kind++; totals.in_kind += row.amountCents;
    if(!Number.isSafeInteger(totals.in_kind))fail("amount");
  });
  return {
    parsePage(p: MarylandPdfPage): MarylandLegacyReceiptOccurrence[] {
      validatePage(p);
      if (p.pageNumber !== lastPage + 1) fail("invalid_page");
      lastPage = p.pageNumber;
      let excludedExpenseScope=table?.kind==="expense";
      const headers = p.cells
        .filter((c) => near(c.left, 19.296) && clean(c.text) === "Date")
        .sort((a,b)=>center(a)-center(b))
        .map((c) => {const observed=header(p,c,excludedExpenseScope);
          excludedExpenseScope=observed.kind==="expense";return {y:center(c),table:observed};});
      headerCount += headers.length;
      const rows: MarylandLegacyReceiptOccurrence[] = [];
      const emitPending = () => {
        if (pending) rows.push(pending);
        pending = undefined;
        pendingPhysical = undefined;
      };
      const rowKeys = new Set<string>();
      const dates = p.cells
        .filter(
          (c) =>
            c.left > 17.56 && c.left < 89.31 && c.right <= 89.33 && datePattern.test(clean(c.text)),
        )
        .sort((a, b) => center(a) - center(b));
      const edges = [
        ...new Set(
          p.borders
            .filter(
              (b) =>
                Math.abs(b.y1 - b.y2) < 0.001 &&
                near(Math.min(b.x1, b.x2), 17.56) &&
                near(Math.max(b.x1, b.x2), 89.435),
            )
            .map((b) => b.y1),
        ),
      ].sort((a, b) => a - b);
      const lastLedgerRule = Math.max(...[...new Set(p.borders.filter(b=>
        Math.abs(b.y1-b.y2)<.001 && b.y1>75 && b.y1<750).map(b=>b.y1))]
        .filter(y=>horizontal(p,y,17.56,593.06)));
      const firstDate = dates[0];
      const firstHeader = headers[0];
      const firstDateTop = firstDate
        ? Math.max(...edges.filter(y => y < center(firstDate)))
        : Infinity;
      const expectedSchedule = firstHeader ? {
        contributions:"SCHEDULE - 1",transfers_in:"SCHEDULE - 1A",
        other_receipts:"SCHEDULE - 1B",in_kind:"SCHEDULE - 1B",expense:"SCHEDULE - 2",
      }[firstHeader.table.kind] : undefined;
      const newSectionTop = firstHeader ? Math.min(firstHeader.y, ...p.cells
        .filter(c => center(c) < firstHeader.y && (["Contributions", "Transfers in",
          "Other Receipts and In-Kind Contributions", "Expenditures"].includes(clean(c.text)) ||
          (near(c.left, 19.296) && Math.abs(c.baselineTop-firstHeader.table.sourceTitleBaseline+6.3)<.12 &&
            clean(c.text).toUpperCase()===expectedSchedule)))
        .map(center)) : Infinity;
      if(observeUnclassified) {
        let active=table,start=75,newHeader=false;
        const schedules={contributions:"SCHEDULE - 1",transfers_in:"SCHEDULE - 1A",other_receipts:"SCHEDULE - 1B",in_kind:"SCHEDULE - 1B",expense:"SCHEDULE - 2"};
        const furniture=new Set(p.cells.filter(c=>headers.some(h=>
          (clean(c.text)===h.table.sourceSection && near(c.baselineTop,h.table.sourceTitleBaseline)) ||
          (near(c.left,19.296) && Math.abs(c.baselineTop-h.table.sourceTitleBaseline+6.3)<.12 && clean(c.text).toUpperCase()===schedules[h.table.kind]) ||
          (c.baselineTop>=h.table.headerBottom-12-.5 && c.baselineTop<=h.table.headerBottom &&
            ["Date","Received","Name and Address of Contributor","Aggregate to","Paid by","Contributions","Amount",
              "Complete Name and Address of Payer","Special","Account","Name and Address of Payee",
              "Name of the Campaign Finance Entity from which the transfer is","received."].includes(clean(c.text))))));
        const sectionTop=(h:typeof headers[number])=>Math.min(h.y,...p.cells.filter(c=>center(c)<h.y &&
          ((clean(c.text)===h.table.sourceSection && near(c.baselineTop,h.table.sourceTitleBaseline)) ||
          (near(c.left,19.296) && Math.abs(c.baselineTop-h.table.sourceTitleBaseline+6.3)<.12 &&
            clean(c.text).toUpperCase()==={contributions:"SCHEDULE - 1",transfers_in:"SCHEDULE - 1A",
              other_receipts:"SCHEDULE - 1B",in_kind:"SCHEDULE - 1B",expense:"SCHEDULE - 2"}[h.table.kind]))).map(center));
        for(const h of headers) {
          if(active?.kind==="in_kind")inKindFinancial.region(p,start,sectionTop(h),active,newHeader,furniture);
          if(h.table.kind!=="in_kind")inKindFinancial.close();
          active=h.table;start=h.table.headerBottom;newHeader=true;
        }
        if(active?.kind==="in_kind")inKindFinancial.region(p,start,750,active,newHeader,furniture);
      }
      const leadingStop = Math.min(firstDateTop, newSectionTop, 750);
      const leadingCells = p.cells.filter(c => center(c) > 75 && center(c) < leadingStop &&
        c.right > 17.56 && c.left < 593.06);
      const leadingStrips = edges.slice(0, -1).map((top, i) => ({top, bottom: edges[i + 1]!}))
        .filter(b => b.top >= 75 && b.bottom <= leadingStop);
      const continuing = !(observeUnclassified && table?.kind==="in_kind") && table?.kind !== "expense" && (leadingStrips.length > 0 ||
        (firstDate && (!firstHeader || center(firstDate) < firstHeader.y)) ||
        (!!table && leadingCells.length > 0));
      if (continuing) {
        if (
          !table ||
          (table.kind !== "expense" && !pending) ||
          !edges.length ||
          !near(edges[0]!, 78.61)
        )
          fail("header");
        // Every leading cell must belong to a complete painted strip. This
        // includes pages without another date and strips before a new header.
        if (leadingCells.some(c => !leadingStrips.some(b => center(c) > b.top && center(c) < b.bottom)))
          fail("row_border");
        for (const {top, bottom} of leadingStrips) {
          for (const y of [top, bottom]) {
            let end = 17.56;
            const parts = p.borders.filter(b => Math.abs(b.y1 - b.y2) < .001 && near(b.y1, y))
              .map(b => [Math.min(b.x1, b.x2), Math.max(b.x1, b.x2)] as const)
              .sort((a, b) => a[0] - b[0]);
            for (const [left, right] of parts) {
              if (right < end) continue;
              if (left > end + .3) break;
              end = Math.max(end, right);
            }
            if (end < table.identityRight - .3) fail("row_border");
          }
          const fragment = p.cells.filter(c=>c.baselineTop>top+.3 && c.baselineTop-c.height<bottom-.3);
          if(fragment.some(c=>c.baselineTop-c.height<top-.3 || c.baselineTop>bottom+.3)) fail("row_border");
          const vertical = (x:number)=>p.borders.some(b=>Math.abs(b.x1-b.x2)<.001 &&
            Math.abs(b.x1-x)<.02 && Math.min(b.y1,b.y2)<=top+.3 && Math.max(b.y1,b.y2)>=bottom-.3);
          const interior = (left:number,right:number)=>p.borders.some(b=>Math.abs(b.x1-b.x2)<.001 &&
            b.x1>left+.02 && b.x1<right-.02 && Math.min(b.y1,b.y2)<=top+.3 && Math.max(b.y1,b.y2)>=bottom-.3);
          const mergedInKind = table.kind==="in_kind" && !vertical(table.identityRight) &&
            [17.56,89.31,503.31,593.06].every(vertical) && !interior(89.31,503.31);
          if(mergedInKind)fail("identity");
          if(interior(table.identityLeft,table.identityRight)) fail("column_border");
          // Continuation strips merge the unused financial columns. The date
          // and identity cell boundaries remain printed; do not require
          // financial-column separators for this nonfinancial strip.
          for (const x of [17.56, table.identityLeft, table.identityRight]) {
            if (
              !p.borders.some(
                (b) =>
                  Math.abs(b.x1 - b.x2) < 0.001 &&
                  Math.abs(b.x1 - x) < 0.02 &&
                  Math.min(b.y1, b.y2) <= top + 0.3 &&
                  Math.max(b.y1, b.y2) >= bottom - 0.3,
              )
            )
              fail("column_border");
          }
          const specialAccount = fragment.filter(
            (c) =>
              table!.kind === "contributions" &&
              c.left > 269.31 &&
              c.right <= 327.36,
          );
          const unknown = fragment.filter(
            (c) => !specialAccount.includes(c) &&
              (c.left <= table!.identityLeft || c.left >= table!.identityRight ||
                c.right > table!.identityRight + 0.5),
          );
          if (unknown.length) {
            if (!observeUnclassified || !pending || table.kind !== "contributions" ||
              unknown.some(c => c.left <= table!.identityRight || c.right > 593.56) ||
              fragment.some(c => apparentFinancial.test(clean(c.text))))
              fail("identity");
            // Unknown fields require the complete merged outer cell, not just
            // the identity cell's boundary. Text outside painted bounds holds.
            if (!p.borders.some(b => Math.abs(b.x1 - b.x2) < .001 &&
              Math.abs(b.x1 - 593.06) < .02 && Math.min(b.y1, b.y2) <= top + .3 &&
              Math.max(b.y1, b.y2) >= bottom - .3)) fail("column_border");
            for (const y of [top, bottom]) {
              let end = table.identityRight;
              const parts = p.borders.filter(b => Math.abs(b.y1 - b.y2) < .001 && near(b.y1, y))
                .map(b => [Math.min(b.x1, b.x2), Math.max(b.x1, b.x2)] as const)
                .sort((a, b) => a[0] - b[0]);
              for (const [left, right] of parts) {
                if (right < end) continue;
                if (left > end + .3) break;
                end = Math.max(end, right);
              }
              if (end < 593.06 - .3) fail("row_border");
            }
            // Even an unclassified strip cannot hide a complete financial row.
            const fullFinancialColumns = table.columns.every(x => p.borders.some(b =>
              Math.abs(b.x1 - b.x2) < 0.001 && Math.abs(b.x1 - x) < 0.02 &&
              Math.min(b.y1, b.y2) <= top + 0.3 && Math.max(b.y1, b.y2) >= bottom - 0.3));
            if (fullFinancialColumns && (
              !pendingPhysical || pendingPhysical.pageNumber !== p.pageNumber - 1 ||
              !pendingPhysical.lastPaintedRow ||
              !fragment.some(c => c.left > table!.identityLeft && c.right <= table!.identityRight + .5) ||
              unknown.some(c => c.left <= 327.36 || c.right > 399.36) ||
              fragment.some(c => (c.left < 89.31 && c.right > 17.56) ||
                (c.left < 593.06 && c.right > 507.36) ||
                (c.left < 507.36 && c.right > 399.36)))) fail("date");
            unknownContinuations.push(Object.freeze({pageNumber: p.pageNumber, top, bottom,
              parentPageNumber: pending.pageNumber, parentOrdinal: pending.ordinal,
              date: pending.date, amountCents: pending.amountCents, tableKind: pending.tableKind,
              sourceSection: pending.sourceSection, sourceCategory: pending.sourceCategory,
              cellCount: unknown.length}));
          }
          // This named source field is excluded from identity on dated rows as
          // well. Retain only its physical count, never arbitrary field text.
          excludedSpecialAccountContinuationCells += specialAccount.length;
          const identity = fragment
            .filter(
              (c) =>
                c.left > table!.identityLeft &&
                c.left < table!.identityRight &&
                c.right <= table!.identityRight + 0.5,
            )
            .sort((a, b) => a.baselineTop - b.baselineTop || a.left - b.left);
          if (identity.length && pending) {
            pending = {
              ...pending,
              nameAddress: clean(
                `${pending.nameAddress} ${identity.map((c) => c.text).join(" ")}`,
              ),
            };
            continuationFragments++;
          }
        }
      }
      // A continuation-only page does not finish its preceding occurrence.
      if (continuing && !dates.length && !headers.length) return rows;
      emitPending();
      for (const d of dates) {
        const preceding = headers.filter((h) => h.y < center(d)).at(-1);
        const active = preceding?.table ?? table;
        if (!active) fail("header");
        // The exact observed expenditure table closes receipt scope. Its
        // financial occurrences belong to the separate returned-facts reader.
        if (active.kind === "expense") continue;
        if(observeUnclassified && active.kind==="in_kind") {
          if(!inKindFinancial.financialRows().some(r=>r.pageNumber===p.pageNumber && center(d)>r.top && center(d)<r.bottom && r.date===civilDate(clean(d.text))))fail("date");
          emitPending();continue;
        }
        if (d.right > 89.71) fail("column_border");
        const above = edges.filter((y) => y < center(d));
        const below = edges.filter((y) => y > center(d));
        if (!above.length || !below.length) fail("row_border");
        const top = Math.max(...above),
          bottom = Math.min(...below);
        if (preceding && top < active.headerBottom - 1) fail("row_border");
        // A new printed section before this date requires its own observed
        // table header; the previous page cannot authorize intervening prose.
        if (
          !preceding &&
          p.cells.some(
            (c) =>
              center(c) > 75 &&
              center(c) < center(d) &&
              [
                "Contributions",
                "Transfers in",
                "Other Receipts and In-Kind Contributions",
                "Expenditures",
              ].includes(clean(c.text)),
          )
        )
          fail("header");
        const key = `${top}:${bottom}`;
        if (rowKeys.has(key)) fail("duplicate_date_cell");
        rowKeys.add(key);
        for (const x of active.columns) {
          if (
            !p.borders.some(
              (b) =>
                Math.abs(b.x1 - b.x2) < 0.001 &&
                Math.abs(b.x1 - x) < 0.02 &&
                Math.min(b.y1, b.y2) <= top + 0.3 &&
                Math.max(b.y1, b.y2) >= bottom - 0.3,
            )
          )
            fail("column_border");
        }
        const row = p.cells.filter(
          (c) => c.baselineTop > top + .3 && c.baselineTop - c.height < bottom - .3,
        );
        if(row.some(c=>c.baselineTop-c.height<top-.3 || c.baselineTop>bottom+.3)) fail("row_border");
        if (row.some(c => c.left < active.identityRight && c.right > active.identityLeft &&
          (c.left <= active.identityLeft || c.right > active.identityRight + .5))) fail("identity");
        const within = (left: number, right: number) =>
          row
            .filter(
              (c) => c.left > left && c.left < right && c.right <= right + 0.5,
            )
            .sort(
              (a, b) =>
                Math.round(a.baselineTop * 10) -
                  Math.round(b.baselineTop * 10) || a.left - b.left,
            );
        const money = within(active.amountLeft, 593.06);
        if (money.length !== 1) fail("amount");
        const amountCents = cents(clean(money[0]!.text));
        const parsedDate = civilDate(clean(d.text));
        const identity = within(active.identityLeft, active.identityRight);
        if (!identity.length) fail("identity");
        const nameAddress = clean(identity.map((c) => c.text).join(" "));
        const paidBy =
          active.kind === "contributions"
            ? clean(
                within(399.36, 507.36)
                  .map((c) => c.text)
                  .join(" "),
              )
            : null;
        if (active.kind === "contributions" && !paidBy) fail("identity");
        counts[active.kind]++;
        totals[active.kind] += amountCents;
        if (!Number.isSafeInteger(totals[active.kind])) fail("amount");
        emitPending();
        pending = {
          pageNumber: p.pageNumber,
          ordinal: rowKeys.size - 1,
          role: active.kind === "other_receipts" ? "other" : "gift",
          tableKind: active.kind,
          sourceSection: active.sourceSection,
          sourceCategory: active.sourceCategory,
          paidBy,
          date: parsedDate,
          amountCents,
          nameAddress,
        };
        const trailing = p.cells.filter(c=>center(c)>lastLedgerRule+.3 && center(c)<750 &&
          c.right>17.56 && c.left<593.06);
        const firstTrailingRule = Math.min(...p.borders.filter(b=>Math.abs(b.y1-b.y2)<.001 &&
          b.y1>lastLedgerRule+.5 && b.y1<750).map(b=>b.y1));
        const trailingFinancialGrid = active.columns.every(x=>p.borders.some(b=>
          Math.abs(b.x1-b.x2)<.001 && Math.abs(b.x1-x)<.02 &&
          Math.max(b.y1,b.y2)>lastLedgerRule+.5));
        pendingPhysical = {pageNumber:p.pageNumber,top,bottom,
          lastPaintedRow:near(bottom,lastLedgerRule) && !p.cells.some(c => c.baselineTop>bottom+.3 &&
            c.baselineTop-c.height<lastLedgerRule-.3 && c.right>17.56 && c.left<593.06) &&
            !trailing.some(c=>apparentFinancial.test(clean(c.text)) || center(c)<firstTrailingRule-.3) &&
            !trailingFinancialGrid};
      }
      // An amount in a fully ruled financial row cannot disappear simply
      // because its date is missing or malformed. Insets/merged totals do not
      // establish these complete table columns.
      for (let i = 0; i < edges.length - 1; i++) {
        const top = edges[i]!,
          bottom = edges[i + 1]!;
        const preceding = headers.filter((h) => h.y < top).at(-1);
        const active = preceding?.table ?? table;
        if (
          !active || active.kind === "expense" || (observeUnclassified && active.kind==="in_kind") ||
          (firstHeader && top >= newSectionTop && top < firstHeader.table.headerBottom - 1) ||
          (preceding && top < active.headerBottom - 1) ||
          rowKeys.has(`${top}:${bottom}`)
        )
          continue;
        const fullColumns = active.columns.every((x) =>
          p.borders.some(
            (b) =>
              Math.abs(b.x1 - b.x2) < 0.001 &&
              Math.abs(b.x1 - x) < 0.02 &&
              Math.min(b.y1, b.y2) <= top + 0.3 &&
              Math.max(b.y1, b.y2) >= bottom - 0.3,
          ),
        );
        if (
          fullColumns &&
          p.cells.some(
            (c) =>
              center(c) > top &&
              center(c) < bottom &&
              c.left > active.amountLeft &&
              c.left < 593.06 &&
              c.right <= 593.56,
          )
        )
          fail("date");
      }
      if(observeUnclassified)for(const c of p.cells) {
        const preceding=headers.filter(h=>h.table.sourceTitleBaseline-3<center(c)).at(-1),active=preceding?.table??table;
        if(active?.kind!=="in_kind" || c.right<=503.31 || c.left>=593.06 || !apparentFinancial.test(clean(c.text)) || isRunningReportDueDate(p,c))continue;
        const supported=[...inKindFinancial.financialRows(),...inKindFinancial.scheduleTotals()].some(r=>r.pageNumber===p.pageNumber &&
          c.baselineTop-c.height>=r.top-.3 && c.baselineTop<=r.bottom+.3);
        if(!supported)fail("amount");
      }
      if (headers.length) table = headers.at(-1)!.table;
      else if (!dates.length && !(observeUnclassified && table?.kind==="in_kind")) table = undefined;
      return rows;
    },
    flushPending(): MarylandLegacyReceiptOccurrence[] {
      const result = pending ? [pending] : [];
      pending = undefined;
      pendingPhysical = undefined;
      return result;
    },
    finish() {
      if (!lastPage || !headerCount || pending) fail("header");
      if(observeUnclassified)inKindFinancial.close();
      return {
        pageCount: lastPage,
        headerCount,
        continuationFragments,
        excludedSpecialAccountContinuationCells,
        unclassifiedContinuationCount: unknownContinuations.length,
        scope: "published_receipts" as const,
        counts: { ...counts },
        totalsCents: { ...totals },
        ...(observeUnclassified ? {inKindIdentityScope:"unavailable" as const,
          inKindFinancialOccurrenceCount:inKindFinancial.financialRows().length,
          inKindDescriptionUncertaintyCount:inKindFinancial.descriptionUncertainty().length} : {}),
      };
    },
    privateUnknownContinuations() {
      return Object.freeze([...unknownContinuations]);
    },
    privateInKindFinancialOccurrences: inKindFinancial.financialRows,
    privateInKindDescriptionUncertainty: inKindFinancial.descriptionUncertainty,
    privateInKindScheduleTotals: inKindFinancial.scheduleTotals,
  };
}

/** Full identity remains strict, including unclassified continuation fields. */
export function createMarylandLegacyReceiptParser() {
  const parser=createLegacyReceiptEngine(false);
  return {parsePage:parser.parsePage,flushPending:parser.flushPending,privateUnknownContinuations:parser.privateUnknownContinuations,
    finish(){const {inKindIdentityScope:_identity,inKindFinancialOccurrenceCount:_financial,inKindDescriptionUncertaintyCount:_uncertainty,...facts}=parser.finish();return facts;}};
}

/** Observation only: unknown nonfinancial fields remain explicitly unbound.
 * A separate source-bound comparator must prove full fiscal-cohort disjointness
 * and every eligible occurrence. This never accepts cash or donor identities. */
export function createMarylandLegacyReceiptObservationParser() {
  return createLegacyReceiptEngine(true);
}

export async function readMarylandLegacyReportReceipts(
  bytes: Uint8Array,
  onOccurrences: (
    rows: readonly MarylandLegacyReceiptOccurrence[],
  ) => void | Promise<void>,
) {
  const parser = createMarylandLegacyReceiptParser();
  const geometry = await readMarylandReportPdfGeometry(bytes, async (p) => {
    await onOccurrences(parser.parsePage(p));
  });
  await onOccurrences(parser.flushPending());
  return { ...geometry, ...parser.finish() };
}

export async function readMarylandLegacyReceiptObservations(
  bytes: Uint8Array,
  onOccurrences: (rows: readonly MarylandLegacyReceiptOccurrence[]) => void | Promise<void>,
) {
  const sourceBytes = Uint8Array.from(bytes);
  const parser = createMarylandLegacyReceiptObservationParser();
  const geometry = await readMarylandReportPdfGeometry(sourceBytes, async p => {
    await onOccurrences(parser.parsePage(p));
  });
  await onOccurrences(parser.flushPending());
  return {...geometry, sourceFacts: parser.finish(),
    privateUnknownContinuations: parser.privateUnknownContinuations(),
    privateInKindFinancialOccurrences:parser.privateInKindFinancialOccurrences(),
    privateInKindDescriptionUncertainty:parser.privateInKindDescriptionUncertainty(),
    privateInKindScheduleTotals:parser.privateInKindScheduleTotals()};
}
