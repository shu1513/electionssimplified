import { createHash } from "node:crypto";

export type MarylandPdfCell = {
  text: string; left: number; right: number; baselineTop: number; height: number;
};
export type MarylandPdfBorder = { x1: number; y1: number; x2: number; y2: number };
export type MarylandPdfPage = {
  pageNumber: number; width: number; height: number;
  cells: readonly MarylandPdfCell[]; borders: readonly MarylandPdfBorder[];
};
export class MarylandPdfGeometryError extends Error {
  constructor(public readonly code: "invalid_pdf" | "limit" | "unsupported_geometry" |
    "graphics_state" | "invalid_page" | "header" | "row_border" | "column_border" |
    "amount" | "date" | "identity" | "duplicate_date_cell") {
    super(`Maryland report PDF: ${code}`);
  }
}
function fail(code: ConstructorParameters<typeof MarylandPdfGeometryError>[0]): never {
  throw new MarylandPdfGeometryError(code);
}
type Matrix = [number, number, number, number, number, number];
const identity: Matrix = [1, 0, 0, 1, 0, 0];
function numbers(value: unknown): number[] | null {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) return null;
  const result = Array.from(value as ArrayLike<unknown>);
  return result.every(n => typeof n === "number" && Number.isFinite(n)) ? result as number[] : null;
}
function multiply(a: Matrix, b: number[]): Matrix {
  return [a[0]*b[0]!+a[2]*b[1]!, a[1]*b[0]!+a[3]*b[1]!,
    a[0]*b[2]!+a[2]*b[3]!, a[1]*b[2]!+a[3]*b[3]!,
    a[0]*b[4]!+a[2]*b[5]!+a[4], a[1]*b[4]!+a[3]*b[5]!+a[5]];
}
type PathCodes = { save: number; restore: number; transform: number; constructPath: number;
  moveTo: number; lineTo: number; rectangle: number; closePath: number;
  stroke: number; closeStroke: number; fill: number; eoFill: number; fillStroke: number;
  eoFillStroke: number; closeFillStroke: number; closeEOFillStroke: number; endPath: number };

/** Painted axis-aligned rules only. Coordinates are transformed through the
 * PDF graphics state and converted to top-origin page coordinates. A path
 * definition without a paint operation is not evidence of a printed cell. */
export function inspectMarylandPdfBorders(operators: {
  fnArray: ArrayLike<number>; argsArray: ArrayLike<unknown>;
}, codes: PathCodes, pageHeight: number): MarylandPdfBorder[] {
  if (!Number.isFinite(pageHeight) || pageHeight <= 0 ||
    operators.fnArray.length !== operators.argsArray.length) fail("graphics_state");
  let matrix: Matrix = [...identity];
  const stack: Matrix[] = [], result: MarylandPdfBorder[] = [];
  let pending: MarylandPdfBorder[] = [], filledRectangles: MarylandPdfBorder[] = [];
  let current: [number,number] | null = null, start: [number,number] | null = null;
  const paints = new Set([codes.stroke, codes.closeStroke, codes.fill, codes.eoFill,
    codes.fillStroke, codes.eoFillStroke, codes.closeFillStroke, codes.closeEOFillStroke]);
  const strokes = new Set([codes.stroke,codes.closeStroke,codes.fillStroke,
    codes.eoFillStroke,codes.closeFillStroke,codes.closeEOFillStroke]);
  function edge(x1: number, y1: number, x2: number, y2: number) {
    const x = (a: number, b: number) => matrix[0]*a+matrix[2]*b+matrix[4];
    const y = (a: number, b: number) => pageHeight-(matrix[1]*a+matrix[3]*b+matrix[5]);
    const border = {x1: x(x1,y1), y1: y(x1,y1), x2: x(x2,y2), y2: y(x2,y2)};
    if (Object.values(border).some(n => !Number.isFinite(n))) fail("graphics_state");
    if (Math.abs(border.x1-border.x2) < .001 || Math.abs(border.y1-border.y2) < .001)
      pending.push(border);
  }
  for (let i=0; i<operators.fnArray.length; i++) {
    const op = operators.fnArray[i], args = operators.argsArray[i] as unknown[] | null;
    if (op === codes.save) stack.push([...matrix]);
    else if (op === codes.restore) { const prior = stack.pop(); if (!prior) fail("graphics_state"); matrix = prior; }
    else if (op === codes.transform) {
      if (current) fail("graphics_state");
      const values = numbers(args);
      if (!values || values.length !== 6) fail("graphics_state");
      matrix = multiply(matrix, values);
    } else if (op === codes.constructPath) {
      if (!Array.isArray(args)) fail("graphics_state");
      const path = numbers(args[0]), coordinates = numbers(args[1]);
      if (!path || !coordinates) fail("graphics_state");
      let offset = 0;
      const part: MarylandPdfBorder[] = pending; pending = [];
      let supported = true;
      for (const command of path) {
        if (command === codes.rectangle) {
          const [x,y,w,h] = coordinates.slice(offset,offset+4); offset += 4;
          if ([x,y,w,h].some(v=>v===undefined)) fail("graphics_state");
          const beginning = pending.length;
          edge(x!,y!,x!+w!,y!); edge(x!+w!,y!,x!+w!,y!+h!);
          edge(x!+w!,y!+h!,x!,y!+h!); edge(x!,y!+h!,x!,y!);
          if (Math.abs(w!*h!*(matrix[0]*matrix[3]-matrix[1]*matrix[2]))>.000001)
            filledRectangles.push(...pending.slice(beginning));
          current = start = [x!,y!];
        } else if (command === codes.moveTo || command === codes.lineTo) {
          const next = coordinates.slice(offset,offset+2); offset += 2;
          if (next.length !== 2) fail("graphics_state");
          if (command === codes.lineTo) {
            if (!current) fail("graphics_state");
            edge(current[0],current[1],next[0]!,next[1]!);
          } else start = [next[0]!,next[1]!];
          current = [next[0]!,next[1]!];
        } else if (command === codes.closePath) {
          if (!current || !start) fail("graphics_state");
          edge(current[0],current[1],start[0],start[1]); current = start;
        } else { supported = false; break; }
      }
      if (supported && offset !== coordinates.length) fail("graphics_state");
      pending = supported ? [...part,...pending] : part;
      if (!supported) { pending = []; filledRectangles = []; current = start = null; }
    } else if (paints.has(op!)) {
      // Fill-only open lines and zero-area rectangles paint no cell region.
      // Only observed nondegenerate rectangular fills supply filled borders.
      result.push(...(strokes.has(op!) ? pending : filledRectangles));
      pending = []; filledRectangles = []; current = start = null;
    } else if (op === codes.endPath) { pending = []; filledRectangles = []; current = start = null; }
    if (result.length+pending.length > 200_000 || stack.length > 100) fail("limit");
  }
  if (stack.length) fail("graphics_state");
  return result;
}

/** Reads every page of an untouched local PDF, one page at a time. The hash
 * identifies source bytes; extraction alone grants no report/currentness or
 * financial authority. Callers must not persist donor-text derivatives. */
export async function readMarylandReportPdfGeometry(bytes: Uint8Array,
  onPage: (page: MarylandPdfPage) => void | Promise<void>) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 5 || bytes.byteLength > 64*1024*1024 ||
    Buffer.from(bytes.subarray(0,5)).toString("ascii") !== "%PDF-") fail("invalid_pdf");
  const data = new Uint8Array(bytes);
  const sha256 = createHash("sha256").update(data).digest("hex");
  const { getDocument, OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({data, isEvalSupported: false, useSystemFonts: true});
  try {
    const pdf = await task.promise;
    if (!Number.isInteger(pdf.numPages) || pdf.numPages < 1 || pdf.numPages > 6000) fail("limit");
    let count = 0;
    for (let pageNumber=1; pageNumber<=pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      try {
        // The native cover/controls have variable heights (737/994/853 pt in
        // the observed PP2 report). Schedule recognition remains separate and
        // requires its exact 595x842 geometry in the receipt page parser.
        if (page.rotate !== 0 || page.userUnit !== 1 || page.view.length !== 4 || page.view[0] !== 0 || page.view[1] !== 0 ||
          Math.abs(page.view[2]!-595) > .01 || !Number.isFinite(page.view[3]) ||
          page.view[3]! < 500 || page.view[3]! > 2000) fail("unsupported_geometry");
        const content = await page.getTextContent({disableNormalization: true});
        const cells: MarylandPdfCell[] = [];
        for (const item of content.items) {
          if (!("str" in item) || !item.str.trim()) continue;
          const [a,b,c,d,x,y] = item.transform;
          if (![a,b,c,d,x,y,item.height,item.width].every(Number.isFinite) ||
            Math.abs(b!) > .001 || Math.abs(c!) > .001 || a! <= 0 || d! <= 0 ||
            item.width <= 0 || item.height <= 0) fail("unsupported_geometry");
          cells.push({text: item.str, left: x!, right: x!+item.width,
            baselineTop: page.view[3]!-y!, height: item.height});
          if (++count > 5_000_000 || cells.length > 40_000) fail("limit");
        }
        if (!cells.length) fail("unsupported_geometry");
        await onPage({pageNumber, width: page.view[2]!, height: page.view[3]!, cells,
          borders: inspectMarylandPdfBorders(await page.getOperatorList(),OPS,page.view[3]!)});
      } finally { page.cleanup(); }
    }
    return {sha256, byteCount: bytes.byteLength, pageCount: pdf.numPages, textItemCount: count};
  } finally { await task.destroy(); }
}

export type MarylandPdfReceiptOccurrence = {
  pageNumber: number; ordinal: number; role: "gift" | "return";
  schedule: "gift_monetary" | "gift_in_kind" | "return_monetary" | "return_in_kind";
  date: string; amountCents: number; nameAddress: string;
};
const clean = (value: string) => value.trim().replace(/\s+/g," ");
const center = (cell: MarylandPdfCell) => cell.baselineTop-cell.height*.3;
const currency = /^\$((?:\d{1,3}(?:,\d{3})+|\d+))\.(\d{2})$/;
const dateToken = /^\d{2}\/\d{2}\/\d{4}$/;
function date(value: string) {
  const [month,day,year] = value.split("/").map(Number);
  const iso = `${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (year! < 1900 || year! > 2100 || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10) !== iso) fail("date");
  return iso;
}
/** Exact observed modern receipt headers and physical row/cell boundaries.
 * This page primitive does not select a report, discard historical versions,
 * classify donors or qualify an entire schedule. Empty pages cannot establish
 * an empty report. Aggregate and original-gift amounts are never substituted. */
export function parseMarylandModernReceiptPage(page: MarylandPdfPage): MarylandPdfReceiptOccurrence[] {
  if (!Number.isInteger(page.pageNumber) || page.pageNumber < 1 ||
    page.width !== 595 || page.height !== 842 || page.cells.length > 40_000 ||
    page.borders.length > 200_000 || page.cells.some(c=>!c.text.trim() ||
      ![c.left,c.right,c.baselineTop,c.height].every(Number.isFinite) || c.right<=c.left || c.height<=0 ||
      c.left<0 || c.right>page.width+1 || center(c)<0 || center(c)>page.height) ||
    page.borders.some(b=>!Object.values(b).every(Number.isFinite))) fail("invalid_page");
  const headers: {baseline: number; bottom: number; contributorLeft: number;
    anchor: MarylandPdfCell; schedule: MarylandPdfReceiptOccurrence["schedule"]}[] = [];
  for (const contributor of page.cells.filter(c=>clean(c.text)==="Contributor Details")) {
    const line = page.cells.filter(c=>Math.abs(c.baselineTop-contributor.baselineTop)<1)
      .sort((a,b)=>a.left-b.left);
    const tokens = line.map(c=>clean(c.text)).join("|");
    let schedule: MarylandPdfReceiptOccurrence["schedule"], anchor: MarylandPdfCell;
    let lower = Math.max(...line.map(c=>c.baselineTop));
    if (tokens === "Date|Payment Method|Fund Type|Contributor Details|Amount|Aggregate") {
      schedule = "gift_monetary"; anchor = line.find(c=>clean(c.text)==="Amount")!;
    } else if (tokens === "Date|Fund Type|Contributor Details|Aggregate") {
      const value = page.cells.filter(c=>c.left>435 && c.right<=505+1 &&
        Math.abs(c.baselineTop-contributor.baselineTop)<=6).sort((a,b)=>a.baselineTop-b.baselineTop||a.left-b.left);
      if (value.map(c=>clean(c.text)).join("|") !== "Fair Market|Value") fail("header");
      schedule = "gift_in_kind"; anchor = value.at(-1)!; lower = Math.max(lower,...value.map(c=>c.baselineTop));
    } else if (tokens === "Return Date|Contribution Date|Contributor Details|Contribution Amount|Return Amount") {
      schedule = "return_monetary"; anchor = line.at(-1)!;
    } else if (tokens === "Return Date|Contribution Date|Contributor Details|Fair Market Value|Return Amount") {
      schedule = "return_in_kind"; anchor = line.at(-1)!;
    } else fail("header");
    headers.push({baseline: contributor.baselineTop, bottom: lower, contributorLeft: contributor.left-4, anchor, schedule});
  }
  const horizontal = [...new Set(page.borders.filter(b=>Math.abs(b.y1-b.y2)<.001 &&
    Math.min(b.x1,b.x2)<=20 && Math.max(b.x1,b.x2)>=80).map(b=>Number(b.y1.toFixed(3))))];
  const result: MarylandPdfReceiptOccurrence[] = [], usedRows = new Set<string>();
  for (const dateCell of page.cells.filter(c=>c.left<80 && dateToken.test(clean(c.text)))) {
    const preceding = headers.filter(h=>h.bottom<center(dateCell)).sort((a,b)=>b.baseline-a.baseline);
    const header = preceding[0]; if (!header) fail("header");
    const above = horizontal.filter(y=>y<center(dateCell)), below = horizontal.filter(y=>y>center(dateCell));
    if (!above.length || !below.length) fail("row_border");
    const top = Math.max(...above), bottom = Math.min(...below), rowKey = `${top}:${bottom}`;
    if (usedRows.has(rowKey)) fail("duplicate_date_cell"); usedRows.add(rowKey);
    if (top<header.bottom) fail("row_border");
    const vertical = [...new Set(page.borders.filter(b=>Math.abs(b.x1-b.x2)<.001 &&
      Math.min(b.y1,b.y2)<=top+.01 && Math.max(b.y1,b.y2)>=bottom-.01).map(b=>Number(b.x1.toFixed(3))))];
    const dateLefts=vertical.filter(x=>Math.abs(x-20)<.01);
    const dateRights=vertical.filter(x=>x>20+1);
    if (dateLefts.length!==1 || !dateRights.length || dateCell.left<=dateLefts[0]! ||
      dateCell.right>Math.min(...dateRights)+1) fail("column_border");
    const lefts = vertical.filter(x=>Math.abs(x-header.contributorLeft)<=1);
    if (lefts.length!==1) fail("column_border");
    const left = lefts[0]!, rights = vertical.filter(x=>x>left+1);
    const anchorX = (header.anchor.left+header.anchor.right)/2;
    const amountLefts = vertical.filter(x=>x<anchorX), amountRights = vertical.filter(x=>x>anchorX);
    if (!rights.length || !amountLefts.length || !amountRights.length) fail("column_border");
    const right = Math.min(...rights), amountLeft = Math.max(...amountLefts), amountRight = Math.min(...amountRights);
    const rowCells = page.cells.filter(c=>center(c)>top && center(c)<bottom);
    const donor = rowCells.filter(c=>c.left>left && c.left<right && c.right<=right+1)
      .sort((a,b)=>Math.round(a.baselineTop*10)-Math.round(b.baselineTop*10)||a.left-b.left);
    const amounts = rowCells.filter(c=>c.left>amountLeft && c.left<amountRight && c.right<=amountRight+1);
    if (amounts.length!==1 || !currency.test(clean(amounts[0]!.text))) fail("amount");
    const match = currency.exec(clean(amounts[0]!.text))!;
    const amountCents = Number(match[1]!.replaceAll(",",""))*100+Number(match[2]);
    if (!Number.isSafeInteger(amountCents) || amountCents<=0) fail("amount");
    if (!donor.length) fail("identity");
    const nameAddress = clean(donor.map(c=>c.text).join(" "))
      .replace(/(\d{5})\s*-\s*(\d{4})$/,"$1-$2");
    result.push({pageNumber: page.pageNumber, ordinal: result.length,
      role: header.schedule.startsWith("return") ? "return" : "gift", schedule: header.schedule,
      date: date(clean(dateCell.text)), amountCents, nameAddress});
  }
  return result;
}
