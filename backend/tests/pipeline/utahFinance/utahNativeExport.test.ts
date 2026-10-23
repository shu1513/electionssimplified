import { describe, expect, it } from "vitest";
import { parseUtahNativeExport } from "../../../src/pipeline/utahFinance/utahNativeExport.js";
import { parseUtahDisclosuresTransactionRows } from "../../../src/pipeline/utahFinance/utahDisclosuresClient.js";
import { isUtahDirectDonorSupportReceipt } from "../../../src/pipeline/utahFinance/utahDirectContributionAggregator.js";

const columns = ["PCC", "REPORT", "TRAN_ID", "TRAN_TYPE", "TRAN_DATE", "TRAN_AMT", "INKIND", "LOAN", "AMENDS", "NAME", "PURPOSE", "ADDRESS1", "ADDRESS2", "CITY", "STATE", "ZIP", "INKIND_COMMENTS"];
const values = ["Example Candidate", "2026 - Convention", "1", "Contribution", "4/1/2026", "25.00", "", "", "", "Example Committee", "", "", "", "", "", "", ""];
const cell = (s: string) => /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
function file(overrides: Record<string, string> = {}, annual = false) {
  const row = values.map((v, i) => overrides[columns[i]] ?? v);
  return [annual ? ["FILED", ...columns] : columns, annual ? ["4/10/2026", ...row] : row]
    .map(r => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

describe("Utah observed native exports", () => {
  it("recognizes actual X/blank flags through the ordinary mapper and excludes loans from donor support", () => {
    const [loan] = parseUtahDisclosuresTransactionRows(file({ LOAN: "X" }));
    expect(loan.loan).toBe(true);
    expect(isUtahDirectDonorSupportReceipt({transaction: loan, electionYear: 2026})).toBe(false);
    expect(parseUtahDisclosuresTransactionRows(file({ INKIND: "X" }))[0].inKind).toBe(true);
    expect(parseUtahDisclosuresTransactionRows(file())[0]).toMatchObject({ inKind: false, loan: false });
  });
  it("accepts the complete 17-column folder shape with exact cents and reported flags", () => {
    expect(parseUtahNativeExport(file({ INKIND: "X", TRAN_AMT: "0.2900" }), "PCC", "folder"))
      .toMatchObject([{ transactionId: "1", amountCents: 29, inKind: true, loan: false }]);
  });
  it("accepts the complete annual shape and retains the reported filing value", () => {
    expect(parseUtahNativeExport(file({}, true), "PCC", "annual")[0].filed).toBe("4/10/2026");
  });
  it("preserves signed amounts, zero occurrences, multiline fields, and escaped quotes", () => {
    const negative = parseUtahNativeExport(file({TRAN_AMT: "-5.00", NAME: 'Example "Quoted", Committee\nSecond line'}), "PCC", "folder");
    expect(negative[0]).toMatchObject({ amountCents: -500, name: 'Example "Quoted", Committee\nSecond line' });
    expect(parseUtahNativeExport(file({ TRAN_AMT: "0" }), "PCC", "folder")).toHaveLength(1);
  });
  it.each([
    { TRAN_AMT: "1.001" }, { TRAN_AMT: "90071992547409.92" }, { TRAN_AMT: "1e3" },
    { TRAN_ID: "" }, { TRAN_ID: "invalid" }, { TRAN_DATE: "2/30/2026" },
    { TRAN_TYPE: "unknown" }, { INKIND: "unknown" }, { LOAN: "unknown" }, { PCC: "" },
  ])("holds the whole export for an invalid primitive: %o", (bad) => {
    expect(() => parseUtahNativeExport(file(bad), "PCC", "folder"))
      .toThrow("Utah native export failed complete validation");
  });
  it("does not accept a valid prefix when a later record is corrupt", () => {
    const bad = file() + values.map((v,i) => i === 2 ? "2" : i === 5 ? "invalid" : cell(v)).join(",");
    expect(() => parseUtahNativeExport(bad, "PCC", "folder")).toThrow("complete validation");
  });
  it.each([
    file().replace("Example Candidate", 'Example "Candidate'),
    file().replace("Example Candidate", '"Example Candidate"trailer'),
    file().replace(/\r\n$/, ",extra\r\n"),
    file().split("\r\n")[0] + "\r\n1,short\r\n",
    file() + '""\r\n',
    file() + ",\r\n",
  ])("holds malformed quoting and record widths", (bad) => {
    expect(() => parseUtahNativeExport(bad, "PCC", "folder")).toThrow("complete validation");
  });
  it("holds repeated native IDs rather than silently deduplicating", () => {
    const csv = file();
    expect(() => parseUtahNativeExport(csv + csv.split("\r\n")[1], "PCC", "folder")).toThrow("complete validation");
  });
  it("requires the actual receiving class and scope even for an empty export", () => {
    expect(() => parseUtahNativeExport(file(), "PAC", "folder")).toThrow("complete validation");
    expect(() => parseUtahNativeExport(file(), "PCC", "annual")).toThrow("complete validation");
    expect(() => parseUtahNativeExport("There are no recorded transactions", "PCC", "folder")).toThrow("complete validation");
    expect(() => parseUtahNativeExport("<html>Human verification required</html>", "PCC", "folder")).toThrow("complete validation");
    expect(parseUtahNativeExport(columns.join(","), "PCC", "folder")).toEqual([]);
  });
});
