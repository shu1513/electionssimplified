import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchMichiganMitnCurrentExpenditureRows, parseMichiganMitnFilingsHtml,
  selectMichiganMitnCurrentExpenditureRows, type MichiganMitnFiling,
} from "../../../src/pipeline/michiganFinance/michiganMitnFilingPolicy.js";
import { MICHIGAN_MITN_IE_EXPORT_HEADER, scopeMichiganMitnIndependentExpenditureExportRows } from "../../../src/pipeline/michiganFinance/michiganMitnSupplementalData.js";
import type { MichiganMitnFetchFn } from "../../../src/pipeline/michiganFinance/michiganMitnPublicSearchClient.js";

const header = [...MICHIGAN_MITN_IE_EXPORT_HEADER];
function expense(id: string, amount = "100", period = "July CS", committee = "0517243", year = "2026"): string[] {
  const row = Array.from({ length: 29 }, () => "");
  Object.assign(row, { 0: "1", 1: id, 2: "C", 3: year, 4: period, 5: "Independent Expenditures", 6: "RTL", 7: committee,
    8: "Independent Expenditure", 9: "Mail", 13: "Vendor", 18: "S", 19: "Candidate", 22: "06/20/2026", 23: amount,
    28: "Candidate - State & Judicial, Representative in State Legislature, Friends of Alex - Support" });
  return row;
}
function filing(overrides: Partial<MichiganMitnFiling> = {}): MichiganMitnFiling {
  return { documentType: "Campaign Statements", statementYear: 2026, documentName: "July CS", sequenceNumber: "26-766086",
    refersToSequenceNumber: "", coverageBegin: "2026-04-21", coverageEnd: "2026-07-20", receivedDate: "2026-07-21", status: "Submitted", ...overrides };
}
function amendment(overrides: Partial<MichiganMitnFiling> = {}) {
  return filing({ documentType: "Amended Campaign Statements", sequenceNumber: "26-1085913",
    refersToSequenceNumber: "26-766086", receivedDate: "2026-07-23", ...overrides });
}
function select(raw: string[][], amended: string[][], filings: MichiganMitnFiling[]) {
  return selectMichiganMitnCurrentExpenditureRows({ statementYears: [2026], rawRows: [header, ...raw], amendedRows: [header, ...amended],
    filingsByCommittee: new Map([["517243", filings]]) });
}
function card(f: MichiganMitnFiling) {
  const field = (name: string, value: string) => `<dt>${name}</dt><dd>${value}</dd>`;
  const date = (value: string) => `<span datetime="${value}">${value}<span>`;
  return `<li>${field("Document Type", f.documentType)}${field("Statement Year", String(f.statementYear))}
    ${field("Document Name", f.documentName)}${field("Sequence Number", f.sequenceNumber)}${field("Refers to Seq No", f.refersToSequenceNumber)}
    ${field("Coverge Period", `${date(f.coverageBegin)} &ndash; ${date(f.coverageEnd)}`)}${field("Date Received", date(f.receivedDate))}${field("Status", f.status)}</li>`;
}
function page(filings: MichiganMitnFiling[], first = 1, total = filings.length) {
  return `<div id="committeeDetailsSectionContent"><ul class="block sm:hidden">${filings.map(card).join("")}</ul>
    <table><tr><td>Repeated desktop records ignored</td></tr></table><span><span class="font-medium">${first}</span> -
    <span class="font-medium">${first + filings.length - 1}</span> of <span class="font-medium">${total.toLocaleString("en-US")}</span></span></div>`;
}
const registry = `<table><tr x-bind:hx-vals="JSON.stringify({ parameters: { id: 19319 } })"><td>517243</td>
<td>Independent Expenditure</td><td>RIGHT TO LIFE OF MICHIGAN VICTORY FUND (SUPERPAC)</td><td>Active</td></tr></table>`;
function response(body: string, ok = true, status = 200) {
  return { ok, status, text: async () => body, arrayBuffer: async () => new ArrayBuffer(0) };
}
const directories: string[] = [];
async function directory() { const name = await mkdtemp(path.join(os.tmpdir(), "michigan-filing-policy-")); directories.push(name); return name; }
afterEach(async () => { await Promise.all(directories.splice(0).map((name) => rm(name, { recursive: true, force: true }))); });

describe("Michigan current filing period policy", () => {
  it("ignores local, vague and out-of-cycle periods while checking eligible original periods", () => {
    const local = expense("local", "100", "July CS", "99999");
    local[28] = "Candidate - Local, City Mayor, Detroit Mayor - Support";
    const vague = expense("vague", "100", "July CS", "88888"); vague[28] = "";
    const old = expense("old", "100", "July CS", "77777"); old[22] = "12/20/2024";
    const eligible = expense("eligible"); eligible[22] = "12/20/2025";
    const scoped = scopeMichiganMitnIndependentExpenditureExportRows([header, local, vague, old, eligible], [2025, 2026]);
    expect(selectMichiganMitnCurrentExpenditureRows({ statementYears: [2026], rawRows: scoped, amendedRows: [header],
      filingsByCommittee: new Map([["517243", [filing()]]]) })).toEqual([header, eligible]);
  });
  it("clears an eligible original period when the amendment has only out-of-scope IE", () => {
    const local = expense("amended-local"); local[28] = "Candidate - Local, City Mayor, Detroit Mayor - Support";
    const eligible = expense("deleted"); eligible[22] = "12/20/2025";
    const scope = (rows: string[][]) => scopeMichiganMitnIndependentExpenditureExportRows([header, ...rows], [2025, 2026]);
    expect(selectMichiganMitnCurrentExpenditureRows({ statementYears: [2026], rawRows: scope([eligible, local]), amendedRows: scope([local]),
      filingsByCommittee: new Map([["517243", [filing(), amendment()]]]) })).toEqual([header]);
  });
  it("still rejects multiple amendments in an eligible original period after scoping", () => {
    const eligible = expense("one"); eligible[22] = "12/20/2025";
    expect(() => selectMichiganMitnCurrentExpenditureRows({ statementYears: [2026],
      rawRows: scopeMichiganMitnIndependentExpenditureExportRows([header, eligible], [2025, 2026]), amendedRows: [header],
      filingsByCommittee: new Map([["517243", [filing(), amendment(), amendment({ sequenceNumber: "26-other" })]]]) })).toThrow(/ambiguous/);
  });
  it("retains original periods without amendments", () => {
    const row = expense("one"); expect(select([row], [], [filing()])).toEqual([header, row]);
  });
  it("retains multiple unamended immediate reports sharing a statement name", () => {
    const original = filing({ documentType: "Immediate Disclosure Reports", documentName: "Special Election Independent Expenditure Report" });
    const row = expense("one", "100", original.documentName);
    expect(select([row], [], [original, { ...original, sequenceNumber: "26-other", coverageBegin: "2026-01-01" }])).toEqual([header, row]);
  });
  it("replaces whole periods, removing deleted IDs and correcting changed amounts", () => {
    const changed = expense("retained", "80");
    expect(select([expense("retained"), expense("deleted", "500"), changed], [changed], [filing(), amendment()])).toEqual([header, changed]);
  });
  it("removes every original expense when the verified amendment has zero IE rows", () => {
    expect(select([expense("deleted")], [], [filing(), amendment()])).toEqual([header]);
  });
  it("keeps unamended periods alongside replaced amended periods", () => {
    const april = expense("april", "50", "April CS");
    expect(select([expense("july"), april], [], [filing(), amendment(), filing({ documentName: "April CS", sequenceNumber: "26-515556" })]))
      .toEqual([header, april]);
  });
  it("rejects multiple amendments even if exported expenses are identical or empty", () => {
    expect(() => select([expense("one")], [], [filing(), amendment(), amendment({ sequenceNumber: "26-next" })])).toThrow(/ambiguous/);
  });
  describe("separate elections sharing a pre-election label", () => {
    const primary = filing({ documentName: "Pre-Election CS", coverageBegin: "2026-01-01", coverageEnd: "2026-07-20" });
    const general = filing({ documentName: "Pre-Election CS", sequenceNumber: "26-general", coverageBegin: "2026-08-25",
      coverageEnd: "2026-10-18", receivedDate: "2026-10-19" });
    const amendedGeneral = amendment({ documentName: "Pre-Election CS", refersToSequenceNumber: general.sequenceNumber,
      coverageBegin: general.coverageBegin, coverageEnd: general.coverageEnd, receivedDate: "2026-10-20" });
    const records = () => [primary, general, amendedGeneral];
    const row = () => expense("one", "100", "Pre-Election CS");
    it("accepts identical economics and resolves the explicit reference rather than the first original", () => {
      const first = row(), second = expense("two", "200", "Pre-Election CS");
      expect(select([first, second, first, second], [second, first], records())).toEqual([header, second, first]);
      expect(select([first], [first], records().reverse())).toEqual([header, first]);
    });
    it("ignores only the already-ignored filing completion metadata", () => {
      const original = row(), amended = row(); amended[2] = "I";
      expect(select([original], [amended], records())).toEqual([header, amended]);
    });
    it.each(Array.from({ length: 29 }, (_, i) => i).filter((i) => ![2, 3, 4].includes(i)))(
      "holds a changed economic field at column %i", (column) => {
        const changed = row(); changed[column] = column === 23 ? "101" : `${changed[column]} changed`;
        expect(() => select([row()], [changed], records())).toThrow();
      }
    );
    it("holds an extra original expense, amendment addition, or empty amendment", () => {
      const extra = expense("extra", "200", "Pre-Election CS");
      expect(() => select([row(), extra], [row()], records())).toThrow(/ambiguous original filing coverage/);
      expect(() => select([row()], [row(), extra], records())).toThrow(/ambiguous original filing coverage/);
      expect(() => select([row()], [], records())).toThrow(/ambiguous original filing coverage/);
    });
    it.each([
      { coverageBegin: general.coverageBegin, coverageEnd: general.coverageEnd },
      { coverageEnd: general.coverageBegin },
      { coverageBegin: "" },
      { coverageEnd: "2026-02-30" },
      { coverageBegin: "2026-07-21", coverageEnd: "2026-07-20" },
      { documentType: "Immediate Disclosure Reports" },
    ])("holds invalid, overlapping or unsupported other original coverage %o", (change) => {
      expect(() => select([row()], [row()], [{ ...primary, ...change }, general, amendedGeneral])).toThrow(/ambiguous original filing coverage/);
    });
    it("still requires one amendment and a unique matching reference and coverage", () => {
      expect(() => select([row()], [row()], [...records(), { ...amendedGeneral, sequenceNumber: "26-next" }])).toThrow(/ambiguous/);
      expect(() => select([row()], [row()], [primary, general, { ...amendedGeneral, refersToSequenceNumber: "26-unknown" }])).toThrow(/reference/);
      expect(() => select([row()], [row()], [primary, general, { ...amendedGeneral, coverageBegin: "2026-08-26" }])).toThrow(/coverage/);
      expect(() => select([row()], [row()], [primary, general, { ...amendedGeneral, receivedDate: "2026-10-18" }])).toThrow(/coverage/);
    });
  });
  it.each([
    ["missing original", [amendment()]],
    ["amendment with two originals", [filing(), filing({ sequenceNumber: "26-other" }), amendment()]],
    ["returned filing", [filing({ status: "Returned for Clarification" })]],
    ["wrong reference", [filing(), amendment({ refersToSequenceNumber: "26-wrong" })]],
    ["wrong coverage begin", [filing(), amendment({ coverageBegin: "2026-04-20" })]],
    ["wrong coverage end", [filing(), amendment({ coverageEnd: "2026-07-19" })]],
    ["blank original coverage", [filing({ coverageBegin: "" }), amendment()]],
    ["earlier received date", [filing(), amendment({ receivedDate: "2026-07-20" })]],
    ["different period name", [filing({ documentName: "October CS" })]],
  ] as const)("rejects %s", (_, filings) => { expect(() => select([expense("one")], [], [...filings])).toThrow(); });
  it("does not infer amendment existence from expense rows", () => {
    expect(() => select([expense("one")], [expense("one")], [filing()])).toThrow(/unverified amended/);
  });
  it("accepts original immediate reports and rejects their unsupported amendments", () => {
    const original = filing({ documentType: "Immediate Disclosure Reports", documentName: "Special Election Independent Expenditure Report" });
    const row = expense("one", "100", original.documentName);
    expect(select([row], [], [original])).toEqual([header, row]);
    expect(() => select([row], [], [original, amendment({ documentType: "Amended Immediate Disclosure Reports", documentName: original.documentName })]))
      .toThrow(/unsupported amended immediate/);
  });
  it("normalizes leading zero IDs and statement name case and whitespace", () => {
    expect(select([expense("one")], [], [filing({ documentName: " july  cs " })])).toHaveLength(2);
  });
  it("requires every committee manifest and the expected years", () => {
    expect(() => select([expense("one", "100", "July CS", "99999")], [], [filing()])).toThrow(/no complete filing manifest/);
    expect(() => select([expense("one", "100", "July CS", "517243", "2025")], [], [filing()])).toThrow(/unexpected statement year/);
  });
});

describe("Michigan public filing manifest", () => {
  it("qualifies and reuses a coherent cache for equivalent IE across separate pre-election periods", async () => {
    const rawCacheDir = await directory();
    const primary = filing({ documentName: "Pre-Election CS", coverageBegin: "2026-01-01", coverageEnd: "2026-07-20" });
    const general = filing({ documentName: "Pre-Election CS", sequenceNumber: "26-general", coverageBegin: "2026-08-25",
      coverageEnd: "2026-10-18", receivedDate: "2026-10-19" });
    const amended = amendment({ documentName: "Pre-Election CS", refersToSequenceNumber: general.sequenceNumber,
      coverageBegin: general.coverageBegin, coverageEnd: general.coverageEnd, receivedDate: "2026-10-20" });
    const row = expense("one", "100", "Pre-Election CS"); row[22] = "09/01/2026";
    const fetchFn = vi.fn<MichiganMitnFetchFn>(async (url) => response(url.includes("action=search") ? registry : page([primary, general, amended])));
    const input = { statementYears: [2026], rawRows: [header, row, row], amendedRows: [header, row], rawCacheDir, fetchFn };
    const result = await fetchMichiganMitnCurrentExpenditureRows({ ...input, refresh: true });
    expect(result).toHaveLength(1); expect(result[0]).toMatchObject({ doc_seq_no: "one", amount: "100" });
    fetchFn.mockClear();
    expect(await fetchMichiganMitnCurrentExpenditureRows({ ...input, refresh: false })).toEqual(result);
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("parses source labels, sequence references and dates once", () => {
    expect(parseMichiganMitnFilingsHtml(page([filing(), amendment()]))).toEqual({ filings: [filing(), amendment()], first: 1, last: 2, total: 2 });
  });
  it("parses comma-separated totals", () => { expect(parseMichiganMitnFilingsHtml(page([filing()], 1, 1234)).total).toBe(1234); });
  it.each(["<html>maintenance</html>", page([filing()]).replace("Date Received", "Renamed Field"),
    page([filing()]).replace('of <span class="font-medium">1', 'of <span class="font-medium">0')])("rejects missing or inconsistent metadata", (html) => {
    expect(() => parseMichiganMitnFilingsHtml(html)).toThrow();
  });
  it("loads all pages, caches a coherent snapshot and reuses without network", async () => {
    const rawCacheDir = await directory();
    const fetchFn = vi.fn<MichiganMitnFetchFn>(async (url, init) => {
      if (url.includes("action=search")) {
        expect(new URLSearchParams(init.body).get("form.committeeId")).toBe("0517243"); return response(registry);
      }
      const body = new URLSearchParams(init.body);
      expect(body.get("section")).toBe("filings"); expect(body.get("parameters")).toBe('{"id":19319}'); expect(body.get("perPage")).toBe("100");
      expect(body.get("sortColumn")).toBe("sequenceNumber"); expect(body.get("sortDirection")).toBe("desc");
      return response(body.get("currentPage") === "1" ? page([filing()], 1, 2) : page([amendment()], 2, 2));
    });
    const input = { statementYears: [2026], rawRows: [header, expense("deleted")], amendedRows: [header], rawCacheDir, fetchFn };
    expect(await fetchMichiganMitnCurrentExpenditureRows({ ...input, refresh: true })).toEqual([]); expect(fetchFn).toHaveBeenCalledTimes(3);
    fetchFn.mockClear(); expect(await fetchMichiganMitnCurrentExpenditureRows({ ...input, refresh: false })).toEqual([]); expect(fetchFn).not.toHaveBeenCalled();
    await expect(fetchMichiganMitnCurrentExpenditureRows({ ...input, rawRows: [header, expense("deleted", "101")], refresh: false })).rejects.toThrow(/full export\/manifest refresh/);
  });
  it("requires a coordinated refresh for missing cached manifests", async () => {
    const fetchFn = vi.fn<MichiganMitnFetchFn>();
    await expect(fetchMichiganMitnCurrentExpenditureRows({ statementYears: [2026], rawRows: [header, expense("one")], amendedRows: [header],
      rawCacheDir: await directory(), refresh: false, fetchFn })).rejects.toThrow(/full export\/manifest refresh/); expect(fetchFn).not.toHaveBeenCalled();
  });
  it("rejects repeated pages", async () => {
    const fetchFn: MichiganMitnFetchFn = async (url) => response(url.includes("action=search") ? registry : page([filing()], 1, 2));
    await expect(fetchMichiganMitnCurrentExpenditureRows({ statementYears: [2026], rawRows: [header, expense("one")], amendedRows: [header],
      rawCacheDir: await directory(), refresh: true, fetchFn })).rejects.toThrow(/skipped or repeated/);
  });
  it("rejects changing totals", async () => {
    const fetchFn: MichiganMitnFetchFn = async (url, init) => response(url.includes("action=search") ? registry :
      new URLSearchParams(init.body).get("currentPage") === "1" ? page([filing()], 1, 2) : page([amendment()], 2, 3));
    await expect(fetchMichiganMitnCurrentExpenditureRows({ statementYears: [2026], rawRows: [header, expense("one")], amendedRows: [header],
      rawCacheDir: await directory(), refresh: true, fetchFn })).rejects.toThrow(/pagination changed/);
  });
  it("does not cache a manifest after failed amendment validation", async () => {
    const rawCacheDir = await directory();
    const fetchFn: MichiganMitnFetchFn = async (url) => response(url.includes("action=search") ? registry : page([filing(), amendment({ refersToSequenceNumber: "bad" })]));
    const input = { statementYears: [2026], rawRows: [header, expense("one")], amendedRows: [header], rawCacheDir, fetchFn };
    await expect(fetchMichiganMitnCurrentExpenditureRows({ ...input, refresh: true })).rejects.toThrow(/reference or coverage/);
    await expect(fetchMichiganMitnCurrentExpenditureRows({ ...input, refresh: false })).rejects.toThrow(/full export\/manifest refresh/);
  });
  it("collapses exact duplicate source filing sequences while counting every pagination record", async () => {
    const fetchFn: MichiganMitnFetchFn = async (url) => response(url.includes("action=search") ? registry : page([filing(), filing()]));
    expect(await fetchMichiganMitnCurrentExpenditureRows({ statementYears: [2026], rawRows: [header, expense("one")], amendedRows: [header],
      rawCacheDir: await directory(), refresh: true, fetchFn })).toHaveLength(1);
  });
  it("rejects conflicting repeated source filing sequences", async () => {
    const fetchFn: MichiganMitnFetchFn = async (url) => response(url.includes("action=search") ? registry : page([filing(), filing({ receivedDate: "2026-07-22" })]));
    await expect(fetchMichiganMitnCurrentExpenditureRows({ statementYears: [2026], rawRows: [header, expense("one")], amendedRows: [header],
      rawCacheDir: await directory(), refresh: true, fetchFn })).rejects.toThrow(/conflicting repeated/);
  });
  it("rejects HTTP failure and missing internal registry identity", async () => {
    const input = { statementYears: [2026], rawRows: [header, expense("one")], amendedRows: [header], rawCacheDir: await directory(), refresh: true };
    await expect(fetchMichiganMitnCurrentExpenditureRows({ ...input, fetchFn: async () => response("", false, 503) })).rejects.toThrow(/status 503/);
    await expect(fetchMichiganMitnCurrentExpenditureRows({ ...input, fetchFn: async () => response(registry.replace("id: 19319", "unknown: 19319")) })).rejects.toThrow(/registry identity/);
  });
});
