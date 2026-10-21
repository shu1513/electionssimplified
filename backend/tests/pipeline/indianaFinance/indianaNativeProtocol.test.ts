import { describe, expect, it } from "vitest";
import {
  INDIANA_NATIVE_ORIGIN as origin, inCents, inDay, inFiledClock, inHtml,
  closeIndianaNativeReceiptPages, parseIndianaNativeReceiptPage,
  qualifyIndianaNativePacSubset, selectIndianaNativeFilingVersion,
  type IndianaNativeReceipt, type IndianaNativeReceiptDetail, type IndianaNativeReceiptPage,
} from "../../../src/pipeline/indianaFinance/indianaNativeProtocol.js";

const html = (s: string) => inHtml(Buffer.from(s), origin);
const receipt = (id: string, cents = 10000): IndianaNativeReceipt => ({ url: `${origin}/PublicSite/SearchPages/ContributionDetail.aspx?Synthetic=${id}`, cells: [id], name: "Synthetic PAC", committee: "Synthetic Candidate Committee", kind: "Direct", day: "2026-10-01", cents });
const page = (rows: IndianaNativeReceipt[], count = rows.length): IndianaNativeReceiptPage => ({ count, totalCents: rows.reduce((n,r) => n+r.cents,0), rows, pager: { page: 1, sizeName: "synthetic_size", size50Value: "50", resize: ["synthetic_size", ""], next: null } });
const detail = (r: IndianaNativeReceipt): IndianaNativeReceiptDetail => ({ file: "synthetic-file", committee: r.committee, committeeClass: "Candidate", donorClass: "Political Action Committee", name: r.name, kind: r.kind, day: r.day, cents: r.cents });

describe("Indiana native financial boundaries", () => {
  it("preserves signed credits and exact four-place currency, without rounding", () => {
    expect(inCents("($1,234.50)")).toBe(-123450);
    expect(inCents("-$1,234.5000")).toBe(-123450);
    expect(inCents("$0.00")).toBe(0);
    for (const value of ["$1.001", "1,23.00", "(-1.00)", "NaN", "9007199254740992"]) expect(() => inCents(value)).toThrow();
  });
  it("validates actual calendar days and source wall clocks, including noon/midnight", () => {
    expect(inDay("2/29/2024")).toBe("2024-02-29");
    expect(() => inDay("2/29/2026")).toThrow();
    expect(inFiledClock("Oct 16 2026 12:00AM")).toBe("2026-10-16T00:00:00");
    expect(inFiledClock("Oct 16 2026 12:00PM")).toBe("2026-10-16T12:00:00");
    expect(() => inFiledClock("Feb 30 2026 1:00PM")).toThrow();
    expect(() => inFiledClock("Oct 16 2026 13:00PM")).toThrow();
  });
  it("rejects malformed bytes before reading any plausible prefix", () => {
    expect(() => inHtml(Buffer.from([0x3c,0x70,0x3e,0xc3,0x28]),origin)).toThrow("invalid_utf8");
  });
  it("closes a signed ledger, but rejects missing rows, duplicate native events and changed closing money", () => {
    const rows=[receipt("one"),receipt("credit",-12000)], p=page(rows);
    expect(closeIndianaNativeReceiptPages([p],[structuredClone(p)],rows[0]!.committee)).toEqual(rows);
    expect(p.totalCents).toBe(-2000);
    expect(() => closeIndianaNativeReceiptPages([page(rows,3)],[page(rows,3)],rows[0]!.committee)).toThrow("native_receipt_full_closure");
    const duplicate=page([rows[0]!,rows[0]!]);
    expect(() => closeIndianaNativeReceiptPages([duplicate],[duplicate],rows[0]!.committee)).toThrow("native_receipt_identity_conflict");
    expect(() => closeIndianaNativeReceiptPages([p],[{...p,totalCents:0}],rows[0]!.committee)).toThrow("native_receipt_closing_changed");
  });
  it("requires complete PAC event/value subset and literal donor class independently of gift kind", () => {
    const r=receipt("one"), args={all:[r],pac:[r],details:new Map([[r.url,detail(r)]]),file:"synthetic-file",committee:r.committee};
    expect(qualifyIndianaNativePacSubset(args).cashCents).toBe(10000);
    expect(() => qualifyIndianaNativePacSubset({...args,pac:[{...r,cents:20000}]})).toThrow("pac_not_exact_native_subset");
    expect(() => qualifyIndianaNativePacSubset({...args,details:new Map([[r.url,{...detail(r),donorClass:"Individual"}]])})).toThrow("pac_detail_conflict");
    expect(() => qualifyIndianaNativePacSubset({...args,details:new Map([[r.url,{...detail(r),file:"different-file"}]])})).toThrow("pac_recipient_identity_conflict");
  });
  it("separates cash and in-kind gifts, preserves credits, and excludes source-declared loans", () => {
    const cash=receipt("cash"), credit=receipt("credit",-2000), inkind={...receipt("inkind",3000),kind:"In-Kind"}, loan={...receipt("loan",9000),kind:"Loan"};
    const rows=[cash,credit,inkind,loan], result=qualifyIndianaNativePacSubset({all:rows,pac:rows,details:new Map(rows.map(r=>[r.url,detail(r)])),file:"synthetic-file",committee:cash.committee});
    expect([result.cashCents,result.inKindCents,result.excludedNonGiftRows,result.gifts.length]).toEqual([8000,3000,1,3]);
  });
  it("parses the numeric US filed clocks published by native registration families strictly", () => {
    expect(inFiledClock("10/16/2026 12:00AM")).toBe("2026-10-16T00:00:00");
    expect(inFiledClock("10/16/2026 12:00:59PM")).toBe("2026-10-16T12:00:59");
    expect(inFiledClock("2/29/2024")).toBe("2024-02-29T00:00:00");
    expect(() => inFiledClock("2/29/2026 1:00PM")).toThrow("invalid_calendar_date");
    expect(() => inFiledClock("16/10/2026 1:00PM")).toThrow("invalid_calendar_date");
    expect(() => inFiledClock("10/16/2026 13:00PM")).toThrow("invalid_filed_hour");
    expect(() => inFiledClock("10/16/2026 24:00")).toThrow("invalid_filed_time");
    expect(() => inFiledClock("10/16/2026 unknown")).toThrow("invalid_filed_clock");
  });

  it("uses the unique latest filed clock for amended families, never source ids or row position", () => {
    const d=html(`<table id="_ctl0_Content_grdAmendments"><tr><th>Amendment</th><th>Report</th><th>Filed</th><th></th></tr>${[
      ["Amended","Oct 16 2026 3:00PM","latest"],["","Oct 15 2026 3:00PM","base"],["Amended","Oct 16 2026 2:00PM","earlier"],
    ].map(([caption,clock,id])=>`<tr><td><span id="${id}_lblAmendment">${caption}</span></td><td>2026 PreElect Report</td><td><span id="${id}_lblFiledDate">${clock}</span></td><td><a href="javascript:__doPostBack('${id}','')">View</a></td></tr>`).join("")}</table>`);
    try { expect(selectIndianaNativeFilingVersion(d,"2026 PreElect Report",true).callback[0]).toBe("latest");
      d.querySelector("#earlier_lblFiledDate")!.textContent="Oct 16 2026 3:00PM";
      expect(()=>selectIndianaNativeFilingVersion(d,"2026 PreElect Report",true)).toThrow("ambiguous_native_replacement");
    } finally { d.defaultView?.close(); }
  });
  it("reads grid Type as gift kind and the native event link as identity", () => {
    const d=html(`<span id="_ctl0_Content_lblRecordsFound">1 records found</span><span id="_ctl0_Content_lblTotalContributions">$100.00</span><table id="_ctl0_Content_dgdSearchResults"><tr>${["Contributor","City, State","Type","Amount","Date","Candidate/Committee Name","In Kind?","Large?",""] .map(v=>`<th>${v}</th>`).join("")}</tr><tr><td>Synthetic PAC</td><td>Example, IN</td><td>Direct</td><td>$100.00</td><td>10/1/2026</td><td>Synthetic Committee</td><td></td><td></td><td><a onclick="window.open('/PublicSite/SearchPages/ContributionDetail.aspx?Synthetic=one')">View</a></td></tr><tr><td colspan="9"><span>1</span><select name="synthetic_size" onchange="__doPostBack('synthetic_size','')"><option>10</option><option>25</option><option>50</option></select></td></tr></table>`);
    try { const p=parseIndianaNativeReceiptPage(d,origin);expect(p.rows[0]!.kind).toBe("Direct");expect(p.rows[0]!.url).toContain("Synthetic=one");expect(p.totalCents).toBe(10000); }
    finally { d.defaultView?.close(); }
  });
});

// Supplemental reports can overlap later regular filings. Late corrections
// must hold, rather than double counting or quietly dropping the supplement.
describe("Indiana current financial periods", () => {
  it("holds gaps, uncovered late money and later supplemental corrections", async () => {
    const {qualifyIndianaNativePeriods}=await import("../../../src/pipeline/indianaFinance/indianaNativeProtocol.js");
    const periods=[{begin:"2025-01-01",end:"2025-12-31",filed:"2026-01-20T10:00:00"},{begin:"2026-01-01",end:"2026-10-09",filed:"2026-10-16T10:00:00"}];
    const covered={begin:"2026-04-20",end:"2026-04-20",filed:"2026-04-21T10:00:00"};
    expect(()=>qualifyIndianaNativePeriods(periods,[covered],"2025-01-01","2026-10-21")).not.toThrow();
    expect(()=>qualifyIndianaNativePeriods(periods,[{...covered,begin:"2026-10-20",end:"2026-10-20"}],"2025-01-01","2026-10-21")).toThrow("unqualified_uncovered_supplement");
    expect(()=>qualifyIndianaNativePeriods(periods,[{...covered,filed:"2026-10-17T10:00:00"}],"2025-01-01","2026-10-21")).toThrow("unqualified_uncovered_supplement");
    expect(()=>qualifyIndianaNativePeriods([{...periods[0]!}, {...periods[1]!,begin:"2026-01-02"}],[],"2025-01-01","2026-10-21")).toThrow("native_period_gap_or_overlap");
  });
});
