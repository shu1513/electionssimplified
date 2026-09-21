import { describe, expect, it } from "vitest";

import {
  housePtrPdfUrl,
  parseAmountRange,
  parseHouseFdIndex,
  parseHousePtrItems,
  planAmendmentSupersedes,
  planStockTradeFiling,
  selectHousePtrFilings,
  type AmendableTrade,
  type PtrTextItem,
} from "../../../src/pipeline/stockTrades/housePtr.js";

const INDEX_XML = `<?xml version="1.0" encoding="utf-8"?>
<FinancialDisclosure>
  <Member>
    <Prefix>Hon.</Prefix><Last>Allen</Last><First>Richard W.</First><Suffix />
    <FilingType>P</FilingType><StateDst>GA12</StateDst><Year>2025</Year>
    <FilingDate>1/16/2025</FilingDate><DocID>20026537</DocID>
  </Member>
  <Member>
    <Prefix /><Last>Smith &amp; Jones</Last><First>Pat</First><Suffix />
    <FilingType>C</FilingType><StateDst>TX31</StateDst><Year>2025</Year>
    <FilingDate>10/12/2025</FilingDate><DocID>10072640</DocID>
  </Member>
  <Member>
    <Prefix>Hon.</Prefix><Last>Allen</Last><First>Richard W.</First><Suffix />
    <FilingType>P</FilingType><StateDst>GA12</StateDst><Year>2025</Year>
    <FilingDate>1/16/2025</FilingDate><DocID>20026537</DocID>
  </Member>
  <Member>
    <Prefix /><Last>Doe</Last><First>Alex</First><Suffix />
    <FilingType>P</FilingType><StateDst>AK00</StateDst><Year>2025</Year>
    <FilingDate>2/31/2025</FilingDate><DocID>8220001</DocID>
  </Member>
</FinancialDisclosure>`;

describe("parseHouseFdIndex", () => {
  it("reads every filing with state and district split", () => {
    const rows = parseHouseFdIndex(INDEX_XML);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual({
      prefix: "Hon.",
      last: "Allen",
      first: "Richard W.",
      suffix: "",
      filingType: "P",
      state: "GA",
      district: "12",
      year: "2025",
      filingDate: "2025-01-16",
      docId: "20026537",
    });
    expect(rows[1]!.last).toBe("Smith & Jones");
  });

  it("rejects an impossible calendar date instead of passing it on", () => {
    expect(parseHouseFdIndex(INDEX_XML)[3]!.filingDate).toBeNull();
  });

  it("selects PTR filings once per DocID", () => {
    const filings = selectHousePtrFilings(parseHouseFdIndex(INDEX_XML));
    expect(filings.map((row) => row.docId)).toEqual(["20026537", "8220001"]);
  });

  it("builds the filing URL from the filing year and DocID", () => {
    expect(housePtrPdfUrl("2025", "20026537")).toBe(
      "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20026537.pdf"
    );
  });
});

describe("parseAmountRange", () => {
  it("reads a printed range", () => {
    expect(parseAmountRange("$1,001 - $15,000")).toEqual({ low: 1001, high: 15000 });
    expect(parseAmountRange("$1,000,001 -  $5,000,000")).toEqual({ low: 1000001, high: 5000000 });
  });

  it("reads an open-ended top range with no high end", () => {
    expect(parseAmountRange("Over $50,000,000")).toEqual({ low: 50000000, high: null });
    expect(parseAmountRange("Spouse/DC Over $1,000,000")).toEqual({ low: 1000000, high: null });
  });

  it("keeps an exact figure the filer typed as both ends", () => {
    expect(parseAmountRange("$823.45")).toEqual({ low: 823, high: 823 });
  });

  it("returns null for anything else", () => {
    expect(parseAmountRange("")).toBeNull();
    expect(parseAmountRange("$15,000 - $1,001")).toBeNull();
    expect(parseAmountRange("about $5,000")).toBeNull();
  });
});

// Builds positioned text the way pdfjs reports an e-filed PTR. NUL stands in
// for each small-cap glyph of a form label.
const NUL = String.fromCharCode(0);
const label = (text: string) => text.replace(/[a-z]/g, NUL);

function header(page: number, y: number): PtrTextItem[] {
  return [
    { page, x: 25, y, text: "ID" },
    { page, x: 66, y, text: "Owner" },
    { page, x: 105, y, text: "Asset" },
    { page, x: 262, y, text: "Transaction" },
    { page, x: 262, y: y - 11, text: "Type" },
    { page, x: 327, y, text: "Date" },
    { page, x: 382, y, text: "Notification" },
    { page, x: 382, y: y - 11, text: "Date" },
    { page, x: 446, y, text: "Amount" },
    { page, x: 525, y, text: "Cap." },
    { page, x: 525, y: y - 11, text: "Gains >" },
    { page, x: 525, y: y - 22, text: "$200?" },
  ];
}

function tradeRow(
  page: number,
  y: number,
  cells: { owner?: string; asset: string[]; type: string; date: string; notified: string; amount: string[]; status?: string }
): PtrTextItem[] {
  const items: PtrTextItem[] = [];
  if (cells.owner) {
    items.push({ page, x: 66, y, text: cells.owner });
  }
  cells.asset.forEach((line, index) => items.push({ page, x: 105, y: y - 10 * index, text: line }));
  items.push({ page, x: 262, y, text: cells.type });
  items.push({ page, x: 327, y, text: cells.date });
  items.push({ page, x: 381, y, text: cells.notified });
  cells.amount.forEach((line, index) => items.push({ page, x: 446, y: y - 10 * index, text: line }));
  const labelY = y - 10 * cells.asset.length - 8;
  items.push({ page, x: 105, y: labelY, text: `${label("Filing Status")}: ${cells.status ?? "New"}` });
  items.push({ page, x: 105, y: labelY - 12, text: `${label("Subholding Of")}: Brokerage Account (XYZ) [ST]` });
  return items;
}

const PREAMBLE: PtrTextItem[] = [
  { page: 1, x: 483, y: 712, text: "Filing ID #20032062" },
  { page: 1, x: 22, y: 594, text: "Name:" },
  { page: 1, x: 99, y: 594, text: "Hon. Pat Example" },
];
const FOOTER = (page: number, y: number): PtrTextItem[] => [
  { page, x: 25, y, text: "* For the complete list of asset type abbreviations, please visit" },
  { page, x: 22, y: y - 30, text: label("Initial Public Offerings") },
  { page, x: 39, y: y - 60, text: "I CERTIFY that the statements I have made are true" },
];

describe("parseHousePtrItems", () => {
  it("reads rows with owner, ticker, asset type, wrapped amount and status", () => {
    const result = parseHousePtrItems([
      ...PREAMBLE,
      ...header(1, 503),
      ...tradeRow(1, 459, {
        asset: ["GSK plc American Depositary Shares", "(GSK) [ST]"],
        type: "S",
        date: "07/28/2025",
        notified: "08/11/2025",
        amount: ["$1,001 - $15,000"],
      }),
      ...tradeRow(1, 380, {
        owner: "SP",
        asset: ["US TREASU NOTE 4.375% DUE", "12/15/26 (91282CJP7) [GS]"],
        type: "P",
        date: "12/03/2024",
        notified: "01/08/2025",
        amount: ["$100,001 -", "$250,000"],
      }),
      ...tradeRow(1, 300, {
        owner: "DC",
        asset: ["Bitcoin (BTC) [CT]"],
        type: "S (partial)",
        date: "02/01/2025",
        notified: "02/03/2025",
        amount: ["$15,001 - $50,000"],
        status: "Amended",
      }),
      ...FOOTER(1, 240),
    ]);
    expect(result.status).toBe("parsed");
    if (result.status !== "parsed") return;
    expect(result.trades.map(({ rawText: _raw, ...trade }) => trade)).toEqual([
      {
        rowIndex: 1,
        owner: "self",
        assetName: "GSK plc American Depositary Shares",
        ticker: "GSK",
        assetType: "ST",
        transactionType: "sale",
        transactionDate: "2025-07-28",
        notificationDate: "2025-08-11",
        amountLow: 1001,
        amountHigh: 15000,
        filingStatus: "new",
      },
      {
        rowIndex: 2,
        owner: "spouse",
        assetName: "US TREASU NOTE 4.375% DUE 12/15/26 (91282CJP7)",
        ticker: null,
        assetType: "GS",
        transactionType: "purchase",
        transactionDate: "2024-12-03",
        notificationDate: "2025-01-08",
        amountLow: 100001,
        amountHigh: 250000,
        filingStatus: "new",
      },
      {
        rowIndex: 3,
        owner: "child",
        assetName: "Bitcoin",
        ticker: "BTC",
        assetType: "CT",
        transactionType: "partial_sale",
        transactionDate: "2025-02-01",
        notificationDate: "2025-02-03",
        amountLow: 15001,
        amountHigh: 50000,
        filingStatus: "amended",
      },
    ]);
    // The subholding label line never leaks into the asset name.
    expect(result.trades[0]!.assetName).not.toContain("Brokerage");
  });

  it("skips the header that repeats on a later page", () => {
    const result = parseHousePtrItems([
      ...PREAMBLE,
      ...header(1, 503),
      ...tradeRow(1, 459, { owner: "JT", asset: ["AAON, Inc. - Common Stock (AAON)", "[ST]"], type: "S", date: "01/13/2025", notified: "01/13/2025", amount: ["$1,001 - $15,000"] }),
      { page: 2, x: 483, y: 750, text: "Filing ID #20032062" },
      ...header(2, 706),
      ...tradeRow(2, 643, { owner: "JT", asset: ["Netflix, Inc. - Common Stock (NFLX)", "[ST]"], type: "E", date: "01/14/2025", notified: "01/14/2025", amount: ["$1,001 - $15,000"] }),
      ...FOOTER(2, 500),
    ]);
    expect(result.status).toBe("parsed");
    if (result.status !== "parsed") return;
    expect(result.trades.map((trade) => [trade.owner, trade.assetName, trade.ticker, trade.transactionType])).toEqual([
      ["joint", "AAON, Inc. - Common Stock", "AAON", "sale"],
      ["joint", "Netflix, Inc. - Common Stock", "NFLX", "exchange"],
    ]);
  });

  it("treats a PDF with no text layer as a scanned paper filing", () => {
    expect(parseHousePtrItems([])).toEqual({ status: "scanned" });
  });

  it("fails the whole filing rather than keep a row it cannot read", () => {
    const badDate = parseHousePtrItems([
      ...header(1, 503),
      ...tradeRow(1, 459, { asset: ["Acme (ACME) [ST]"], type: "P", date: "02/31/2025", notified: "03/01/2025", amount: ["$1,001 - $15,000"] }),
      ...FOOTER(1, 300),
    ]);
    expect(badDate.status).toBe("parse_failed");
    const badOwner = parseHousePtrItems([
      ...header(1, 503),
      ...tradeRow(1, 459, { owner: "XX", asset: ["Acme (ACME) [ST]"], type: "P", date: "02/01/2025", notified: "03/01/2025", amount: ["$1,001 - $15,000"] }),
      ...FOOTER(1, 300),
    ]);
    expect(badOwner.status).toBe("parse_failed");
    expect(parseHousePtrItems([{ page: 1, x: 10, y: 10, text: "Some other document" }]).status).toBe("parse_failed");
  });
});

describe("planStockTradeFiling", () => {
  const parsed = { status: "parsed" as const };
  it("inserts a filing that is not stored", () => {
    expect(planStockTradeFiling(undefined, parsed, "v1")).toEqual({ action: "insert" });
  });

  it("never touches a parsed filing again, so a re-run adds nothing", () => {
    const existing = { docId: "1", parseStatus: "parsed", parserVersion: "v1", tradeCount: 3 };
    expect(planStockTradeFiling(existing, parsed, "v1")).toEqual({ action: "unchanged" });
  });

  it("leaves a scanned filing alone while it is still scanned", () => {
    const existing = { docId: "1", parseStatus: "scanned", parserVersion: "v1", tradeCount: 0 };
    expect(planStockTradeFiling(existing, { status: "scanned" }, "v1")).toEqual({ action: "unchanged" });
  });

  it("re-reads a filing that failed before or came from an older parser", () => {
    const failed = { docId: "1", parseStatus: "parse_failed", parserVersion: "v1", tradeCount: 0 };
    expect(planStockTradeFiling(failed, parsed, "v1")).toEqual({ action: "reparse" });
    const old = { docId: "1", parseStatus: "parsed", parserVersion: "v0", tradeCount: 3 };
    expect(planStockTradeFiling(old, parsed, "v1")).toEqual({ action: "reparse" });
  });
});

describe("planAmendmentSupersedes", () => {
  const trade = (id: string, filingOrder: string, overrides: Partial<AmendableTrade> = {}): AmendableTrade => ({
    id,
    filingOrder,
    supersededById: null,
    owner: "self",
    assetName: "Acme Corp",
    ticker: "ACME",
    transactionType: "purchase",
    transactionDate: "2025-03-01",
    filingStatus: "new",
    ...overrides,
  });

  it("an amended row replaces one earlier row that agrees on owner, asset, date and type", () => {
    const pairs = planAmendmentSupersedes([
      trade("a", "2025-03-10|1"),
      trade("b", "2025-03-10|1"),
      trade("c", "2025-04-02|2", { filingStatus: "amended" }),
    ]);
    expect(pairs).toEqual([["a", "c"]]);
  });

  it("supersedes nothing when no earlier row agrees, and nothing twice", () => {
    expect(
      planAmendmentSupersedes([
        trade("a", "2025-03-10|1", { transactionDate: "2025-02-27" }),
        trade("c", "2025-04-02|2", { filingStatus: "amended" }),
      ])
    ).toEqual([]);
    expect(
      planAmendmentSupersedes([
        trade("a", "2025-03-10|1", { supersededById: "c" }),
        trade("c", "2025-04-02|2", { filingStatus: "amended" }),
      ])
    ).toEqual([]);
  });

  it("never pairs rows of the same filing", () => {
    expect(
      planAmendmentSupersedes([trade("a", "2025-04-02|2"), trade("c", "2025-04-02|2", { filingStatus: "amended" })])
    ).toEqual([]);
  });
});
