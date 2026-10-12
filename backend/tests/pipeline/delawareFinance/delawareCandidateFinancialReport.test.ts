import { describe, expect, it } from "vitest";
import { parseDelawareCandidateFinancialReport } from "../../../src/pipeline/delawareFinance/delawareCandidateFinancialReport.js";
import type {
  DelawareThirdPartyPdfCell as Cell,
  DelawareThirdPartyPdfExtraction as Extraction,
} from "../../../src/pipeline/delawareFinance/delawareThirdPartyFinancialReport.js";

const cell = (text: string, x: number, y: number): Cell => ({
  text,
  x,
  y,
  width: 20,
  height: 9,
});
const header = (parts: readonly (readonly [string, number])[], y = 355) =>
  parts.map(([text, x]) => cell(text, x, y));
const amount = (value: string, y: number, x = 710) => cell(value, x, y);
function fixture(): Extraction {
  const pages = Array.from({ length: 11 }, (_, index) => ({
    pageNumber: index + 1,
    width: 792,
    height: 612,
    cells: [] as Cell[],
  }));
  pages[0]!.cells = [
    cell("FULL ORGANIZATION NAME:", 38, 428),
    cell("Friends of Example Candidate", 426, 428),
    cell("ACCOUNT NUMBER :", 38, 408),
    cell("01000001", 264, 408),
    cell("DATE OF THIS REPORT :", 438, 408),
    cell("10/05/2026", 616, 408),
    cell("REPORTING PERIOD START :", 38, 388),
    cell("01/01/2026", 262, 388),
    cell("REPORTING PERIOD END :", 438, 388),
    cell("10/04/2026", 616, 388),
  ];
  for (const page of pages.slice(1))
    page.cells.push(
      cell("ACCOUNT NUMBER :", 38, 440),
      cell("01000001", 264, 440),
      cell("REPORTING PERIOD :", 330, 440),
      cell("01/01/2026", 485, 440),
      cell("10/04/2026", 659, 440),
    );
  const coverLabels = [
    ["1. BEGINNING BALANCE", "$0.00", 424],
    ["A. SCHEDULE A - TOTAL RECEIPTS", "$1,840.00", 390],
    ["B. SCHEDULE C-1 - TOTAL IN-KIND RECEIPTS", "$0.00", 372],
    ["C. SCHEDULE D-1 - TOTAL LOANS RECEIVED AND DEBTS INCURRED", "$0.00", 355],
    ["D. SCHEDULE E - TOTAL EXPENSE REIMBURSEMENTS RECEIVED", "$0.00", 337],
    ["E. SUBTOTAL (Total of A,B,C,D)", "$1,840.00", 320],
    ["F. SCHEDULE B - TOTAL EXPENDITURES", "$1,200.00", 287],
    ["G. SCHEDULE C-2 - TOTAL IN-KIND EXPENDITURES", "$0.00", 270],
    ["H. SCHEDULE D-2 - LOAN AND DEBT PAYMENTS", "$0.00", 253],
    ["I. SCHEDULE E - INTER COMMITTEE (SHARED) EXPENSES", "$0.00", 236],
    ["J. SUBTOTAL (Total of F,G,H,I)", "$1,200.00", 219],
    ["4. ENDING BALANCE", "$640.00", 193],
    ["5. VALUE OF NON-CASH ASSETS (From Schedule F)", "$0.00", 176],
    ["6. VALUE OF DISPOSED/TRANSFERRED ASSETS (From Schedule G)", "$0.00", 158],
    [
      "7. VALUE OF LOANS AT END OF PERIOD (Loan Balance From Schedule D-2)",
      "$34,000.00",
      140,
    ],
  ] as const;
  pages[1]!.cells.push(
    cell("STATEMENT OF ACCOUNT BALANCE", 275, 500),
    ...coverLabels.flatMap(([text, value, y]) => [
      cell(text, 55, y),
      amount(value, y, 650),
    ]),
  );
  const titles = [
    "SCHEDULE A - TOTAL RECEIPTS",
    "SCHEDULE B - TOTAL EXPENDITURES",
    "SCHEDULE C-1 - TOTAL IN-KIND RECEIPTS",
    "SCHEDULE C-2 - TOTAL IN-KIND EXPENDITURES",
    "SCHEDULE D-1 - TOTAL LOANS RECEIVED AND DEBTS INCURRED",
    "SCHEDULE D-2 - TOTAL LOANS AND DEBTS OUTSTANDING",
    "SCHEDULE E - INTER COMMITTEE (SHARED) EXPENSES",
    "SCHEDULE F - NON-CASH ASSETS",
    "SCHEDULE G - ELIMINATION OF ASSETS",
  ];
  titles.forEach((title, index) =>
    pages[index + 2]!.cells.push(cell(title, 250, 490)),
  );
  pages[2]!.cells.push(
    ...header([
      ["Date Received", 60],
      ["Contributor Name", 204],
      ["Contributor Mailing Address", 382],
      ["Aggregate Amount", 555],
      ["Amount Received", 660],
    ]),
    cell("09/15/2026", 70, 338),
    cell("Reported Committee", 145, 338),
    cell("SANITIZED ADDRESS", 340, 338),
    amount("$600.00", 338, 610),
    amount("$600.00", 338),
    cell("TOTAL ITEMIZED RECEIPTS", 39, 313),
    amount("$600.00", 313),
    cell("TOTAL OF CONTRIBUTIONS NOT EXCEEDING $100", 39, 295),
    amount("$1,240.00", 295),
    cell("GRAND TOTAL RECEIPTS", 39, 277),
    amount("$1,840.00", 277),
  );
  pages[3]!.cells.push(
    ...header(
      [
        ["Date Expended", 49],
        ["Payee Name", 175],
        ["Payee Mailing Address", 304],
        ["Vendor", 492],
      ],
      344,
    ),
    cell("Aggregate", 604, 349),
    cell("Amount", 604, 338),
    cell("Amount", 689, 349),
    cell("Expended", 689, 338),
    cell("09/20/2026", 61, 324),
    cell("Individual Return", 129, 324),
    cell("SANITIZED ADDRESS", 300, 324),
    amount("$1,200.00", 324, 620),
    amount("$1,200.00", 324),
    cell("TOTAL ITEMIZED EXPENDITURES", 38, 279),
    amount("$1,200.00", 279),
    cell("TOTAL OF EXPENDITURES NOT EXCEEDING $100", 38, 261),
    amount("$0.00", 261),
    cell("GRAND TOTAL EXPENDITURES", 38, 243),
    amount("$1,200.00", 243),
  );
  pages[4]!.cells.push(
    ...header(
      [
        ["Date Received", 59],
        ["Contributor Name", 202],
        ["Contributor Mailing Address", 380],
        ["Description of", 563],
        ["Est. Amount Received", 649],
      ],
      311,
    ),
    cell("Contribution", 566, 300),
    cell("TOTAL ITEMIZED IN-KIND CONTRIBUTIONS", 38, 285),
    amount("$0.00", 285),
    cell("TOTAL OF IN-KIND CONTRIBUTIONS NOT EXCEEDING $100", 38, 267),
    amount("$0.00", 267),
    cell("GRAND TOTAL RECEIPTS", 38, 249),
    amount("$0.00", 249),
  );
  pages[5]!.cells.push(
    ...header(
      [
        ["Date Expended", 50],
        ["Person or Activity Name", 150],
        ["Person or Activity", 310],
        ["Vendor", 480],
        ["Description of", 585],
        ["Est. Amount", 679],
      ],
      312,
    ),
    cell("Location or Mailing Address", 289, 301),
    cell("Expenditure", 590, 301),
    cell("Expended", 686, 301),
    cell("TOTAL ITEMIZED IN-KIND", 38, 286),
    cell("EXPENDITURES", 172, 286),
    amount("$0.00", 286),
    cell("TOTAL OF IN-KIND", 38, 268),
    cell("EXPENDITURES NOT EXCEEDING $100", 135, 268),
    amount("$0.00", 268),
    cell("GRAND TOTAL EXPENDITURES", 38, 250),
    amount("$0.00", 250),
  );
  pages[6]!.cells.push(
    ...header(
      [
        ["Transaction Id", 40],
        ["Date Received", 120],
        ["Lender", 248],
        ["Endorser", 384],
        ["Description of Security", 502],
        ["Int. Rate", 630],
        ["Amount", 688],
      ],
      348,
    ),
    cell("Received", 688, 337),
    cell("TOTAL LOANS RECEIVED", 38, 322),
    amount("$0.00", 322),
  );
  pages[7]!.cells.push(
    ...header(
      [
        ["Transaction Id", 40],
        ["Date Received", 110],
        ["Lender", 214],
        ["Endorser", 322],
        ["Description", 443],
        ["Int", 549],
        ["Previous", 583],
        ["Payments", 642],
        ["Balance", 705],
      ],
      362,
    ),
    cell("Rate", 546, 351),
    cell("Loan", 590, 351),
    cell("Balance", 586, 340),
    cell("Made", 652, 351),
    cell("123456", 58, 326),
    cell("01/10/2018", 120, 326),
    cell("Example Candidate", 176, 326),
    cell("SANITIZED ADDRESS", 176, 316),
    amount("$34,000.00", 326, 590),
    amount("$0.00", 326, 674),
    amount("$34,000.00", 326, 705),
    cell("TOTAL LOANS", 39, 294),
    amount("$34,000.00", 294, 590),
    amount("$0.00", 294, 674),
    amount("$34,000.00", 294, 705),
  );
  pages[8]!.cells.push(
    ...header(
      [
        ["Date Received", 51],
        ["Reimburser", 187],
        ["Description of Activity", 341],
        ["Activity Date", 502],
        ["Total Expense", 595],
        ["Reimbursement", 672],
      ],
      329,
    ),
    cell("TOTAL REIMBURSEMENTS RECEIVED", 38, 312),
    amount("$0.00", 312, 644),
    amount("$0.00", 312),
    ...header(
      [
        ["Date Paid", 61],
        ["Payee", 201],
        ["Description of Activity", 342],
        ["Activity Date", 502],
        ["Total Expense", 595],
        ["Reimbursement", 673],
      ],
      224,
    ),
    cell("TOTAL REIMBURSEMENTS PAID", 38, 207),
    amount("$0.00", 207, 644),
    amount("$0.00", 207),
  );
  pages[9]!.cells.push(
    ...header(
      [
        ["Date Received", 52],
        ["Description of Asset", 221],
        ["Location of Asset (Physical Address)", 449],
        ["Value of Asset", 671],
      ],
      351,
    ),
    cell("TOTAL ASSET VALUE", 38, 333),
    amount("$0.00", 333),
  );
  pages[10]!.cells.push(
    ...header(
      [
        ["Date Eliminated", 48],
        ["Description of Asset", 221],
        ["Disposition of Asset", 485],
        ["Value of Asset", 671],
      ],
      376,
    ),
    cell("TOTAL ASSETS ELIMINATED", 38, 358),
    amount("$0.00", 358),
  );
  paginate(pages);
  return {
    sha256: "a".repeat(64),
    byteCount: 120000,
    pages,
    cover: {
      pageNumber: 2,
      beginningBalanceCents: 0,
      receiptsCents: 184000,
      expendituresCents: 120000,
      endingBalanceCents: 64000,
      reportingPeriodFrom: "01/01/2026",
      reportingPeriodTo: "10/04/2026",
      documentVersion: 1,
      method: "rows",
    },
  };
}
function paginate(pages: Extraction["pages"]): void {
  pages.forEach((page, index) => {
    page.pageNumber = index + 1;
    const cells = page.cells as Cell[];
    for (let i = cells.length - 1; i >= 0; i--)
      if (/^Page \d+ of \d+$/.test(cells[i]!.text)) cells.splice(i, 1);
    cells.push(cell(`Page ${index + 1} of ${pages.length}`, 353, 59));
  });
}
const find = (x: Extraction, n: number, text: string) =>
  x.pages[n - 1]!.cells.find((c) => c.text === text)!;
const read = (x: Extraction) => parseDelawareCandidateFinancialReport(x);

describe("Delaware candidate positioned source facts", () => {
  it("retains separately published anonymous aggregate and outstanding debt with zero current loans/payments", () => {
    const result = read(fixture());
    expect(result.schedules.receipts.rows).toHaveLength(1);
    expect(result.schedules.receipts.controls).toEqual({
      itemizedCents: 60000,
      anonymousCents: 124000,
      grandCents: 184000,
    });
    expect(result.schedules.loansOutstanding.rows[0]!.date).toBe("2018-01-10");
    expect(result.schedules.loansOutstanding.controls).toEqual({
      previousCents: 3400000,
      paymentsCents: 0,
      balanceCents: 3400000,
    });
    expect(result.schedules.loansReceived.rows).toEqual([]);
    expect(result.schedules.reimbursementsReceived.controls.totalCents).toBe(0);
  });
  it("retains source receipt/return text without interpreting economic classes", () => {
    const source = fixture();
    find(source, 3, "Reported Committee").text = "GMMB Inc. Refund/Rebate";
    const result = read(source);
    expect(result.schedules.receipts.rows[0]!.columns.name).toBe(
      "GMMB Inc. Refund/Rebate",
    );
    expect(result.schedules.expenditures.rows[0]!.columns.name).toBe(
      "Individual Return",
    );
    expect(result.schedules.reimbursementsReceived.rows).toEqual([]);
  });
  it("does not confer currentness from a footer version or report label", () => {
    const source = fixture();
    source.cover.documentVersion = 99;
    (source.pages[0]!.cells as Cell[]).push(
      cell("Amended", 100, 75),
      cell("Document: 14904 Version: 2", 642, 41),
    );
    expect(read(source).cover.documentVersion).toBe(99);
  });
  it("copies all positioned source facts before returning", () => {
    const source = fixture();
    const result = read(source);
    find(source, 3, "Reported Committee").text = "Changed";
    expect(result.schedules.receipts.rows[0]!.columns.name).toBe(
      "Reported Committee",
    );
    expect(result.sourcePages[2]!.cells.some((c) => c.text === "Changed")).toBe(
      false,
    );
  });
  it("keeps explicit blank source addresses rather than inventing them", () => {
    const source = fixture();
    (source.pages[2]!.cells as Cell[]).splice(
      source.pages[2]!.cells.findIndex((c) => c.text === "SANITIZED ADDRESS"),
      1,
    );
    expect(read(source).schedules.receipts.rows[0]!.columns.address).toBe("");
  });
  it("keeps equal occurrences with different published positions", () => {
    const source = fixture();
    const p = source.pages[2]!;
    const rows = p.cells.filter((c) => c.y === 338);
    (p.cells as Cell[]).push(...rows.map((c) => ({ ...c, y: 320 })));
    for (const c of p.cells.filter((c) => c.y <= 313 && c.y > 90)) c.y -= 25;
    find(source, 3, "$600.00").text = "$600.00";
    p.cells.find((c) => c.y === 288 && c.x === 710)!.text = "$1,200.00";
    p.cells.find((c) => c.y === 252 && c.x === 710)!.text = "$2,440.00";
    find(source, 2, "$1,840.00").text = "$2,440.00";
    source.pages[1]!.cells.filter((c) => c.text === "$1,840.00").forEach(
      (c) => (c.text = "$2,440.00"),
    );
    find(source, 2, "$640.00").text = "$1,240.00";
    source.cover.receiptsCents = 244000;
    source.cover.endingBalanceCents = 124000;
    expect(read(source).schedules.receipts.rows).toHaveLength(2);
  });
  it("joins exact contiguous page continuation cells to their preceding occurrence", () => {
    const source = fixture();
    const a = source.pages[2]!;
    const moved = a.cells.filter((c) => c.y <= 313 && c.y > 90);
    (a.cells as Cell[]).splice(
      0,
      a.cells.length,
      ...a.cells.filter((c) => !moved.includes(c)),
    );
    const continuation = {
      pageNumber: 4,
      width: 792,
      height: 612,
      cells: [
        cell("CONTINUED NAME", 145, 503),
        ...moved.map((c) => ({ ...c, y: c.y + 120 })),
      ],
    };
    (source.pages as (typeof continuation)[]).splice(3, 0, continuation);
    paginate(source.pages);
    const result = read(source);
    expect(result.schedules.receipts.rows[0]!.columns.name).toBe(
      "Reported Committee CONTINUED NAME",
    );
    expect(result.schedules.receipts.rows[0]!.pageNumbers).toEqual([3, 4]);
  });
  it("accepts published grand-control spill onto a following page", () => {
    const source = fixture();
    const a = source.pages[2]!;
    const moved = a.cells.filter((c) => c.y === 277);
    (a.cells as Cell[]).splice(
      0,
      a.cells.length,
      ...a.cells.filter((c) => !moved.includes(c)),
    );
    (
      source.pages as {
        pageNumber: number;
        width: number;
        height: number;
        cells: Cell[];
      }[]
    ).splice(3, 0, {
      pageNumber: 4,
      width: 792,
      height: 612,
      cells: moved.map((c) => ({ ...c, y: 502 })),
    });
    paginate(source.pages);
    expect(read(source).schedules.receipts.controls.grandCents).toBe(184000);
  });
  it.each([
    [
      "wrong account",
      (x: Extraction) => {
        find(x, 3, "01000001").text = "01000002";
      },
    ],
    [
      "wrong period",
      (x: Extraction) => {
        find(x, 3, "10/04/2026").text = "10/03/2026";
      },
    ],
    [
      "bad printed page",
      (x: Extraction) => {
        find(x, 4, "Page 4 of 11").text = "Page 4 of 12";
      },
    ],
    [
      "wrong class",
      (x: Extraction) => {
        find(x, 1, "01000001").text = "04000001";
      },
    ],
    [
      "shifted header",
      (x: Extraction) => {
        find(x, 3, "Contributor Name").x = 330;
      },
    ],
    [
      "malformed date",
      (x: Extraction) => {
        find(x, 3, "09/15/2026").text = "02/30/2026";
      },
    ],
    [
      "unbound column",
      (x: Extraction) => {
        (x.pages[2]!.cells as Cell[]).push(cell("unbound", 770, 330));
      },
    ],
    [
      "stray tail amount",
      (x: Extraction) => {
        (x.pages[2]!.cells as Cell[]).push(amount("$600.00", 255));
      },
    ],
    [
      "missing control",
      (x: Extraction) => {
        find(x, 3, "TOTAL ITEMIZED RECEIPTS").text = "MISSING";
      },
    ],
    [
      "conflicting monetary row",
      (x: Extraction) => {
        find(x, 3, "$600.00").text = "$700.00";
        x.pages[2]!.cells.find((c) => c.x === 710 && c.y === 338)!.text =
          "$700.00";
      },
    ],
    [
      "fractional cents",
      (x: Extraction) => {
        x.pages[2]!.cells.find((c) => c.x === 710 && c.y === 338)!.text =
          "$600.001";
      },
    ],
    [
      "shifted debt total",
      (x: Extraction) => {
        x.pages[7]!.cells.find((c) => c.x === 674 && c.y === 294)!.x = 620;
      },
    ],
    [
      "wrong balance account",
      (x: Extraction) => {
        find(x, 2, "01000001").text = "01000002";
      },
    ],
    [
      "wrong outstanding cover",
      (x: Extraction) => {
        find(x, 2, "$34,000.00").text = "$0.00";
      },
    ],
    [
      "wrong debt control",
      (x: Extraction) => {
        x.pages[7]!.cells.find((c) => c.x === 705 && c.y === 294)!.text =
          "$33,000.00";
      },
    ],
    [
      "ambiguous control",
      (x: Extraction) => {
        (x.pages[2]!.cells as Cell[]).push(
          cell("TOTAL ITEMIZED RECEIPTS", 39, 230),
          amount("$600.00", 230),
        );
      },
    ],
  ] as const)(
    "rejects %s rather than returning partial financial facts",
    (_label, mutate) => {
      const source = fixture();
      mutate(source);
      expect(() => read(source)).toThrow();
    },
  );
});
