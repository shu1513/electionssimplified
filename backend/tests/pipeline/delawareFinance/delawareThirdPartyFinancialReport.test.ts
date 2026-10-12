import { describe, expect, it } from "vitest";
import {
  extractDelawareThirdPartyFinancialPdf,
  parseDelawareThirdPartyFinancialReport,
  type DelawareThirdPartyPdfCell,
  type DelawareThirdPartyPdfExtraction,
} from "../../../src/pipeline/delawareFinance/delawareThirdPartyFinancialReport.js";

// Sanitized positioned source-shaped facts. No real addresses or fetched PDF bodies.
const cell = (
  text: string,
  x: number,
  y: number,
): DelawareThirdPartyPdfCell => ({ text, x, y, width: 20, height: 9 });
function fixture(): DelawareThirdPartyPdfExtraction {
  const pages = Array.from({ length: 11 }, (_, i) => ({
    pageNumber: i + 1,
    width: 792,
    height: 612,
    cells: [] as DelawareThirdPartyPdfCell[],
  }));
  pages[0]!.cells = [
    cell("FULL ORGANIZATION NAME:", 38, 428),
    cell("THE STATEHOUSE FUND", 426, 428),
    cell("ACCOUNT NUMBER :", 38, 408),
    cell("04006716", 264, 408),
    cell("DATE OF THIS REPORT :", 438, 408),
    cell("08/18/2026", 616, 408),
    cell("REPORTING PERIOD START :", 38, 388),
    cell("08/05/2026", 262, 388),
    cell("REPORTING PERIOD END :", 438, 388),
    cell("08/18/2026", 616, 388),
  ];
  for (const p of pages.slice(1))
    p.cells = [
      cell("ACCOUNT NUMBER :", 38, 440),
      cell("04006716", 264, 440),
      cell("REPORTING PERIOD :", 330, 440),
      cell("08/05/2026", 485, 440),
      cell("08/18/2026", 659, 440),
    ];
  pages[1]!.cells.push(
    cell("STATEMENT OF ACCOUNT BALANCE", 275, 500),
    cell("A. SCHEDULE A - TOTAL RECEIPTS", 55, 390),
    cell("$525,000.00", 650, 390),
    cell("F. SCHEDULE B - TOTAL EXPENDITURES", 55, 287),
    cell("$499,015.00", 650, 287),
  );
  pages[1]!.cells.push(
    cell("1. BEGINNING BALANCE", 55, 424),
    cell("$0.00", 670, 424),
    cell("E. SUBTOTAL (Total of A,B,C,D)", 55, 320),
    cell("$525,000.00", 646, 320),
    cell("J. SUBTOTAL (Total of F,G,H,I)", 55, 219),
    cell("$499,015.00", 647, 219),
    cell("4. ENDING BALANCE", 55, 193),
    cell("$25,985.00", 650, 193),
  );
  pages[2]!.cells.push(
    cell("SCHEDULE A - TOTAL RECEIPTS", 292, 494),
    cell("Date Received", 60, 355),
    cell("Contributor Name", 204, 355),
    cell("Contributor Mailing Address", 382, 355),
    cell("Aggregate Amount", 554, 355),
    cell("Amount Received", 659, 355),
    cell("08/07/2026", 60, 338),
    cell("Public First Action", 146, 338),
    cell("SANITIZED ADDRESS", 330, 338),
    cell("$525,000.00", 598, 338),
    cell("$525,000.00", 703, 338),
    cell("TOTAL ITEMIZED RECEIPTS", 39, 313),
    cell("$525,000.00", 703, 313),
    cell("TOTAL OF CONTRIBUTIONS NOT EXCEEDING $100", 39, 295),
    cell("$0.00", 727, 295),
    cell("GRAND TOTAL RECEIPTS", 39, 277),
    cell("$525,000.00", 703, 277),
  );
  pages[3]!.cells.push(
    cell("SCHEDULE B - TOTAL EXPENDITURES", 281, 490),
    cell("Date Expended", 49, 344),
    cell("Payee Name", 175, 344),
    cell("Payee Mailing Address", 304, 344),
    cell("Vendor", 492, 344),
    cell("Aggregate", 604, 349),
    cell("Amount", 604, 338),
    cell("Amount", 685, 349),
    cell("Expended", 685, 338),
    cell("08/17/2026", 60, 324),
    cell("Bryson Gillette, LLC", 129, 324),
    cell("SANITIZED ADDRESS", 300, 324),
    cell("$499,015.00", 621, 324),
    cell("$499,015.00", 700, 324),
    cell("Support of Kathleen Jennings - State", 129, 304),
    cell("Office - Attorney General - Democratic", 129, 294),
    cell("TOTAL ITEMIZED EXPENDITURES", 38, 279),
    cell("$499,015.00", 700, 279),
    cell("TOTAL OF EXPENDITURES NOT EXCEEDING $100", 38, 261),
    cell("$0.00", 725, 261),
    cell("GRAND TOTAL EXPENDITURES", 38, 243),
    cell("$499,015.00", 700, 243),
  );
  const extras = [
    ["SCHEDULE C-1 - TOTAL IN-KIND RECEIPTS", "GRAND TOTAL RECEIPTS", 1],
    [
      "SCHEDULE C-2 - TOTAL IN-KIND EXPENDITURES",
      "GRAND TOTAL EXPENDITURES",
      1,
    ],
    [
      "SCHEDULE D-1 - TOTAL LOANS RECEIVED AND DEBTS INCURRED",
      "TOTAL LOANS RECEIVED",
      1,
    ],
    ["SCHEDULE D-2 - TOTAL LOANS AND DEBTS OUTSTANDING", "TOTAL LOANS", 3],
    [
      "SCHEDULE E - INTER COMMITTEE (SHARED) EXPENSES",
      "TOTAL REIMBURSEMENTS RECEIVED",
      2,
    ],
    ["SCHEDULE F - NON-CASH ASSETS", "TOTAL ASSET VALUE", 1],
    ["SCHEDULE G - ELIMINATION OF ASSETS", "TOTAL ASSETS ELIMINATED", 1],
  ] as const;
  extras.forEach(([title, label, count], i) => {
    const p = pages[i + 4]!;
    p.cells.push(
      cell(title, 250, 490),
      cell(label, 38, 300),
      ...Array.from({ length: count }, (_, j) =>
        cell("$0.00", 600 + j * 50, 300),
      ),
    );
    if (i === 4)
      p.cells.push(
        cell("TOTAL REIMBURSEMENTS PAID", 38, 200),
        cell("$0.00", 645, 200),
        cell("$0.00", 725, 200),
      );
  });
  return {
    sha256: "a".repeat(64),
    byteCount: 132876,
    pages,
    cover: {
      pageNumber: 2,
      beginningBalanceCents: 0,
      receiptsCents: 52500000,
      expendituresCents: 49901500,
      endingBalanceCents: 2598500,
      reportingPeriodFrom: "08/05/2026",
      reportingPeriodTo: "08/18/2026",
      documentVersion: 1,
      method: "rows",
    },
  };
}
const page = (e: DelawareThirdPartyPdfExtraction, n: number) => e.pages[n - 1]!;
const text = (e: DelawareThirdPartyPdfExtraction, n: number, s: string) =>
  page(e, n).cells.find((c) => c.text === s)!;

describe("Delaware positioned third-party financial facts", () => {
  it("pairs the source target caption with expended amount, retaining ordinary monetary facts rather than currentness authority", () => {
    const r = parseDelawareThirdPartyFinancialReport(fixture());
    expect(r).toMatchObject({
      accountNumber: "04006716",
      organizationName: "THE STATEHOUSE FUND",
      periodStart: "2026-08-05",
      periodEnd: "2026-08-18",
      reportDate: "2026-08-18",
    });
    expect(r.expenditures[0]).toMatchObject({
      amountCents: 49901500,
      name: "Bryson Gillette, LLC",
      target: {
        direction: "support",
        candidateName: "Kathleen Jennings",
        officeName: "Attorney General",
        party: "Democratic",
      },
    });
    expect(r.receipts[0]).toMatchObject({
      amountCents: 52500000,
      date: "2026-08-07",
    });
    expect(r.controls.expenditures.anonymousCents).toBe(0);
    expect(Object.values(r.supplementalTotals).flat()).toEqual(
      Array(12).fill(0),
    );
    expect(r).not.toHaveProperty("verified");
    expect(r).not.toHaveProperty("reportId");
  });
  it("retains unallocated CNDW-shaped expenditures even when a caller knows SO affiliations", () => {
    const e = fixture(),
      p = page(e, 4);
    p.cells = p.cells.filter(
      (c) => !c.text.startsWith("Support of") && !c.text.startsWith("Office -"),
    );
    text(e, 4, "Bryson Gillette, LLC").text = "Shine Creative";
    expect(
      parseDelawareThirdPartyFinancialReport(e).expenditures[0].target,
    ).toBeNull();
  });
  it.each([
    "missing_amount",
    "shift_amount",
    "missing_header",
    "unknown_body",
    "account",
    "period",
    "no_text",
    "missing_schedule",
  ])("rejects incomplete positioned facts %s", (kind) => {
    const e = fixture();
    if (kind === "missing_amount")
      page(e, 4).cells = page(e, 4).cells.filter(
        (c) => !(c.x === 700 && c.y === 324),
      );
    if (kind === "shift_amount")
      page(e, 4).cells.find((c) => c.x === 700 && c.y === 324)!.x = 600;
    if (kind === "missing_header")
      text(e, 4, "Expended").text = "Not an amount header";
    if (kind === "unknown_body")
      (page(e, 4).cells as DelawareThirdPartyPdfCell[]).push(
        cell("UNBOUND ROW", 129, 329),
      );
    if (kind === "account") text(e, 7, "04006716").text = "04000001";
    if (kind === "period") text(e, 7, "08/18/2026").text = "08/19/2026";
    if (kind === "no_text") page(e, 4).cells = [];
    if (kind === "missing_schedule")
      text(e, 9, "SCHEDULE E - INTER COMMITTEE (SHARED) EXPENSES").text =
        "Unsupported sheet";
    expect(() => parseDelawareThirdPartyFinancialReport(e)).toThrow();
  });
  it.each([3, 4])(
    "rejects hidden offsetting monetary cells below the date baseline on schedule page %s",
    (n) => {
      const e = fixture();
      (page(e, n).cells as DelawareThirdPartyPdfCell[]).push(
        cell("$100.00", 700, n === 3 ? 331 : 310),
        cell("-$100.00", 700, n === 3 ? 328 : 307),
      );
      expect(() => parseDelawareThirdPartyFinancialReport(e)).toThrow(
        /additional\/unaligned/,
      );
    },
  );
  it("does not confuse aggregate dollars with amount expended or silently accept changed row dollars", () => {
    const e = fixture();
    page(e, 4).cells.find((c) => c.x === 621 && c.y === 324)!.text =
      "$999,999.00";
    expect(
      parseDelawareThirdPartyFinancialReport(e).expenditures[0].amountCents,
    ).toBe(49901500);
    page(e, 4).cells.find((c) => c.x === 700 && c.y === 324)!.text =
      "$499,016.00";
    expect(() => parseDelawareThirdPartyFinancialReport(e)).toThrow(
      /row\/control/,
    );
  });
  it("leaves multiple captions and unsupported office grammar unallocated", () => {
    const e = fixture();
    (page(e, 4).cells as DelawareThirdPartyPdfCell[]).push(
      cell(
        "Oppose of Other Person - State Office - Attorney General - Republican",
        129,
        284,
      ),
    );
    expect(
      parseDelawareThirdPartyFinancialReport(e).expenditures[0].target,
    ).toBeNull();
    const other = fixture();
    text(other, 4, "Office - Attorney General - Democratic").text =
      "County - Sheriff - Democratic";
    expect(
      parseDelawareThirdPartyFinancialReport(other).expenditures[0].target,
    ).toBeNull();
  });
  it("retains genuine equal occurrences instead of economic dedupe", () => {
    const e = fixture(),
      p = page(e, 4);
    p.cells = p.cells.filter((c) => c.y !== 304 && c.y !== 294);
    const first = p.cells.filter((c) => c.y === 324);
    p.cells.push(...first.map((c) => ({ ...c, y: 304 })));
    p.cells
      .filter((c) => c.text === "$499,015.00" && c.y < 300)
      .forEach((c) => (c.text = "$998,030.00"));
    text(e, 2, "$499,015.00").text = "$998,030.00";
    page(e, 2).cells.find((c) => c.y === 219 && c.x > 600)!.text =
      "$998,030.00";
    page(e, 2).cells.find((c) => c.y === 193 && c.x > 600)!.text =
      "-$473,030.00";
    e.cover.expendituresCents = 99803000;
    e.cover.endingBalanceCents = -47303000;
    const r = parseDelawareThirdPartyFinancialReport(e);
    expect(r.expenditures).toHaveLength(2);
    expect(r.expenditures.map((x) => x.occurrence)).toEqual([0, 1]);
  });
  it("preserves anonymous controls and nonzero supplemental debt as facts, not an inferred allocation", () => {
    const e = fixture();
    text(e, 4, "$0.00").text = "$100.00";
    page(e, 4).cells.find((c) => c.x === 700 && c.y === 243)!.text =
      "$499,115.00";
    text(e, 2, "$499,015.00").text = "$499,115.00";
    page(e, 2).cells.find((c) => c.y === 219 && c.x > 600)!.text =
      "$499,115.00";
    page(e, 2).cells.find((c) => c.y === 193 && c.x > 600)!.text = "$25,885.00";
    e.cover.expendituresCents = 49911500;
    e.cover.endingBalanceCents = 2588500;
    text(e, 7, "$0.00").text = "$1,000.00";
    const r = parseDelawareThirdPartyFinancialReport(e);
    expect(r.controls.expenditures.anonymousCents).toBe(10000);
    expect(r.supplementalTotals.loansReceived).toEqual([100000]);
    expect(r.expenditures[0].amountCents).toBe(49901500);
  });
  it("supports only the observed Schedule F YY start bound to the full cover; other date loss rejects", () => {
    const e = fixture();
    text(e, 10, "08/05/2026").text = "08/05/26";
    text(e, 11, "08/18/2026").y += 2.45;
    expect(parseDelawareThirdPartyFinancialReport(e).periodStart).toBe(
      "2026-08-05",
    );
    text(e, 10, "08/05/26").text = "08/05/25";
    expect(() => parseDelawareThirdPartyFinancialReport(e)).toThrow(/period/);
  });
  it("retains complete supplemental rows even when opposing entries could net a total to zero", () => {
    const e = fixture();
    (page(e, 7).cells as DelawareThirdPartyPdfCell[]).push(
      cell("$100.00", 720, 350),
      cell("-$100.00", 720, 330),
    );
    const r = parseDelawareThirdPartyFinancialReport(e);
    expect(r.supplementalTotals.loansReceived).toEqual([0]);
    expect(
      r.supplementalSourcePages
        .find((p) => p.pageNumber === 7)!
        .cells.filter((c) => c.y > 300 && c.text.includes("100.00")),
    ).toHaveLength(2);
  });
  it("does not trust a supplied cover object inconsistent with its positioned money", () => {
    const e = fixture();
    e.cover.receiptsCents++;
    expect(() => parseDelawareThirdPartyFinancialReport(e)).toThrow(
      /named cover/,
    );
  });
  it("reads a signed parenthesized source credit without promoting it to positive money", () => {
    const e = fixture();
    page(e, 4)
      .cells.filter((c) => c.x >= 600 && c.text === "$499,015.00")
      .forEach((c) => (c.text = "($63.18)"));
    page(e, 2)
      .cells.filter((c) => c.text === "$499,015.00")
      .forEach((c) => (c.text = "($63.18)"));
    page(e, 2).cells.find((c) => c.y === 193 && c.x > 600)!.text =
      "$525,063.18";
    e.cover.expendituresCents = -6318;
    e.cover.endingBalanceCents = 52506318;
    expect(
      parseDelawareThirdPartyFinancialReport(e).expenditures[0].amountCents,
    ).toBe(-6318);
  });
  it("returned facts retain the input generation when a caller later mutates positioned cells", () => {
    const e = fixture(),
      r = parseDelawareThirdPartyFinancialReport(e);
    page(e, 4).cells.find((c) => c.x === 700 && c.y === 324)!.text = "$1.00";
    expect(
      r.expenditures[0].rawCells.some((c) => c.text === "$499,015.00"),
    ).toBe(true);
    expect(r.expenditures[0].amountCents).toBe(49901500);
  });
  it("rejects scans or non-PDF bytes before positioned extraction", async () => {
    await expect(
      extractDelawareThirdPartyFinancialPdf(Buffer.from("HTML response")),
    ).rejects.toThrow(/invalid PDF/);
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 792 612] /Resources << >> /Contents 4 0 R >>",
      "<< /Length 0 >>\nstream\n\nendstream",
    ];
    let body = "%PDF-1.4\n";
    const offsets = [0];
    objects.forEach((o, i) => {
      offsets.push(Buffer.byteLength(body));
      body += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    const start = Buffer.byteLength(body);
    body +=
      "xref\n0 5\n0000000000 65535 f \n" +
      offsets
        .slice(1)
        .map((o) => String(o).padStart(10, "0") + " 00000 n \n")
        .join("") +
      `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
    const bytes = Buffer.from(body);
    const extraction = extractDelawareThirdPartyFinancialPdf(bytes);
    bytes.fill(0);
    await expect(extraction).rejects.toThrow(/image-only\/empty/);
  });
});
