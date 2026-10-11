import { createHash } from "node:crypto";

export type ArkansasPdfCell = { text: string; x: number; y: number; height: number };
export type ArkansasPdfPage = { pageNumber: number; width: number; height: number; cells: readonly ArkansasPdfCell[]; checkedBoxes: readonly { x: number; y: number }[]; squareBoxes: readonly { x: number; y: number; size: number }[] };
export type ArkansasFinancialPdfExtraction = { sha256: string; byteCount: number; pages: readonly ArkansasPdfPage[] };
export type ArkansasPdfOccurrence = { section: number; pageNumber: number; ordinal: number; date: string; nameAddress: string; description: string; employment: string; election: string; amountCents: number; cumulativeCents: number | null; rawCells: readonly ArkansasPdfCell[] };
export type ArkansasParsedFinancialReport = {
  sha256: string; byteCount: number; kind: "candidate" | "independent";
  ownerName: string; filerId: string | null; officeName: string | null; district: string | null;
  reportLabel: string; periodStart: string; periodEnd: string; filedAt: string;
  electionTypeRaw: string | null; electionYear: number | null; electionDateRaw: string | null;
  currentCashCents: number; currentLoanCents: number; currentExpenseCents: number;
  noActivity: "checked_vector" | "unchecked" | "unknown";
  amendment: "checked_vector" | "unchecked" | "unknown";
  returnedCashCents: number | null;
  cashRows: readonly ArkansasPdfOccurrence[]; nonmoneyRows: readonly ArkansasPdfOccurrence[]; expenseRows: readonly ArkansasPdfOccurrence[];
  sectionTotals: Readonly<Record<string, number>>;
  sections: readonly number[];
  pages: readonly ArkansasPdfPage[];
};
const MAX_BYTES = 12 * 1024 * 1024;
const MAX_PAGES = 200;
const MAX_ITEMS = 200_000;
const CHECK_OPS = [13, 14, 14, 15, 14, 14, 15, 14, 15, 18];
const CHECK_COORDS = [0, 0, .066, -.026, .137, -.15, .259, .081, .46, .391, .553, .461, .604, .489, .703, .492, .543, .312, .255, -.205, .154, -.439, .069, -.399, .035, -.293, -.039, -.136, -.091, -.057];
const clean = (s: string): string => s.replace(/\s+/g, " ").trim();
function fail(s: string): never { throw new Error(`Arkansas financial PDF: ${s}`); }
export function arkansasFinancialDate(value: string): string {
  const us = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/.exec(value);
  if (!us && !iso) fail(`invalid date ${value}`);
  const y = Number(us ? us[3] : iso![1]), m = Number(us ? us[1] : iso![2]), d = Number(us ? us[2] : iso![3]);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (y < 1900 || y > 2100 || date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) fail(`invalid calendar date ${value}`);
  return date.toISOString().slice(0, 10);
}
export function arkansasFinancialMoney(value: string): number {
  const m = /^\$((?:\d{1,3}(?:,\d{3})+|\d+))\.(\d{2})$/.exec(clean(value));
  if (!m) fail(`invalid nonnegative money ${value}`);
  const cents = Number(m[1]!.replaceAll(",", "")) * 100 + Number(m[2]);
  if (!Number.isSafeInteger(cents) || cents < 0 || Number((cents / 100).toFixed(2)) * 100 !== cents && Math.round((cents / 100) * 100) !== cents) fail("unsafe money");
  return cents;
}
type Matrix = [number, number, number, number, number, number];
const identity: Matrix = [1, 0, 0, 1, 0, 0];
function mul(a: Matrix, b: number[]): Matrix { return [a[0]*b[0]!+a[2]*b[1]!, a[1]*b[0]!+a[3]*b[1]!, a[0]*b[2]!+a[2]*b[3]!, a[1]*b[2]!+a[3]*b[3]!, a[0]*b[4]!+a[2]*b[5]!+a[4], a[1]*b[4]!+a[3]*b[5]!+a[5]]; }
function point(m: Matrix, x: number, y: number): { x: number; y: number } { return { x: m[0]*x+m[2]*y+m[4], y: m[1]*x+m[3]*y+m[5] }; }
/** Only the exact observed CFIS check path, with its graphics-state transform, grants checked authority. */
export function inspectArkansasCheckboxOperators(ops: { fnArray: ArrayLike<number>; argsArray: ArrayLike<unknown> }, codes: { save: number; restore: number; transform: number; constructPath: number; fill: number; eoFill: number }): Pick<ArkansasPdfPage, "checkedBoxes" | "squareBoxes"> {
  let matrix = [...identity] as Matrix;
  const stack: Matrix[] = [], checked: { x: number; y: number }[] = [], squares: { x: number; y: number; size: number }[] = [];
  let pending: { x: number; y: number } | undefined;
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i], args = ops.argsArray[i] as unknown[] | null;
    if (fn === codes.save) stack.push([...matrix] as Matrix);
    else if (fn === codes.restore) { const previous = stack.pop(); if (!previous) fail("invalid graphics state"); matrix = previous; }
    else if (fn === codes.transform) { if (!Array.isArray(args) || args.length !== 6 || !args.every(n => typeof n === "number" && Number.isFinite(n))) fail("invalid graphics transform"); matrix = mul(matrix, args as number[]); }
    else if (fn === codes.constructPath) {
      pending = undefined;
      if (!args || !Array.isArray(args[0]) || !Array.isArray(args[1])) continue;
      const path = args[0] as number[], coords = args[1] as number[];
      if (path.length === 1 && path[0] === 19 && coords.length === 4 && Math.abs(coords[2]! - coords[3]!) < .01 && coords[2]! >= 8 && coords[2]! <= 12 && matrix[1] === 0 && matrix[2] === 0) {
        const pos = point(matrix, coords[0]!, coords[1]!); squares.push({ ...pos, size: Math.abs(coords[2]! * matrix[0]) });
      }
      if (path.length === CHECK_OPS.length && path.every((n,j) => n === CHECK_OPS[j]) && coords.length === CHECK_COORDS.length && coords.every((n,j) => Math.abs(n-CHECK_COORDS[j]!) < .000001) && matrix[1] === 0 && matrix[2] === 0 && Math.abs(matrix[0]-6.6) < .001 && Math.abs(matrix[3]-6.6) < .001) pending = point(matrix, .2, .1);
    } else if ((fn === codes.fill || fn === codes.eoFill) && pending) { checked.push(pending); pending = undefined; }
    else pending = undefined;
  }
  return { checkedBoxes: checked, squareBoxes: squares };
}
export async function extractArkansasFinancialPdf(bytes: Uint8Array): Promise<ArkansasFinancialPdfExtraction> {
  if (bytes.byteLength < 5 || bytes.byteLength > MAX_BYTES || Buffer.from(bytes.subarray(0, 5)).toString("ascii") !== "%PDF-") fail("invalid PDF bytes/size");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const { getDocument, OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: true });
  try {
    const pdf = await task.promise;
    if (!Number.isInteger(pdf.numPages) || pdf.numPages < 1 || pdf.numPages > MAX_PAGES) fail("page limit");
    const pages: ArkansasPdfPage[] = []; let count = 0;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      if (page.rotate !== 0 || page.view.length !== 4 || Math.abs(page.view[2]!-595) > 1 || Math.abs(page.view[3]!-842) > 1) fail("unsupported form page geometry");
      const content = await page.getTextContent();
      const cells: ArkansasPdfCell[] = [];
      for (const item of content.items) {
        if (!("str" in item) || !clean(item.str)) continue;
        const [a,b,c,d,x,y] = item.transform;
        if (![a,b,c,d,x,y,item.height].every(n => Number.isFinite(n)) || Math.abs(b!) > .001 || Math.abs(c!) > .001) fail("unsupported rotated text");
        cells.push({ text: clean(item.str), x: x!, y: y!, height: item.height });
        if (++count > MAX_ITEMS) fail("text item limit");
      }
      if (!cells.length) fail("image-only/empty page");
      const boxes = inspectArkansasCheckboxOperators(await page.getOperatorList(), OPS);
      pages.push({ pageNumber, width: page.view[2]!, height: page.view[3]!, cells, ...boxes });
    }
    return { sha256, byteCount: bytes.byteLength, pages };
  } finally { await task.destroy(); }
}
type Line = { y: number; cells: ArkansasPdfCell[]; text: string };
function lines(page: ArkansasPdfPage): Line[] {
  const groups: Line[] = [];
  for (const cell of page.cells) {
    let g = groups.find(g => Math.abs(g.y-cell.y) < 1.5);
    if (!g) { g = { y: cell.y, cells: [], text: "" }; groups.push(g); }
    g.cells.push(cell);
  }
  return groups.sort((a,b) => b.y-a.y).map(g => { g.cells.sort((a,b) => a.x-b.x); g.text = clean(g.cells.map(c=>c.text).join(" ")); return g; });
}
function uniqueLine(ls: Line[], re: RegExp, label: string): Line {
  const found = ls.filter(l => re.test(l.text));
  if (found.length !== 1) fail(`missing/ambiguous ${label}`);
  return found[0]!;
}
function firstMoney(line: Line, minX: number, maxX = 595): number {
  const values = line.cells.filter(c=>c.x>=minX&&c.x<maxX&&c.text.startsWith("$"));
  if (values.length !== 1) fail(`missing/ambiguous money ${line.text}`);
  return arkansasFinancialMoney(values[0]!.text);
}
function nextValue(ls: Line[], re: RegExp, label: string, minX = 0, maxX = 595): string {
  const h = uniqueLine(ls, re, label);
  const value = ls.find(l=>l.y < h.y-1.5 && l.y >= h.y-24);
  const text = value?.cells.filter(c=>c.x>=minX&&c.x<maxX).map(c=>c.text).join(" ");
  if (!text) fail(`missing ${label} value`); return clean(text);
}
function checkbox(page: ArkansasPdfPage, pattern: RegExp): ArkansasParsedFinancialReport["noActivity"] {
  const label = page.cells.find(c=>pattern.test(c.text));
  if (!label) return "unknown";
  const square = page.squareBoxes.find(b=>b.x < label.x && label.x-b.x<35 && Math.abs(b.y-label.y)<12);
  if (!square) return "unknown";
  return page.checkedBoxes.some(p=>p.x>square.x&&p.x<square.x+square.size&&p.y>square.y&&p.y<square.y+square.size) ? "checked_vector" : "unchecked";
}
function sectionHeader(ls: Line[], n: number): Line | undefined { return ls.find(l=>new RegExp(`^${n}\\.\\s+(?:ITEMIZED|NONMONEY|NONMONEY|NONMONEY|CAMPAIGN EXPENDITURES|LOAN INFORMATION|INFORMATION CONCERNING)`,"i").test(l.text)); }
function scheduleRows(page: ArkansasPdfPage, ls: Line[], section: number, mode: "cash"|"nonmoney"|"expense", kind: "candidate"|"independent", totals: Record<string,number>, previousRows: ArkansasPdfOccurrence[] = []): ArkansasPdfOccurrence[] {
  const h = sectionHeader(ls, section); if (!h) return [];
  const totalNumbers = mode === "cash" ? (kind === "candidate" ? [16,17,18] : [14,15,16]) : mode === "nonmoney" ? [kind === "candidate" ? 14 : 18] : (kind === "candidate" ? [24,25,26,27] : [20,21,22]);
  for (const n of totalNumbers) {
    const total = ls.find(l=>new RegExp(`^${n}\\.\\s+(?:TOTAL|Total)`).test(l.text));
    if (total) { const candidates = page.cells.filter(c=>c.x>=400&&Math.abs(c.y-total.y)<8&&c.text.startsWith("$")); if(candidates.length!==1)fail(`missing/ambiguous total ${n}`); const value = arkansasFinancialMoney(candidates[0]!.text); const key = String(n); if (totals[key] !== undefined && totals[key] !== value) fail(`conflicting total ${n}`); totals[key] = value; }
  }
  const end = ls.find(l=>new RegExp(`^${totalNumbers[0]}\\.\\s+(?:TOTAL|Total)`).test(l.text));
  const dateX = mode === "expense" ? (kind === "candidate" ? [330,460] : [330,445]) : [30,80];
  const candidates = ls.filter(l=>l.y < h.y-10 && (!end || l.y>end.y+1.5));
  const starts = candidates.filter(l=>l.cells.some(c=>c.x>=dateX[0]!&&c.x<dateX[1]!&&/^\d{2}\/\d{2}\/\d{4}$/.test(c.text)));
  const rows: ArkansasPdfOccurrence[] = [];
  // CFIS can split a wrapped cell at the page break without repeating the date.
  // Only same-section continuation cells below the repeated column header and
  // above the first new dated row belong to the preceding occurrence.
  if(starts.length&&mode!=="expense"){
    const legacy=mode==="cash"&&kind==="candidate"&&!page.cells.some(c=>c.text==="Description"&&c.y>700);
    const headerCells=page.cells.filter(c=>c.x>=250&&c.y<h.y&&c.y>h.y-85&&/^(?:Contributor|Cumulative Total|Cumulative|Total|Total from|this|from this|Employer\/Occupation|And Place of|Business|Contributions|for filing|period)$/.test(c.text));
    if(!headerCells.length)fail("missing repeated cumulative column header");
    const headerBottom=Math.min(...headerCells.map(c=>c.y));
    const continuation=page.cells.filter(c=>c.y<headerBottom-1.5&&c.y>starts[0]!.y+1.5&&c.height>=8.5&&c.x>=80&&c.x<(legacy?240:mode==="nonmoney"?250:225)).sort((a,b)=>b.y-a.y||a.x-b.x);
    const employment=page.cells.filter(c=>c.y<headerBottom-1.5&&c.y>starts[0]!.y+1.5&&c.height>=8.5&&mode==="cash"&&c.x>=(legacy?240:315)&&c.x<(legacy?345:408)).sort((a,b)=>b.y-a.y||a.x-b.x);
    if(continuation.length||employment.length){
      const previous=previousRows.at(-1);
      if(!previous||previous.section!==section||previous.pageNumber!==page.pageNumber-1)fail("orphan schedule continuation");
      previous.nameAddress=clean([previous.nameAddress,...continuation.map(c=>c.text)].join(" "));
      previous.employment=clean([previous.employment,...employment.map(c=>c.text)].join(" "));
      previous.rawCells=[...previous.rawCells,...continuation,...employment];
    }
  }
  for (let i=0;i<starts.length;i++) {
    const start = starts[i]!, lower = starts[i+1]?.y ?? end?.y ?? 0;
    const cells = candidates.filter(l=>l.y<=start.y+1.5&&l.y>lower+1.5).flatMap(l=>l.cells).filter(c=>c.height>=8.5);
    const dates = start.cells.filter(c=>c.x>=dateX[0]!&&c.x<dateX[1]!&&/^\d{2}\/\d{2}\/\d{4}$/.test(c.text));
    if (dates.length!==1) fail("ambiguous row date");
    const legacyCash = mode==="cash"&&kind==="candidate"&&!page.cells.some(c=>c.text==="Description"&&c.y>700);
    const nameRange = mode === "expense" ? [30,200] : [80,mode === "nonmoney" ? 250 : legacyCash ? 240 : 225];
    const descRange = mode === "expense" ? [200,330] : mode === "nonmoney" ? [250,330] : legacyCash ? [0,0] : [225,315];
    const amountRange = mode === "expense" ? [445,590] : mode === "nonmoney" ? [395,470] : legacyCash ? [405,480] : [445,505];
    const names = cells.filter(c=>c.x>=nameRange[0]!&&c.x<nameRange[1]!).map(c=>c.text);
    const amountCells = start.cells.filter(c=>c.x>=amountRange[0]!&&c.x<amountRange[1]!&&c.text.startsWith("$"));
    if (!names.length||amountCells.length!==1) fail(`incomplete section ${section} row`);
    const cumulative = mode==="expense"?[]:start.cells.filter(c=>c.x>=(mode==="nonmoney"?470:legacyCash?480:505)&&c.text.startsWith("$"));
    if (cumulative.length>1) fail("ambiguous cumulative amount");
    rows.push({section,pageNumber:page.pageNumber,ordinal:rows.length,date:arkansasFinancialDate(dates[0]!.text),nameAddress:clean(names.join(" ")),description:clean(cells.filter(c=>c.x>=descRange[0]!&&c.x<descRange[1]!).map(c=>c.text).join(" ")),employment:mode==="cash"?clean(cells.filter(c=>c.x>=(legacyCash?240:315)&&c.x<(legacyCash?345:408)).map(c=>c.text).join(" ")):"",election:mode==="cash"?clean(cells.filter(c=>c.x>=(legacyCash?345:408)&&c.x<(legacyCash?405:445)).map(c=>c.text).join(" ")):"",amountCents:arkansasFinancialMoney(amountCells[0]!.text),cumulativeCents:cumulative.length?arkansasFinancialMoney(cumulative[0]!.text):null,rawCells:cells});
  }
  // No fabricated empty schedule: a recognized explicit no-data marker or totals must exist.
  if (!rows.length&&!candidates.some(l=>/\*?NO DATA ENTERED/i.test(l.text))&&!end) fail(`unparsed/empty section ${section}`);
  return rows;
}
export function parseArkansasFinancialReportPdf(extraction: ArkansasFinancialPdfExtraction): ArkansasParsedFinancialReport {
  if (!/^[a-f0-9]{64}$/.test(extraction.sha256)||!Number.isInteger(extraction.byteCount)||extraction.byteCount<5||!extraction.pages.length||extraction.pages.length>MAX_PAGES) fail("invalid extraction identity");
  const page = extraction.pages[0]!, ls = lines(page);
  const kind = ls.some(l=>/INDEPENDENT EXPENDITURE REPORT/.test(l.text)) ? "independent" : ls.some(l=>/CAMPAIGN CONTRIBUTION AND EXPENDITURE REPORT/.test(l.text)) ? "candidate" : fail("unrecognized report form");
  const ownerName = nextValue(ls,kind==="candidate"?/^1\.\s*Name of Candidate/i:/^Name of independent expenditure committee/i,"owner");
  const officeName = kind==="candidate"?nextValue(ls,/^Office Sought/,"office",0,400):null;
  const district = kind==="candidate"?nextValue(ls,/^Office Sought/,"district",400):null;
  const report = uniqueLine(ls,kind==="candidate"?/^3\. Type of Report:/i:/^\d{4} .* covers period /,"report label");
  const match = kind==="candidate" ? /Type of Report:\s*(.+?)\s+covering\s*(\d{2}\/\d{2}\/\d{4})\s+through\s*(\d{2}\/\d{2}\/\d{4})/i.exec(report.text) : /^(.+?) covers period (\d{2}\/\d{2}\/\d{4}) Through (\d{2}\/\d{2}\/\d{4})/i.exec(report.text);
  if (!match) fail("missing exact report period");
  const stamps = page.cells.filter(c=>/^\d{2}\/\d{2}\/\d{4}\s+\d{1,2}:\d{2}:\d{2}\s+[AP]M$/.test(c.text));
  if(stamps.length!==1)fail("missing/ambiguous filed stamp");
  const stamp=stamps[0]!;
  if(kind==="independent"&&!page.cells.some(c=>c.text==="Filed"&&Math.abs(c.y-stamp.y)<2&&stamp.x-c.x>0&&stamp.x-c.x<40))fail("missing Filed stamp label");
  const sm = /(?:Filed )?(\d{2}\/\d{2}\/\d{4}) (\d{1,2}):(\d{2}):(\d{2}) ([AP]M)/.exec(stamp?.text??"");
  if (!sm||Number(sm[2])<1||Number(sm[2])>12||Number(sm[3])>59||Number(sm[4])>59) fail("invalid filed stamp");
  const hour = Number(sm[2])%12+(sm[5]==="PM"?12:0);
  const filedAt = `${arkansasFinancialDate(sm[1]!)}T${String(hour).padStart(2,"0")}:${sm[3]}:${sm[4]}`;
  const electionLine = ls.find(l=>/Type of Election:/.test(l.text));
  const electionYear = /Year of Election:\s*(\d{4})/.exec(electionLine?.text??"");
  let electionTypeRaw = kind==="candidate" ? /Type of Election:\s*(.*?)\s+Year of Election:/.exec(electionLine?.text??"")?.[1]??null : null;
  if(kind==="independent"&&electionLine) { const following=ls.filter(l=>l.y<electionLine.y&&l.y>electionLine.y-45); electionTypeRaw=following.map(l=>l.text).join(" ")||null; }
  const electionDateRaw = /Date of election\s*(\d{2}\/\d{2}\/\d{4})/i.exec(electionLine?.text??"")?.[1]??null;
  function coverMoney(pattern: RegExp, label: string): number {
    const row = uniqueLine(ls, pattern, label);
    const cells = page.cells.filter(c=>c.x>=350&&c.x<480&&Math.abs(c.y-row.y)<8&&c.text.startsWith("$"));
    if(cells.length!==1)fail(`missing/ambiguous ${label} money`);
    return arkansasFinancialMoney(cells[0]!.text);
  }
  const currentCashCents = coverMoney(/^7\. Total Monetary Contributions/i,"cash cover");
  const currentLoanCents = coverMoney(/^6\. Total Loans/i,"loan cover");
  const currentExpenseCents = coverMoney(/^8\. Total Expenditures/i,"expense cover");
  const noActivity=checkbox(page,/NO ACTIVITY/), amendment=checkbox(page,/Check if this report is an amendment/);
  const sections: number[]=[], totals:Record<string,number>={}, cashRows:ArkansasPdfOccurrence[]=[],nonmoneyRows:ArkansasPdfOccurrence[]=[],expenseRows:ArkansasPdfOccurrence[]=[];
  let returnedCashCents: number|null=null, filerId:string|null=null;
  for(const pg of extraction.pages) {
    const pl=lines(pg);
    for(const l of pl) {
      const id=/^Filer ID\s*:\s*(\d+)$/.exec(l.text); if(id) { if(filerId!==null&&filerId!==id[1])fail("conflicting FilerID");filerId=id[1]!; }
      const ret=/^Returned Contributions$/.test(l.cells[0]?.text??""); if(ret) { const value=firstMoney(l,400);if(returnedCashCents!==null&&returnedCashCents!==value)fail("conflicting returned contributions"); returnedCashCents=value; }
    }
    for(const n of (kind==="candidate"?[11,13,15,19,23]:[10,11,13,17,19])) if(sectionHeader(pl,n)&&!sections.includes(n))sections.push(n);
    cashRows.push(...scheduleRows(pg,pl,kind==="candidate"?15:13,"cash",kind,totals,cashRows));
    nonmoneyRows.push(...scheduleRows(pg,pl,kind==="candidate"?13:17,"nonmoney",kind,totals,nonmoneyRows));
    expenseRows.push(...scheduleRows(pg,pl,kind==="candidate"?23:19,"expense",kind,totals));
  }
  if(sections.length===0) {
    if(extraction.pages.length>2||extraction.pages.slice(1).some(p=>p.cells.some(c=>c.text.includes("$")||/^\d{2}\/\d{2}\/\d{4}$/.test(c.text))))fail("unrecognized abbreviated report content");
    if(noActivity!=="checked_vector"||currentCashCents!==0||currentLoanCents!==0||currentExpenseCents!==0)fail("abbreviated report lacks certified noactivity zero");
  } else {
    for(const section of (kind==="candidate"?[11,13,15,19,23]:[10,11,13,17,19]))if(!sections.includes(section))fail(`missing section ${section}`);
    for(const n of(kind==="candidate"?[14,16,17,18,24,25,26,27]:[14,15,16,18,20,21,22]))if(totals[String(n)]===undefined)fail(`missing total ${n}`);
  }
  const periodStart=arkansasFinancialDate(match[2]!),periodEnd=arkansasFinancialDate(match[3]!);if(periodStart>periodEnd)fail("reversed period");
  return{sha256:extraction.sha256,byteCount:extraction.byteCount,kind,ownerName,filerId,officeName,district,reportLabel:clean(match[1]!),periodStart,periodEnd,filedAt,electionTypeRaw,electionYear:electionYear?Number(electionYear[1]):null,electionDateRaw,currentCashCents,currentLoanCents,currentExpenseCents,noActivity,amendment,returnedCashCents,cashRows,nonmoneyRows,expenseRows,sectionTotals:totals,sections,pages:extraction.pages};
}
