import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/pipeline/michiganFinance/michiganMitnFilingPolicy.js", () => ({
  fetchMichiganMitnCurrentExpenditureRows: vi.fn(),
}));
import { fetchMichiganMitnCurrentExpenditureRows } from "../../../src/pipeline/michiganFinance/michiganMitnFilingPolicy.js";
import {
  fetchMichiganMitnIndependentExpenditureRows,
  fetchMichiganMitnRegistryForNames,
  MICHIGAN_MITN_IE_EXPORT_HEADER,
  michiganMitnIndependentExpenditureExportRowsToLegacy,
  scopeMichiganMitnIndependentExpenditureExportRows,
} from "../../../src/pipeline/michiganFinance/michiganMitnSupplementalData.js";
import { buildZip } from "./mitnXlsxTestFixture.js";

function archive(rows: string[][]): Buffer {
  function column(index: number): string {
    let value = "";
    for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) value = String.fromCharCode(65 + (n - 1) % 26) + value;
    return value;
  }
  const xml = `<worksheet><sheetData>${rows.map((row, r) => `<row r="${r + 1}">${row.map((v, c) => {
    const escaped = v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    return `<c r="${column(c)}${r + 1}" t="inlineStr"><is><t>${escaped}</t></is></c>`;
  }).join("")}</row>`).join("")}</sheetData></worksheet>`;
  return buildZip([{ name: "xl/worksheets/sheet1.xml", content: xml }]);
}
function expense(overrides: Record<number, string> = {}): string[] {
  const row = MICHIGAN_MITN_IE_EXPORT_HEADER.map(() => "" as string);
  Object.assign(row, {
    0: "1", 1: "26-963854", 2: "I", 3: "2026", 4: "July CS", 5: "Independent Expenditures",
    6: "AMERICAN CONSERVATIVE FUND", 7: "0614962", 8: "Independent Expenditure", 18: "S", 19: "Candidate",
    22: "07/20/2026", 23: "229075.00", 24: "999999.00",
    28: "Candidate - State & Judicial, State Senator, Matthew Bierlein for State Senate - Support", ...overrides,
  });
  return row;
}
const table = (...rows: string[][]): string[][] => [[...MICHIGAN_MITN_IE_EXPORT_HEADER], ...rows];
const attachment = (...rows: string[][]): Buffer => archive(table(...rows));
function response(raw: Buffer | string, status = 200) {
  const data = typeof raw === "string" ? Buffer.from(raw) : raw;
  return { ok: status === 200, status, text: async () => data.toString("utf8"),
    arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer };
}
const REGISTRY = `<div id="search-results-top"></div><table><thead><tr><th>Committee ID</th><th>Committee Type</th><th>Committee Name</th><th>Status</th></tr></thead><tbody><tr><td>508347</td><td>Independent</td><td>UAW MICHIGAN VOLUNTARY POLITICAL ACTION COMMITTEE</td><td>Active</td></tr></tbody></table><div>1 - 1 of 1</div>`;
const dirs: string[] = [];
async function cache(): Promise<string> { const dir = await mkdtemp(path.join(os.tmpdir(), "mitn-supplemental-test-")); dirs.push(dir); return dir; }
beforeEach(() => {
  vi.mocked(fetchMichiganMitnCurrentExpenditureRows).mockReset();
  vi.mocked(fetchMichiganMitnCurrentExpenditureRows).mockImplementation(async ({ rawRows }) =>
    michiganMitnIndependentExpenditureExportRowsToLegacy(rawRows)
  );
});
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("Michigan supplemental IE exports", () => {
  it("maps strict target committee/office, transaction year, parent amount and incomplete keyed filings", () => {
    const rows = michiganMitnIndependentExpenditureExportRowsToLegacy(table(expense({ 3: "2026", 22: "12/20/2025" })));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ doc_seq_no: "26-963854", doc_stmnt_year: "2025", amount: "229075.00",
      target_committee_name: "Matthew Bierlein for State Senate", target_office: "State Senate", supp_opp: "S" });
  });
  it("collapses duplicates across statement years and skips supplemental child itemizations", () => {
    const rows = michiganMitnIndependentExpenditureExportRowsToLegacy(table(expense(), expense({ 2: "C", 3: "2025" }), expense({ 0: "2", 23: "1" })));
    expect(rows).toHaveLength(1);
  });
  it.each([23, 22, 18, 28, 7])("rejects conflicting economic versions (column %s)", (column) => {
    const other = expense({ [column]: column === 7 ? "0614962" : "changed" });
    if (column === 7) other[6] = "DIFFERENT COMMITTEE NAME";
    expect(() => michiganMitnIndependentExpenditureExportRowsToLegacy(table(expense(), other))).toThrow("conflicting versions");
  });
  it("excludes blank, multi-target, direction-disagreeing and local/federal office information", () => {
    const source = table(
      expense({ 1: "a", 28: "" }), expense({ 1: "b", 18: "O" }),
      expense({ 1: "c", 28: "Candidate - State & Judicial, State Senator, One - Support; Candidate - State & Judicial, State Senator, Two - Support" }),
      expense({ 1: "d", 28: "Candidate - State & Judicial, City Mayor, Mayor Committee - Support" }),
      expense({ 1: "e", 28: "Candidate - Federal, United States Senator, Senate Committee - Support" })
    );
    expect(michiganMitnIndependentExpenditureExportRowsToLegacy(source)).toEqual([]);
  });
  it("rejects missing headers and impossible dates", () => {
    expect(() => michiganMitnIndependentExpenditureExportRowsToLegacy([["Expense ID"]])).toThrow("headers");
    expect(() => michiganMitnIndependentExpenditureExportRowsToLegacy(table(expense({ 22: "02/30/2026" })))).toThrow("invalid expenditure date");
  });
  it("scopes parent positive state-office expenses by transaction year, retaining amendment versions", () => {
    const eligible = expense({ 22: "12/20/2025" });
    const changed = expense({ 22: "12/20/2025", 23: "100" });
    const source = table(eligible, changed,
      expense({ 1: "local", 28: "Candidate - Local, City Mayor, Detroit Mayor - Support" }),
      expense({ 1: "vague", 28: "" }),
      expense({ 1: "old", 22: "12/20/2024" }),
      expense({ 1: "child", 0: "2" }),
      expense({ 1: "zero", 23: "0" }),
      expense({ 1: "negative", 23: "-1" }),
      expense({ 1: "stance", 18: "O" }));
    expect(scopeMichiganMitnIndependentExpenditureExportRows(source, [2025, 2026])).toEqual(table(eligible, changed));
    expect(scopeMichiganMitnIndependentExpenditureExportRows(source, [2026])).toEqual(table());
  });
  it.each([
    ["amount", { 23: "bad" }], ["infinite amount", { 23: "9".repeat(400) }],
    ["date", { 22: "02/30/2026" }], ["identity", { 7: "invalid" }],
  ])("validates %s even for an irrelevant local expense", (_, overrides) => {
    expect(() => scopeMichiganMitnIndependentExpenditureExportRows(table(expense({
      28: "Candidate - Local, City Mayor, Detroit Mayor - Support", ...overrides,
    })), [2025, 2026])).toThrow();
  });
  it("excludes the dated out-of-cycle legacy placeholder before interpreting its blank money", () => {
    const placeholder = expense({ 1: "4107", 3: "2025", 4: "Annual CS", 6: "BRANCH COUNTY DEMOCRATIC EXECUTIVE COMMITTEE",
      7: "515457", 19: "", 22: "11/01/2024", 23: "", 24: "", 28: ", ,  , " });
    expect(scopeMichiganMitnIndependentExpenditureExportRows(table(placeholder), [2025, 2026])).toEqual(table());
    expect(() => scopeMichiganMitnIndependentExpenditureExportRows(table([...placeholder.slice(0, 22), "11/31/2024", ...placeholder.slice(23)]),
      [2025, 2026])).toThrow("invalid expenditure date");
    expect(() => scopeMichiganMitnIndependentExpenditureExportRows(table([...placeholder.slice(0, 22), "11/01/2025", ...placeholder.slice(23)]),
      [2025, 2026])).toThrow("invalid expenditure amount");
  });
  it("requires the exact schema and valid transaction years", () => {
    expect(() => scopeMichiganMitnIndependentExpenditureExportRows([["Expense ID"]], [2026])).toThrow("headers");
    expect(() => scopeMichiganMitnIndependentExpenditureExportRows(table(), [2026.5])).toThrow("transaction year");
  });
  it("scopes both tables equally before policy and preserves complete raw XLSX bytes", async () => {
    const dir = await cache();
    const eligible = expense({ 22: "12/20/2025" });
    const full = attachment(eligible, expense({ 1: "local", 28: "Candidate - Local, City Mayor, Detroit Mayor - Support" }));
    const amended = attachment(expense({ 1: "amended-local", 28: "Candidate - Local, City Mayor, Detroit Mayor - Support" }));
    const fetchFn = vi.fn().mockResolvedValueOnce(response(full)).mockResolvedValueOnce(response(amended));
    await fetchMichiganMitnIndependentExpenditureRows({ statementYears: [2026], transactionYears: [2025, 2026], rawCacheDir: dir, fetchFn });
    expect(fetchMichiganMitnCurrentExpenditureRows).toHaveBeenCalledWith(expect.objectContaining({
      rawRows: table(eligible), amendedRows: table(),
    }));
    expect(await readFile(path.join(dir, "independent-expenditures-2026.xlsx"))).toEqual(full);
    expect(await readFile(path.join(dir, "independent-expenditures-2026-amended.xlsx"))).toEqual(amended);
  });
  it("defaults transaction scope to requested statement years", async () => {
    const dir = await cache();
    const fetchFn = vi.fn().mockResolvedValueOnce(response(attachment(expense({ 22: "12/20/2025" })))).mockResolvedValueOnce(response(attachment()));
    await fetchMichiganMitnIndependentExpenditureRows({ statementYears: [2026], rawCacheDir: dir, fetchFn });
    expect(fetchMichiganMitnCurrentExpenditureRows).toHaveBeenCalledWith(expect.objectContaining({ rawRows: table(), amendedRows: table() }));
  });
  it("does not deduplicate original and changed amended amounts before policy", async () => {
    const dir = await cache();
    const old = expense(), changed = expense({ 23: "100" });
    const fetchFn = vi.fn().mockResolvedValueOnce(response(attachment(old, changed))).mockResolvedValueOnce(response(attachment(changed)));
    vi.mocked(fetchMichiganMitnCurrentExpenditureRows).mockResolvedValue([]);
    await fetchMichiganMitnIndependentExpenditureRows({ statementYears: [2026], rawCacheDir: dir, fetchFn });
    expect(fetchMichiganMitnCurrentExpenditureRows).toHaveBeenCalledWith(expect.objectContaining({
      rawRows: table(old, changed), amendedRows: table(changed),
    }));
  });
  it("uses both saved full and amended exports without network access", async () => {
    const dir = await cache();
    await writeFile(path.join(dir, "independent-expenditures-2026.xlsx"), attachment(expense()));
    await writeFile(path.join(dir, "independent-expenditures-2026-amended.xlsx"), attachment());
    const fetchFn = vi.fn();
    expect(await fetchMichiganMitnIndependentExpenditureRows({ statementYears: [2026], rawCacheDir: dir, fetchFn })).toHaveLength(1);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(fetchMichiganMitnCurrentExpenditureRows).toHaveBeenCalledWith(expect.objectContaining({ statementYears: [2026], amendedRows: table() }));
  });
  it("sends verified browser headers and independent schedule/full-amended request shapes", async () => {
    const dir = await cache();
    const fetchFn = vi.fn().mockResolvedValueOnce(response(attachment(expense()))).mockResolvedValueOnce(response(attachment()));
    await fetchMichiganMitnIndependentExpenditureRows({ statementYears: [2026, 2026], rawCacheDir: dir, fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const [url, first] = fetchFn.mock.calls[0]!;
    expect(url).toContain("page.miboeCommitteeExpenditureAnalysisPublicSearch&action=export");
    expect(first.headers).toMatchObject({ "hx-request": "true", origin: "https://mi-boe.entellitrak.com" });
    expect(Object.fromEntries(new URLSearchParams(first.body))).toEqual({ "form.campaignStatementYear": "76", "form.expenditureOption": "individual", "form.expenditureSchedule": "195" });
    expect(new URLSearchParams(fetchFn.mock.calls[1]![1].body).get("form.campaignStatementType")).toBe("17");
    expect(await readdir(dir)).toEqual(expect.arrayContaining(["independent-expenditures-2026.xlsx", "independent-expenditures-2026-amended.xlsx"]));
  });
  it("accepts official header-only empty exports and rejects HTML instead of clearing finances", async () => {
    const dir = await cache();
    const fetchFn = vi.fn().mockResolvedValue(response(attachment()));
    expect(await fetchMichiganMitnIndependentExpenditureRows({ statementYears: [2026], rawCacheDir: dir, fetchFn })).toEqual([]);
    fetchFn.mockResolvedValue(response("<html>error</html>"));
    await expect(fetchMichiganMitnIndependentExpenditureRows({ statementYears: [2026], rawCacheDir: dir, refresh: true, fetchFn })).rejects.toThrow("xlsx attachment");
    expect(await readFile(path.join(dir, "independent-expenditures-2026.xlsx"))).toEqual(attachment());
  });
  it("does not replace existing exports when current-filing validation fails", async () => {
    const dir = await cache(); const old = attachment();
    await writeFile(path.join(dir, "independent-expenditures-2026.xlsx"), old);
    await writeFile(path.join(dir, "independent-expenditures-2026-amended.xlsx"), old);
    vi.mocked(fetchMichiganMitnCurrentExpenditureRows).mockRejectedValue(new Error("multiple amendments"));
    const fetchFn = vi.fn().mockResolvedValue(response(attachment(expense())));
    await expect(fetchMichiganMitnIndependentExpenditureRows({ statementYears: [2026], rawCacheDir: dir, refresh: true, fetchFn })).rejects.toThrow("multiple amendments");
    expect(await readFile(path.join(dir, "independent-expenditures-2026.xlsx"))).toEqual(old);
  });
  it("refetches a saved bundle older than the reuse window", async () => {
    const dir = await cache();
    const full = path.join(dir, "independent-expenditures-2026.xlsx");
    await writeFile(full, attachment());
    await writeFile(path.join(dir, "independent-expenditures-2026-amended.xlsx"), attachment());
    await utimes(full, new Date("2000-01-01"), new Date("2000-01-01"));
    const fetchFn = vi.fn().mockResolvedValueOnce(response(attachment(expense()))).mockResolvedValueOnce(response(attachment()));
    expect(await fetchMichiganMitnIndependentExpenditureRows({ statementYears: [2026], rawCacheDir: dir, fetchFn })).toHaveLength(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchMichiganMitnCurrentExpenditureRows).toHaveBeenCalledWith(expect.objectContaining({ refresh: true }));
    expect((await stat(full)).mtimeMs).toBeGreaterThan(Date.now() - 60_000);
  });
  it("refreshes the entire bundle when one saved export is missing", async () => {
    const dir = await cache();
    await writeFile(path.join(dir, "independent-expenditures-2026.xlsx"), attachment());
    const fetchFn = vi.fn().mockResolvedValueOnce(response(attachment(expense()))).mockResolvedValueOnce(response(attachment()));
    expect(await fetchMichiganMitnIndependentExpenditureRows({ statementYears: [2026], rawCacheDir: dir, fetchFn })).toHaveLength(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchMichiganMitnCurrentExpenditureRows).toHaveBeenCalledWith(expect.objectContaining({ refresh: true }));
  });
  it("handles native Response objects without losing prototype status methods", async () => {
    const dir = await cache(); const fetchFn = vi.fn().mockImplementation(async () => new Response(REGISTRY));
    expect(await fetchMichiganMitnRegistryForNames({ names: ["UAW"], rawCacheDir: dir, fetchFn })).toHaveLength(1);
  });
  it("rejects unsupported years and request failures before caching", async () => {
    const dir = await cache(); const fetchFn = vi.fn().mockResolvedValue(response("error", 503));
    await expect(fetchMichiganMitnIndependentExpenditureRows({ statementYears: [2026, 2031], rawCacheDir: dir, fetchFn })).rejects.toThrow("statement-year id");
    expect(fetchFn).not.toHaveBeenCalled();
    await expect(fetchMichiganMitnIndependentExpenditureRows({ statementYears: [2026], rawCacheDir: dir, fetchFn })).rejects.toThrow("503");
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("Michigan supplemental typed registry", () => {
  it("queries all committee types, saves raw HTML, and reuses normalized-name caches", async () => {
    const dir = await cache(); const fetchFn = vi.fn().mockResolvedValue(response(REGISTRY));
    const names = ["UAW MICHIGAN VOLUNTARY POLITICAL ACTION COMMITTEE"];
    expect(await fetchMichiganMitnRegistryForNames({ names, rawCacheDir: dir, fetchFn })).toEqual([
      { committeeId: "508347", committeeType: "Independent", committeeName: names[0], status: "Active" },
    ]);
    const body = new URLSearchParams(fetchFn.mock.calls[0]![1].body);
    expect(body.get("form.committeeName")).toBe(names[0]);
    expect(body.get("form.committeeType")).toBe("");
    expect(body.get("form.candidateLastName")).toBe("");
    expect(body.has("form.sponsoringOrganization")).toBe(true);
    fetchFn.mockRejectedValue(new Error("offline"));
    expect(await fetchMichiganMitnRegistryForNames({ names: [names[0]!.toLowerCase()], rawCacheDir: dir, fetchFn })).toHaveLength(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it.each(["-", "–"])("accepts a complete native two-row footer with %s without confusing its range for pages", async (separator) => {
    const dir = await cache();
    const twoRows = REGISTRY.replace("508347", "515435")
      .replace("<td>Independent</td>", "<td>Independent Expenditure</td>")
      .replace("UAW MICHIGAN VOLUNTARY POLITICAL ACTION COMMITTEE", "BUSINESS LEADERS FOR MICHIGAN PAC II (SUPERPAC)")
      .replace("</tbody>", '<tr><td>514233</td><td>Independent</td><td>BUSINESS LEADERS FOR MICHIGAN PAC</td><td>Active</td></tr></tbody>')
      .replace("<div>1 - 1 of 1</div>", `<nav aria-label="Pagination Navigation"><span class="text-sm text-gray-900">1 of 1</span></nav><span class="items-center text-sm font-normal text-gray-900"><span class="font-medium">1</span> ${separator} <span class="font-medium">2</span> of <span class="font-medium">2</span></span>`);
    const fetchFn = vi.fn().mockImplementation(async () => new Response(twoRows));
    const rows = await fetchMichiganMitnRegistryForNames({ names: ["Business Leaders for Michigan PAC"], rawCacheDir: dir, fetchFn });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.committeeId)).toEqual(["515435", "514233"]);
    expect(rows.map((row) => row.committeeType)).toEqual(["Independent Expenditure", "Independent"]);
    fetchFn.mockRejectedValue(new Error("offline"));
    await expect(fetchMichiganMitnRegistryForNames({ names: ["BUSINESS LEADERS FOR MICHIGAN PAC"], rawCacheDir: dir, fetchFn })).resolves.toEqual(rows);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it.each(["1 - 25 of 26", "2 - 2 of 2", "1 - 2 of 2", "1 - 0 of 0"])("rejects incomplete or inconsistent range %s and never caches it", async (range) => {
    const dir = await cache();
    const fetchFn = vi.fn().mockImplementation(async () => new Response(REGISTRY.replace("1 - 1 of 1", range)));
    await expect(fetchMichiganMitnRegistryForNames({ names: ["Broad"], rawCacheDir: dir, fetchFn })).rejects.toThrow("incomplete paginated");
    expect(await readdir(dir)).toEqual([]);
  });
  it("uses a verified standalone native page label when no record range is present", async () => {
    const dir = await cache();
    const html = REGISTRY.replace("<div>1 - 1 of 1</div>", '<span class="text-sm text-gray-900">1 of 2</span>');
    const fetchFn = vi.fn().mockImplementation(async () => new Response(html));
    await expect(fetchMichiganMitnRegistryForNames({ names: ["Paged"], rawCacheDir: dir, fetchFn })).rejects.toThrow("incomplete paginated");
    expect(await readdir(dir)).toEqual([]);
  });
  it("accepts the official no-results fragment, not arbitrary HTML", async () => {
    const dir = await cache(); const fetchFn = vi.fn().mockResolvedValue(response('<div id="search-results-top"></div><p>No records found based on the criteria you entered</p>'));
    expect(await fetchMichiganMitnRegistryForNames({ names: ["Unknown"], rawCacheDir: dir, fetchFn })).toEqual([]);
    fetchFn.mockResolvedValue(response("<html>MiTN landing page</html>"));
    await expect(fetchMichiganMitnRegistryForNames({ names: ["Other"], rawCacheDir: dir, fetchFn })).rejects.toThrow("not a results table");
  });
  it("rejects paginated partial and row-cap results", async () => {
    const dir = await cache(); const fetchFn = vi.fn().mockResolvedValue(response(REGISTRY.replace("1 - 1 of 1", "1 - 1 of 1,840")));
    await expect(fetchMichiganMitnRegistryForNames({ names: ["Broad"], rawCacheDir: dir, fetchFn })).rejects.toThrow("paginated");
    fetchFn.mockResolvedValue(response("<div>narrow the search criteria</div>"));
    await expect(fetchMichiganMitnRegistryForNames({ names: ["Cap"], rawCacheDir: dir, fetchFn })).rejects.toThrow("row cap");
    expect(await readdir(dir)).toEqual([]);
  });
  it("refetches saved registry HTML older than the reuse window", async () => {
    const dir = await cache(); const fetchFn = vi.fn().mockResolvedValue(response(REGISTRY));
    await fetchMichiganMitnRegistryForNames({ names: ["UAW"], rawCacheDir: dir, fetchFn });
    const file = path.join(dir, `registry-${createHash("sha256").update("UAW").digest("hex")}.html`);
    await utimes(file, new Date("2000-01-01"), new Date("2000-01-01"));
    expect(await fetchMichiganMitnRegistryForNames({ names: ["UAW"], rawCacheDir: dir, fetchFn })).toHaveLength(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect((await stat(file)).mtimeMs).toBeGreaterThan(Date.now() - 60_000);
  });
  it("preserves saved registry HTML after invalid refresh", async () => {
    const dir = await cache(); const fetchFn = vi.fn().mockResolvedValue(response(REGISTRY));
    await fetchMichiganMitnRegistryForNames({ names: ["UAW"], rawCacheDir: dir, fetchFn });
    fetchFn.mockResolvedValue(response("<html>failed</html>"));
    await expect(fetchMichiganMitnRegistryForNames({ names: ["UAW"], rawCacheDir: dir, refresh: true, fetchFn })).rejects.toThrow("not a results table");
    const key = createHash("sha256").update("UAW").digest("hex");
    expect(await readFile(path.join(dir, `registry-${key}.html`), "utf8")).toBe(REGISTRY);
  });
});
