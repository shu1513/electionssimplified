import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  ILLINOIS_SBE_FILED_DOCUMENTS_HEADER as DOCUMENT_HEADER,
  ILLINOIS_SBE_D2_TOTALS_HEADER as D2_HEADER,
  readIllinoisSbeQuarterlyManifestAndTotals,
} from "../../../src/pipeline/illinoisFinance/illinoisSbeQuarterlyReportReader.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
function document(fields: Record<string, string> = {}): string[] {
  const values = { ID: "1023410", CommitteeID: "615", FiledDocType: "  ", DocName: "Quarterly",
    Amend: "False", Archived: "False", ElectionYear: "    ", ElectionType: "  ",
    RptPdBegDate: "2026-07-01 00:00:00", RptPdEndDate: "2026-09-30 00:00:00",
    RcvdDateTime: "2026-10-07 15:46:19.163000000", Source: "I", ...fields } as Record<string, string>;
  return DOCUMENT_HEADER.map((field) => values[field] ?? "");
}
function totals(fields: Record<string, string> = {}): string[] {
  const values = { ID: "594760", CommitteeID: "615", FiledDocID: "1023410", Archived: "False",
    BegFundsAvail: "49673.32", IndivContribI: "3178.3", IndivContribNI: "2678.97",
    XferInI: "1401.85", XferInNI: "100", OtherRctI: "207.27", TotalReceipts: "7566.39",
    InKindI: "160", TotalInKind: "160", XferOutI: "916.27", ExpendI: "21549.42",
    ExpendNI: "395.44", IndependentExpI: "2127.87", TotalExpend: "24989",
    EndFundsAvail: "32250.71", ...fields } as Record<string, string>;
  return D2_HEADER.map((field) => values[field] ?? "0");
}
function tsv(header: readonly string[], rows: string[][]): Buffer {
  return Buffer.from(header.join("\t") + "\r\n" + rows.map((row) =>
    row.map((field) => /[\t\r\n"]/.test(field) ? '"' + field.replace(/"/g, '""') + '"' : field).join("\t")
  ).join("\r\n") + "\r\n", "latin1");
}
async function fixture(documents = [document()], d2 = [totals()]) {
  const directory = await mkdtemp(join(tmpdir(), "illinois-quarterly-test-")); directories.push(directory);
  const filedDocumentsPath = join(directory, "FiledDocs.txt"), d2TotalsPath = join(directory, "D2Totals.txt");
  await writeFile(filedDocumentsPath, tsv(DOCUMENT_HEADER, documents));
  await writeFile(d2TotalsPath, tsv(D2_HEADER, d2));
  return { filedDocumentsPath, d2TotalsPath, coverageYears: [2025, 2026] };
}
describe("complete Illinois Quarterly manifests and D2 totals", () => {
  it("replays the official 615 Q3 monetary/source identity without losing fractional civil filing time", async () => {
    const input = await fixture();
    const result = await readIllinoisSbeQuarterlyManifestAndTotals(input);
    const report = result.currentReportsByCommitteeId.get("615")![0]!;
    expect(report.document).toMatchObject({ documentId: "1023410", filedDocType: "  ", receivedDay: "2026-10-07",
      receivedAtRaw: "2026-10-07 15:46:19.163000000", electionYear: "    ", source: "I" });
    expect(report.d2.amountsCents).toMatchObject({ IndependentExpI: 212787, IndivContribI: 317830,
      XferInI: 140185, TotalReceipts: 756639, TotalExpend: 2498900, EndFundsAvail: 3225071, InKindI: 16000 });
    expect(Object.keys(report.d2.amountsCents)).toHaveLength(27);
    expect(result.unknownCommittees.size).toBe(0);
    expect(result.sources.filedDocuments.rowCount).toBe(1);
    expect(result.sources.d2Totals.bytes).toBe(tsv(D2_HEADER, [totals()]).length);
  });
  it("retains all archived versions for same-day identity lookup and selects the unique current amendment", async () => {
    const input = await fixture([
      document({ ID: "1012431", CommitteeID: "39503", Archived: "True", RptPdBegDate: "2026-04-01 00:00:00",
        RptPdEndDate: "2026-06-30 00:00:00", RcvdDateTime: "2026-07-09 07:43:37" }),
      document({ ID: "1013045", CommitteeID: "39503", Amend: "True", RptPdBegDate: "2026-04-01 00:00:00",
        RptPdEndDate: "2026-06-30 00:00:00", RcvdDateTime: "2026-07-09 07:58:57" }),
    ], [totals({ ID: "589883", CommitteeID: "39503", FiledDocID: "1013045", IndivContribI: "9150", XferInI: "2500" })]);
    const result = await readIllinoisSbeQuarterlyManifestAndTotals(input);
    expect(result.documentsById.size).toBe(2);
    expect(result.documentsById.get("1012431")!.archived).toBe(true);
    expect([...result.documentsById.values()].map((doc) => doc.receivedDay)).toEqual(["2026-07-09", "2026-07-09"]);
    expect(result.currentReportsByCommitteeId.get("39503")![0]!.document.documentId).toBe("1013045");
  });
  it("scopes report-period intersection, retaining Q4 filed next year and cross-year periods", async () => {
    const input = await fixture([document({ RptPdBegDate: "2026-10-01 00:00:00", RptPdEndDate: "2027-01-01 00:00:00",
      RcvdDateTime: "2027-01-15 23:59:59.1" })]);
    input.coverageYears = [2026];
    expect((await readIllinoisSbeQuarterlyManifestAndTotals(input)).documentsById.get("1023410")!.receivedDay).toBe("2027-01-15");
  });
  it("ignores historical and rapid documents without manufacturing an empty committee snapshot", async () => {
    const input = await fixture([document({ DocName: "A-1" }), document({ ID: "7",
      RptPdBegDate: "2024-01-01 00:00:00", RptPdEndDate: "2024-03-31 00:00:00", RcvdDateTime: "2026-01-01 00:00:00" })]);
    const result = await readIllinoisSbeQuarterlyManifestAndTotals(input);
    expect(result.documentsById.size).toBe(0); expect(result.currentReportsByCommitteeId.size).toBe(0);
    expect(result.unknownCommittees.size).toBe(0);
  });
  it.each([
    ["missing", [totals({ FiledDocID: "0" })]],
    ["archived-only", [totals({ Archived: "True" })]],
    ["multiple-current", [totals(), totals({ ID: "99" })]],
    ["ownership", [totals({ CommitteeID: "999" })]],
    ["malformed-archive", [totals({ Archived: "false" })]],
    ["invalid-money", [totals({ IndependentExpI: "" })]],
    ["unsafe-cents", [totals({ IndependentExpI: "999999999999999999999" })]],
    ["excessive-precision", [totals({ IndependentExpI: "0.00001" })]],
  ])("preserves the affected component as unknown for %s D2 evidence", async (_label, rows) => {
    const result = await readIllinoisSbeQuarterlyManifestAndTotals(await fixture(undefined, rows));
    expect(result.unknownCommittees.has("615")).toBe(true);
    expect(result.currentReportsByCommitteeId.has("615")).toBe(false);
  });
  it("two current report IDs invalidate only their committee, not another verified committee", async () => {
    const result = await readIllinoisSbeQuarterlyManifestAndTotals(await fixture([
      document(), document({ ID: "99" }), document({ ID: "100", CommitteeID: "100" }),
    ], [totals(), totals({ ID: "100", CommitteeID: "100", FiledDocID: "100" })]));
    expect(result.unknownCommittees.has("615")).toBe(true);
    expect(result.currentReportsByCommitteeId.has("100")).toBe(true);
  });
  it("invalid scoped semantic identity does not abort another committee's valid report", async () => {
    const result = await readIllinoisSbeQuarterlyManifestAndTotals(await fixture([
      document(), document({ ID: "not-a-source-id", CommitteeID: "8" }),
    ]));
    expect(result.unknownCommittees.has("8")).toBe(true);
    expect(result.currentReportsByCommitteeId.has("615")).toBe(true);
  });
  it("an archived-only period and malformed scoped metadata remain unknown", async () => {
    const result = await readIllinoisSbeQuarterlyManifestAndTotals(await fixture([
      document({ Archived: "True" }), document({ ID: "8", CommitteeID: "8", RptPdBegDate: "2026-02-30 00:00:00" }),
    ]));
    expect(result.unknownCommittees.has("615")).toBe(true);
    expect(result.unknownCommittees.has("8")).toBe(true);
    expect(result.documentsById.get("8")!.periodStart).toBeNull();
  });
  it("conflicting duplicate document or D2 IDs invalidate both affected owners", async () => {
    const duplicateDoc = await readIllinoisSbeQuarterlyManifestAndTotals(await fixture([
      document(), document({ CommitteeID: "99" }),
    ]));
    expect([...duplicateDoc.unknownCommittees.keys()].sort()).toEqual(["615", "99"]);
    const duplicateD2 = await readIllinoisSbeQuarterlyManifestAndTotals(await fixture([
      document(), document({ ID: "8", CommitteeID: "8" }),
    ], [totals(), totals({ CommitteeID: "8", FiledDocID: "8" })]));
    expect([...duplicateD2.unknownCommittees.keys()].sort()).toEqual(["615", "8"]);
  });
  it("collapses exact identity duplicates while preserving raw counts and supports signed cash balance", async () => {
    const d2 = totals({ EndFundsAvail: "-32.51", IndependentExpI: "0" });
    const result = await readIllinoisSbeQuarterlyManifestAndTotals(await fixture([document(), document()], [d2, d2]));
    expect(result.sources.filedDocuments.rowCount).toBe(2);
    expect(result.sources.d2Totals.rowCount).toBe(2);
    expect(result.documentsById.size).toBe(1);
    expect(result.currentReportsByCommitteeId.get("615")![0]!.d2.amountsCents).toMatchObject({ EndFundsAvail: -3251, IndependentExpI: 0 });
  });
  it("retains exact published sub-cent balances without blocking valid cash or IE", async () => {
    const result = await readIllinoisSbeQuarterlyManifestAndTotals(await fixture(undefined, [
      totals({ BegFundsAvail: "17490.2871", EndFundsAvail: "-0.0001" }),
    ]));
    const d2 = result.currentReportsByCommitteeId.get("615")![0]!.d2;
    expect(d2.amountsRaw.BegFundsAvail).toBe("17490.2871");
    expect(d2.amountsTenThousandths).toMatchObject({ BegFundsAvail: 174902871, EndFundsAvail: -1 });
    expect(d2.amountsCents).toMatchObject({ BegFundsAvail: null, EndFundsAvail: null });
    expect(d2.components).toEqual({ cashItemized: true, independentExpenditures: true, raised: true });
    expect(d2.monetaryDiagnostics.BegFundsAvail).toContain("not an exact");
  });
  it("independently gates cash, IE and raised when exact published amounts are sub-cent or negative", async () => {
    const result = await readIllinoisSbeQuarterlyManifestAndTotals(await fixture(undefined, [
      totals({ IndivContribI: "0.0001", IndependentExpNI: "0.0001", TotalReceipts: "-1", TotalDebts: "-2" }),
    ]));
    const d2 = result.currentReportsByCommitteeId.get("615")![0]!.d2;
    expect(result.unknownCommittees.size).toBe(0);
    expect(d2.components).toEqual({ cashItemized: false, independentExpenditures: false, raised: false });
    expect(d2.amountsCents).toMatchObject({ IndivContribI: null, IndependentExpNI: null, TotalReceipts: null, TotalDebts: null });
    expect(d2.amountsTenThousandths).toMatchObject({ IndivContribI: 1, IndependentExpNI: 1, TotalReceipts: -10000 });
  });
  it("excludes only unequivocally out-of-scope reversed periods and counts the source anomaly", async () => {
    const result = await readIllinoisSbeQuarterlyManifestAndTotals(await fixture([
      document(), document({ ID: "486197", CommitteeID: "5053", RptPdBegDate: "2012-07-01 00:00:00",
        RptPdEndDate: "2012-06-30 00:00:00", RcvdDateTime: "2012-12-31 11:59:15" }),
    ]));
    expect(result.diagnostics.excludedOutOfScopeMalformedPeriods).toBe(1);
    expect(result.documentsById.has("486197")).toBe(false);
    expect(result.unknownCommittees.size).toBe(0);
  });
  it("binds untouched source bytes to optional expected SHA-256", async () => {
    const input = await fixture();
    const filedDocuments = createHash("sha256").update(tsv(DOCUMENT_HEADER, [document()])).digest("hex");
    const d2Totals = createHash("sha256").update(tsv(D2_HEADER, [totals()])).digest("hex");
    expect((await readIllinoisSbeQuarterlyManifestAndTotals({ ...input, expectedSha256: { filedDocuments, d2Totals } })).sources.d2Totals.sha256).toBe(d2Totals);
    await expect(readIllinoisSbeQuarterlyManifestAndTotals({ ...input, expectedSha256: { filedDocuments, d2Totals: "0".repeat(64) } })).rejects.toThrow("SHA-256 mismatch");
  });
  it.each(["header", "width", "newline", "empty"])("rejects incomplete or structurally changed %s sources globally", async (mode) => {
    const input = await fixture();
    const raw = tsv(DOCUMENT_HEADER, [document()]);
    await writeFile(input.filedDocumentsPath, mode === "header" ? raw.toString().replace("CommitteeID", "CommitteeId") :
      mode === "width" ? raw.toString().replace("\tQuarterly", "\tEXTRA\tQuarterly") :
      mode === "newline" ? raw.subarray(0, raw.length - 2) : "");
    await expect(readIllinoisSbeQuarterlyManifestAndTotals(input)).rejects.toThrow();
  });
  it("parses source multiline quote conventions without treating comment content as identity", async () => {
    const input = await fixture([document({ Comment: 'public “comment”\nwith "quotes"' })]);
    const result = await readIllinoisSbeQuarterlyManifestAndTotals(input);
    expect(result.documentsById.size).toBe(1); expect(result.unknownCommittees.size).toBe(0);
  });
  it("rejects an empty or invalid requested coverage", async () => {
    const input = await fixture();
    await expect(readIllinoisSbeQuarterlyManifestAndTotals({ ...input, coverageYears: [] })).rejects.toThrow("coverageYears");
    await expect(readIllinoisSbeQuarterlyManifestAndTotals({ ...input, coverageYears: [2026.5] })).rejects.toThrow("coverageYears");
  });
});
