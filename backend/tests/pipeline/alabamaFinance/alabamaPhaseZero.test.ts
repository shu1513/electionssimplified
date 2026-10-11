import { describe, expect, it } from "vitest";

import {
  parseAlabamaAmountCents,
  parseAlabamaCashExtract,
  parseAlabamaExpenditureExtract,
} from "../../../src/pipeline/alabamaFinance/alabamaFcpaCsv.js";
import {
  alabamaCoverCashCents,
  alabamaCoverExpenditureCents,
  alabamaCoverInKindCents,
  parseAlabamaDollarsCents,
  parseAlabamaFilingDetailCover,
  parseAlabamaWallClockMs,
  reconcileAlabamaCommittee,
  summarizeAlabamaCashRows,
  summarizeAlabamaExpenditureRows,
} from "../../../src/pipeline/alabamaFinance/alabamaPhaseZero.js";
import type { AlabamaRaceRow } from "../../../src/pipeline/alabamaFinance/alabamaFcpaClient.js";

const CASH_HEADER =
  "CommitteeId,ContributionAmount,ContributionDate,LastName,FirstName,MI,Suffix,Address1,City,State,Zip," +
  "ContributionID,FiledDate,ContributionType,ContributorType,CommitteeType,CommitteeName,CandidateName,Amended";

function cashLine(overrides: Partial<Record<"committeeId" | "amount" | "id" | "type" | "contributor" | "amended", string>> = {}): string {
  return [
    overrides.committeeId ?? "32837",
    overrides.amount ?? "500.00",
    "01/05/2026",
    "Doe",
    "Jane",
    "",
    " ",
    "1 Main St",
    "Selma",
    "AL",
    "36701",
    overrides.id ?? "1386065",
    "01/06/2026",
    overrides.type ?? "Cash (Itemized)",
    overrides.contributor ?? "Individual",
    "Principal Campaign Committee",
    "",
    "DOUG JONES",
    overrides.amended ?? "N",
  ].join(",");
}

describe("parseAlabamaAmountCents", () => {
  it("parses plain and negative decimal amounts to signed cents", () => {
    expect(parseAlabamaAmountCents("326.40")).toBe(32640);
    expect(parseAlabamaAmountCents("15000")).toBe(1500000);
    expect(parseAlabamaAmountCents("-500.00")).toBe(-50000);
    expect(parseAlabamaAmountCents("0.5")).toBe(50);
  });

  it("rejects non-amounts", () => {
    expect(parseAlabamaAmountCents("36701")).toBe(3670100);
    expect(parseAlabamaAmountCents("$500.00")).toBeNull();
    expect(parseAlabamaAmountCents("1,000.00")).toBeNull();
    expect(parseAlabamaAmountCents("Selma")).toBeNull();
    expect(parseAlabamaAmountCents("")).toBeNull();
  });
});

describe("parseAlabamaCashExtract", () => {
  it("retains complete donor name and address fields for native source identity checks", () => {
    const fields = cashLine().split(",");
    fields[5] = "Leon";
    fields[6] = "III";
    const parsed = parseAlabamaCashExtract(`${CASH_HEADER}\n${fields.join(",")}\n`);
    expect(parsed.rows[0]).toMatchObject({
      middleName: "Leon", suffix: "III", address1: "1 Main St",
      city: fields[8], state: fields[9], zip: fields[10],
    });
  });

  it("quarantines unsafe monetary cents instead of silently losing precision", () => {
    const parsed = parseAlabamaCashExtract(`${CASH_HEADER}\n${cashLine({ amount: "90071992547410.00" })}`);
    expect(parsed.rows).toEqual([]);
    expect(parsed.quarantined).toEqual([{ recordNumber: 1, fieldCount: 19, reason: "bad_amount" }]);
  });

  it("parses clean rows including quoted fields with commas and newlines", () => {
    const quoted = cashLine().replace("1 Main St", '"1 Main St, Apt 2\nRear"');
    const csv = `﻿${CASH_HEADER}\n${cashLine()}\r\n${quoted}\n`;
    const result = parseAlabamaCashExtract(csv);
    expect(result.recordCount).toBe(2);
    expect(result.quarantined).toEqual([]);
    expect(result.rows[0]).toMatchObject({
      committeeId: "32837",
      amountCents: 50000,
      contributionId: "1386065",
      contributionType: "Cash (Itemized)",
      amended: "N",
    });
  });

  it("treats a stray mid-field quote as a literal character", () => {
    const csv = `${CASH_HEADER}\n${cashLine().replace("Doe", 'O"Doe')}\n`;
    const result = parseAlabamaCashExtract(csv);
    expect(result.quarantined).toEqual([]);
    expect(result.rows[0]!.lastName).toBe('O"Doe');
  });

  it("quarantines short rows, bad ids, and bad amounts without aborting", () => {
    const csv = [
      CASH_HEADER,
      cashLine(),
      "31702,534.10,05/15/2026,Broken", // field_count
      cashLine({ id: "not-a-number" }),
      cashLine({ amount: "12.34.56" }),
    ].join("\n");
    const result = parseAlabamaCashExtract(csv);
    expect(result.rows).toHaveLength(1);
    expect(result.quarantined.map((record) => record.reason)).toEqual([
      "field_count",
      "bad_id",
      "bad_amount",
    ]);
  });

  it("throws when the header changes", () => {
    expect(() => parseAlabamaCashExtract(`${CASH_HEADER},Occupation\n`)).toThrow(/header changed/);
  });
});

describe("parseAlabamaExpenditureExtract", () => {
  it("parses a 20-column expenditure row", () => {
    const header = CASH_HEADER.replace("ContributionAmount", "ExpenditureAmount")
      .replace("ContributionDate", "ExpenditureDate")
      .replace("ContributionID", "Explanation,ExpenditureID")
      .replace("ContributionType,ContributorType", "Purpose,ExpenditureType");
    const line =
      "31702,534.10,05/15/2026,Whatley,Harold,Leon,III,1104 Chewacla rd,Opelika,AL,36804," +
      "Signs for Campaign,1443455,05/17/2026,Advertising,Itemized,Principal Campaign Committee,,HAROLD WHATLEY,N";
    const result = parseAlabamaExpenditureExtract(`${header}\n${line}\n`);
    expect(result.quarantined).toEqual([]);
    expect(result.rows[0]).toMatchObject({
      committeeId: "31702",
      amountCents: 53410,
      expenditureId: "1443455",
      purpose: "Advertising",
      expenditureType: "Itemized",
    });
  });
});

describe("parseAlabamaDollarsCents / parseAlabamaWallClockMs", () => {
  it("parses portal dollar strings", () => {
    expect(parseAlabamaDollarsCents("$358,862.76")).toBe(35886276);
    expect(parseAlabamaDollarsCents("$0.00")).toBe(0);
    expect(parseAlabamaDollarsCents("-$21.23")).toBe(-2123);
    expect(() => parseAlabamaDollarsCents("358.862,76")).toThrow(/Unparseable/);
  });

  it("parses and orders both portal timestamp formats", () => {
    const extractStamp = parseAlabamaWallClockMs("Aug 26, 2026, 2:32:00 AM");
    const filedBefore = parseAlabamaWallClockMs("08/25/2026 11:59 PM");
    const filedAfter = parseAlabamaWallClockMs("08/26/2026 08:41 PM");
    const noon = parseAlabamaWallClockMs("08/26/2026 12:05 PM");
    const midnight = parseAlabamaWallClockMs("08/26/2026 12:05 AM");
    expect(filedBefore).toBeLessThan(extractStamp);
    expect(filedAfter).toBeGreaterThan(extractStamp);
    expect(midnight).toBeLessThan(extractStamp);
    expect(noon).toBeGreaterThan(extractStamp);
  });
});

describe("parseAlabamaFilingDetailCover", () => {
  const html = `
    <div>Beginning Balance $358,862.76</div>
    <div>Cash Contributions</div>
    <div>Itemized cash contributions $10,000.00</div>
    <div>Non-itemized cash contributions $0.00</div>
    <div>Non-itemized employee payroll contributions $0.00</div>
    <div>Itemized in-kind contributions $2,173.91</div>
    <div>Non-itemized in-kind contributions $0.00</div>
    <div>Itemized receipts from other sources $0.00</div>
    <div>Non-itemized receipts from other sources $0.00</div>
    <div>Itemized Expenditures $18,340.18</div>
    <div>Non-itemized Expenditures $21.23</div>
    <div>Itemized Line of Credit Expenditures $0.00</div>
    <div>Non-itemized Line of Credit Expenditures $0.00</div>
    <div>Ending Balance $350,501.35</div>`;

  it("parses the Woods-style periodic cover in document order", () => {
    const cover = parseAlabamaFilingDetailCover(html);
    if (cover.kind !== "periodic") throw new Error("expected periodic cover");
    expect(cover.beginningBalanceCents).toBe(35886276);
    expect(cover.itemizedCashCents).toBe(1000000);
    expect(cover.itemizedInKindCents).toBe(217391);
    expect(cover.itemizedExpenditureCents).toBe(1834018);
    expect(cover.nonItemizedExpenditureCents).toBe(2123);
    expect(cover.itemizedLocCents).toBe(0);
    expect(cover.endingBalanceCents).toBe(35050135);
    expect(alabamaCoverCashCents(cover)).toBe(1000000);
    expect(alabamaCoverInKindCents(cover)).toBe(217391);
    expect(alabamaCoverExpenditureCents(cover)).toBe(1836141);
  });

  it("parses the reduced Major Contribution Report cover", () => {
    const cover = parseAlabamaFilingDetailCover(`
      <div>Details for the Major Contribution Report</div>
      <div>Beginning Balance $1,659,100.23</div>
      <div>Total Cash Contribution $20,000.00</div>
      <div>Total In-Kind Contributions $0.00</div>
      <div>Total Receipt from Other Sources $0.00</div>`);
    if (cover.kind !== "major_contribution") throw new Error("expected major cover");
    expect(cover.beginningBalanceCents).toBe(165910023);
    expect(cover.totalCashCents).toBe(2000000);
    expect(alabamaCoverCashCents(cover)).toBe(2000000);
    expect(alabamaCoverInKindCents(cover)).toBe(0);
    expect(alabamaCoverExpenditureCents(cover)).toBe(0);
  });

  it("fails loudly when a label is missing", () => {
    expect(() => parseAlabamaFilingDetailCover(html.replace("Ending Balance", "Final"))).toThrow(
      /missing "Ending Balance"/
    );
  });

  it("reads accounting-style negative balances, ($220.23), as negative cents", () => {
    // Live 2026-09-01: overdrawn committees render negatives in parentheses,
    // which the "-$" form alone rejected as a missing label.
    const cover = parseAlabamaFilingDetailCover(
      html
        .replace("Beginning Balance $358,862.76", "Beginning Balance ($220.23)")
        .replace("Ending Balance $350,501.35", "Ending Balance ($45.90)")
    );
    if (cover.kind !== "periodic") throw new Error("expected periodic cover");
    expect(cover.beginningBalanceCents).toBe(-22023);
    expect(cover.endingBalanceCents).toBe(-4590);
    expect(cover.itemizedCashCents).toBe(1000000);
  });
});

function raceRow(overrides: Partial<AlabamaRaceRow> = {}): AlabamaRaceRow {
  return {
    COMMITTEEID: 7962,
    CANDIDATE: "Jones, Doug",
    CANDIDATESTATUS: "Active",
    BEGINNINGFUNDS: 0,
    MONETARYCONTRIB: 100.0,
    MONETARYEXP: 40.0,
    NONMONETARYCONTRIB: 10.0,
    OTHERSOURCES: 0,
    ENDINGFUNDS: 60.0,
    YEAR: 2026,
    ...overrides,
  };
}

describe("summaries and reconciliation", () => {
  const cashRows = parseAlabamaCashExtract(
    [
      CASH_HEADER,
      cashLine({ amount: "60.00" }),
      cashLine({ amount: "25.00", type: "Cash (Non-Itemized)", amended: "Y" }),
      cashLine({ amount: "10.00", type: "In-Kind (Itemized)" }),
      cashLine({ amount: "5.00", contributor: "Returned (Cash Only)" }),
      cashLine({ amount: "-3.00" }),
      cashLine({ committeeId: "99999", amount: "77.00" }),
    ].join("\n")
  ).rows;

  it("summarizes cash vs in-kind vs returned vs negative for one committee", () => {
    const summary = summarizeAlabamaCashRows(cashRows, "32837");
    expect(summary.cash).toEqual({ rowCount: 4, amountCents: 8700 });
    expect(summary.inKind).toEqual({ rowCount: 1, amountCents: 1000 });
    expect(summary.returnedRows).toEqual({ rowCount: 1, amountCents: 500 });
    expect(summary.negativeRows).toEqual({ rowCount: 1, amountCents: -300 });
    expect(summary.amendedRowCount).toBe(1);
  });

  it("throws on an unknown contribution type", () => {
    const rows = parseAlabamaCashExtract(`${CASH_HEADER}\n${cashLine({ type: "Loan" })}`).rows;
    expect(() => summarizeAlabamaCashRows(rows, "32837")).toThrow(/Unknown Alabama contribution type/);
  });

  it("gates race-vs-covers exactly and reports extract coverage", () => {
    const expenditureSummary = { regular: { rowCount: 1, amountCents: 4000 }, lineOfCredit: { rowCount: 0, amountCents: 0 }, amendedRowCount: 0 };
    const cashSummary = summarizeAlabamaCashRows(cashRows, "32837");
    const periodicCover = parseAlabamaFilingDetailCover(`
      Beginning Balance $0.00 Itemized cash contributions $67.00 Non-itemized cash contributions $0.00
      Non-itemized employee payroll contributions $0.00 Itemized in-kind contributions $10.00
      Non-itemized in-kind contributions $0.00 Itemized receipts from other sources $0.00
      Non-itemized receipts from other sources $0.00 Itemized Expenditures $40.00
      Non-itemized Expenditures $0.00 Itemized Line of Credit Expenditures $0.00
      Non-itemized Line of Credit Expenditures $0.00 Ending Balance $27.00`);
    const majorCover = parseAlabamaFilingDetailCover(`
      Beginning Balance $27.00 Total Cash Contribution $33.00
      Total In-Kind Contributions $0.00 Total Receipt from Other Sources $0.00`);

    // Race says $100 cash; covers say $67 + $33; extracts hold $87 of it.
    const result = reconcileAlabamaCommittee({
      raceRow: raceRow({ MONETARYCONTRIB: 100.0, ENDINGFUNDS: 60.0 }),
      cashSummary,
      expenditureSummary,
      covers: [periodicCover, majorCover],
    });
    expect(result.cash.authorityStatus).toBe("exact");
    expect(result.cash.extractCoverage).toBeCloseTo(0.87, 5);
    expect(result.inKind.authorityStatus).toBe("exact");
    expect(result.expenditure.authorityStatus).toBe("exact");
    expect(result.raceIdentityDeltaCents).toBe(0);

    const mismatch = reconcileAlabamaCommittee({
      raceRow: raceRow({ MONETARYCONTRIB: 100.0 }),
      cashSummary,
      expenditureSummary,
      covers: [periodicCover],
    });
    expect(mismatch.cash.authorityStatus).toBe("mismatch");
    expect(mismatch.cash.authorityDeltaCents).toBe(3300);
  });

  it("splits regular vs line-of-credit expenditures", () => {
    const header = CASH_HEADER.replace("ContributionAmount", "ExpenditureAmount")
      .replace("ContributionDate", "ExpenditureDate")
      .replace("ContributionID", "Explanation,ExpenditureID")
      .replace("ContributionType,ContributorType", "Purpose,ExpenditureType");
    const rows = parseAlabamaExpenditureExtract(
      [
        header,
        "32837,40.00,01/05/2026,V,,,,1 St,Selma,AL,36701,,9001,01/06/2026,Advertising,Itemized,Principal Campaign Committee,,X,N",
        "32837,7.00,01/05/2026,V,,,,1 St,Selma,AL,36701,,9002,01/06/2026,Other,Itemized Line of Credit Expenditure,Principal Campaign Committee,,X,Y",
      ].join("\n")
    ).rows;
    const summary = summarizeAlabamaExpenditureRows(rows, "32837");
    expect(summary.regular).toEqual({ rowCount: 1, amountCents: 4000 });
    expect(summary.lineOfCredit).toEqual({ rowCount: 1, amountCents: 700 });
    expect(summary.amendedRowCount).toBe(1);
  });
});
