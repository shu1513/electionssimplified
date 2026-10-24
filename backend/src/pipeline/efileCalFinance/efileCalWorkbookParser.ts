import { read as readXlsxWorkbook, utils as xlsxUtils, type WorkBook } from "xlsx";

/**
 * Parser for efile.systems campaign bulk-export workbooks (CAL 2.20 data in
 * XLSX form), as served by California local agencies on that vendor — San José
 * (`efile.sanjoseca.gov`) and San Diego (`efile.sandiego.gov`) verified
 * 2026-08-10 with identical 15-sheet layouts.
 *
 * Ground truth from the live San José 2025 + 2026 exports:
 * - Every cell is a text string (amounts like "6385.00", dates like
 *   "20260516"), except Memo_Code / Ctrib_Self which are boolean cells.
 * - `F460-Summary` rows key on (Form_Type, Line_Item) — Form_Type domain seen:
 *   F460, A, B1, C, D, E, F, H, I. A bare line number is ambiguous.
 * - `Filer_ID` is not always numeric — the literal string "Pending" appears.
 * - `Elect_Date` is dirty upstream (period dates, blanks) — parsed leniently.
 * - Filed arithmetic can be internally wrong; this parser stays faithful to
 *   the cells and leaves invariant checks to aggregation.
 *
 * Privacy: contributor/lender street addresses (`*_Adr1/2`, city/state/zip)
 * are deliberately never surfaced on parsed rows.
 */

export const EFILE_CAL_SUMMARY_SHEET = "F460-Summary";
export const EFILE_CAL_SCHEDULE_A_SHEET = "F460-A-Contribs";
export const EFILE_CAL_SCHEDULE_C_SHEET = "F460-C-Contribs";
export const EFILE_CAL_SCHEDULE_B1_SHEET = "F460-B1-Loans";
export const EFILE_CAL_SCHEDULE_D_SHEET = "F460-D-ContribIndepExpn";
export const EFILE_CAL_S496_SHEET = "S496";
export const EFILE_CAL_S497_SHEET = "S497";

export const EFILE_CAL_REQUIRED_SHEETS = [
  EFILE_CAL_SUMMARY_SHEET,
  EFILE_CAL_SCHEDULE_A_SHEET,
  EFILE_CAL_SCHEDULE_C_SHEET,
  EFILE_CAL_SCHEDULE_B1_SHEET,
  EFILE_CAL_SCHEDULE_D_SHEET,
  EFILE_CAL_S496_SHEET,
  EFILE_CAL_S497_SHEET,
] as const;

/** Fields present on every row of every sheet (filing identity + period). */
export type EfileCalFilingRowBase = {
  /** FPPC committee ID as text — may be the literal "Pending"; never assume numeric. */
  filerId: string;
  filerName: string;
  /** "000" original, "001"+ amendments. */
  reportNum: string;
  eFilingId: string;
  origEFilingId: string;
  /** CAL committee-type code (observed: C, P, G); null on some S496 rows. Verbatim — gate downstream. */
  cmtteType: string | null;
  /** ISO dates (YYYY-MM-DD) or null. */
  rptDate: string | null;
  fromDate: string | null;
  thruDate: string | null;
  /** Dirty upstream (period dates observed) — soft signal only; unparseable values become null. */
  electDate: string | null;
  formType: string;
};

export type EfileCalSummaryRow = EfileCalFilingRowBase & {
  /** Key rows on (formType, lineItem) — never on lineItem alone. */
  lineItem: string;
  amountACents: number | null;
  amountBCents: number | null;
  amountCCents: number | null;
};

/** Schedule A (monetary) and Schedule C (nonmonetary) share one shape. */
export type EfileCalContributionRow = EfileCalFilingRowBase & {
  tranId: string;
  entityCd: string | null;
  contributorLastName: string | null;
  contributorFirstName: string | null;
  /** Reported giving committee ID, when the source supplies Cmte_ID. */
  contributorCommitteeId?: string | null;
  contributorOccupation: string | null;
  contributorEmployer: string | null;
  contributorSelfEmployed: boolean;
  amountCents: number;
  cumulativeYtdCents: number | null;
  receiptDate: string | null;
  memo: boolean;
};

export type EfileCalLoanRow = EfileCalFilingRowBase & {
  tranId: string;
  entityCd: string | null;
  lenderLastName: string | null;
  lenderFirstName: string | null;
  lenderOccupation: string | null;
  lenderEmployer: string | null;
  /**
   * Loan_Amt1..8 verbatim as cents; the (column → schedule-B1 box) mapping is
   * pinned where loans are aggregated, not here.
   */
  loanAmt1Cents: number | null;
  loanAmt2Cents: number | null;
  loanAmt3Cents: number | null;
  loanAmt4Cents: number | null;
  loanAmt5Cents: number | null;
  loanAmt6Cents: number | null;
  loanAmt7Cents: number | null;
  loanAmt8Cents: number | null;
  memo: boolean;
};

export type EfileCalScheduleDRow = EfileCalFilingRowBase & {
  tranId: string;
  entityCd: string | null;
  payeeLastName: string | null;
  /** IND = independent expenditure; MON/IKD are contributions to committees, not IEs. Verbatim. */
  expnCode: string | null;
  expnDate: string | null;
  amountCents: number;
  candidateLastName: string | null;
  candidateFirstName: string | null;
  officeCd: string | null;
  officeDscr: string | null;
  jurisCd: string | null;
  jurisDscr: string | null;
  distNo: string | null;
  /** Observed domain: SUPPORT / OPPOSE (this vendor writes full words, not CAL's S/O). Verbatim. */
  suppOppCd: string | null;
  memo: boolean;
};

export type EfileCalS496Row = EfileCalFilingRowBase & {
  tranId: string;
  amountCents: number;
  expDate: string | null;
  candidateLastName: string | null;
  candidateFirstName: string | null;
  officeCd: string | null;
  officeDscr: string | null;
  jurisCd: string | null;
  jurisDscr: string | null;
  distNo: string | null;
  suppOppCd: string | null;
  memo: boolean;
};

export type EfileCalS497Row = EfileCalFilingRowBase & {
  tranId: string;
  entityCd: string | null;
  entityLastName: string | null;
  entityFirstName: string | null;
  amountCents: number;
  ctribDate: string | null;
  candidateLastName: string | null;
  candidateFirstName: string | null;
  officeCd: string | null;
  officeDscr: string | null;
  distNo: string | null;
  memo: boolean;
};

export type EfileCalWorkbook = {
  summary: EfileCalSummaryRow[];
  scheduleA: EfileCalContributionRow[];
  scheduleC: EfileCalContributionRow[];
  scheduleB1: EfileCalLoanRow[];
  scheduleD: EfileCalScheduleDRow[];
  s496: EfileCalS496Row[];
  s497: EfileCalS497Row[];
  /**
   * Rows skipped under `collectUnusableRows` (San Diego's live 2025 export
   * carries a Major Donor filing block with blank Form_Type). Absent in the
   * default throw mode. Callers that collect MUST surface these — a linked
   * committee's row landing here means its totals are incomplete.
   */
  unusableRows?: EfileCalUnusableRow[];
};

const XLSX_ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const;

export function isEfileCalWorkbookData(data: Uint8Array): boolean {
  return XLSX_ZIP_MAGIC.every((byte, index) => data[index] === byte);
}

type RawRow = Record<string, unknown>;

/**
 * A single row failed validation. Distinct from generic errors so collect
 * mode (below) can skip exactly these and never mask a real drift signal
 * (missing sheets/columns, unreadable workbook) — those still throw plain
 * Errors regardless of mode.
 */
export class EfileCalUnusableRowError extends Error {
  constructor(
    readonly sheet: string,
    readonly rowNumber: number,
    readonly reason: string
  ) {
    super(`efile CAL workbook sheet ${sheet} row ${rowNumber} is unusable: ${reason}`);
    this.name = "EfileCalUnusableRowError";
  }
}

/**
 * Identity of a skipped row, so callers can tie it back to a committee and
 * fail closed when a linked committee's data is incomplete. Fields are read
 * leniently from the raw cells (the row already failed validation).
 */
export type EfileCalUnusableRow = {
  sheet: string;
  rowNumber: number;
  reason: string;
  filerId: string | null;
  filerName: string | null;
  eFilingId: string | null;
};

class RowContext {
  constructor(
    private readonly sheet: string,
    private readonly rowNumber: number
  ) {}

  fail(reason: string): never {
    throw new EfileCalUnusableRowError(this.sheet, this.rowNumber, reason);
  }
}

function toText(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim().replace(/\s+/g, " ");
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

function requiredText(row: RawRow, key: string, ctx: RowContext): string {
  const value = toText(row[key]);
  if (value === null) ctx.fail(`missing ${key}`);
  return value;
}

/**
 * Exact decimal-text → integer cents. The export writes every amount as a
 * text cell ("6385.00"); numbers are rejected on purpose so a silent vendor
 * format change fails loud instead of accumulating float error.
 */
function toCents(value: unknown, key: string, ctx: RowContext): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    ctx.fail(`${key} is not a text amount cell: ${JSON.stringify(value)}`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match) ctx.fail(`${key} is not a money amount: ${JSON.stringify(value)}`);
  const [, sign, whole, frac] = match;
  const cents = Number(whole) * 100 + Number((frac ?? "").padEnd(2, "0") || "0");
  if (!Number.isSafeInteger(cents)) ctx.fail(`${key} is out of range: ${JSON.stringify(value)}`);
  return sign === "-" ? -cents : cents;
}

function requiredCents(row: RawRow, key: string, ctx: RowContext): number {
  const cents = toCents(row[key], key, ctx);
  if (cents === null) ctx.fail(`missing ${key}`);
  return cents;
}

/** YYYYMMDD text → ISO YYYY-MM-DD; blanks null; malformed non-blank throws unless lenient. */
function toIsoDate(value: unknown, key: string, ctx: RowContext, options?: { lenient?: boolean }): string | null {
  const text = toText(value);
  if (text === null) return null;
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (!match) {
    if (options?.lenient) return null;
    ctx.fail(`${key} is not a YYYYMMDD date: ${JSON.stringify(value)}`);
  }
  const [, year, month, day] = match;
  const yearNum = Number(year);
  const monthNum = Number(month);
  const dayNum = Number(day);
  const roundTrip = new Date(Date.UTC(yearNum, monthNum - 1, dayNum));
  const isRealDate =
    roundTrip.getUTCFullYear() === yearNum &&
    roundTrip.getUTCMonth() === monthNum - 1 &&
    roundTrip.getUTCDate() === dayNum;
  if (!isRealDate) {
    if (options?.lenient) return null;
    ctx.fail(`${key} is not a calendar date: ${JSON.stringify(value)}`);
  }
  return `${year}-${month}-${day}`;
}

/** Memo cells are boolean in this export; CAL text convention ("X" / blank) also accepted. */
function toFlag(value: unknown, key: string, ctx: RowContext): boolean {
  if (typeof value === "boolean") return value;
  if (value === null || value === undefined) return false;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return false;
    if (trimmed.toUpperCase() === "X") return true;
  }
  ctx.fail(`${key} is not a flag cell: ${JSON.stringify(value)}`);
}

function parseBase(row: RawRow, ctx: RowContext): EfileCalFilingRowBase {
  // San José writes the literal "Pending" for committees without an FPPC id;
  // San Diego's tenant leaves the cell blank for the same state (the same
  // committee carries its real id on later rows). Both normalize to
  // "Pending" so the downstream no-durable-identity machinery applies.
  // Only genuine blanks qualify: a non-string cell (vendor drift to numeric
  // Filer_ID cells) must fail loud, not silently erase committee identity.
  const filerIdRaw = row["Filer_ID"];
  if (filerIdRaw !== null && filerIdRaw !== undefined && typeof filerIdRaw !== "string") {
    ctx.fail(`Filer_ID is not a text cell: ${JSON.stringify(filerIdRaw)}`);
  }
  return {
    filerId: toText(filerIdRaw) ?? "Pending",
    filerName: requiredText(row, "Filer_NamL", ctx),
    reportNum: requiredText(row, "Report_Num", ctx),
    eFilingId: requiredText(row, "e_filing_id", ctx),
    origEFilingId: requiredText(row, "orig_e_filing_id", ctx),
    cmtteType: toText(row["Cmtte_Type"]),
    rptDate: toIsoDate(row["Rpt_Date"], "Rpt_Date", ctx),
    fromDate: toIsoDate(row["From_Date"], "From_Date", ctx),
    thruDate: toIsoDate(row["Thru_Date"], "Thru_Date", ctx),
    electDate: toIsoDate(row["Elect_Date"], "Elect_Date", ctx, { lenient: true }),
    formType: requiredText(row, "Form_Type", ctx),
  };
}

const BASE_COLUMNS = [
  "Filer_ID",
  "Filer_NamL",
  "Report_Num",
  "e_filing_id",
  "orig_e_filing_id",
  "Cmtte_Type",
  "Rpt_Date",
  "From_Date",
  "Thru_Date",
  "Elect_Date",
  "Form_Type",
] as const;

export const EFILE_CAL_REQUIRED_COLUMNS_BY_SHEET: Readonly<Record<string, readonly string[]>> = {
  [EFILE_CAL_SUMMARY_SHEET]: [...BASE_COLUMNS, "Line_Item", "Amount_A", "Amount_B", "Amount_C"],
  [EFILE_CAL_SCHEDULE_A_SHEET]: [...BASE_COLUMNS, "Tran_ID", "Entity_Cd", "Ctrib_NamL", "Ctrib_NamF", "Ctrib_Occ", "Ctrib_Emp", "Ctrib_Self", "Amount", "Cum_YTD", "Rcpt_Date", "Memo_Code"],
  [EFILE_CAL_SCHEDULE_C_SHEET]: [...BASE_COLUMNS, "Tran_ID", "Entity_Cd", "Ctrib_NamL", "Ctrib_NamF", "Ctrib_Occ", "Ctrib_Emp", "Ctrib_Self", "Amount", "Cum_YTD", "Rcpt_Date", "Memo_Code"],
  [EFILE_CAL_SCHEDULE_B1_SHEET]: [...BASE_COLUMNS, "Tran_ID", "Entity_Cd", "Lndr_NamL", "Lndr_NamF", "Loan_OCC", "Loan_EMP", "Loan_Amt1", "Loan_Amt2", "Loan_Amt3", "Loan_Amt4", "Loan_Amt5", "Loan_Amt6", "Loan_Amt7", "Loan_Amt8", "Memo_Code"],
  [EFILE_CAL_SCHEDULE_D_SHEET]: [...BASE_COLUMNS, "Tran_ID", "Entity_Cd", "Payee_NamL", "Expn_Code", "Expn_Date", "Amount", "Cand_NamL", "Cand_NamF", "Office_Cd", "Office_Dscr", "Juris_Cd", "Juris_Dscr", "Dist_No", "Supp_Opp_Cd", "Memo_Code"],
  [EFILE_CAL_S496_SHEET]: [...BASE_COLUMNS, "Tran_ID", "Amount", "Exp_Date", "Cand_NamL", "Cand_NamF", "Office_Cd", "Office_Dscr", "Juris_Cd", "Juris_Dscr", "Dist_No", "Supp_Opp_Cd", "Memo_Code"],
  [EFILE_CAL_S497_SHEET]: [...BASE_COLUMNS, "Tran_ID", "Entity_Cd", "Enty_NamL", "Enty_NamF", "Amount", "Ctrib_Date", "Cand_NamL", "Cand_NamF", "Office_Cd", "Office_Dscr", "Dist_No", "Memo_Code"],
};

function sheetRows(workbookSheets: WorkBook["Sheets"], sheetName: string): { row: RawRow; ctx: RowContext }[] {
  const sheet = workbookSheets[sheetName]!;
  // Validate the header row directly so header-only (and blank) sheets still
  // fail closed when required columns are absent.
  const headerRow =
    xlsxUtils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, blankrows: false })[0] ?? [];
  const headers = new Set(headerRow.filter((cell): cell is string => typeof cell === "string"));
  const missing = (EFILE_CAL_REQUIRED_COLUMNS_BY_SHEET[sheetName] ?? []).filter((column) => !headers.has(column));
  if (missing.length > 0) {
    throw new Error(`efile CAL workbook sheet ${sheetName} is missing required columns: ${missing.join(", ")}`);
  }
  const rows = xlsxUtils.sheet_to_json<RawRow>(sheet, { raw: true, defval: null });
  // Header row is row 1, first data row is row 2.
  return rows.map((row, index) => ({ row, ctx: new RowContext(sheetName, index + 2) }));
}

function parseContributionRow({ row, ctx }: { row: RawRow; ctx: RowContext }): EfileCalContributionRow {
  return {
    ...parseBase(row, ctx),
    tranId: requiredText(row, "Tran_ID", ctx),
    entityCd: toText(row["Entity_Cd"]),
    contributorLastName: toText(row["Ctrib_NamL"]),
    contributorFirstName: toText(row["Ctrib_NamF"]),
    contributorCommitteeId: toText(row["Cmte_ID"]),
    contributorOccupation: toText(row["Ctrib_Occ"]),
    contributorEmployer: toText(row["Ctrib_Emp"]),
    contributorSelfEmployed: toFlag(row["Ctrib_Self"], "Ctrib_Self", ctx),
    amountCents: requiredCents(row, "Amount", ctx),
    cumulativeYtdCents: toCents(row["Cum_YTD"], "Cum_YTD", ctx),
    receiptDate: toIsoDate(row["Rcpt_Date"], "Rcpt_Date", ctx),
    memo: toFlag(row["Memo_Code"], "Memo_Code", ctx),
  };
}

export function parseEfileCalWorkbook(
  data: Uint8Array,
  options: { collectUnusableRows?: boolean } = {}
): EfileCalWorkbook {
  if (!isEfileCalWorkbookData(data)) {
    throw new Error("efile CAL bulk export is not an XLSX workbook; refusing to parse");
  }
  const unusableRows: EfileCalUnusableRow[] | null = options.collectUnusableRows ? [] : null;
  // Row-scoped validation failures either throw (default — the San José
  // posture) or are skipped and recorded (collect mode); anything that is not
  // an EfileCalUnusableRowError always propagates.
  const mapRows = <T>(entries: { row: RawRow; ctx: RowContext }[], parse: (entry: { row: RawRow; ctx: RowContext }) => T): T[] => {
    if (unusableRows === null) return entries.map(parse);
    const parsed: T[] = [];
    for (const entry of entries) {
      try {
        parsed.push(parse(entry));
      } catch (error) {
        if (error instanceof EfileCalUnusableRowError) {
          unusableRows.push({
            sheet: error.sheet,
            rowNumber: error.rowNumber,
            reason: error.reason,
            filerId: toText(entry.row["Filer_ID"]),
            filerName: toText(entry.row["Filer_NamL"]),
            eFilingId: toText(entry.row["e_filing_id"]),
          });
          continue;
        }
        throw error;
      }
    }
    return parsed;
  };

  let sheets: WorkBook["Sheets"];
  let sheetNames: string[];
  try {
    const workbook = readXlsxWorkbook(data, { type: "buffer" });
    sheets = workbook.Sheets;
    sheetNames = workbook.SheetNames;
  } catch (error) {
    throw new Error(
      `efile CAL bulk export workbook could not be read: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const present = new Set(sheetNames);
  const missingSheets = EFILE_CAL_REQUIRED_SHEETS.filter((name) => !present.has(name));
  if (missingSheets.length > 0) {
    throw new Error(`efile CAL bulk export workbook is missing required sheets: ${missingSheets.join(", ")}`);
  }

  const summary = mapRows(sheetRows(sheets, EFILE_CAL_SUMMARY_SHEET), ({ row, ctx }): EfileCalSummaryRow => {
    return {
      ...parseBase(row, ctx),
      lineItem: requiredText(row, "Line_Item", ctx),
      amountACents: toCents(row["Amount_A"], "Amount_A", ctx),
      amountBCents: toCents(row["Amount_B"], "Amount_B", ctx),
      amountCCents: toCents(row["Amount_C"], "Amount_C", ctx),
    };
  });

  const scheduleA = mapRows(sheetRows(sheets, EFILE_CAL_SCHEDULE_A_SHEET), parseContributionRow);
  const scheduleC = mapRows(sheetRows(sheets, EFILE_CAL_SCHEDULE_C_SHEET), parseContributionRow);

  const scheduleB1 = mapRows(sheetRows(sheets, EFILE_CAL_SCHEDULE_B1_SHEET), ({ row, ctx }): EfileCalLoanRow => {
    return {
      ...parseBase(row, ctx),
      tranId: requiredText(row, "Tran_ID", ctx),
      entityCd: toText(row["Entity_Cd"]),
      lenderLastName: toText(row["Lndr_NamL"]),
      lenderFirstName: toText(row["Lndr_NamF"]),
      lenderOccupation: toText(row["Loan_OCC"]),
      lenderEmployer: toText(row["Loan_EMP"]),
      loanAmt1Cents: toCents(row["Loan_Amt1"], "Loan_Amt1", ctx),
      loanAmt2Cents: toCents(row["Loan_Amt2"], "Loan_Amt2", ctx),
      loanAmt3Cents: toCents(row["Loan_Amt3"], "Loan_Amt3", ctx),
      loanAmt4Cents: toCents(row["Loan_Amt4"], "Loan_Amt4", ctx),
      loanAmt5Cents: toCents(row["Loan_Amt5"], "Loan_Amt5", ctx),
      loanAmt6Cents: toCents(row["Loan_Amt6"], "Loan_Amt6", ctx),
      loanAmt7Cents: toCents(row["Loan_Amt7"], "Loan_Amt7", ctx),
      loanAmt8Cents: toCents(row["Loan_Amt8"], "Loan_Amt8", ctx),
      memo: toFlag(row["Memo_Code"], "Memo_Code", ctx),
    };
  });

  const scheduleD = mapRows(sheetRows(sheets, EFILE_CAL_SCHEDULE_D_SHEET), ({ row, ctx }): EfileCalScheduleDRow => {
    return {
      ...parseBase(row, ctx),
      tranId: requiredText(row, "Tran_ID", ctx),
      entityCd: toText(row["Entity_Cd"]),
      payeeLastName: toText(row["Payee_NamL"]),
      expnCode: toText(row["Expn_Code"]),
      expnDate: toIsoDate(row["Expn_Date"], "Expn_Date", ctx),
      amountCents: requiredCents(row, "Amount", ctx),
      candidateLastName: toText(row["Cand_NamL"]),
      candidateFirstName: toText(row["Cand_NamF"]),
      officeCd: toText(row["Office_Cd"]),
      officeDscr: toText(row["Office_Dscr"]),
      jurisCd: toText(row["Juris_Cd"]),
      jurisDscr: toText(row["Juris_Dscr"]),
      distNo: toText(row["Dist_No"]),
      suppOppCd: toText(row["Supp_Opp_Cd"]),
      memo: toFlag(row["Memo_Code"], "Memo_Code", ctx),
    };
  });

  const s496 = mapRows(sheetRows(sheets, EFILE_CAL_S496_SHEET), ({ row, ctx }): EfileCalS496Row => {
    return {
      ...parseBase(row, ctx),
      tranId: requiredText(row, "Tran_ID", ctx),
      amountCents: requiredCents(row, "Amount", ctx),
      expDate: toIsoDate(row["Exp_Date"], "Exp_Date", ctx),
      candidateLastName: toText(row["Cand_NamL"]),
      candidateFirstName: toText(row["Cand_NamF"]),
      officeCd: toText(row["Office_Cd"]),
      officeDscr: toText(row["Office_Dscr"]),
      jurisCd: toText(row["Juris_Cd"]),
      jurisDscr: toText(row["Juris_Dscr"]),
      distNo: toText(row["Dist_No"]),
      suppOppCd: toText(row["Supp_Opp_Cd"]),
      memo: toFlag(row["Memo_Code"], "Memo_Code", ctx),
    };
  });

  const s497 = mapRows(sheetRows(sheets, EFILE_CAL_S497_SHEET), ({ row, ctx }): EfileCalS497Row => {
    return {
      ...parseBase(row, ctx),
      tranId: requiredText(row, "Tran_ID", ctx),
      entityCd: toText(row["Entity_Cd"]),
      entityLastName: toText(row["Enty_NamL"]),
      entityFirstName: toText(row["Enty_NamF"]),
      amountCents: requiredCents(row, "Amount", ctx),
      ctribDate: toIsoDate(row["Ctrib_Date"], "Ctrib_Date", ctx),
      candidateLastName: toText(row["Cand_NamL"]),
      candidateFirstName: toText(row["Cand_NamF"]),
      officeCd: toText(row["Office_Cd"]),
      officeDscr: toText(row["Office_Dscr"]),
      distNo: toText(row["Dist_No"]),
      memo: toFlag(row["Memo_Code"], "Memo_Code", ctx),
    };
  });

  return {
    summary,
    scheduleA,
    scheduleC,
    scheduleB1,
    scheduleD,
    s496,
    s497,
    ...(unusableRows !== null ? { unusableRows } : {}),
  };
}
