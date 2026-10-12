// Parsers for Kansas SOS CFR viewer pages (docs/plans/plan-kansas-finance.md).
//
// Every shape below was captured live 2026-08-26. The viewer renders values
// in id-stamped <span>s, which keeps parsing structural:
// - report cover (reports/exp_report_main.aspx): lblCashBeginning,
//   lblTotalContributions, lblCashThisPeriod, lblTotalExpenditures,
//   lblCashOnHandClose, lblInKindContributions, lblOtherTransactions, plus
//   identity spans and the disabled chkAmended/chkTermination checkboxes.
// - schedule totals: Schedule A lblTotalItemized/lblTotalUnitemized/
//   lblPoliticalMaterials/lblContributorUnknown/lblTotalReceipts; Schedule C
//   lblTotalItemizedExpenditures/lblTotalUnitemized/lblTotalExpenditures;
//   Schedule B lblTotalItemized/lblTotalUnitemized/lblTotalInKind.
// - Schedule A itemized rows (Phase 2): one <tr> of seven <td>s per row;
//   only the address/zip carry id-stamped spans (Repeater2_lblAddress_N,
//   Repeater2_lblZip_N), everything else is free text inside the cells.
// - Schedule B itemized rows (Phase 2): same anchors, one <tr> of five
//   <td>s — date, name+address, occupation, description, value.
// - contribution export: one <span id="lblField_N"> set per row.
// - candidate-filings grids: e-filed rows carry lblDate_N and postback name
//   links; paper rows carry lblOriginalDate_N, an <img id="..._paper_N"
//   title="Paper Filing">, and their links open the scanned PDF.
//
// All money is parsed to integer cents. The strict parser rejects anything
// it does not fully understand; the OCR-tolerant parser (for scanned KPDC
// PDFs) may return an `uncertain` read that callers accept only when an
// arithmetic cross-check (cover lines 1+2=3, 3-4=5; IE running totals)
// validates it.

const HTML_ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&nbsp;": " ",
};

export function decodeKansasHtmlText(value: string): string {
  return value.replace(
    /&(?:#x([0-9a-fA-F]+)|#(\d+)|amp|lt|gt|quot|nbsp);/g,
    (entity, hex?: string, decimal?: string) => {
      if (hex !== undefined) return String.fromCodePoint(Number.parseInt(hex, 16));
      if (decimal !== undefined) return String.fromCodePoint(Number.parseInt(decimal, 10));
      return HTML_ENTITY_MAP[entity] ?? entity;
    }
  );
}

/**
 * Every hidden input (name -> value) of a WebForms page. The next POST must
 * echo them all: omitting __VIEWSTATEENCRYPTED produced a 500 live.
 */
export function parseKansasHiddenFields(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const tag of html.matchAll(/<input[^>]*type="hidden"[^>]*>/g)) {
    const name = /name="([^"]+)"/.exec(tag[0]);
    if (!name) continue;
    const value = /value="([^"]*)"/.exec(tag[0]);
    fields[decodeKansasHtmlText(name[1]!)] = decodeKansasHtmlText(value?.[1] ?? "");
  }
  return fields;
}

/**
 * Strict money parse to integer cents. Accepts the viewer's live variants:
 * "$3,077.59", "$ 4350.00", "$0", "$ 0", the cover's bare "1600.00", and
 * accounting-style negatives — "($4,000.00)" is a live credit-card refund row
 * (Schmidt 2026; dropping it overstated the itemized sum by $8,000).
 * Anything else (including blanks) is null.
 */
export function parseKansasMoneyCents(raw: string): number | null {
  let text = decodeKansasHtmlText(raw).trim();
  let sign = 1;
  const parenthesized = /^\((.*)\)$/.exec(text);
  if (parenthesized) {
    sign = -1;
    text = parenthesized[1]!.trim();
  }
  const match = /^\$?\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{2}))?$/.exec(text);
  if (!match) return null;
  const whole = Number.parseInt(match[1]!.replace(/,/g, ""), 10);
  const cents = match[2] === undefined ? 0 : Number.parseInt(match[2], 10);
  return sign * (whole * 100 + cents);
}

export type KansasOcrMoney = { cents: number; uncertain: boolean };

/**
 * OCR-tolerant money parse for scanned KPDC PDFs. Live artifacts:
 * "$ 359,633.00" (spaces), "$ 138,270 ,00" (comma as decimal point with a
 * stray space), "$2,550.001" (a table border read as a trailing digit).
 * A read that required dropping trailing artifact digits is `uncertain` and
 * must only be used when an arithmetic cross-check validates it. A string
 * whose decimal point cannot be located confidently returns null.
 */
export function parseKansasOcrMoneyCents(raw: string): KansasOcrMoney | null {
  let text = raw.replace(/\s+/g, " ").trim().replace(/^\$\s*/, "");
  if (!text) return null;
  // Normalize "138,270 ,00" / "138,270, 00" -> "138,270.00".
  text = text.replace(/\s*[,.]\s*(\d{2})$/, ".$1");
  const exact = /^(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})$/.exec(text);
  if (exact) {
    return {
      cents: Number.parseInt(exact[1]!.replace(/,/g, ""), 10) * 100 + Number.parseInt(exact[2]!, 10),
      uncertain: false,
    };
  }
  // Trailing artifact digits after a well-formed .XX (e.g. "2,550.001").
  const artifact = /^(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})\d{1,2}$/.exec(text);
  if (artifact) {
    return {
      cents:
        Number.parseInt(artifact[1]!.replace(/,/g, ""), 10) * 100 + Number.parseInt(artifact[2]!, 10),
      uncertain: true,
    };
  }
  return null;
}

/**
 * Results-page record count. Rendered as
 * `<span id="lblRecordCount">4285</span>\n record(s) found.` (the phrase sits
 * outside the span), so the span is the anchor.
 */
export function parseKansasRecordCount(html: string): number | null {
  const match = /<span id="lblRecordCount"[^>]*>([\d,]+)<\/span>/.exec(html);
  if (!match) return null;
  return Number.parseInt(match[1]!.replace(/,/g, ""), 10);
}

// ---------------------------------------------------------------------------
// Contribution/expenditure export (HTML table served as Contributions.xls).

export type KansasContributionExportRow = {
  candidateName: string;
  contributorName: string;
  city: string;
  state: string;
  zip: string;
  occupation: string;
  /** Always blank in live data; kept so drift is visible. */
  industry: string;
  date: string;
  tenderType: string;
  amountCents: number | null;
  inKindAmountCents: number | null;
  inKindDescription: string;
  periodStart: string;
  periodEnd: string;
};

function collectIndexedSpans(html: string, prefix: string): Map<number, string> {
  const values = new Map<number, string>();
  const pattern = new RegExp(`<span id="${prefix}_(\\d+)">([^<]*)</span>`, "g");
  for (const match of html.matchAll(pattern)) {
    values.set(Number.parseInt(match[1]!, 10), decodeKansasHtmlText(match[2]!).trim());
  }
  return values;
}

export function parseKansasContributionExportRows(html: string): KansasContributionExportRow[] {
  const byField = {
    candidateName: collectIndexedSpans(html, "lblCandName"),
    contributorName: collectIndexedSpans(html, "lblContributor"),
    city: collectIndexedSpans(html, "lblCity"),
    state: collectIndexedSpans(html, "lblState"),
    zip: collectIndexedSpans(html, "lblZip"),
    occupation: collectIndexedSpans(html, "lblOccupation"),
    industry: collectIndexedSpans(html, "lblIndustry"),
    date: collectIndexedSpans(html, "lblDate"),
    tenderType: collectIndexedSpans(html, "lblTypeofTender"),
    amount: collectIndexedSpans(html, "lblAmount"),
    inKindAmount: collectIndexedSpans(html, "lblInKindAmount"),
    inKindDescription: collectIndexedSpans(html, "lblInKindDescription"),
    periodStart: collectIndexedSpans(html, "lblStartDate"),
    periodEnd: collectIndexedSpans(html, "lblEndDate"),
  };
  const rows: KansasContributionExportRow[] = [];
  const indexes = [...byField.contributorName.keys()].sort((a, b) => a - b);
  for (const index of indexes) {
    const amountText = byField.amount.get(index) ?? "";
    const inKindText = byField.inKindAmount.get(index) ?? "";
    rows.push({
      candidateName: byField.candidateName.get(index) ?? "",
      contributorName: byField.contributorName.get(index) ?? "",
      city: byField.city.get(index) ?? "",
      state: byField.state.get(index) ?? "",
      zip: byField.zip.get(index) ?? "",
      occupation: byField.occupation.get(index) ?? "",
      industry: byField.industry.get(index) ?? "",
      date: byField.date.get(index) ?? "",
      tenderType: byField.tenderType.get(index) ?? "",
      amountCents: amountText === "" ? null : parseKansasMoneyCents(amountText),
      inKindAmountCents: inKindText === "" ? null : parseKansasMoneyCents(inKindText),
      inKindDescription: byField.inKindDescription.get(index) ?? "",
      periodStart: byField.periodStart.get(index) ?? "",
      periodEnd: byField.periodEnd.get(index) ?? "",
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Report cover.

export type KansasReportCover = {
  candidateName: string;
  officeSought: string;
  district: string;
  periodStart: string;
  periodEnd: string;
  amended: boolean;
  termination: boolean;
  electronicallyFiledOn: string | null;
  cashBeginningCents: number | null;
  totalContributionsCents: number | null;
  cashAvailableCents: number | null;
  totalExpendituresCents: number | null;
  cashCloseCents: number | null;
  inKindCents: number | null;
  otherTransactionsCents: number | null;
};

function spanValue(html: string, id: string): string {
  const match = new RegExp(`<span id="${id}"[^>]*>([^<]*)</span>`).exec(html);
  return match ? decodeKansasHtmlText(match[1]!).trim() : "";
}

function checkboxChecked(html: string, id: string): boolean {
  const match = new RegExp(`<input[^>]*id="${id}"[^>]*>`).exec(html);
  return match ? /\bchecked\b/.test(match[0]) : false;
}

export function parseKansasReportCover(html: string): KansasReportCover {
  const filedText = spanValue(html, "lblElectronicSignature");
  const filedMatch = /Electronically filed on:\s*(.+)$/.exec(filedText);
  return {
    candidateName: spanValue(html, "lblCandOrgName"),
    officeSought: spanValue(html, "lblOfficeSoughtName"),
    district: spanValue(html, "lblDistrictNo"),
    periodStart: spanValue(html, "lblFileStartDate"),
    periodEnd: spanValue(html, "lblFileEndDate"),
    amended: checkboxChecked(html, "chkAmended"),
    termination: checkboxChecked(html, "chkTermination"),
    electronicallyFiledOn: filedMatch ? filedMatch[1]!.trim() : filedText.trim() || null,
    cashBeginningCents: parseKansasMoneyCents(spanValue(html, "lblCashBeginning")),
    totalContributionsCents: parseKansasMoneyCents(spanValue(html, "lblTotalContributions")),
    cashAvailableCents: parseKansasMoneyCents(spanValue(html, "lblCashThisPeriod")),
    totalExpendituresCents: parseKansasMoneyCents(spanValue(html, "lblTotalExpenditures")),
    cashCloseCents: parseKansasMoneyCents(spanValue(html, "lblCashOnHandClose")),
    inKindCents: parseKansasMoneyCents(spanValue(html, "lblInKindContributions")),
    otherTransactionsCents: parseKansasMoneyCents(spanValue(html, "lblOtherTransactions")),
  };
}

/**
 * Cover arithmetic self-check (K.S.A. 25-4148 form): 1+2=3 and 3-4=5, exact
 * to the cent. A cover that fails is quarantined, never published.
 */
export function reconcileKansasCoverArithmetic(cover: {
  cashBeginningCents: number | null;
  totalContributionsCents: number | null;
  cashAvailableCents: number | null;
  totalExpendituresCents: number | null;
  cashCloseCents: number | null;
}): boolean {
  const { cashBeginningCents, totalContributionsCents, cashAvailableCents, totalExpendituresCents, cashCloseCents } =
    cover;
  if (
    cashBeginningCents === null ||
    totalContributionsCents === null ||
    cashAvailableCents === null ||
    totalExpendituresCents === null ||
    cashCloseCents === null
  ) {
    return false;
  }
  return (
    cashBeginningCents + totalContributionsCents === cashAvailableCents &&
    cashAvailableCents - totalExpendituresCents === cashCloseCents
  );
}

// ---------------------------------------------------------------------------
// Schedule totals (Phase 0 reconciles totals only; rows are Phase 2).

export type KansasScheduleATotals = {
  totalItemizedCents: number | null;
  totalUnitemizedCents: number | null;
  politicalMaterialsCents: number | null;
  contributorUnknownCents: number | null;
  totalReceiptsCents: number | null;
};

export function parseKansasScheduleATotals(html: string): KansasScheduleATotals {
  return {
    totalItemizedCents: parseKansasMoneyCents(spanValue(html, "lblTotalItemized")),
    totalUnitemizedCents: parseKansasMoneyCents(spanValue(html, "lblTotalUnitemized")),
    politicalMaterialsCents: parseKansasMoneyCents(spanValue(html, "lblPoliticalMaterials")),
    contributorUnknownCents: parseKansasMoneyCents(spanValue(html, "lblContributorUnknown")),
    totalReceiptsCents: parseKansasMoneyCents(spanValue(html, "lblTotalReceipts")),
  };
}

export type KansasScheduleBTotals = {
  /** "Total Itemized (over $100) In-Kind Contributions". */
  totalItemizedCents: number | null;
  /** "Total Unitemized ($100 or less) In-Kind Contributions". */
  totalUnitemizedCents: number | null;
  /** "TOTAL IN-KIND CONTRIBUTIONS THIS PERIOD" = cover line 6 (live: 5/5 Governor 2026 covers). */
  totalInKindCents: number | null;
};

export function parseKansasScheduleBTotals(html: string): KansasScheduleBTotals {
  return {
    totalItemizedCents: parseKansasMoneyCents(spanValue(html, "lblTotalItemized")),
    totalUnitemizedCents: parseKansasMoneyCents(spanValue(html, "lblTotalUnitemized")),
    totalInKindCents: parseKansasMoneyCents(spanValue(html, "lblTotalInKind")),
  };
}

export type KansasScheduleCTotals = {
  totalItemizedCents: number | null;
  totalUnitemizedCents: number | null;
  totalExpendituresCents: number | null;
};

export function parseKansasScheduleCTotals(html: string): KansasScheduleCTotals {
  return {
    totalItemizedCents: parseKansasMoneyCents(spanValue(html, "lblTotalItemizedExpenditures")),
    totalUnitemizedCents: parseKansasMoneyCents(spanValue(html, "lblTotalUnitemized")),
    totalExpendituresCents: parseKansasMoneyCents(spanValue(html, "lblTotalExpenditures")),
  };
}

// ---------------------------------------------------------------------------
// Schedule A itemized rows (Phase 2).
//
// Live shape (Helwig HD1, 2026-09-01): each itemized receipt is one <tr> of
// seven <td>s — date, name+address, type of payment, occupation, primary
// total, general total, amount. The name is the free text before the cell's
// first <br />; a person filed through the form's separate first/last fields
// renders as two source lines ("Corky \nZahm"), an entity as one, but that
// is a hint, not a classification. The address and zip are the only
// id-stamped spans (Repeater2_lblAddress_N / Repeater2_lblZip_N), so the
// span index anchors the row. "Primary Total"/"General Total" are the
// contributor's running phase aggregates, not row money — the row's money
// is the "Amount" column, and the sum of every Amount must equal
// lblTotalItemized cent-exact or the schedule is quarantined.
//
// Contributor names and addresses stay in restricted raw staging only
// (K.S.A. 25-4154(d)); nothing here is a published surface.

export type KansasScheduleARow = {
  /** Repeater2 row index from the address/zip span ids. */
  index: number;
  /** As rendered ("07/23/26"). */
  date: string;
  contributorName: string;
  /** Address lines after the name, one per rendered line (street, suite, "City ST zip"). */
  addressLines: string[];
  zip: string;
  /** "Cash", "Check", "Loan", "E-funds", "Other" as rendered. */
  tenderType: string;
  /** Free text; "" when the cell is blank (not required at or under $150). */
  occupation: string;
  primaryTotalCents: number | null;
  generalTotalCents: number | null;
  amountCents: number | null;
};

export type KansasScheduleARows = {
  rows: KansasScheduleARow[];
  /** <tr>s that carried a Repeater2 span but not the seven expected cells (structural drift). */
  malformedRowCount: number;
};

const SCHEDULE_A_CELL_COUNT = 7;
const CELL_LINE_BREAK = String.fromCharCode(0);

/**
 * Rendered lines of a table cell: <br /> breaks lines, every other tag is
 * dropped, source newlines inside a line are just whitespace (the viewer
 * emits "Leawood&nbsp;\nKS&nbsp;\n<span>66211</span>" as one visual line).
 */
function cellLines(cellHtml: string): string[] {
  return decodeKansasHtmlText(cellHtml.replace(/<br\s*\/?>/gi, CELL_LINE_BREAK).replace(/<[^>]+>/g, ""))
    .split(CELL_LINE_BREAK)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "");
}

function cellInnerHtmls(rowHtml: string): string[] {
  return [...rowHtml.matchAll(/<td(?:\s[^>]*)?>([\s\S]*?)<\/td>/gi)].map((match) => match[1]!);
}

/**
 * The itemized <tr>s of a schedule page (Schedules A and B share the
 * Repeater2 address/zip anchors): each row's cells, or a malformed count
 * for rows that carried the anchor but not `cellCount` cells.
 */
function collectKansasScheduleRows(html: string, cellCount: number): { rows: { index: number; cells: string[] }[]; malformedRowCount: number } {
  const rows: { index: number; cells: string[] }[] = [];
  let malformedRowCount = 0;
  for (const rowMatch of html.matchAll(/<tr(?:\s[^>]*)?>([\s\S]*?)<\/tr>/gi)) {
    const rowHtml = rowMatch[1]!;
    const indexMatch = /id="Repeater2_lblAddress_(\d+)"/.exec(rowHtml);
    if (!indexMatch) continue;
    const cells = cellInnerHtmls(rowHtml);
    if (cells.length !== cellCount) {
      malformedRowCount += 1;
      continue;
    }
    rows.push({ index: Number.parseInt(indexMatch[1]!, 10), cells });
  }
  return { rows, malformedRowCount };
}

/** Name (first rendered line), address lines, and the zip span of a contributor cell. */
function parseKansasContributorCell(cellHtml: string): { contributorName: string; addressLines: string[]; zip: string } {
  const lines = cellLines(cellHtml);
  const zipMatch = /<span id="Repeater2_lblZip_\d+"[^>]*>([^<]*)<\/span>/.exec(cellHtml);
  return {
    contributorName: lines[0] ?? "",
    addressLines: lines.slice(1),
    zip: zipMatch ? decodeKansasHtmlText(zipMatch[1]!).trim() : "",
  };
}

export function parseKansasScheduleARows(html: string): KansasScheduleARows {
  const collected = collectKansasScheduleRows(html, SCHEDULE_A_CELL_COUNT);
  const rows = collected.rows.map(({ index, cells }) => {
    const [dateCell, contributorCell, tenderCell, occupationCell, primaryCell, generalCell, amountCell] = cells as [
      string, string, string, string, string, string, string,
    ];
    return {
      index,
      date: cellLines(dateCell).join(" "),
      ...parseKansasContributorCell(contributorCell),
      tenderType: cellLines(tenderCell).join(" "),
      occupation: cellLines(occupationCell).join(" "),
      primaryTotalCents: parseKansasMoneyCents(cellLines(primaryCell).join("")),
      generalTotalCents: parseKansasMoneyCents(cellLines(generalCell).join("")),
      amountCents: parseKansasMoneyCents(cellLines(amountCell).join("")),
    };
  });
  return { rows, malformedRowCount: collected.malformedRowCount };
}

export type KansasScheduleACheck = {
  /** Every row had seven cells and a parseable Amount. */
  rowsParsed: boolean;
  /** Sum of row Amounts equals lblTotalItemized cent-exact. */
  itemizedSumMatchesTotal: boolean;
  /** Form identity: itemized + unitemized + political materials + unknown = total receipts. */
  totalsArithmeticOk: boolean;
};

/** Schedule A self-check; a schedule failing any line is quarantined, never aggregated. */
export function checkKansasScheduleA(parsed: KansasScheduleARows, totals: KansasScheduleATotals): KansasScheduleACheck {
  const rowsParsed = parsed.malformedRowCount === 0 && parsed.rows.every((row) => row.amountCents !== null);
  const rowSum = parsed.rows.reduce((sum, row) => sum + (row.amountCents ?? 0), 0);
  const { totalItemizedCents, totalUnitemizedCents, politicalMaterialsCents, contributorUnknownCents, totalReceiptsCents } =
    totals;
  return {
    rowsParsed,
    itemizedSumMatchesTotal: rowsParsed && totalItemizedCents !== null && rowSum === totalItemizedCents,
    totalsArithmeticOk:
      totalItemizedCents !== null &&
      totalUnitemizedCents !== null &&
      politicalMaterialsCents !== null &&
      contributorUnknownCents !== null &&
      totalReceiptsCents !== null &&
      totalItemizedCents + totalUnitemizedCents + politicalMaterialsCents + contributorUnknownCents === totalReceiptsCents,
  };
}

// ---------------------------------------------------------------------------
// Schedule B itemized rows (Phase 2).
//
// Live shape (Governor 2026, five reports captured 2026-09-03): each
// itemized in-kind contribution is one <tr> of five <td>s — date,
// name+address (same Repeater2 spans as Schedule A, zip may carry +4),
// occupation, description ("Food and Drink", "Donation of Signs"), value.
// There is no tender column and no running phase totals. The sum of every
// Value must equal lblTotalItemized cent-exact, itemized + unitemized must
// equal lblTotalInKind, and lblTotalInKind equalled cover line 6 on every
// captured report. A filer may itemize under the $100 line ($50 rows seen).

export type KansasScheduleBRow = {
  /** Repeater2 row index from the address/zip span ids. */
  index: number;
  /** As rendered ("01/30/26"). */
  date: string;
  contributorName: string;
  addressLines: string[];
  zip: string;
  /** Free text; "" when the cell is blank (an entity, or at or under $150). */
  occupation: string;
  /** Free text ("Food and Drink"). */
  description: string;
  valueCents: number | null;
};

export type KansasScheduleBRows = {
  rows: KansasScheduleBRow[];
  /** <tr>s that carried a Repeater2 span but not the five expected cells (structural drift). */
  malformedRowCount: number;
};

const SCHEDULE_B_CELL_COUNT = 5;

export function parseKansasScheduleBRows(html: string): KansasScheduleBRows {
  const collected = collectKansasScheduleRows(html, SCHEDULE_B_CELL_COUNT);
  const rows = collected.rows.map(({ index, cells }) => {
    const [dateCell, contributorCell, occupationCell, descriptionCell, valueCell] = cells as [string, string, string, string, string];
    return {
      index,
      date: cellLines(dateCell).join(" "),
      ...parseKansasContributorCell(contributorCell),
      occupation: cellLines(occupationCell).join(" "),
      description: cellLines(descriptionCell).join(" "),
      valueCents: parseKansasMoneyCents(cellLines(valueCell).join("")),
    };
  });
  return { rows, malformedRowCount: collected.malformedRowCount };
}

export type KansasScheduleBCheck = {
  /** Every row had five cells and a parseable Value. */
  rowsParsed: boolean;
  /** Sum of row Values equals lblTotalItemized cent-exact. */
  itemizedSumMatchesTotal: boolean;
  /** Form identity: itemized + unitemized = total in-kind. */
  totalsArithmeticOk: boolean;
};

/** Schedule B self-check; a schedule failing any line is quarantined, never aggregated. */
export function checkKansasScheduleB(parsed: KansasScheduleBRows, totals: KansasScheduleBTotals): KansasScheduleBCheck {
  const rowsParsed = parsed.malformedRowCount === 0 && parsed.rows.every((row) => row.valueCents !== null);
  const rowSum = parsed.rows.reduce((sum, row) => sum + (row.valueCents ?? 0), 0);
  const { totalItemizedCents, totalUnitemizedCents, totalInKindCents } = totals;
  return {
    rowsParsed,
    itemizedSumMatchesTotal: rowsParsed && totalItemizedCents !== null && rowSum === totalItemizedCents,
    totalsArithmeticOk:
      totalItemizedCents !== null &&
      totalUnitemizedCents !== null &&
      totalInKindCents !== null &&
      totalItemizedCents + totalUnitemizedCents === totalInKindCents,
  };
}

/** One opened Schedule A page: its rows and its total lines. */
export type KansasScheduleA = { rows: KansasScheduleARows; totals: KansasScheduleATotals };
/** One opened Schedule B page: its rows and its total lines. */
export type KansasScheduleB = { rows: KansasScheduleBRows; totals: KansasScheduleBTotals };

export function parseKansasScheduleA(html: string): KansasScheduleA {
  return { rows: parseKansasScheduleARows(html), totals: parseKansasScheduleATotals(html) };
}

export function parseKansasScheduleB(html: string): KansasScheduleB {
  return { rows: parseKansasScheduleBRows(html), totals: parseKansasScheduleBTotals(html) };
}

// ---------------------------------------------------------------------------
// Candidate-filings grids.

export type KansasCfrGridRow = {
  index: number;
  /** Filed date: lblDate_N, lblOriginalDate_N, or IndividualEntity lblPaperDate_N. */
  fileDate: string;
  amendmentDate: string;
  /** lblAmendmentNo_N on the Appointment of Treasurer grid: "" on an original appointment. */
  amendmentNo: string;
  name: string;
  officeSought: string;
  district: string;
  /** Explicit marker: <img id="<grid>_paper_N" title="Paper Filing">. */
  channel: "efile" | "paper";
  /** First row postback target, e.g. "grdviewCfrResults$ctl02$lnkbtnLastName". */
  postbackTarget: string | null;
};

/**
 * Rows of a viewer results grid (`grdviewCfrResults`, `grdviewLookupResults`,
 * `gvIndividualEntity`, ...). Handles both live shapes: e-filed rows
 * (lblDate_N + lnkbtn name links that open the HTML report) and paper rows
 * (lblOriginalDate_N + a "Paper Filing" pdf icon; their links open the
 * scanned PDF in a new window).
 */
export function parseKansasCfrGridRows(html: string, gridId: string): KansasCfrGridRow[] {
  const spanPattern = new RegExp(`<span id="${gridId}_(\\w+?)_(\\d+)"[^>]*>([^<]*)</span>`, "g");
  const fields = new Map<number, Map<string, string>>();
  for (const match of html.matchAll(spanPattern)) {
    const index = Number.parseInt(match[2]!, 10);
    if (!fields.has(index)) fields.set(index, new Map());
    fields.get(index)!.set(match[1]!, decodeKansasHtmlText(match[3]!).trim());
  }

  const anchorPattern = new RegExp(
    `<a id="${gridId}_\\w+?_(\\d+)"[^>]*href="javascript:__doPostBack\\(&#39;([^&]+)&#39;`,
    "g"
  );
  const anchors = new Map<number, string[]>();
  const anchorText = new Map<number, string[]>();
  const anchorFullPattern = new RegExp(
    `<a id="${gridId}_\\w+?_(\\d+)"[^>]*href="javascript:__doPostBack\\(&#39;([^&]+)&#39;[^>]*>([^<]*)</a>`,
    "g"
  );
  for (const match of html.matchAll(anchorPattern)) {
    const index = Number.parseInt(match[1]!, 10);
    if (!anchors.has(index)) anchors.set(index, []);
    anchors.get(index)!.push(match[2]!);
  }
  for (const match of html.matchAll(anchorFullPattern)) {
    const index = Number.parseInt(match[1]!, 10);
    if (!anchorText.has(index)) anchorText.set(index, []);
    const text = decodeKansasHtmlText(match[3]!).trim();
    if (text) anchorText.get(index)!.push(text);
  }

  const paperPattern = new RegExp(`<img id="${gridId}_paper_(\\d+)"`, "g");
  const paperRows = new Set<number>();
  for (const match of html.matchAll(paperPattern)) {
    paperRows.add(Number.parseInt(match[1]!, 10));
  }

  const indexes = new Set<number>([...fields.keys(), ...anchors.keys()]);
  return [...indexes]
    .sort((a, b) => a - b)
    .map((index) => {
      const rowFields = fields.get(index) ?? new Map<string, string>();
      const names = anchorText.get(index) ?? [];
      return {
        index,
        fileDate: rowFields.get("lblDate") ?? rowFields.get("lblOriginalDate") ?? rowFields.get("lblPaperDate") ?? "",
        amendmentDate: rowFields.get("lblAmendmentDate") ?? "",
        amendmentNo: rowFields.get("lblAmendmentNo") ?? "",
        name: names.join(" "),
        officeSought: rowFields.get("labelOfficeSought") ?? "",
        district: (rowFields.get("lblDistrictNumber") ?? "").replace(/^\/\s*/, ""),
        channel: paperRows.has(index) ? "paper" : "efile",
        postbackTarget: anchors.get(index)?.[0] ?? null,
      };
    });
}

/**
 * The pager's rendered current-page number, or null when no pager exists
 * (single-page results). Live markup: the pager row holds one `Page$N`
 * postback link per other page and the CURRENT page as a bare
 * `<td><span>N</span></td>` (no link, no id). A stale WebForms postback
 * re-renders a page rather than navigating, so the paging walk asserts
 * this value instead of trusting that a 200 answer advanced.
 */
export function parseKansasCfrGridCurrentPage(html: string, gridId: string): number | null {
  const current = new Set<number>();
  for (const chunk of html.split(/<tr[\s>]/i)) {
    // A pager chunk names the grid in its __doPostBack links and pages via Page$N.
    if (!chunk.includes(gridId) || !chunk.includes("Page$")) continue;
    for (const match of chunk.matchAll(/<td>\s*<span>(\d+)<\/span>\s*<\/td>/g)) {
      current.add(Number.parseInt(match[1]!, 10));
    }
  }
  if (current.size !== 1) return null;
  return [...current.values()][0]!;
}
