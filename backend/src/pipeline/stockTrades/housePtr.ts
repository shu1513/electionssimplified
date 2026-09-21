import { parseIndexDate } from "../travel/houseGiftTravel.js";

// Periodic Transaction Reports (PTRs) filed with the House Clerk: the
// securities trades a member or candidate must report under the STOCK Act.
//
// The Clerk publishes one financial-disclosure index per filing year
// (`<year>FD.xml` inside
// https://disclosures-clerk.house.gov/public_disc/financial-pdfs/<year>FD.zip).
// A PTR is an index row with FilingType "P"; its PDF is at
// https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/<year>/<DocID>.pdf.
// E-filed PTRs are text PDFs with one fixed table layout, parsed here from
// positioned text. Paper PTRs are scanned images: they are recognized and
// kept as filings, and no trade is read from them.

export const HOUSE_PTR_PARSER_VERSION = "house-ptr-v1";

export type HouseFdIndexRow = {
  prefix: string;
  last: string;
  first: string;
  suffix: string;
  filingType: string;
  state: string;
  // District digits as printed ("04", "00" for at-large), or "" when absent.
  district: string;
  // The filing year, which is also the PDF's directory on the Clerk site.
  year: string;
  // ISO date, or null when the index left the field blank or unreadable.
  filingDate: string | null;
  docId: string;
};

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function field(block: string, tag: string): string {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block);
  return match ? decodeXmlText(match[1]!).replace(/\s+/g, " ").trim() : "";
}

export function parseHouseFdIndex(xml: string): HouseFdIndexRow[] {
  const rows: HouseFdIndexRow[] = [];
  for (const match of xml.matchAll(/<Member>([\s\S]*?)<\/Member>/g)) {
    const block = match[1]!;
    const stateDst = /^([A-Za-z]{2})(\d{0,2})$/.exec(field(block, "StateDst"));
    rows.push({
      prefix: field(block, "Prefix"),
      last: field(block, "Last"),
      first: field(block, "First"),
      suffix: field(block, "Suffix"),
      filingType: field(block, "FilingType").toUpperCase(),
      state: stateDst ? stateDst[1]!.toUpperCase() : "",
      district: stateDst ? stateDst[2]! : "",
      year: field(block, "Year"),
      filingDate: parseIndexDate(field(block, "FilingDate")),
      docId: field(block, "DocID"),
    });
  }
  return rows;
}

/** PTR rows only, one per DocID (the index can list a filing twice). */
export function selectHousePtrFilings(rows: readonly HouseFdIndexRow[]): HouseFdIndexRow[] {
  const byDocId = new Map<string, HouseFdIndexRow>();
  for (const row of rows) {
    if (row.filingType === "P" && /^\d+$/.test(row.docId) && /^\d{4}$/.test(row.year) && !byDocId.has(row.docId)) {
      byDocId.set(row.docId, row);
    }
  }
  return [...byDocId.values()];
}

export function housePtrPdfUrl(filingYear: string, docId: string): string {
  return `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${filingYear}/${docId}.pdf`;
}

/** `Pelosi` + `Nancy` → `Pelosi, Nancy`, the shape matchHouseTripLegislator reads. */
export function housePtrMemberName(row: Pick<HouseFdIndexRow, "last" | "first">): string {
  return `${row.last}, ${row.first}`;
}

export type StockTradeAmountRange = { low: number; high: number | null };

function parseDollars(value: string): number | null {
  const digits = value.replace(/[$,\s]/g, "");
  return /^\d+$/.test(digits) ? Number(digits) : null;
}

/**
 * `$1,001 - $15,000` → { low: 1001, high: 15000 }. `Over $50,000,000` →
 * { low: 50000000, high: null }. The form offers ranges only; an exact figure
 * appears only when the filer typed one. Anything unreadable → null.
 */
export function parseAmountRange(text: string): StockTradeAmountRange | null {
  const value = text.replace(/\s+/g, " ").trim();
  const range = /^\$([\d,]+) ?- ?\$([\d,]+)$/.exec(value);
  if (range) {
    const low = parseDollars(range[1]!);
    const high = parseDollars(range[2]!);
    return low !== null && high !== null && high >= low ? { low, high } : null;
  }
  // A few filers type one exact figure instead of picking a range. It is the
  // filing's own number, kept in whole dollars as both ends.
  const exact = /^\$([\d,]+)(?:\.\d{1,2})?$/.exec(value);
  if (exact) {
    const dollars = parseDollars(exact[1]!);
    return dollars !== null ? { low: dollars, high: dollars } : null;
  }
  const over = /^(?:Spouse\/DC )?Over \$([\d,]+)$/i.exec(value) ?? /^\$([\d,]+) ?\+$/.exec(value);
  if (over) {
    const low = parseDollars(over[1]!);
    return low !== null ? { low, high: null } : null;
  }
  return null;
}

export type StockTradeOwner = "self" | "spouse" | "child" | "joint";
export type StockTradeTransactionType = "purchase" | "sale" | "partial_sale" | "exchange";

const OWNER_BY_CODE: Readonly<Record<string, StockTradeOwner>> = {
  "": "self",
  SP: "spouse",
  DC: "child",
  JT: "joint",
};

/** One positioned text run, as pdfjs reports it (`str` untouched). */
export type PtrTextItem = { page: number; x: number; y: number; text: string };

export type HousePtrTrade = {
  // Position in the filing, from 1. With the DocID it keys the stored row.
  rowIndex: number;
  owner: StockTradeOwner;
  assetName: string;
  ticker: string | null;
  assetType: string | null;
  transactionType: StockTradeTransactionType;
  transactionDate: string;
  notificationDate: string | null;
  amountLow: number;
  amountHigh: number | null;
  filingStatus: "new" | "amended";
  rawText: string;
};

export type HousePtrParseResult =
  | { status: "parsed"; trades: HousePtrTrade[] }
  // No text layer at all: a paper filing scanned to an image.
  | { status: "scanned" }
  | { status: "parse_failed"; detail: string };

// The form prints its labels in small caps; pdfjs returns the capitals and a
// NUL for every small-cap glyph ("F\0\0\0\0\0 S\0\0\0\0\0: New" is "Filing
// Status: New"). A NUL therefore marks a label, never filer-entered text.
const LABEL_MARK = /\u0000/;

function clean(text: string): string {
  return text.replace(/\u0000/g, "").replace(/\s+/g, " ").trim();
}

type Columns = { owner: number; asset: number; type: number; date: number; notification: number; amount: number; gains: number };

const COLUMN_TOLERANCE = 12;

function findColumns(items: readonly PtrTextItem[]): { columns: Columns; page: number; y: number } | null {
  for (const owner of items) {
    if (clean(owner.text) !== "Owner") {
      continue;
    }
    const sameLine = items.filter((item) => item.page === owner.page && Math.abs(item.y - owner.y) < 3);
    const x = (label: string, after: number): number | null => {
      const hit = sameLine.filter((item) => clean(item.text) === label && item.x > after).sort((a, b) => a.x - b.x)[0];
      return hit ? hit.x : null;
    };
    const asset = x("Asset", owner.x);
    const type = asset === null ? null : x("Transaction", asset);
    const date = type === null ? null : x("Date", type);
    const notification = date === null ? null : x("Notification", date);
    const amount = notification === null ? null : x("Amount", notification);
    const gains = amount === null ? null : x("Cap.", amount);
    if (asset !== null && type !== null && date !== null && notification !== null && amount !== null && gains !== null) {
      return { columns: { owner: owner.x, asset, type, date, notification, amount, gains }, page: owner.page, y: owner.y };
    }
  }
  return null;
}

type ColumnName = "id" | keyof Columns;

function columnOf(x: number, columns: Columns): ColumnName {
  const ordered: [ColumnName, number][] = [
    ["gains", columns.gains],
    ["amount", columns.amount],
    ["notification", columns.notification],
    ["date", columns.date],
    ["type", columns.type],
    ["asset", columns.asset],
    ["owner", columns.owner],
  ];
  for (const [name, start] of ordered) {
    if (x >= start - COLUMN_TOLERANCE) {
      return name;
    }
  }
  return "id";
}

const TRANSACTION_TYPE = /^(P|S|E)(?:\s*\(partial\))?$/i;

function splitAsset(lines: readonly string[]): Pick<HousePtrTrade, "assetName" | "ticker" | "assetType"> {
  let name = lines.join(" ").replace(/\s+/g, " ").trim();
  let assetType: string | null = null;
  const typeMatch = /\s*\[([A-Z0-9]{2,3})\]\s*$/.exec(name);
  if (typeMatch) {
    assetType = typeMatch[1]!;
    name = name.slice(0, typeMatch.index).trim();
  }
  // A trailing parenthesis holds a ticker for stocks and a CUSIP for bonds.
  // Only a ticker-shaped value is kept, and it stays in the name either way.
  const tickerMatch = /\(([A-Z]{1,5}(?:[.\-/][A-Z]{1,2})?)\)\s*$/.exec(name);
  let ticker: string | null = null;
  if (tickerMatch) {
    ticker = tickerMatch[1]!;
    name = name.slice(0, tickerMatch.index).trim();
  }
  return { assetName: name.replace(/\s+-$/, "").trim(), ticker, assetType };
}

/**
 * Trades from the positioned text of one e-filed PTR. A row starts at a
 * transaction-type cell (P, S, S (partial), E) and runs to the next one.
 * The parser is strict: a row whose date or amount cannot be read fails the
 * whole filing (`parse_failed`) rather than storing a partial list, so a
 * stored filing is always complete.
 */
export function parseHousePtrItems(rawItems: readonly PtrTextItem[]): HousePtrParseResult {
  const items = rawItems.filter((item) => clean(item.text).length > 0);
  if (items.length === 0) {
    return { status: "scanned" };
  }
  const header = findColumns(items);
  if (!header) {
    return { status: "parse_failed", detail: "transaction table header not found" };
  }
  const { columns } = header;

  // Reading order across pages. Dropped: everything before the first table
  // header, the three-line header itself (it repeats on every page), and the
  // "Filing ID #" stamp.
  const position = (item: PtrTextItem): number => item.page * 100_000 - item.y;
  const headerLines = items.filter(
    (item) => clean(item.text) === "Owner" && Math.abs(item.x - columns.owner) < COLUMN_TOLERANCE
  );
  const inHeaderBand = (item: PtrTextItem): boolean =>
    headerLines.some((line) => line.page === item.page && item.y <= line.y + 3 && item.y >= line.y - 26);
  const tableStart = header.page * 100_000 - header.y;
  const ordered = items
    .filter((item) => position(item) > tableStart && !inHeaderBand(item) && !/^Filing ID #/.test(clean(item.text)))
    .sort((a, b) => position(a) - position(b) || a.x - b.x);

  // The table ends at the asset-type footnote or the next section heading
  // (a label at the left margin).
  const endIndex = ordered.findIndex(
    (item) => /^\* For the complete list/.test(clean(item.text)) || (LABEL_MARK.test(item.text) && item.x < columns.owner - COLUMN_TOLERANCE)
  );
  const table = endIndex >= 0 ? ordered.slice(0, endIndex) : ordered;

  const anchors = table.filter((item) => columnOf(item.x, columns) === "type" && TRANSACTION_TYPE.test(clean(item.text)));
  const trades: HousePtrTrade[] = [];
  for (const [index, anchor] of anchors.entries()) {
    const start = position(anchor) - 3;
    const next = anchors[index + 1];
    const end = next ? position(next) - 3 : Number.POSITIVE_INFINITY;
    const rowItems = table.filter((item) => position(item) >= start && position(item) < end);
    const cells = (name: ColumnName): string[] =>
      rowItems.filter((item) => columnOf(item.x, columns) === name && !LABEL_MARK.test(item.text)).map((item) => clean(item.text));

    const ownerCode = cells("owner").join(" ").toUpperCase();
    const owner = OWNER_BY_CODE[ownerCode];
    if (!owner) {
      return { status: "parse_failed", detail: `row ${index + 1}: unknown owner code "${ownerCode}"` };
    }
    // Filer text in the asset column ends at the first label line
    // (Filing Status, Subholding Of, Description, ...).
    const assetLines: string[] = [];
    for (const item of rowItems.filter((entry) => columnOf(entry.x, columns) === "asset")) {
      if (LABEL_MARK.test(item.text)) {
        break;
      }
      assetLines.push(clean(item.text));
    }
    const asset = splitAsset(assetLines);
    if (!asset.assetName) {
      return { status: "parse_failed", detail: `row ${index + 1}: no asset name` };
    }
    const typeText = cells("type").join(" ");
    const typeCode = clean(anchor.text).charAt(0).toUpperCase();
    const transactionType: StockTradeTransactionType =
      typeCode === "P" ? "purchase" : typeCode === "E" ? "exchange" : /partial/i.test(typeText) ? "partial_sale" : "sale";
    const transactionDate = parseIndexDate(cells("date")[0] ?? "");
    if (!transactionDate) {
      return { status: "parse_failed", detail: `row ${index + 1}: unreadable transaction date "${cells("date").join(" ")}"` };
    }
    const amount = parseAmountRange(cells("amount").join(" "));
    if (!amount) {
      return { status: "parse_failed", detail: `row ${index + 1}: unreadable amount "${cells("amount").join(" ")}"` };
    }
    const statusLabel = rowItems.find((item) => LABEL_MARK.test(item.text) && /^F\s*S\s*:/.test(clean(item.text)));
    trades.push({
      rowIndex: index + 1,
      owner,
      ...asset,
      transactionType,
      transactionDate,
      notificationDate: parseIndexDate(cells("notification")[0] ?? ""),
      amountLow: amount.low,
      amountHigh: amount.high,
      filingStatus: statusLabel && /amended/i.test(statusLabel.text) ? "amended" : "new",
      rawText: rowItems.map((item) => clean(item.text)).join(" | "),
    });
  }
  if (trades.length === 0) {
    return { status: "parse_failed", detail: "no transaction rows found under the table header" };
  }
  return { status: "parsed", trades };
}

export type ExistingStockTradeFiling = { docId: string; parseStatus: string; parserVersion: string; tradeCount: number };

export type StockTradeFilingPlan =
  | { action: "insert" }
  | { action: "unchanged" }
  // A filing stored as scanned / parse_failed, or by an older parser, that
  // now parses: its rows are replaced in one transaction.
  | { action: "reparse" };

/**
 * What to do with one filing given what is stored under its DocID. A parsed
 * filing from the current parser is never touched again, so a re-run adds
 * nothing and changes nothing.
 */
export function planStockTradeFiling(
  existing: ExistingStockTradeFiling | undefined,
  parsed: Pick<HousePtrParseResult, "status">,
  parserVersion: string
): StockTradeFilingPlan {
  if (!existing) {
    return { action: "insert" };
  }
  if (existing.parseStatus === "parsed" && existing.parserVersion === parserVersion) {
    return { action: "unchanged" };
  }
  if (existing.parseStatus === parsed.status && existing.parseStatus !== "parsed") {
    return { action: "unchanged" };
  }
  return { action: "reparse" };
}

export type AmendableTrade = Pick<HousePtrTrade, "owner" | "assetName" | "ticker" | "transactionType" | "transactionDate" | "filingStatus"> & {
  id: string;
  // Filing order: filing date, then DocID.
  filingOrder: string;
  supersededById: string | null;
};

function amendmentKey(trade: AmendableTrade): string {
  const asset = (trade.ticker ?? trade.assetName).toLowerCase().replace(/[^a-z0-9]/g, "");
  return `${trade.owner}|${asset}|${trade.transactionDate}|${trade.transactionType}`;
}

/**
 * Amendment rule. The House form marks each restated row "Amended" but does
 * not say which earlier row it restates. A row marked amended supersedes one
 * earlier, not yet superseded row of the same filer with the same owner,
 * asset, transaction date and transaction type: the usual amendment corrects
 * the amount or the notification date. When no earlier row agrees on all
 * four, nothing is superseded and both rows stay listed, because guessing
 * would hide a real trade. Returns [supersededId, byId] pairs.
 */
export function planAmendmentSupersedes(trades: readonly AmendableTrade[]): [string, string][] {
  const ordered = [...trades].sort((a, b) => a.filingOrder.localeCompare(b.filingOrder));
  const taken = new Set(ordered.filter((trade) => trade.supersededById).map((trade) => trade.id));
  const pairs: [string, string][] = [];
  const alreadyUsed = new Set(ordered.map((trade) => trade.supersededById).filter((id): id is string => id !== null));
  for (const amended of ordered) {
    if (amended.filingStatus !== "amended" || alreadyUsed.has(amended.id)) {
      continue;
    }
    const target = ordered.find(
      (earlier) =>
        earlier.id !== amended.id &&
        earlier.filingOrder < amended.filingOrder &&
        !taken.has(earlier.id) &&
        amendmentKey(earlier) === amendmentKey(amended)
    );
    if (target) {
      taken.add(target.id);
      pairs.push([target.id, amended.id]);
    }
  }
  return pairs;
}
