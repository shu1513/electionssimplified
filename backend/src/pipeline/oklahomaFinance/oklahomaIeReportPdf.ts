import { inspectMarylandPdfBorders, type MarylandPdfBorder } from "../marylandFinance/marylandReportPdfGeometry.js";

export class OklahomaIeReportHold extends Error {
  constructor(public readonly code: string) { super(`Oklahoma IE report held: ${code}`); }
}
function hold(code: string): never { throw new OklahomaIeReportHold(code); }
type Cell = { text: string; left: number; right: number; y: number };
type Box = { left: number; right: number; top: number; bottom: number };
type Header = { box: Box; label: string };
export type OklahomaIePrintedRow = {
  candidateAndStance: string; type: string; dates: string[]; cents: number;
};
export type OklahomaIeReport = {
  rows: OklahomaIePrintedRow[]; declaredCents: number; parsedCents: number;
  controlsClose: boolean; pages: number; fullText: string;coverText:string;coverColumns:string[];
};
const letters = (s: string) => s.replace(/[^A-Za-z]/g, "").toUpperCase();

/** Signed decimal cents. Wrapped tokens in one painted cell are one amount. */
export function oklahomaIePrintedCents(raw: string): number | null {
  const s = raw.replace(/\s/g, "").replace(/\u2212/g, "-");
  if (!/^(?:-?\$?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?|\(\$?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?\))$/.test(s)) return null;
  const negative = s.startsWith("-") || s.startsWith("(");
  const [whole, fraction = ""] = s.replace(/[-$(),]/g, "").split(".");
  const n = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(n) ? (negative ? -n : n) : null;
}

function rectangle(c: Cell, borders: readonly MarylandPdfBorder[]): Box | null {
  const vs = borders.filter(b => Math.abs(b.x1-b.x2)<.01 && Math.min(b.y1,b.y2)<=c.y+.1 && Math.max(b.y1,b.y2)>=c.y-.1);
  const left = Math.max(...vs.filter(b=>b.x1<=c.left+.5).map(b=>b.x1));
  const right = Math.min(...vs.filter(b=>b.x1>c.left+.5).map(b=>b.x1));
  const hs = borders.filter(b=>Math.abs(b.y1-b.y2)<.01 && Math.min(b.x1,b.x2)<=c.left+1.1 && Math.max(b.x1,b.x2)>=c.left+.9);
  const top = Math.max(...hs.filter(b=>b.y1<c.y).map(b=>b.y1));
  const bottom = Math.min(...hs.filter(b=>b.y1>c.y).map(b=>b.y1));
  return [left,right,top,bottom].every(Number.isFinite) ? {left,right,top,bottom} : null;
}
function ordered(cells: Cell[], separator: string) {
  return cells.sort((a,b)=>a.y-b.y||a.left-b.left).map(c=>c.text).join(separator);
}

/** Full native PDF only. Geometry and names stay in memory. Parsing never
 * establishes inventory membership, version authority or candidate allocation. */
export async function parseOklahomaIeReportPdf(bytes: Uint8Array): Promise<OklahomaIeReport> {
  if (bytes.byteLength<5 || bytes.byteLength>16*1024*1024 || Buffer.from(bytes.subarray(0,5)).toString()!=="%PDF-" || !Buffer.from(bytes.subarray(-128)).includes(Buffer.from("%%EOF"))) hold("pdf_bytes");
  const { getDocument, OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({data:new Uint8Array(bytes),isEvalSupported:false,useSystemFonts:true});
  try {
    const pdf = await task.promise;
    if (pdf.numPages<1 || pdf.numPages>100) hold("pdf_page_limit");
    const rows: OklahomaIePrintedRow[] = []; let active: Header[] | null = null, declared: number | null = null, parsed = 0, fullText = "",coverText="",coverColumns:string[]=[];
    for (let p=1;p<=pdf.numPages;p++) {
      const page=await pdf.getPage(p);
      try {
        if (page.rotate!==0 || page.userUnit!==1 || page.view[0]!==0 || page.view[1]!==0) hold("pdf_orientation");
        const content=await page.getTextContent(),height=page.view[3]!;
        const cells: Cell[]=[];
        for (const i of content.items) {
          if (!("str" in i) || !i.str.trim()) continue;
          if (![...i.transform,i.width,i.height].every(Number.isFinite) || Math.abs(i.transform[1]!)>.001 || Math.abs(i.transform[2]!)>.001) hold("pdf_text_transform");
          cells.push({text:i.str.trim(),left:i.transform[4]!,right:i.transform[4]!+i.width,y:height-i.transform[5]!-i.height*.3});
        }
        fullText += ordered([...cells], " ")+"\n";
        const borders=inspectMarylandPdfBorders(await page.getOperatorList(),OPS,height);
        const anchors=cells.filter(c=>/\bCandidate/.test(c.text)); let cutoff=0;
        if (anchors.length) {
          if (anchors.length!==1) hold("pdf_header");
          const ar=rectangle(anchors[0]!,borders); if(!ar) hold("pdf_header_border");
          if(p===1){const cover=cells.filter(c=>c.y<ar.top);coverText=ordered([...cover]," ");
            // Row-major extraction can interleave another cover column with
            // a wrapped filer label. Reassemble equal left alignments too.
            coverColumns=[...new Set(cover.map(c=>Math.round(c.left*2)/2))].map(x=>ordered(cover.filter(c=>Math.abs(c.left-x)<.51)," "));
          }
          const grouped=new Map<string,{box:Box;cells:Cell[]}>();
          for(const c of cells.filter(c=>c.y>ar.top && c.y<ar.bottom)) {
            const b=rectangle(c,borders); if(!b) hold("pdf_header_border");
            const key=JSON.stringify(b),g=grouped.get(key)??{box:b,cells:[]}; g.cells.push(c);grouped.set(key,g);
          }
          active=[...grouped.values()].map(g=>({box:g.box,label:letters(ordered(g.cells,""))}));
          if(active.length!==6 || active.filter(h=>["CANDIDATE","OFFICE","SUPPORT","OPPOSE"].every(w=>h.label.includes(w))).length!==1 || active.filter(h=>h.label.includes("AMOUNT")).length!==1 || active.filter(h=>h.label.includes("TYPE")).length!==1 || active.filter(h=>h.label.includes("DATE")&&!h.label.includes("CANDIDATE")).length!==1 || active.filter(h=>h.label.includes("DESCRIPTION")).length!==1 || active.filter(h=>["EXPENDITURE","NAME","ADDRESS"].every(w=>h.label.includes(w))).length!==1) hold("pdf_header_schema");
          cutoff=active.find(h=>h.label.includes("AMOUNT"))!.box.bottom;
          const controls=cells.filter(c=>c.y<anchors[0]!.y && /^\$[\d,]+\.\d{2}$/.test(c.text));
          if(controls.length!==1) hold("pdf_parent_control");
          const n=oklahomaIePrintedCents(controls[0]!.text); if(n===null || n<0 || (declared!==null && declared!==n)) hold("pdf_parent_control"); declared=n;
        }
        if(!active) hold("pdf_missing_header");
        const amount=active.find(h=>h.label.includes("AMOUNT"))!;
        const boxes=new Map<string,Box>();
        // Enumerate every nonempty amount cell, including unknown/correcting
        // syntax. Numeric-only seeds would silently skip malformed amounts.
        for(const c of cells.filter(c=>c.y>cutoff && c.left>=amount.box.left-.5 && c.left<amount.box.right-.5)) {
          const b=rectangle(c,borders);
          // Cover/footer rectangles may cross the amount column on headerless
          // continuation pages. Only its actual painted column is a data cell.
          // A skipped cell that reads as money is a data row with broken or
          // shifted borders: dropping it would let reconciliation fail while a
          // candidate whose only row it was still reads as $0, so hold instead.
          if(!b||Math.abs(b.left-amount.box.left)>.5||Math.abs(b.right-amount.box.right)>.5){
            if(/^[\s$(),.\d−-]+$/.test(c.text)&&/\d/.test(c.text))hold("pdf_amount_border");
            continue;
          }
          boxes.set(JSON.stringify(b),b);
        }
        for(const rb of boxes.values()) {
          const read=(h:Header,sep=" ")=>ordered(cells.filter(c=>c.y>Math.max(rb.top,cutoff) && c.y<rb.bottom && c.left>=h.box.left-.5 && c.left<h.box.right-.5),sep);
          const n=oklahomaIePrintedCents(read(amount,"")); if(n===null) hold("pdf_amount");
          parsed+=n;if(!Number.isSafeInteger(parsed))hold("unsafe_money");
          rows.push({candidateAndStance:read(active.find(h=>h.label.includes("CANDIDATE"))!),type:letters(read(active.find(h=>h.label.includes("TYPE"))!,"")),dates:active.filter(h=>h.label.includes("DATE")&&!h.label.includes("CANDIDATE")).map(h=>read(h,"")),cents:n});
        }
      } finally {page.cleanup();}
    }
    if(declared===null || !rows.length)hold("pdf_missing_control_or_rows");
    return {rows,declaredCents:declared,parsedCents:parsed,controlsClose:parsed===declared,pages:pdf.numPages,fullText,coverText,coverColumns};
  } finally {await task.destroy();}
}

/** Exactly one printed target per amount. Multi-target cells carry no
 * per-candidate allocation and must never duplicate or divide the amount. */
export function singleOklahomaIeTarget(raw: string): {name:string;stance:"support"|"oppose"} | null {
  if((raw.match(/\(\s*(?:Support|Oppose)\s*\)/gi)??[]).length!==1)return null;
  const m=/^(.+?)\s*\(\s*(Support|Oppose)\s*\)\s*$/i.exec(raw);
  if(!m?.[1]?.trim()||/[,;&/]|\b(?:AND|OR)\b/i.test(m[1]))return null;
  return {name:m[1].trim(),stance:m[2]!.toLowerCase() as "support"|"oppose"};
}

export type OklahomaIePrintedTarget={name:string;office:string;district:string|null;stance:"support"|"oppose"};
/** Native target cells print name, office, then explicit stance together.
 * District is supplied by the corroborated receiving profile, never invented
 * from this label. Unknown office grammar holds the complete observation. */
export function parseOklahomaIePrintedTargets(raw:string):OklahomaIePrintedTarget[]|null {
  const targets:OklahomaIePrintedTarget[]=[];let end=0;
  const offices="Lieutenant Governor|Attorney General|State Treasurer|State Auditor and Inspector|State Auditor|Auditor and Inspector|Superintendent of Public Instruction|State Superintendent of Public Instruction|State Superintendent|Commissioner of Insurance|Insurance Commissioner|Labor Commissioner|Commissioner of Labor|Corporation Commissioner|State Senator|State Senate|State Representative|State House|Governor|Treasurer|Auditor|County Commissioner|District Attorney|County Sheriff|Sheriff|County Assessor|County Clerk|County Treasurer|County Court Clerk|Court Clerk|Associate District Judge|District Court Judge|District Judge|Special District Judge|Supreme Court Justice|Court of Civil Appeals Judge|Court of Criminal Appeals Judge|City Council|City Councilor|City Council Member|Town Council|Town Council Member|Council Member|City Council Ward|Town Council Ward|Council Ward|Council|Mayor|School Board|School Board Member|School Board District|Board of Education|City Clerk|County|Trustee".split("|").sort((a,b)=>b.length-a.length);
  const suffix=new RegExp(`^(.*?)\\s*(${offices.map(s=>s.split(" ").join("\\s*")).join("|")})(?:\\s*[-,:]?\\s*(?:District|Dist\\.?|#)?\\s*(\\d+))?\\s*$`,"i");
  for(const m of raw.matchAll(/(.+?)\(\s*(Support|Oppose)\s*\)/gi)){
    if(m.index!==end)return null;end=m.index!+m[0].length;
    const nameAndOffice=suffix.exec(m[1]!.trim());if(!nameAndOffice?.[1]?.trim())return null;
    const office=offices.find(s=>s.replace(/\s/g,"").toUpperCase()===nameAndOffice[2]!.replace(/\s/g,"").toUpperCase());if(!office)return null;
    targets.push({name:nameAndOffice[1].trim(),office,district:nameAndOffice[3]?String(Number(nameAndOffice[3])):null,stance:m[2]!.toLowerCase() as "support"|"oppose"});
  }
  return targets.length&&raw.slice(end).trim()===""?targets:null;
}
