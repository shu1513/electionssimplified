import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acquireMissouriMecCandidateFinanceArtifacts,
  acquireMissouriMecOutsideSpendingArtifacts,
  acquireMissouriMecOutsideSpenderContributionArtifacts,
} from "../../../src/pipeline/missouriFinance/missouriMecArtifactAcquisition.js";
import {
  readMissouriMecCandidateFinanceArtifacts,
  readMissouriMecCommitteeReceiptArtifacts,
  readMissouriMecOutsideSpenderContributionArtifacts,
  readMissouriMecOutsideSpendingArtifacts,
} from "../../../src/pipeline/missouriFinance/missouriMecArtifactCache.js";
import * as artifactCache from "../../../src/pipeline/missouriFinance/missouriMecArtifactCache.js";
import type { MissouriMecResponse, MissouriMecSession } from "../../../src/pipeline/missouriFinance/missouriMecClient.js";
import { MISSOURI_MEC_CONTRIBUTION_EXPORT_HEADER, MISSOURI_MEC_EXPENDITURE_EXPORT_HEADER } from "../../../src/pipeline/missouriFinance/missouriMecParsers.js";

const state = `<input type="hidden" name="__VIEWSTATE" value="state"><input type="hidden" name="__EVENTVALIDATION" value="validation">`;
const committee = `${state}<span id="x_lblMECID">C263985</span><span id="x_lblCommName">Jane for Missouri</span><span id="x_lblCandName">Jane Doe</span>
  <span id="x_gvElecHistory_lblElecYear_0">11/3/2026</span><span id="x_gvElecHistory_lblElectionType_0">General Election</span>
  <span id="x_gvElecHistory_lblSub_0">State Representative</span><span id="x_gvElecHistory_lblPolSub_0">Missouri House</span>`;
const reports = `${state}<span id="x_grvReportOutside_lblYear_0">2026</span>`;
const inventory = `${state}<a id="x_grvReports_0_hlink_0" data-CPID="1"></a><span id="x_grvReports_0_lblReport_0">July Quarterly Report</span><span id="x_grvReports_0_lblDateReceived_0">7/15/2026</span>`;
const table = (header: readonly string[]) => `<table><tr>${header.map((value) => `<th>${value}</th>`).join("")}</tr></table>`;

function response(body: string, contentType = "text/html"): MissouriMecResponse {
  return { status: 200, contentType, contentDisposition: null, redirectLocation: null, body: Buffer.from(body), text: () => body };
}

function redirect(location: string): MissouriMecResponse {
  return { status: 302, contentType: "text/html", contentDisposition: null, redirectLocation: location, body: Buffer.alloc(0), text: () => "" };
}

function emptyTransactionExportRedirect(filename: string): MissouriMecResponse {
  return {
    status: 302,
    contentType: "text/html",
    contentDisposition: `attachment;filename=${filename}`,
    redirectLocation: "/mec/Error.aspx?aspxerrorpath=/MEC/Campaign_Finance/CF12_ContrExpendResults.aspx",
    body: Buffer.from("Object moved"),
    text: () => "Object moved",
  };
}

const newTempDirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(newTempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function candidateCacheDir() {
  const dir = await mkdtemp(join(tmpdir(), "mo-acquire-qualified-")); newTempDirs.push(dir); return dir;
}
const contributionData = ["C263985", "Example recipient", "July Quarterly Report", "Example committee", "", "", "",
  "", "", "", "", "", "", "", "8/5/2026", "$10.00", "Monetary", "uninterpreted"];
const expenditureData = ["C263985", "Example recipient", "July Quarterly Report", "", "", "Example vendor", "", "", "", "", "",
  "Services", "8/5/2026", "$10.00", "Paid"];
function exportTable(mode: "contributions" | "expenditures", rowCount: number) {
  const header = mode === "contributions" ? MISSOURI_MEC_CONTRIBUTION_EXPORT_HEADER : MISSOURI_MEC_EXPENDITURE_EXPORT_HEADER;
  const values = mode === "contributions" ? contributionData : expenditureData;
  return table(header).replace("</table>", `${Array.from({ length: rowCount }, () => `<tr>${values.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</table>`);
}
type TransactionMode = "contributions" | "expenditures";
type SessionOptions = {
  results?: Partial<Record<TransactionMode, string>>;
  exports?: Partial<Record<TransactionMode, MissouriMecResponse>>;
  closingInventory?: string;
  directClosingInventory?: string;
  expenditureError?: Error;
  profile?: string;
};
function candidateSession(options: SessionOptions = {}) {
  let mode: TransactionMode = "contributions";
  let inventoryReads = 0;
  const resultPage = (kind: TransactionMode) => `${state}<a>Full Disclosure Reports (1)</a>` +
    `<table id="ContentPlaceHolder_${kind === "contributions" ? "grvContrSearch" : "grvExpendSearch"}"></table>`;
  const get = vi.fn(async (url: string) => {
    if (url.includes("CommInfo.aspx")) return response(options.profile ?? committee);
    if (url.includes("CF12_ContrExpendResults.aspx")) return response(options.results?.[mode] ?? resultPage(mode));
    return response(state);
  });
  const postForm = vi.fn(async (url: string, fields: Record<string, string>) => {
    if (url.includes("CommInfo.aspx")) {
      if (fields.__EVENTTARGET?.endsWith("lbtnReports")) return response(reports);
      inventoryReads += 1;
      return response(inventoryReads === 1 ? inventory : inventoryReads === 3
        ? options.directClosingInventory ?? options.closingInventory ?? inventory : options.closingInventory ?? inventory);
    }
    if (url.includes("CF12_ContrExpendResults.aspx")) {
      if (mode === "expenditures" && options.expenditureError) throw options.expenditureError;
      return options.exports?.[mode] ?? response(exportTable(mode, 1), "application/vnd.ms-excel");
    }
    if (fields.__EVENTTARGET?.endsWith("lbtnContr")) mode = "contributions";
    if (fields.__EVENTTARGET?.endsWith("lbtnExpend")) mode = "expenditures";
    if (fields["ctl00$ctl00$ContentPlaceHolder$ContentPlaceHolder1$btnSearch"]) return response("CF12_ContrExpendResults.aspx");
    return response(state);
  });
  return { get, postForm } as MissouriMecSession & { get: typeof get; postForm: typeof postForm };
}
function acquireCandidate(cacheDir: string, options: SessionOptions = {}) {
  return acquireMissouriMecCandidateFinanceArtifacts({ mecid: "C263985", year: 2026, cacheDir,
    session: candidateSession(options), now: new Date("2026-08-19T00:00:00Z") });
}

const partialResult = { receiptArtifactsAvailable: true, directArtifactsAvailable: false, expenditureCount: null,
  directArtifactsSkippedReason: "Missouri MEC direct artifacts unavailable after receipt capture" };

describe("acquireMissouriMecCandidateFinanceArtifacts", () => {
  it("reconciles both Full Disclosure counts and closes inventory before installing", async () => {
    const cacheDir = await candidateCacheDir();
    const session = candidateSession();
    expect(await acquireMissouriMecCandidateFinanceArtifacts({ mecid: "C263985", year: 2026, cacheDir, session }))
      .toEqual({ mecid: "C263985", year: 2026, reportCount: 1, contributionCount: 1, expenditureCount: 1,
        receiptArtifactsAvailable: true, directArtifactsAvailable: true });
    expect(session.get).toHaveBeenCalledTimes(7);
    expect(session.postForm).toHaveBeenCalledTimes(14);
    expect(session.postForm).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      "ctl00$ctl00$ContentPlaceHolder$ContentPlaceHolder1$txtCommID": "C263985",
      "ctl00$ctl00$ContentPlaceHolder$ContentPlaceHolder1$ddYear": "2026",
    }), expect.any(Object));
    const loaded = await readMissouriMecCandidateFinanceArtifacts({ cacheDir, mecid: "C263985", year: 2026 });
    expect(loaded.contributionRows).toHaveLength(1);
    expect(loaded.expenditureRows).toHaveLength(1);
  });

  it.each(["contributions", "expenditures"] as const)("rejects missing %s Full Disclosure count", async (mode) => {
    const cacheDir = await candidateCacheDir();
    const pending = acquireCandidate(cacheDir, { results: { [mode]: `${state}<span>48 Hour > $5000 Reports (1)</span>` } });
    if (mode === "contributions") await expect(pending).rejects.toThrow("Missing Missouri MEC full-disclosure result count");
    else expect(await pending).toMatchObject(partialResult);
  });

  it.each(["contributions", "expenditures"] as const)("rejects contradictory %s advertised counts", async (mode) => {
    const cacheDir = await candidateCacheDir();
    const pending = acquireCandidate(cacheDir, { results: { [mode]: `${state}<span>Full Disclosure Reports (1)</span><span>Full Disclosure Reports (2)</span>` } });
    if (mode === "contributions") await expect(pending).rejects.toThrow("Conflicting Missouri MEC full-disclosure result counts");
    else expect(await pending).toMatchObject(partialResult);
  });

  it.each(["contributions", "expenditures"] as const)("rejects short %s exports and keeps previous complete source", async (mode) => {
    const cacheDir = await candidateCacheDir();
    await acquireCandidate(cacheDir);
    const before = await readMissouriMecCandidateFinanceArtifacts({ cacheDir, mecid: "C263985", year: 2026 });
    const receiptsBefore = await readMissouriMecCommitteeReceiptArtifacts({ cacheDir, mecid: "C263985", year: 2026 });
    const pointer = join(cacheDir, "C263985", "2026", "candidate-current.json");
    const pointerBefore = await readFile(pointer, "utf8");
    const receiptPointer = join(cacheDir, "C263985", "2026", "committee-receipts-current.json");
    const receiptPointerBefore = await readFile(receiptPointer, "utf8");
    const pending = acquireCandidate(cacheDir, { exports: { [mode]: response(exportTable(mode, 0), "application/vnd.ms-excel") } });
    if (mode === "contributions") {
      await expect(pending).rejects.toThrow("Missouri MEC transaction export count mismatch");
      expect(await readFile(receiptPointer, "utf8")).toBe(receiptPointerBefore);
    } else {
      expect(await pending).toMatchObject(partialResult);
      expect(await readFile(receiptPointer, "utf8")).not.toBe(receiptPointerBefore);
    }
    expect(await readFile(pointer, "utf8")).toBe(pointerBefore);
    expect(await readMissouriMecCommitteeReceiptArtifacts({ cacheDir, mecid: "C263985", year: 2026 })).toEqual(receiptsBefore);
    expect(await readMissouriMecCandidateFinanceArtifacts({ cacheDir, mecid: "C263985", year: 2026 })).toEqual(before);
  });

  it.each(["contributions", "expenditures"] as const)("accepts exact zero %s only with known no-grid redirect", async (mode) => {
    const cacheDir = await candidateCacheDir();
    const filename = mode === "contributions" ? "Contribution_Search.xls" : "Expenditure_Search.xls";
    const result = await acquireCandidate(cacheDir, { results: { [mode]: `${state}<a>Full Disclosure Reports (0)</a>` },
      exports: { [mode]: emptyTransactionExportRedirect(filename) } });
    expect(mode === "contributions" ? result.contributionCount : result.expenditureCount).toBe(0);
  });

  it.each(["positive", "missing", "grid", "wrong_redirect"] as const)("rejects zero-error shortcut with %s evidence", async (shape) => {
    const cacheDir = await candidateCacheDir();
    const results = `${state}${shape === "missing" ? "" : `Full Disclosure Reports (${shape === "positive" ? 1 : 0})`}` +
      (shape === "grid" ? '<table id="ContentPlaceHolder_grvExpendSearch"></table>' : "");
    const exported = emptyTransactionExportRedirect("Expenditure_Search.xls");
    if (shape === "wrong_redirect") exported.redirectLocation = "/unexpected";
    expect(await acquireCandidate(cacheDir, { results: { expenditures: results }, exports: { expenditures: exported } })).toMatchObject(partialResult);
  });

  it("rejects a zero count contradicting a nonempty valid export", async () => {
    const cacheDir = await candidateCacheDir();
    await expect(acquireCandidate(cacheDir, { results: { contributions: `${state}Full Disclosure Reports (0)` } }))
      .rejects.toThrow("Missouri MEC transaction export count mismatch");
  });

  it.each(["id", "name", "date", "amendment"] as const)("rejects closing inventory mutation in %s and retains previous source", async (kind) => {
    const cacheDir = await candidateCacheDir();
    await acquireCandidate(cacheDir);
    const before = await readMissouriMecCandidateFinanceArtifacts({ cacheDir, mecid: "C263985", year: 2026 });
    const changed = kind === "id" ? inventory.replace('data-CPID="1"', 'data-CPID="2"') : kind === "date"
      ? inventory.replace("7/15/2026", "7/16/2026") : inventory.replace("July Quarterly Report", kind === "amendment" ? "AMENDED July Quarterly Report" : "October Quarterly Report");
    await expect(acquireCandidate(cacheDir, { closingInventory: changed }))
      .rejects.toThrow("Missouri MEC report inventory changed during acquisition");
    expect(await readMissouriMecCandidateFinanceArtifacts({ cacheDir, mecid: "C263985", year: 2026 })).toEqual(before);
  });

  it.each(["transport", "malformed_export", "closing_inventory", "full_publish"] as const)(
    "keeps freshly qualified receipts and the prior direct pointer after %s failure", async (failure) => {
      const cacheDir = await candidateCacheDir();
      await acquireCandidate(cacheDir);
      const before = await readMissouriMecCandidateFinanceArtifacts({ cacheDir, mecid: "C263985", year: 2026 });
      const directPointer = join(cacheDir, "C263985", "2026", "candidate-current.json");
      const pointerBefore = await readFile(directPointer, "utf8");
      const receiptPointer = join(cacheDir, "C263985", "2026", "committee-receipts-current.json");
      const receiptBefore = await readFile(receiptPointer, "utf8");
      const options: SessionOptions = { exports: { contributions: response(exportTable("contributions", 1).replace("$10.00", "$20.00"), "application/vnd.ms-excel") } };
      if (failure === "transport") options.expenditureError = new Error("SYNTHETIC_PRIVATE_ERROR");
      if (failure === "malformed_export") options.exports!.expenditures = response(exportTable("expenditures", 1).replace("$10.00", "SYNTHETIC_PRIVATE_AMOUNT"), "application/vnd.ms-excel");
      if (failure === "closing_inventory") options.directClosingInventory = inventory.replace('data-CPID="1"', 'data-CPID="2"');
      if (failure === "full_publish") vi.spyOn(artifactCache, "storeMissouriMecCandidateArtifactBundle").mockRejectedValueOnce(new Error("SYNTHETIC_PRIVATE_IO_ERROR"));
      expect(await acquireCandidate(cacheDir, options)).toEqual({ mecid: "C263985", year: 2026, reportCount: 1, contributionCount: 1, ...partialResult });
      expect(await readFile(directPointer, "utf8")).toBe(pointerBefore);
      expect(await readFile(receiptPointer, "utf8")).not.toBe(receiptBefore);
      expect(await readMissouriMecCandidateFinanceArtifacts({ cacheDir, mecid: "C263985", year: 2026 })).toEqual(before);
      const receipts = await readMissouriMecCommitteeReceiptArtifacts({ cacheDir, mecid: "C263985", year: 2026 });
      expect(receipts.contributionRows.map((row) => row.amountCents)).toEqual([2000]);
    });

  it("returns partial receipt availability on a fresh cache with no direct artifacts", async () => {
    const cacheDir = await candidateCacheDir();
    expect(await acquireCandidate(cacheDir, { expenditureError: new Error("private transport error") })).toMatchObject(partialResult);
    expect((await readMissouriMecCommitteeReceiptArtifacts({ cacheDir, mecid: "C263985", year: 2026 })).contributionRows).toHaveLength(1);
    await expect(readMissouriMecCandidateFinanceArtifacts({ cacheDir, mecid: "C263985", year: 2026 })).rejects.toThrow();
  });

  it("throws on receipt publication failure even when an older qualified receipt exists", async () => {
    const cacheDir = await candidateCacheDir();
    await acquireCandidate(cacheDir);
    const receiptPointer = join(cacheDir, "C263985", "2026", "committee-receipts-current.json");
    const directPointer = join(cacheDir, "C263985", "2026", "candidate-current.json");
    const before = await Promise.all([readFile(receiptPointer, "utf8"), readFile(directPointer, "utf8")]);
    vi.spyOn(artifactCache, "storeMissouriMecCommitteeReceiptArtifactBundle").mockRejectedValueOnce(new Error("receipt publication failed"));
    const session = candidateSession();
    await expect(acquireMissouriMecCandidateFinanceArtifacts({ mecid: "C263985", year: 2026, cacheDir, session })).rejects.toThrow("receipt publication failed");
    expect(await Promise.all([readFile(receiptPointer, "utf8"), readFile(directPointer, "utf8")])).toEqual(before);
    expect(session.get).toHaveBeenCalledTimes(4);
    expect(session.postForm).toHaveBeenCalledTimes(8);
  });

  it("does not leak malformed source cells through export errors", async () => {
    const cacheDir = await candidateCacheDir();
    const privateMarker = "SYNTHETIC_PRIVATE_MARKER";
    const bad = exportTable("contributions", 1).replace("$10.00", privateMarker);
    await expect(acquireCandidate(cacheDir, { exports: { contributions: response(bad, "application/vnd.ms-excel") } }))
      .rejects.toThrow(/^Missouri MEC transaction export failed validation$/);
  });
});

describe("acquireMissouriMecOutsideSpendingArtifacts", () => {
  it("proves grid/export ordering and stores link-derived spender MECIDs", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "mo-outside-acquire-"));
    const search = state;
    const results = `${state}<span>1 records found</span>
      <span id="x_grvExpenditures_lblName_0">Jane Doe 10 Private St</span>
      <span id="x_grvExpenditures_lblSought_0">State Representative</span>
      <span id="x_grvExpenditures_lblSupp_0">Support</span>
      <span id="x_grvExpenditures_lblDate_0">10/20/2026</span>
      <span id="x_grvExpenditures_lblAmount_0">$25.00</span>
      <a id="x_grvExpenditures_lbtnCommittee_0" href="javascript:__doPostBack(&#39;ctl00$grid$ctl02$lbtnCommittee&#39;,&#39;&#39;)">Example PAC</a>
      <span id="x_grvExpenditures_lblReport_0">8 Day Before General Election</span>`;
    const outsideExport = `<table><tr>${[
      "Candidates Name and Address", "Office Sought", "Support/Oppose", "Date", "Amount",
      "Reporting Committee", "Report",
    ].map((value) => `<th>${value}</th>`).join("")}</tr><tr>${[
      "Jane Doe 10 Private St", "State Representative", "Support", "10/20/2026", "$25.00",
      "Example PAC", "8 Day Before General Election",
    ].map((value) => `<td>${value}</td>`).join("")}</tr></table>`;
    const get = vi.fn().mockResolvedValueOnce(response(search));
    const postForm = vi.fn()
      .mockResolvedValueOnce(response(results))
      .mockResolvedValueOnce(response(outsideExport, "application/vnd.ms-excel"))
      .mockResolvedValueOnce(redirect("/MEC/Campaign_Finance/CommInfo.aspx?mecid=C123456"));
    await expect(acquireMissouriMecOutsideSpendingArtifacts({
      year: 2026, cacheDir, session: { get, postForm } as MissouriMecSession,
      now: new Date("2026-08-19T00:00:00Z"),
    })).resolves.toEqual({ year: 2026, rowCount: 1, spenderCount: 1, unresolvedSpenderCount: 0 });
    expect(postForm).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      __EVENTTARGET: "ctl00$grid$ctl02$lbtnCommittee",
    }), expect.any(Object));
    await expect(readMissouriMecOutsideSpendingArtifacts({ cacheDir, year: 2026 })).resolves.toMatchObject({
      identities: [{ reportingCommittee: "Example PAC", mecid: "C123456" }],
    });
  });

  it("uses unique case-folded MECID/name activity evidence when paged grid links are broken", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "mo-outside-fallback-"));
    const gridRow = (name: string, committeeName: string, page: number, next = false) => `${state}
      <span id="x_grvExpenditures_lblName_0">${name} 10 Private St</span>
      <span id="x_grvExpenditures_lblSought_0">State Representative</span>
      <span id="x_grvExpenditures_lblSupp_0">Support</span>
      <span id="x_grvExpenditures_lblDate_0">10/20/2026</span>
      <span id="x_grvExpenditures_lblAmount_0">$25.00</span>
      <a id="x_grvExpenditures_lbtnCommittee_0" href="javascript:__doPostBack(&#39;ctl00$grid$ctl02$lbtnCommittee&#39;,&#39;&#39;)">${committeeName}</a>
      <span id="x_grvExpenditures_lblReport_0">8 Day Before General Election</span>
      <span id="x_grvExpenditures_CurrentPage"><font>${page}</font></span>
      ${next ? '<a id="x_grvExpenditures_lbtnNextPage" href="javascript:__doPostBack(&#39;ctl00$grid$ctl28$lbtnNextPage&#39;,&#39;&#39;)">Next</a>' : ""}`;
    const firstPage = `<span>2 records found</span>${gridRow("Jane Doe", "First PAC", 1, true)}`;
    const secondPage = gridRow("Jane Roe", "Second PAC", 2);
    const outsideExport = `<table><tr>${[
      "Candidates Name and Address", "Office Sought", "Support/Oppose", "Date", "Amount", "Reporting Committee", "Report",
    ].map((value) => `<th>${value}</th>`).join("")}</tr>${[
      ["Jane Doe 10 Private St", "First PAC"], ["Jane Roe 10 Private St", "Second PAC"],
    ].map(([name, committeeName]) => `<tr>${[
      name, "State Representative", "Support", "10/20/2026", "$25.00", committeeName, "8 Day Before General Election",
    ].map((value) => `<td>${value}</td>`).join("")}</tr>`).join("")}</table>`;
    const activity = `${state}<table id="x_gvAdvanced"><tr>${[
      "Status Date", "MECID", "Committee Name", "Committee Type", "Committee Candidate", "Committee Status",
    ].map((value) => `<th>${value}</th>`).join("")}</tr><tr>${[
      "8/19/2026", "C654321", "Second Pac", "Political Action", "", "Active",
    ].map((value) => `<td>${value}</td>`).join("")}</tr></table>`;
    const get = vi.fn().mockResolvedValueOnce(response(state)).mockResolvedValueOnce(response(state));
    const postForm = vi.fn()
      .mockResolvedValueOnce(response(firstPage))
      .mockResolvedValueOnce(response(outsideExport, "application/vnd.ms-excel"))
      .mockResolvedValueOnce(redirect("/MEC/Campaign_Finance/CommInfo.aspx?mecid=C123456"))
      .mockResolvedValueOnce(response(secondPage))
      .mockResolvedValueOnce(response(state))
      .mockResolvedValueOnce(response(activity));
    await expect(acquireMissouriMecOutsideSpendingArtifacts({
      year: 2026, cacheDir, session: { get, postForm } as MissouriMecSession,
      now: new Date("2026-08-19T00:00:00Z"),
    })).resolves.toEqual({ year: 2026, rowCount: 2, spenderCount: 2, unresolvedSpenderCount: 0 });
    await expect(readMissouriMecOutsideSpendingArtifacts({ cacheDir, year: 2026 })).resolves.toMatchObject({
      identities: expect.arrayContaining([
        { reportingCommittee: "First PAC", mecid: "C123456" },
        { reportingCommittee: "Second PAC", mecid: "C654321" },
      ]),
    });
    expect(postForm.mock.calls.filter((call) => call[1]?.__EVENTTARGET === "ctl00$grid$ctl02$lbtnCommittee")).toHaveLength(1);
  });

  it("does not apply one row's direct MECID to later rows that only share its committee name", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "mo-outside-row-scope-"));
    const grid = (candidate: string, page: number, next: boolean) => `${state}
      <span id="x_grvExpenditures_lblName_0">${candidate} 10 Private St</span>
      <span id="x_grvExpenditures_lblSought_0">State Representative</span>
      <span id="x_grvExpenditures_lblSupp_0">Support</span>
      <span id="x_grvExpenditures_lblDate_0">10/20/2026</span>
      <span id="x_grvExpenditures_lblAmount_0">$25.00</span>
      <a id="x_grvExpenditures_lbtnCommittee_0" href="javascript:__doPostBack(&#39;ctl00$grid$ctl02$lbtnCommittee&#39;,&#39;&#39;)">Reused PAC</a>
      <span id="x_grvExpenditures_lblReport_0">8 Day Before General Election</span>
      <span id="x_grvExpenditures_CurrentPage"><font>${page}</font></span>
      ${next ? '<a id="x_grvExpenditures_lbtnNextPage" href="javascript:__doPostBack(&#39;ctl00$grid$ctl28$lbtnNextPage&#39;,&#39;&#39;)">Next</a>' : ""}`;
    const firstPage = `<span>2 records found</span>${grid("Jane Doe", 1, true)}`;
    const secondPage = grid("Jane Roe", 2, false);
    const outsideExport = `<table><tr>${[
      "Candidates Name and Address", "Office Sought", "Support/Oppose", "Date", "Amount", "Reporting Committee", "Report",
    ].map((value) => `<th>${value}</th>`).join("")}</tr>${["Jane Doe", "Jane Roe"].map((candidate) => `<tr>${[
      `${candidate} 10 Private St`, "State Representative", "Support", "10/20/2026", "$25.00", "Reused PAC", "8 Day Before General Election",
    ].map((value) => `<td>${value}</td>`).join("")}</tr>`).join("")}</table>`;
    const activityNames = ["Reused Pac", "REUSED PAC"];
    const activity = `${state}<table id="x_gvAdvanced"><tr>${[
      "Status Date", "MECID", "Committee Name", "Committee Type", "Committee Candidate", "Committee Status",
    ].map((value) => `<th>${value}</th>`).join("")}</tr>${["C123456", "C654321"].map((mecid, index) => `<tr>${[
      "8/19/2026", mecid, activityNames[index], "Political Action", "", "Active",
    ].map((value) => `<td>${value}</td>`).join("")}</tr>`).join("")}</table>`;
    const get = vi.fn().mockResolvedValueOnce(response(state)).mockResolvedValueOnce(response(state));
    const postForm = vi.fn()
      .mockResolvedValueOnce(response(firstPage))
      .mockResolvedValueOnce(response(outsideExport, "application/vnd.ms-excel"))
      .mockResolvedValueOnce(redirect("/MEC/Campaign_Finance/CommInfo.aspx?mecid=C123456"))
      .mockResolvedValueOnce(response(secondPage))
      .mockResolvedValueOnce(response(state))
      .mockResolvedValueOnce(response(activity));
    await expect(acquireMissouriMecOutsideSpendingArtifacts({
      year: 2026, cacheDir, session: { get, postForm } as MissouriMecSession,
      now: new Date("2026-08-19T00:00:00Z"),
    })).resolves.toEqual({ year: 2026, rowCount: 2, spenderCount: 1, unresolvedSpenderCount: 1 });
    await expect(readMissouriMecOutsideSpendingArtifacts({ cacheDir, year: 2026 })).resolves.toMatchObject({
      identities: [{ reportingCommittee: "Reused PAC", mecid: null }],
    });
  });
});

describe("acquireMissouriMecOutsideSpenderContributionArtifacts", () => {
  it("caches PAC report inventory and CF12 contributions without requiring candidate history", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "mo-spender-acquire-"));
    const pac = `${state}<span id="x_lblMECID">C123456</span><span id="x_lblCommName">Example PAC</span>`;
    const { get, postForm } = candidateSession({ profile: pac,
      results: { contributions: `${state}<a>Full Disclosure Reports (0)</a>` },
      exports: { contributions: emptyTransactionExportRedirect("Contribution_Search.xls") } });
    await expect(acquireMissouriMecOutsideSpenderContributionArtifacts({
      mecid: "c123456", year: 2026, cacheDir, session: { get, postForm } as MissouriMecSession,
      now: new Date("2026-08-19T00:00:00Z"),
    })).resolves.toEqual({
      mecid: "C123456", year: 2026, committeeName: "Example PAC", reportCount: 1, contributionCount: 0,
    });
    await expect(readMissouriMecOutsideSpenderContributionArtifacts({
      cacheDir, mecid: "C123456", year: 2026,
    })).resolves.toMatchObject({ inventory: [{ reportId: "1" }], contributionRows: [] });
  });
});
