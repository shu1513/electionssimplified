import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  parseVermontReportControlPages,
  readVermontReportControlPdf,
  type VermontControlPdfCell,
  type VermontControlPdfPage,
} from "../../../src/pipeline/vermontFinance/vermontReportControlPdfParser.js";

const pdfMock = vi.hoisted(() => ({ getDocument: vi.fn() }));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: pdfMock.getDocument,
}));

const cell = (
  text: string,
  x: number,
  y: number,
  width = 90,
): VermontControlPdfCell => ({ text, x, y, width, height: 9 });
const dollar = (cents: number) =>
  `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;
const captions = [
  "Monetary Contributions over $100",
  "Monetary Contributions $100 or less",
  "Loans Received During this Reporting Period",
  "Refunded Contributions",
  "Total Monetary Contributions",
  "Monetary Expenditures",
  "Loan Payments",
  "Refunded Expenditures",
  "Total Monetary Expenditures",
  "Expenditures used in a Mass Media Activity",
  "Refunded Expenditures used in a Mass Media Activity",
  "Total Mass Media Expenditures",
  "Outstanding Balance from Previous Reporting Period",
  "Loans Received During this Reporting Period",
  "Subtotal",
  "Loan Payments Made During this Reporting Period",
  "Loan Amount Forgiven During this Reporting Period",
  "Loan Amount Due at the End of This Reporting Period",
  "In-Kind (Non-Money) Contributions",
  "Refunded In-Kind (Non-Money) Contributions",
  "Total In-Kind (Non-Money) Contributions",
  "In-Kind (Non-Money) Expenditures",
  "Refunded In-Kind (Non-Money) Expenditures",
  "Total In-Kind (Non-Money) Expenditures",
  "Total In-Kind (Non-Money) Transaction Balance",
];
// Derived physical control columns; fictional identity, no source contacts or report bytes.
function fixture(): VermontControlPdfPage[] {
  const pages = [1, 2, 3].map((pageNumber) => ({
    pageNumber,
    width: 595,
    height: 842,
    cells: [] as VermontControlPdfCell[],
  }));
  const report = "2026 Oct 1 - Disclosures";
  for (const p of pages) {
    const y = p.pageNumber === 1 ? 793.4 : 798.4;
    p.cells.push(
      cell("Source system title", 461, y + 21, 90),
      cell("EXAMPLE, ALEX", 461, y + 10.5, 80),
      cell(report, 461, y, 99),
    );
  }
  pages[0]!.cells.push(
    cell("Candidate Name", 28, 715.9),
    cell("ALEX EXAMPLE", 148, 715.9),
    cell("Office Sought", 28, 695.9),
    cell("Governor", 148, 695.9),
    cell("Election Cycle:", 28, 383.9),
    cell("2026 GENERAL ELECTION", 196, 383.9, 125),
    cell("Report Name:", 28, 363.9),
    cell(report, 196, 363.9, 100),
    cell("Reporting Period:", 28, 333.9),
    cell("Start Date:", 196, 343.9, 55),
    cell("08/30/2026", 276, 343.9, 45),
    cell("End Date:", 380, 343.9, 55),
    cell("09/28/2026", 485, 343.9, 45),
    cell("Due Date:", 196, 323.9, 55),
    cell("10/01/2026", 276, 323.9, 45),
    cell("Original Filed Date:", 380, 323.9, 90),
    cell("10/01/2026", 485, 323.9, 45),
    cell("PRIVATE CONTACT MUST NOT LEAVE FACTS", 30, 500, 300),
  );
  const s = pages[1]!.cells;
  s.push(
    cell("SECTION 5: SUMMARY PAGE", 27, 750, 180),
    cell("THIS PERIOD", 340, 750, 75),
    cell("CAMPAIGN TO DATE", 470, 750, 95),
    cell("Monetary Transactions", 27, 718.9, 150),
  );
  for (const [label, y, period, cycle] of [
    [
      "A. Beginning Balance at the Start of the Reporting Period",
      699.1,
      10000,
      null,
    ],
    ["A1. Surplus Amount from Previous Campaign", 669.1, null, 5000],
    ["B. Total Monetary Contributions", 638, 11800, 31800],
    ["C. Total Monetary Expenditures", 608, 3900, 18900],
    [
      "D. Ending Balance at the End of the Reporting Period",
      579.1,
      17900,
      null,
    ],
  ] as const) {
    s.push(cell(label, 27, y, 270));
    if (period !== null) s.push(cell(dollar(period), 376, y - 5, 50));
    if (cycle !== null) s.push(cell(dollar(cycle), 520, y - 5, 50));
  }
  const ys = [
    728.9, 708.9, 688.9, 668.9, 648.9, 598.9, 578.9, 558.9, 538.9, 486.9, 466.9,
    446.9, 393.9, 373.9, 353.9, 333.9, 313.9, 293.9, 241.9, 221.9, 201.9, 181.9,
    161.9, 141.9, 121.9,
  ];
  const values = [
    10000,
    2000,
    1000,
    1200,
    11800,
    4000,
    200,
    300,
    3900,
    1000,
    0,
    null,
    2000,
    1000,
    3000,
    200,
    100,
    2700,
    1000,
    200,
    800,
    1500,
    100,
    1400,
    -600,
  ];
  ys.forEach((y, i) => {
    pages[2]!.cells.push(
      cell(`${i + 1}.`, 23, y, 15),
      cell(captions[i]!, 43, y, 255),
    );
    if (values[i] !== null)
      pages[2]!.cells.push(cell(dollar(values[i]!), 519, y, 50));
  });
  for (const [n, label] of [
    [1, "Number of Transactions:"],
    [2, "Number of Contributors:"],
    [3, "Number of Transactions:1"],
    [6, "Number of Transactions:43"],
    [10, "Number of Transactions:5"],
  ] as const)
    pages[2]!.cells.push(cell(label, 302, ys[n - 1]!, 115));
  return pages;
}
function control(pages: VermontControlPdfPage[], row: number) {
  const anchor = pages[2]!.cells.find((c) => c.text === `${row}.`)!;
  return pages[2]!.cells.find(
    (c) => c.text.includes("$") && c.x >= 450 && c.y === anchor.y,
  )!;
}
function change(pages: VermontControlPdfPage[], text: string, value: string) {
  const found = pages.flatMap((p) => p.cells).find((c) => c.text === text)!;
  found.text = value;
}

describe("Vermont regular report control PDF facts", () => {
  it("retains source-shaped signed controls, unknown counts and blank MM total", () => {
    const result = parseVermontReportControlPages(fixture());
    expect(result).toMatchObject({
      receivingFilerName: "EXAMPLE, ALEX",
      candidateFullName: "ALEX EXAMPLE",
      periodStart: "2026-08-30",
      periodEnd: "2026-09-28",
      originalFiledDate: "2026-10-01",
      summary: {
        monetaryContributionsPeriodCents: 11800,
        monetaryContributionsCycleCents: 31800,
      },
      controls: {
        cashOver100Cents: 10000,
        loansReceivedCents: 1000,
        refundedContributionsCents: 1200,
        totalMonetaryContributionsCents: 11800,
        inKindTransactionBalanceCents: -600,
        totalMassMediaExpendituresCents: null,
      },
      counts: {
        cashOver100: null,
        cash100OrLess: null,
        loansReceived: 1,
        monetaryExpenditures: 43,
        massMediaExpenditures: 5,
      },
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE CONTACT");
    expect(result).not.toHaveProperty("current");
    expect(result).not.toHaveProperty("amendment");
  });
  it("preserves a genuinely blank filed date without inferring Original", () => {
    const p = fixture();
    p[0]!.cells = p[0]!.cells.filter((c) => !(c.x === 485 && c.y === 323.9));
    expect(parseVermontReportControlPages(p).originalFiledDate).toBeNull();
  });
  it("accepts a published MM total only when its separate controls agree", () => {
    const p = fixture();
    p[2]!.cells.push(cell("$10.00", 519, 446.9, 50));
    expect(
      parseVermontReportControlPages(p).controls
        .totalMassMediaExpendituresCents,
    ).toBe(1000);
    p[2]!.cells.at(-1)!.text = "$11.00";
    expect(() => parseVermontReportControlPages(p)).toThrow(
      "mass-media controls",
    );
  });
  it.each([1, 4, 5, 7, 15, 18, 21, 24, 25])(
    "rejects a changed control %i despite valid printed cents",
    (n) => {
      const p = fixture();
      const c = control(p, n);
      c.text = dollar(Number(c.text.replace(/[$]/g, "")) * 100 + 1);
      expect(() => parseVermontReportControlPages(p)).toThrow("inconsistent");
    },
  );
  it("rejects swapped period/campaign financial columns", () => {
    const p = fixture();
    const y = 633;
    const cells = p[1]!.cells.filter(
      (c) => c.y === y && c.text.startsWith("$"),
    );
    [cells[0]!.text, cells[1]!.text] = [cells[1]!.text, cells[0]!.text];
    expect(() => parseVermontReportControlPages(p)).toThrow(
      "receipt summary agreement",
    );
  });
  it.each(["x", "y", "width"] as const)(
    "rejects shifted detailed financial %s",
    (key) => {
      const p = fixture();
      control(p, 1)[key] += key === "y" ? 8 : 20;
      expect(() => parseVermontReportControlPages(p)).toThrow();
    },
  );
  it("rejects an extra offsetting amount rather than summing hidden cells", () => {
    const p = fixture();
    p[2]!.cells.push(cell("$1.00", 519, 640, 50), cell("-$1.00", 519, 630, 50));
    expect(() => parseVermontReportControlPages(p)).toThrow(
      "unbound detailed money",
    );
  });
  it("rejects duplicate numbered controls and missing captions", () => {
    const p = fixture();
    p[2]!.cells.push({ ...p[2]!.cells.find((c) => c.text === "1.")! });
    expect(() => parseVermontReportControlPages(p)).toThrow(
      "numbered financial control",
    );
    const q = fixture();
    change(q, captions[0]!, "Other unidentified contributions");
    expect(() => parseVermontReportControlPages(q)).toThrow(
      "unsupported numbered control caption",
    );
  });
  it.each(["$1.001", "$90071992547409.92", "($100.00)"])(
    "rejects unsupported or unsafe currency %s",
    (value) => {
      const p = fixture();
      control(p, 1).text = value;
      expect(() => parseVermontReportControlPages(p)).toThrow();
    },
  );
  it.each([
    "Number of Transactions:1x",
    "Number of Transactions:-1",
    "Number of Transactions:9007199254740992",
  ])("rejects invalid count %s", (value) => {
    const p = fixture();
    change(p, "Number of Transactions:1", value);
    expect(() => parseVermontReportControlPages(p)).toThrow("count control");
  });
  it("rejects invalid civil dates and reversed periods", () => {
    const p = fixture();
    change(p, "08/30/2026", "02/30/2026");
    expect(() => parseVermontReportControlPages(p)).toThrow("civil date");
    const q = fixture();
    change(q, "08/30/2026", "09/30/2026");
    expect(() => parseVermontReportControlPages(q)).toThrow("reversed");
  });
  it("binds every control page to the same full owner and report heading", () => {
    const p = fixture();
    p[1]!.cells.find((c) => c.text === "EXAMPLE, ALEX")!.text = "OTHER, ALEX";
    expect(() => parseVermontReportControlPages(p)).toThrow(
      "conflicting control-page identity",
    );
    const q = fixture();
    q[2]!.cells.find((c) => c.text === "2026 Oct 1 - Disclosures")!.text =
      "2026 Sep 1 - Disclosures";
    expect(() => parseVermontReportControlPages(q)).toThrow(
      "running report heading",
    );
  });
  it("rejects absent, reordered and resized control pages", () => {
    expect(() => parseVermontReportControlPages(fixture().slice(0, 2))).toThrow(
      "geometry",
    );
    const p = fixture();
    p.reverse();
    expect(() => parseVermontReportControlPages(p)).toThrow("geometry");
    const q = fixture();
    q[2]!.width = 596;
    expect(() => parseVermontReportControlPages(q)).toThrow("geometry");
  });
  it("rejects non-PDF bytes before loading or exposing their body", async () => {
    await expect(
      readVermontReportControlPdf(new TextEncoder().encode("private body")),
    ).rejects.toThrow("invalid PDF bytes or size");
  });
  it("snapshots original PDF bytes before awaiting and returns contact-free facts", async () => {
    const pages = fixture();
    const destroy = vi.fn(async () => {});
    pdfMock.getDocument.mockImplementation(() => ({
      promise: Promise.resolve({
        numPages: 6,
        getPage: async (n: number) => ({
          rotate: 0,
          view: [0, 0, 595, 842],
          getTextContent: async () => ({
            items: pages[n - 1]!.cells.map((c) => ({
              str: c.text,
              transform: [9, 0, 0, 9, c.x, c.y],
              width: c.width,
              height: c.height,
            })),
          }),
        }),
      }),
      destroy,
    }));
    const bytes = new TextEncoder().encode("%PDF-original fixture");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const length = bytes.length;
    const resultPromise = readVermontReportControlPdf(bytes);
    bytes.fill(0);
    const result = await resultPromise;
    expect(result).toMatchObject({
      pdfSha256: digest,
      byteCount: length,
      pageCount: 6,
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE CONTACT");
    expect(
      Buffer.from(pdfMock.getDocument.mock.calls.at(-1)![0].data).toString(),
    ).toBe("%PDF-original fixture");
    expect(destroy).toHaveBeenCalledOnce();
  });
  it("rejects extraction failures with static diagnostics and destroys the document", async () => {
    const destroy = vi.fn(async () => {});
    pdfMock.getDocument.mockImplementation(() => ({
      promise: Promise.reject(new Error("PRIVATE CONTACT FAILURE")),
      destroy,
    }));
    await expect(
      readVermontReportControlPdf(new TextEncoder().encode("%PDF-bad")),
    ).rejects.toThrow(
      "Vermont report control PDF: could not extract source PDF",
    );
    expect(destroy).toHaveBeenCalledOnce();
  });
});
