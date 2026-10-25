import { describe, expect, it } from "vitest";

import {
  EFILE_CAL_REQUIRED_COLUMNS_BY_SHEET,
  EFILE_CAL_SCHEDULE_A_SHEET,
  EFILE_CAL_SCHEDULE_B1_SHEET,
  EFILE_CAL_SCHEDULE_C_SHEET,
  EFILE_CAL_SCHEDULE_D_SHEET,
  EFILE_CAL_S496_SHEET,
  EFILE_CAL_S497_SHEET,
  EFILE_CAL_SUMMARY_SHEET,
  isEfileCalWorkbookData,
  parseEfileCalWorkbook,
} from "../../../src/pipeline/efileCalFinance/efileCalWorkbookParser.js";
import { buildEfileCalExportWorkbook, EFILE_CAL_FIXTURE_BASE } from "./efileCalExportFixture.js";

describe("efileCalWorkbookParser", () => {
  it("parses every consumed sheet into typed rows with exact cents and ISO dates", () => {
    const workbook = buildEfileCalExportWorkbook({
      rowsBySheet: {
        [EFILE_CAL_SUMMARY_SHEET]: [
          { ...EFILE_CAL_FIXTURE_BASE, Form_Type: "F460", Line_Item: "1", Amount_A: "6385.00", Amount_B: "6385.00" },
          // (Form_Type, Line_Item) is the key: A line 2 and C line 2 are
          // different quantities than F460 line 2 (net loans).
          { ...EFILE_CAL_FIXTURE_BASE, Form_Type: "A", Line_Item: "2", Amount_A: "99.50", Amount_B: "99.50" },
          { ...EFILE_CAL_FIXTURE_BASE, Form_Type: "C", Line_Item: "2", Amount_A: "0.00", Amount_B: "0.00" },
        ],
        [EFILE_CAL_SCHEDULE_A_SHEET]: [
          {
            ...EFILE_CAL_FIXTURE_BASE,
            Form_Type: "A",
            Tran_ID: "INC133",
            Entity_Cd: "IND",
            Ctrib_NamL: "Doe",
            Ctrib_NamF: "Jane",
            Ctrib_Occ: "Engineer",
            Ctrib_Emp: "Acme Corp",
            Ctrib_Self: false,
            Amount: "500.00",
            Cum_YTD: "750.00",
            Rcpt_Date: "20260214",
            Memo_Code: false,
          },
        ],
        [EFILE_CAL_SCHEDULE_B1_SHEET]: [
          {
            ...EFILE_CAL_FIXTURE_BASE,
            Form_Type: "B1",
            Tran_ID: "LN01",
            Entity_Cd: "IND",
            Lndr_NamL: "Doan",
            Lndr_NamF: "Bien",
            Loan_OCC: "Retired",
            Loan_EMP: null,
            Loan_Amt1: "0.00",
            Loan_Amt2: "20000.00",
            Loan_Amt3: "20000.00",
            Loan_Amt4: null,
            Memo_Code: false,
          },
        ],
        [EFILE_CAL_SCHEDULE_D_SHEET]: [
          {
            ...EFILE_CAL_FIXTURE_BASE,
            Form_Type: "D",
            Cmtte_Type: "G",
            Tran_ID: "PDT156",
            Entity_Cd: "OTH",
            Payee_NamL: "Print Shop",
            Expn_Code: "IND",
            Expn_Date: "20260512",
            Amount: "15000.00",
            Cand_NamL: "Ortiz",
            Cand_NamF: "Peter",
            Office_Cd: "CCM",
            Office_Dscr: "City Council",
            Juris_Cd: "CIT",
            Juris_Dscr: "San Jose",
            Dist_No: "5",
            Supp_Opp_Cd: "SUPPORT",
            Memo_Code: false,
          },
        ],
        [EFILE_CAL_S496_SHEET]: [
          {
            ...EFILE_CAL_FIXTURE_BASE,
            Form_Type: "F496",
            Cmtte_Type: null,
            From_Date: null,
            Thru_Date: null,
            Elect_Date: null,
            Tran_ID: "PDT222",
            Amount: "9535.67",
            Exp_Date: "20260522",
            Cand_NamL: "Ortiz",
            Cand_NamF: "Peter",
            Office_Cd: "CCM",
            Office_Dscr: "City Council",
            Juris_Cd: "CIT",
            Juris_Dscr: "San Jose",
            Dist_No: "5",
            Supp_Opp_Cd: "OPPOSE",
            Memo_Code: false,
          },
        ],
        [EFILE_CAL_S497_SHEET]: [
          {
            ...EFILE_CAL_FIXTURE_BASE,
            Form_Type: "F497P1",
            Tran_ID: "LATE1",
            Entity_Cd: "IND",
            Enty_NamL: "Smith",
            Enty_NamF: "Ann",
            Amount: "2000.00",
            Ctrib_Date: "20261030",
            Cand_NamL: null,
            Cand_NamF: null,
            Office_Cd: null,
            Office_Dscr: null,
            Dist_No: null,
            Memo_Code: false,
          },
        ],
      },
    });

    expect(isEfileCalWorkbookData(workbook)).toBe(true);
    const parsed = parseEfileCalWorkbook(workbook);

    expect(parsed.summary).toHaveLength(3);
    expect(parsed.summary[0]).toMatchObject({
      filerId: "1480385",
      reportNum: "000",
      cmtteType: "C",
      formType: "F460",
      lineItem: "1",
      amountACents: 638500,
      amountBCents: 638500,
      amountCCents: null,
      rptDate: "2026-05-16",
      fromDate: "2026-01-01",
      thruDate: "2026-04-18",
      electDate: "2026-11-03",
    });
    expect(parsed.summary.map((row) => [row.formType, row.lineItem])).toEqual([
      ["F460", "1"],
      ["A", "2"],
      ["C", "2"],
    ]);
    expect(parsed.summary[1]!.amountACents).toBe(9950);

    expect(parsed.scheduleA).toHaveLength(1);
    expect(parsed.scheduleA[0]).toMatchObject({
      tranId: "INC133",
      entityCd: "IND",
      contributorLastName: "Doe",
      contributorFirstName: "Jane",
      contributorOccupation: "Engineer",
      contributorEmployer: "Acme Corp",
      contributorSelfEmployed: false,
      amountCents: 50000,
      cumulativeYtdCents: 75000,
      receiptDate: "2026-02-14",
      memo: false,
    });
    // Privacy: contributor street addresses must never surface on parsed rows.
    expect(Object.keys(parsed.scheduleA[0]!).join(" ")).not.toMatch(/Adr|address/i);

    expect(parsed.scheduleC).toEqual([]);

    expect(parsed.scheduleB1[0]).toMatchObject({
      tranId: "LN01",
      lenderLastName: "Doan",
      lenderFirstName: "Bien",
      lenderOccupation: "Retired",
      lenderEmployer: null,
      loanAmt1Cents: 0,
      loanAmt2Cents: 2000000,
      loanAmt3Cents: 2000000,
      loanAmt4Cents: null,
    });

    expect(parsed.scheduleD[0]).toMatchObject({
      cmtteType: "G",
      expnCode: "IND",
      amountCents: 1500000,
      expnDate: "2026-05-12",
      candidateLastName: "Ortiz",
      distNo: "5",
      suppOppCd: "SUPPORT",
    });

    expect(parsed.s496[0]).toMatchObject({
      cmtteType: null,
      fromDate: null,
      thruDate: null,
      electDate: null,
      amountCents: 953567,
      expDate: "2026-05-22",
      suppOppCd: "OPPOSE",
    });

    expect(parsed.s497[0]).toMatchObject({
      formType: "F497P1",
      entityLastName: "Smith",
      amountCents: 200000,
      ctribDate: "2026-10-30",
      candidateLastName: null,
    });
  });

  it("keeps Filer_ID as text so the literal 'Pending' survives", () => {
    const workbook = buildEfileCalExportWorkbook({
      rowsBySheet: {
        [EFILE_CAL_SUMMARY_SHEET]: [
          { ...EFILE_CAL_FIXTURE_BASE, Filer_ID: "Pending", Form_Type: "F460", Line_Item: "1", Amount_A: "1.00", Amount_B: "1.00" },
        ],
      },
    });
    expect(parseEfileCalWorkbook(workbook).summary[0]!.filerId).toBe("Pending");
  });

  it("parses money exactly, including negatives and one-decimal cells, and rejects non-text amounts", () => {
    const summaryRow = (amount: string | number) => ({
      rowsBySheet: {
        [EFILE_CAL_SUMMARY_SHEET]: [
          { ...EFILE_CAL_FIXTURE_BASE, Form_Type: "F460", Line_Item: "1", Amount_A: amount, Amount_B: "0.00" },
        ],
      },
    });

    expect(parseEfileCalWorkbook(buildEfileCalExportWorkbook(summaryRow("-12.34"))).summary[0]!.amountACents).toBe(-1234);
    expect(parseEfileCalWorkbook(buildEfileCalExportWorkbook(summaryRow("1234.5"))).summary[0]!.amountACents).toBe(123450);
    expect(parseEfileCalWorkbook(buildEfileCalExportWorkbook(summaryRow("7"))).summary[0]!.amountACents).toBe(700);
    expect(() => parseEfileCalWorkbook(buildEfileCalExportWorkbook(summaryRow(6385)))).toThrow(
      "Amount_A is not a text amount cell"
    );
    expect(() => parseEfileCalWorkbook(buildEfileCalExportWorkbook(summaryRow("1,234.00")))).toThrow(
      "Amount_A is not a money amount"
    );
  });

  it("is lenient about dirty Elect_Date but strict about period dates", () => {
    const workbook = buildEfileCalExportWorkbook({
      rowsBySheet: {
        [EFILE_CAL_SUMMARY_SHEET]: [
          { ...EFILE_CAL_FIXTURE_BASE, Elect_Date: "not-a-date", Form_Type: "F460", Line_Item: "1", Amount_A: "1.00", Amount_B: "1.00" },
        ],
      },
    });
    expect(parseEfileCalWorkbook(workbook).summary[0]!.electDate).toBeNull();

    const badThru = buildEfileCalExportWorkbook({
      rowsBySheet: {
        [EFILE_CAL_SUMMARY_SHEET]: [
          { ...EFILE_CAL_FIXTURE_BASE, Thru_Date: "20269999", Form_Type: "F460", Line_Item: "1", Amount_A: "1.00", Amount_B: "1.00" },
        ],
      },
    });
    expect(() => parseEfileCalWorkbook(badThru)).toThrow("Thru_Date is not a calendar date");

    // Well-formed but impossible dates (Feb 30) must also fail strict fields
    // and null out lenient ones.
    const impossibleThru = buildEfileCalExportWorkbook({
      rowsBySheet: {
        [EFILE_CAL_SUMMARY_SHEET]: [
          { ...EFILE_CAL_FIXTURE_BASE, Thru_Date: "20260230", Form_Type: "F460", Line_Item: "1", Amount_A: "1.00", Amount_B: "1.00" },
        ],
      },
    });
    expect(() => parseEfileCalWorkbook(impossibleThru)).toThrow("Thru_Date is not a calendar date");

    const impossibleElect = buildEfileCalExportWorkbook({
      rowsBySheet: {
        [EFILE_CAL_SUMMARY_SHEET]: [
          { ...EFILE_CAL_FIXTURE_BASE, Elect_Date: "20260230", Form_Type: "F460", Line_Item: "1", Amount_A: "1.00", Amount_B: "1.00" },
        ],
      },
    });
    expect(parseEfileCalWorkbook(impossibleElect).summary[0]!.electDate).toBeNull();

    // Leap-day sanity: Feb 29 valid in 2024, impossible in 2026.
    const leapOk = buildEfileCalExportWorkbook({
      rowsBySheet: {
        [EFILE_CAL_SUMMARY_SHEET]: [
          { ...EFILE_CAL_FIXTURE_BASE, Thru_Date: "20240229", Form_Type: "F460", Line_Item: "1", Amount_A: "1.00", Amount_B: "1.00" },
        ],
      },
    });
    expect(parseEfileCalWorkbook(leapOk).summary[0]!.thruDate).toBe("2024-02-29");

    const leapBad = buildEfileCalExportWorkbook({
      rowsBySheet: {
        [EFILE_CAL_SUMMARY_SHEET]: [
          { ...EFILE_CAL_FIXTURE_BASE, Thru_Date: "20260229", Form_Type: "F460", Line_Item: "1", Amount_A: "1.00", Amount_B: "1.00" },
        ],
      },
    });
    expect(() => parseEfileCalWorkbook(leapBad)).toThrow("Thru_Date is not a calendar date");
  });

  it("normalizes flag cells from booleans and CAL 'X' text, failing closed otherwise", () => {
    const scheduleARow = (memo: string | boolean) => ({
      rowsBySheet: {
        [EFILE_CAL_SCHEDULE_A_SHEET]: [
          {
            ...EFILE_CAL_FIXTURE_BASE,
            Form_Type: "A",
            Tran_ID: "T1",
            Ctrib_Self: false,
            Amount: "1.00",
            Memo_Code: memo,
          },
        ],
      },
    });

    expect(parseEfileCalWorkbook(buildEfileCalExportWorkbook(scheduleARow(true))).scheduleA[0]!.memo).toBe(true);
    expect(parseEfileCalWorkbook(buildEfileCalExportWorkbook(scheduleARow("X"))).scheduleA[0]!.memo).toBe(true);
    expect(parseEfileCalWorkbook(buildEfileCalExportWorkbook(scheduleARow(""))).scheduleA[0]!.memo).toBe(false);
    expect(() => parseEfileCalWorkbook(buildEfileCalExportWorkbook(scheduleARow("Y")))).toThrow(
      "Memo_Code is not a flag cell"
    );
  });

  it("fails closed on non-XLSX bytes, missing sheets, missing columns, and rows without identity", () => {
    const html = new TextEncoder().encode("<html>maintenance page</html>");
    expect(isEfileCalWorkbookData(html)).toBe(false);
    expect(() => parseEfileCalWorkbook(html)).toThrow("is not an XLSX workbook");

    const missingSheet = buildEfileCalExportWorkbook({ omitSheets: [EFILE_CAL_S496_SHEET] });
    expect(() => parseEfileCalWorkbook(missingSheet)).toThrow("missing required sheets: S496");

    const missingColumn = buildEfileCalExportWorkbook({
      headersBySheet: { [EFILE_CAL_SUMMARY_SHEET]: ["Filer_ID", "Form_Type", "Line_Item"] },
      rowsBySheet: {
        [EFILE_CAL_SUMMARY_SHEET]: [{ Filer_ID: "1", Form_Type: "F460", Line_Item: "1" }],
      },
    });
    expect(() => parseEfileCalWorkbook(missingColumn)).toThrow(/F460-Summary is missing required columns/);

    // Header validation must not depend on data rows being present.
    const headerOnlyMissingColumn = buildEfileCalExportWorkbook({
      headersBySheet: { [EFILE_CAL_SUMMARY_SHEET]: ["Filer_ID", "Form_Type", "Line_Item"] },
    });
    expect(() => parseEfileCalWorkbook(headerOnlyMissingColumn)).toThrow(
      /F460-Summary is missing required columns/
    );

    const missingTranId = buildEfileCalExportWorkbook({
      rowsBySheet: {
        [EFILE_CAL_SCHEDULE_A_SHEET]: [
          { ...EFILE_CAL_FIXTURE_BASE, Form_Type: "A", Tran_ID: " ", Ctrib_Self: false, Amount: "1.00", Memo_Code: false },
        ],
      },
    });
    expect(() => parseEfileCalWorkbook(missingTranId)).toThrow(
      "sheet F460-A-Contribs row 2 is unusable: missing Tran_ID"
    );
  });

  it("normalizes a blank Filer_ID to the literal 'Pending' (San Diego writes empty cells for the same state)", () => {
    const workbook = buildEfileCalExportWorkbook({
      rowsBySheet: {
        [EFILE_CAL_S496_SHEET]: [
          {
            ...EFILE_CAL_FIXTURE_BASE,
            Filer_ID: "",
            Form_Type: "F496",
            Tran_ID: "PDT1",
            Amount: "22165.00",
            Cand_NamL: "Richard Bailey",
            Supp_Opp_Cd: "OPPOSE",
            Memo_Code: false,
          },
        ],
      },
    });
    expect(parseEfileCalWorkbook(workbook).s496[0]!.filerId).toBe("Pending");

    // Only genuine blanks default: numeric cells are vendor drift, fail loud.
    const numericId = buildEfileCalExportWorkbook({
      rowsBySheet: {
        [EFILE_CAL_SUMMARY_SHEET]: [
          { ...EFILE_CAL_FIXTURE_BASE, Filer_ID: 1480385, Form_Type: "F460", Line_Item: "1", Amount_A: "1.00", Amount_B: "1.00" },
        ],
      },
    });
    expect(() => parseEfileCalWorkbook(numericId)).toThrow("Filer_ID is not a text cell");
  });

  it("collectUnusableRows skips row-scoped failures and records them; default mode still throws", () => {
    // San Diego's live exports carry Major Donor filing blocks with blank
    // Form_Type; one bad row must not poison the workbook in collect mode.
    const workbook = buildEfileCalExportWorkbook({
      rowsBySheet: {
        [EFILE_CAL_SUMMARY_SHEET]: [
          { ...EFILE_CAL_FIXTURE_BASE, Form_Type: "", Line_Item: "1", Amount_A: "136600.00" },
          { ...EFILE_CAL_FIXTURE_BASE, Form_Type: "F460", Line_Item: "1", Amount_A: "6385.00", Amount_B: "6385.00" },
        ],
      },
    });
    expect(() => parseEfileCalWorkbook(workbook)).toThrow(
      "sheet F460-Summary row 2 is unusable: missing Form_Type"
    );

    const parsed = parseEfileCalWorkbook(workbook, { collectUnusableRows: true });
    expect(parsed.summary).toHaveLength(1);
    expect(parsed.summary[0]!.amountACents).toBe(638500);
    // Identity fields let callers tie the skip back to a committee and fail
    // closed when a linked committee's data is incomplete.
    expect(parsed.unusableRows).toEqual([
      {
        sheet: EFILE_CAL_SUMMARY_SHEET,
        rowNumber: 2,
        reason: "missing Form_Type",
        filerId: "1480385",
        filerName: "Test Committee for City Council 2026",
        eFilingId: "24690",
      },
    ]);

    // Structural drift (missing sheets/columns) is never collectable.
    const missingColumn = buildEfileCalExportWorkbook({
      headersBySheet: { [EFILE_CAL_SUMMARY_SHEET]: ["Filer_ID", "Form_Type", "Line_Item"] },
    });
    expect(() => parseEfileCalWorkbook(missingColumn, { collectUnusableRows: true })).toThrow(
      /F460-Summary is missing required columns/
    );
  });

  it("parses a workbook whose sheets are header-only to empty row sets", () => {
    const parsed = parseEfileCalWorkbook(buildEfileCalExportWorkbook());
    expect(parsed).toEqual({
      summary: [],
      scheduleA: [],
      scheduleC: [],
      scheduleB1: [],
      scheduleD: [],
      s496: [],
      s497: [],
    });
  });
});

it("retains optional native giving committee ID without making it a required column",()=>{const book=buildEfileCalExportWorkbook({headersBySheet:{[EFILE_CAL_SCHEDULE_A_SHEET]:[...EFILE_CAL_REQUIRED_COLUMNS_BY_SHEET[EFILE_CAL_SCHEDULE_A_SHEET]!,"Cmte_ID"]},rowsBySheet:{[EFILE_CAL_SCHEDULE_A_SHEET]:[{...EFILE_CAL_FIXTURE_BASE,Form_Type:"A",Tran_ID:"A1",Entity_Cd:"PTY",Ctrib_NamL:"Example Party",Cmte_ID:"2222222",Ctrib_Self:false,Amount:"100.01",Memo_Code:false}]}});expect(parseEfileCalWorkbook(book).scheduleA[0]).toMatchObject({entityCd:"PTY",contributorCommitteeId:"2222222",amountCents:10001});});
