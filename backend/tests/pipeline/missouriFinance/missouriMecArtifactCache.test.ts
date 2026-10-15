import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, afterEach } from "vitest";

import {
  readMissouriMecArtifact,
  readMissouriMecCandidateFinanceArtifacts,
  readMissouriMecCommitteeReceiptArtifacts,
  readMissouriMecOutsideSpendingArtifacts,
  readMissouriMecQualifiedOutsideSpendingArtifacts,
  storeMissouriMecOutsideSpendingArtifactBundle,
  storeMissouriMecOutsideSpendingExportSnapshot,
  qualifyMissouriMecOutsideSpendingExportSnapshot,
  parseMissouriMecOutsideSpendingResultCount,
  storeMissouriMecArtifact,
  storeMissouriMecCandidateArtifactBundle,
  storeMissouriMecCommitteeReceiptArtifactBundle,
  storeMissouriMecOutsideSpendingArtifacts,
} from "../../../src/pipeline/missouriFinance/missouriMecArtifactCache.js";
import { MISSOURI_MEC_CONTRIBUTION_EXPORT_HEADER, MISSOURI_MEC_EXPENDITURE_EXPORT_HEADER } from "../../../src/pipeline/missouriFinance/missouriMecParsers.js";

const committeeHtml = `<span id="x_lblMECID">C263985</span><span id="x_lblCommName">Jane for Missouri</span><span id="x_lblCandName">Jane Doe</span>
  <span id="x_gvElecHistory_lblElecYear_0">11/3/2026</span><span id="x_gvElecHistory_lblElectionType_0">General Election</span>
  <span id="x_gvElecHistory_lblSub_0">State Representative</span><span id="x_gvElecHistory_lblPolSub_0">Missouri House</span>`;

function candidateBundle(cacheDir: string, date = "2026-10-15T12:00:00Z") {
  const inventory = `<a id="x_grvReports_0_hlink_0" data-CPID="1"></a><span id="x_grvReports_0_lblReport_0">July Quarterly Report</span><span id="x_grvReports_0_lblDateReceived_0">7/15/2026</span>`;
  const table = (header: readonly string[]) => `<table><tr>${header.map((value) => `<th>${value}</th>`).join("")}</tr></table>`;
  return { cacheDir, mecid: "C263985", year: 2026, retrievedAt: new Date(date),
    artifacts: [
      { type: "committee_info" as const, body: committeeHtml, sourceUrl: "https://example.test/profile" },
      { type: "report_inventory" as const, body: inventory, sourceUrl: "https://example.test/reports" },
      { type: "contributions" as const, body: table(MISSOURI_MEC_CONTRIBUTION_EXPORT_HEADER), sourceUrl: "https://example.test/receipts" },
      { type: "expenditures" as const, body: table(MISSOURI_MEC_EXPENDITURE_EXPORT_HEADER), sourceUrl: "https://example.test/spending" },
    ],
    transactionResultBodies: { contributions: "Full Disclosure Reports (0)", expenditures: "Full Disclosure Reports (0)" },
    closingInventoryBody: inventory,
  };
}

describe("missouriMecArtifactCache", () => {
  it("qualifies receipts without an expenditure source and preserves them after a failed full refresh", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "mo-mec-receipts-"));
    const bundle = candidateBundle(cacheDir);
    await storeMissouriMecCommitteeReceiptArtifactBundle({ ...bundle,
      artifacts: bundle.artifacts.filter((artifact) => artifact.type !== "expenditures"),
      transactionResultBodies: { contributions: bundle.transactionResultBodies.contributions },
    });
    bundle.artifacts[3]!.body = "Unavailable expenditure source";
    await expect(storeMissouriMecCandidateArtifactBundle(bundle)).rejects.toThrow("failed source qualification");
    await expect(readMissouriMecCommitteeReceiptArtifacts(bundle)).resolves.toMatchObject({
      contributionRows: [], sourceRetrievedAt: bundle.retrievedAt.toISOString(),
    });
    await expect(readMissouriMecCandidateFinanceArtifacts(bundle)).rejects.toThrow("Missing Missouri MEC artifact");
  });

  it("requires independent receipt controls and preserves their prior pointer on failure", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "mo-mec-receipts-"));
    const full = candidateBundle(cacheDir);
    await storeMissouriMecCandidateArtifactBundle(full);
    await expect(readMissouriMecCommitteeReceiptArtifacts(full)).rejects.toThrow("Missing qualified Missouri MEC committee receipt source");
    const receipts = { ...full, artifacts: full.artifacts.filter((artifact) => artifact.type !== "expenditures"),
      transactionResultBodies: { contributions: full.transactionResultBodies.contributions } };
    await storeMissouriMecCommitteeReceiptArtifactBundle(receipts);
    const pointerPath = join(cacheDir, "C263985/2026/committee-receipts-current.json");
    const before = await readFile(pointerPath, "utf8");
    await expect(storeMissouriMecCommitteeReceiptArtifactBundle({ ...receipts,
      transactionResultBodies: { contributions: "Full Disclosure Reports (1)" },
    })).rejects.toThrow("failed source qualification");
    expect(await readFile(pointerPath, "utf8")).toBe(before);
    const pointer = JSON.parse(before) as { generation: string };
    await writeFile(join(cacheDir, "C263985/2026/committee-receipts-generations", pointer.generation, "closing_inventory.html"), "missing inventory");
    await expect(readMissouriMecCommitteeReceiptArtifacts(receipts)).rejects.toThrow("failed source qualification");
  });

  it("rejects an invalid source observation timestamp", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "mo-mec-receipts-"));
    const full = candidateBundle(cacheDir);
    await storeMissouriMecCommitteeReceiptArtifactBundle({ ...full,
      artifacts: full.artifacts.filter((artifact) => artifact.type !== "expenditures"),
      transactionResultBodies: { contributions: full.transactionResultBodies.contributions },
    });
    const pointer = JSON.parse(await readFile(join(cacheDir, "C263985/2026/committee-receipts-current.json"), "utf8")) as { generation: string };
    const manifestPath = join(cacheDir, "C263985/2026/committee-receipts-generations", pointer.generation, "C263985/2026/contributions.xls.html.manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    await writeFile(manifestPath, JSON.stringify({ ...manifest, retrievedAt: "invalid" }));
    await expect(readMissouriMecCommitteeReceiptArtifacts(full)).rejects.toThrow("Stale or invalid Missouri MEC artifact");
  });

  it("publishes one private immutable candidate generation and ignores later legacy partial writes", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "mo-mec-bundle-"));
    const bundle = candidateBundle(cacheDir);
    await storeMissouriMecCandidateArtifactBundle(bundle);
    const pointerPath = join(cacheDir, "C263985/2026/candidate-current.json");
    const pointer = JSON.parse(await readFile(pointerPath, "utf8")) as { generation: string };
    const root = join(cacheDir, "C263985/2026/candidate-generations", pointer.generation);
    expect((await stat(pointerPath)).mode & 0o777).toBe(0o600);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, "contribution_results.html"))).mode & 0o777).toBe(0o600);
    await storeMissouriMecArtifact({ cacheDir, key: { type: "committee_info", mecid: bundle.mecid, year: bundle.year },
      body: committeeHtml.replace("Jane for Missouri", "Legacy partial refresh"), sourceUrl: "https://example.test", retrievedAt: new Date("2026-10-16T00:00:00Z") });
    await expect(readMissouriMecCandidateFinanceArtifacts(bundle)).resolves.toMatchObject({
      committeeInfo: { committeeName: "Jane for Missouri" }, contributionRows: [], expenditureRows: [],
    });
    expect((await readMissouriMecArtifact({ cacheDir, key: { type: "committee_info", mecid: bundle.mecid, year: bundle.year } })).manifest.retrievedAt).toBe(bundle.retrievedAt.toISOString());
  });

  it.each(["count", "inventory", "identity", "member"] as const)("keeps the published generation when new %s qualification fails", async (failure) => {
    const cacheDir = await mkdtemp(join(tmpdir(), "mo-mec-bundle-"));
    await storeMissouriMecCandidateArtifactBundle(candidateBundle(cacheDir));
    const pointerPath = join(cacheDir, "C263985/2026/candidate-current.json");
    const before = await readFile(pointerPath, "utf8");
    const next = candidateBundle(cacheDir, "2026-10-16T00:00:00Z");
    if (failure === "count") next.transactionResultBodies.contributions = "Full Disclosure Reports (1)";
    if (failure === "inventory") next.closingInventoryBody = next.closingInventoryBody.replace('data-CPID="1"', 'data-CPID="2"');
    if (failure === "identity") next.artifacts[0]!.body = committeeHtml.replace("C263985", "C123456");
    if (failure === "member") next.artifacts.pop();
    await expect(storeMissouriMecCandidateArtifactBundle(next)).rejects.toThrow("failed source qualification");
    expect(await readFile(pointerPath, "utf8")).toBe(before);
    await expect(readMissouriMecCandidateFinanceArtifacts(next)).resolves.toMatchObject({ contributionRows: [] });
  });

  it("revalidates saved raw controls and never falls back to legacy after corruption", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "mo-mec-bundle-"));
    const bundle = candidateBundle(cacheDir);
    await storeMissouriMecCandidateArtifactBundle(bundle);
    const pointer = JSON.parse(await readFile(join(cacheDir, "C263985/2026/candidate-current.json"), "utf8")) as { generation: string };
    await writeFile(join(cacheDir, "C263985/2026/candidate-generations", pointer.generation, "contribution_results.html"), "Full Disclosure Reports (1)");
    await expect(readMissouriMecCandidateFinanceArtifacts(bundle)).rejects.toThrow("failed source qualification");
  });

  it("concurrent complete publishers leave one coherent generation", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "mo-mec-bundle-"));
    const first = candidateBundle(cacheDir);
    const second = candidateBundle(cacheDir, "2026-10-16T00:00:00Z");
    second.artifacts[0]!.body = committeeHtml.replace("Jane for Missouri", "New committee name");
    await Promise.all([storeMissouriMecCandidateArtifactBundle(first), storeMissouriMecCandidateArtifactBundle(second)]);
    const result = await readMissouriMecCandidateFinanceArtifacts(first);
    expect(["Jane for Missouri", "New committee name"]).toContain(result.committeeInfo.committeeName);
    const metadata = await readMissouriMecArtifact({ cacheDir, key: { type: "committee_info", mecid: first.mecid, year: first.year } });
    expect(metadata.manifest.retrievedAt).toBe(result.committeeInfo.committeeName === "Jane for Missouri" ? first.retrievedAt.toISOString() : second.retrievedAt.toISOString());
  });

  it("stores validated PII-bearing artifacts owner-only and verifies hashes on read", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "mo-mec-cache-"));
    const key = { type: "committee_info" as const, mecid: "C263985", year: 2026 };
    await storeMissouriMecArtifact({ cacheDir, key, sourceUrl: "https://example.test", body: committeeHtml, retrievedAt: new Date("2026-08-19T00:00:00Z") });
    const filePath = join(cacheDir, "C263985/2026/committee_info.html");
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(cacheDir, "C263985/2026"))).mode & 0o777).toBe(0o700);
    expect((await readMissouriMecArtifact({ cacheDir, key })).body).toBe(committeeHtml);
    await writeFile(filePath, `${await readFile(filePath, "utf8")} `, "utf8");
    await expect(readMissouriMecArtifact({ cacheDir, key })).rejects.toThrow("Stale or invalid Missouri MEC artifact");
  });

  it("validates before replacing a good artifact", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "mo-mec-cache-"));
    const key = { type: "committee_info" as const, mecid: "C263985", year: 2026 };
    await storeMissouriMecArtifact({ cacheDir, key, sourceUrl: "https://example.test", body: committeeHtml });
    await expect(storeMissouriMecArtifact({ cacheDir, key, sourceUrl: "https://example.test", body: "bad" })).rejects.toThrow();
    expect((await readMissouriMecArtifact({ cacheDir, key })).body).toBe(committeeHtml);
  });

  it("rejects a mixed-vintage candidate bundle after a partial refresh", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "mo-mec-cache-"));
    const mecid = "C263985";
    const year = 2026;
    const first = new Date("2026-08-19T00:00:00Z");
    const inventory = `<a id="x_grvReports_0_hlink_0" data-CPID="1"></a><span id="x_grvReports_0_lblReport_0">July Quarterly Report</span><span id="x_grvReports_0_lblDateReceived_0">7/15/2026</span>`;
    const table = (header: readonly string[]) => `<table><tr>${header.map((value) => `<th>${value}</th>`).join("")}</tr></table>`;
    for (const artifact of [
      { type: "committee_info" as const, body: committeeHtml },
      { type: "report_inventory" as const, body: inventory },
      { type: "contributions" as const, body: table(MISSOURI_MEC_CONTRIBUTION_EXPORT_HEADER) },
      { type: "expenditures" as const, body: table(MISSOURI_MEC_EXPENDITURE_EXPORT_HEADER) },
    ]) {
      await storeMissouriMecArtifact({ cacheDir, key: { type: artifact.type, mecid, year }, sourceUrl: "https://example.test", body: artifact.body, retrievedAt: first });
    }
    await expect(readMissouriMecCandidateFinanceArtifacts({ cacheDir, mecid, year })).resolves.toMatchObject({ contributionRows: [] });
    await storeMissouriMecArtifact({
      cacheDir, key: { type: "expenditures", mecid, year }, sourceUrl: "https://example.test",
      body: table(MISSOURI_MEC_EXPENDITURE_EXPORT_HEADER), retrievedAt: new Date("2026-08-20T00:00:00Z"),
    });
    await expect(readMissouriMecCandidateFinanceArtifacts({ cacheDir, mecid, year })).rejects.toThrow("Mixed-vintage");
  });

  it("stores and verifies a complete yearly outside-spending identity bundle", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "mo-mec-cache-"));
    const outside = `<table><tr>${[
      "Candidates Name and Address", "Office Sought", "Support/Oppose", "Date", "Amount",
      "Reporting Committee", "Report",
    ].map((value) => `<th>${value}</th>`).join("")}</tr><tr>${[
      "Jane Doe 10 Private St", "State Representative", "Support", "10/20/2026", "$25.00",
      "Example PAC", "8 Day Before General Election",
    ].map((value) => `<td>${value}</td>`).join("")}</tr></table>`;
    await storeMissouriMecOutsideSpendingArtifacts({
      cacheDir, year: 2026, sourceUrl: "https://example.test/outside", exportBody: outside,
      identities: [{ reportingCommittee: "Example PAC", mecid: "C123456" }],
      retrievedAt: new Date("2026-08-19T00:00:00Z"),
    });
    await expect(readMissouriMecOutsideSpendingArtifacts({ cacheDir, year: 2026 })).resolves.toMatchObject({
      rows: [{ reportingCommittee: "Example PAC", amountCents: 2500 }],
      identities: [{ reportingCommittee: "Example PAC", mecid: "C123456" }],
      sourceUrl: "https://example.test/outside",
    });
    await expect(storeMissouriMecOutsideSpendingArtifacts({
      cacheDir, year: 2026, sourceUrl: "https://example.test/outside", exportBody: outside, identities: [],
    })).rejects.toThrow("identity coverage mismatch");
  });
});

// Inject actual filesystem interruptions/barriers; source financial fixtures remain synthetic.
const io = vi.hoisted(() => ({
  beforeWrite: undefined as undefined | ((path: string) => Promise<void>),
  beforeRead: undefined as undefined | ((path: string) => Promise<void>),
}));
vi.mock("node:fs/promises", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original,
    writeFile: async (...args: Parameters<typeof original.writeFile>) => { await io.beforeWrite?.(String(args[0])); return original.writeFile(...args); },
    readFile: async (...args: Parameters<typeof original.readFile>) => { await io.beforeRead?.(String(args[0])); return original.readFile(...args); },
  };
});
afterEach(() => { io.beforeWrite = undefined; io.beforeRead = undefined; });
function yearlyBundle(cacheDir: string, amounts = [2500], id: string | null = null) {
  const header = ["Candidates Name and Address", "Office Sought", "Support/Oppose", "Date", "Amount", "Reporting Committee", "Report"];
  const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const cells = (amount: number) => ["Synthetic Candidate 10 Example St", "State Representative", "Support", "10/20/2026", money(amount), "Example Reported Committee", "8 Day Before General Election"];
  const exportBody = `<table><tr>${header.map(v => `<th>${v}</th>`).join("")}</tr>${amounts.map(a => `<tr>${cells(a).map(v => `<td>${v}</td>`).join("")}</tr>`).join("")}</table>`;
  const gridPageBodies = amounts.map((amount, index) => `<span id="x_grvExpenditures_lblName_0">${cells(amount)[0]}</span>
    <span id="x_grvExpenditures_lblSought_0">State Representative</span><span id="x_grvExpenditures_lblSupp_0">Support</span>
    <span id="x_grvExpenditures_lblDate_0">10/20/2026</span><span id="x_grvExpenditures_lblAmount_0">${money(amount)}</span>
    <a id="x_grvExpenditures_lbtnCommittee_0" href="javascript:__doPostBack(&#39;ctl00$grid$ctl02$lbtnCommittee&#39;,&#39;&#39;)">Example Reported Committee</a>
    <span id="x_grvExpenditures_lblReport_0">8 Day Before General Election</span><span id="x_grvExpenditures_CurrentPage">${index + 1}</span>
    ${index < amounts.length - 1 ? '<a id="x_grvExpenditures_lbtnNextPage" href="javascript:__doPostBack(&#39;ctl00$grid$ctl28$lbtnNextPage&#39;,&#39;&#39;)">Next</a>' : ""}`);
  const resultsBody = `<span>${amounts.length} records found</span>${gridPageBodies[0] ?? ""}`;
  if (gridPageBodies.length) gridPageBodies[0] = resultsBody;
  return { cacheDir, year: 2026, sourceUrl: "https://www.mec.mo.gov/MEC/Campaign_Finance/CF_SearchDirExp.aspx", exportBody,
    identities: amounts.length ? [{ reportingCommittee: "Example Reported Committee", mecid: id }] : [],
    retrievedAt: new Date("2026-10-15T12:00:00Z"), resultsBody, gridPageBodies };
}
async function yearlyRoot(cacheDir: string) {
  const pointer = JSON.parse(await readFile(join(cacheDir, "_outside/2026/registered-ie-current.json"), "utf8"));
  return join(cacheDir, "_outside/2026/registered-ie-generations", pointer.generation);
}
describe("qualified immutable Missouri yearly outside source", () => {
  it.each(["1,23", "-1", "+1", "1.2", "01", "1e2"])("rejects malformed native count %s", count => {
    expect(() => parseMissouriMecOutsideSpendingResultCount(`${count} records found`)).toThrow("Invalid Missouri MEC outside-spending result count");
  });
  it("requires explicit consistent native result counts", () => {
    expect(parseMissouriMecOutsideSpendingResultCount("<b>2,122</b> records found; 2122 records found")).toBe(2122);
    expect(() => parseMissouriMecOutsideSpendingResultCount("1 records found; 2 records found")).toThrow();
    expect(() => parseMissouriMecOutsideSpendingResultCount("no count")).toThrow();
  });
  it("returns original source provenance and permits unresolved auxiliary IDs", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "mo-ie-generation-")); const bundle = yearlyBundle(cacheDir, [2500, 2500]);
    await storeMissouriMecOutsideSpendingArtifactBundle(bundle);
    const source = await readMissouriMecQualifiedOutsideSpendingArtifacts(bundle);
    expect(source.rows).toHaveLength(2); if (source.sourceKind !== "grid_reconciled_export") throw new Error("expected grid source"); expect(source.identities[0]!.mecid).toBeNull();
    expect(source.sourceRetrievedAt).toBe(bundle.retrievedAt.toISOString());
    expect(source.sourceSha256).toBe(createHash("sha256").update(bundle.exportBody).digest("hex"));
    expect(source.sourceByteSize).toBe(Buffer.byteLength(bundle.exportBody));
    expect(source.sourcePageCount).toBe(2); expect(source.sourceRowCount).toBe(2);
    expect(source.sourceControls.map(c => c.file)).toEqual(["results.html", "grid-002.html"]);
    expect(source.sourceControls.every(c => Object.keys(c).sort().join(",") === "byteSize,file,sha256")).toBe(true);
    expect(Object.keys(source).some(key => /identity.*sha/i.test(key))).toBe(false);
    const root = await yearlyRoot(cacheDir);
    expect((await stat(root)).mode & 0o777).toBe(0o700); expect((await stat(join(root, "results.html"))).mode & 0o777).toBe(0o600);
  });
  it("qualifies true source zero only from explicit zero and an empty export", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "mo-ie-zero-")); const bundle = yearlyBundle(cacheDir, []);
    await storeMissouriMecOutsideSpendingArtifactBundle(bundle);
    await expect(readMissouriMecQualifiedOutsideSpendingArtifacts(bundle)).resolves.toMatchObject({rows: [],sourceRowCount:0,sourcePageCount:0});
    await expect(storeMissouriMecOutsideSpendingArtifactBundle({...bundle,resultsBody:"no native count"})).rejects.toThrow("failed qualification");
    await expect(storeMissouriMecOutsideSpendingArtifactBundle({...bundle,resultsBody:"1 records found"})).rejects.toThrow("failed qualification");
    const dirtyZero = yearlyBundle(cacheDir);
    await expect(storeMissouriMecOutsideSpendingArtifactBundle({...bundle,resultsBody:dirtyZero.resultsBody.replace("1 records found","0 records found")})).rejects.toThrow("failed qualification");
  });
  it.each([
    ["candidate", "Synthetic Candidate", "Different Candidate"], ["office", "State Representative", "State Senator"],
    ["stance", "Support", "Oppose"], ["date", "10/20/2026", "10/21/2026"],
    ["money", "$25.00", "$26.00"], ["report", "8 Day Before General Election", "July Quarterly"],
  ])("rejects same-count financial-cell mismatch in %s", async (_label, before, after) => {
    const cacheDir = await mkdtemp(join(tmpdir(), "mo-ie-cells-")); const bundle = yearlyBundle(cacheDir);
    bundle.resultsBody = bundle.resultsBody.replace(before!, after!); bundle.gridPageBodies[0] = bundle.resultsBody;
    await expect(storeMissouriMecOutsideSpendingArtifactBundle(bundle)).rejects.toThrow("failed qualification");
  });
  it.each(["count", "missing_page", "wrong_page", "missing_next", "duplicate_occurrence"])("rejects incomplete whole-source %s controls", async mode => {
    const cacheDir = await mkdtemp(join(tmpdir(), "mo-ie-controls-")); const b = yearlyBundle(cacheDir, [2500, 3000]);
    if(mode === "count") { b.resultsBody = b.resultsBody.replace("2 records found", "3 records found"); b.gridPageBodies[0] = b.resultsBody; }
    if(mode === "missing_page") b.gridPageBodies.pop();
    if(mode === "wrong_page") b.gridPageBodies[1] = b.gridPageBodies[1]!.replace('CurrentPage">2', 'CurrentPage">1');
    if(mode === "missing_next") { b.resultsBody=b.resultsBody.replace(/<a id="x_grvExpenditures_lbtnNextPage"[\s\S]*?<\/a>/, ""); b.gridPageBodies[0]=b.resultsBody; }
    if(mode === "duplicate_occurrence") b.gridPageBodies[1]=b.gridPageBodies[1]!.replace("$30.00","$25.00");
    await expect(storeMissouriMecOutsideSpendingArtifactBundle(b)).rejects.toThrow("failed qualification");
  });
  it.each(["outside_spender_identities.json", "grid-002.html", "registered-ie-current.json.tmp-"])("keeps prior pointer usable after staging filesystem failure at %s", async fragment => {
    const cacheDir = await mkdtemp(join(tmpdir(), "mo-ie-fault-")); const first=yearlyBundle(cacheDir,[2500]);
    await storeMissouriMecOutsideSpendingArtifactBundle(first); const pointer=await readFile(join(cacheDir,"_outside/2026/registered-ie-current.json"),"utf8");
    io.beforeWrite=async path=>{if(path.includes(fragment))throw new Error("synthetic_storage_failure");};
    try { await expect(storeMissouriMecOutsideSpendingArtifactBundle(yearlyBundle(cacheDir,[3000,4000]))).rejects.toThrow("Missouri MEC yearly outside source publication failed"); }
    finally {io.beforeWrite=undefined;}
    expect(await readFile(join(cacheDir,"_outside/2026/registered-ie-current.json"),"utf8")).toBe(pointer);
    expect((await readMissouriMecQualifiedOutsideSpendingArtifacts(first)).rows[0]!.amountCents).toBe(2500);
  });
  it("same-timestamp concurrent publishers never mix annual export and auxiliary identities", async () => {
    const cacheDir=await mkdtemp(join(tmpdir(),"mo-ie-concurrent-"));
    await Promise.all([storeMissouriMecOutsideSpendingArtifactBundle(yearlyBundle(cacheDir,[2500],"C111111")),storeMissouriMecOutsideSpendingArtifactBundle(yearlyBundle(cacheDir,[3000],"C222222"))]);
    const read=await readMissouriMecQualifiedOutsideSpendingArtifacts({cacheDir,year:2026});
    if (read.sourceKind !== "grid_reconciled_export") throw new Error("expected grid source");
    expect(read.identities[0]!.mecid).toBe(read.rows[0]!.amountCents===2500?"C111111":"C222222");
  });
  it("a reader already resolving one generation stays coherent across pointer replacement", async () => {
    const cacheDir=await mkdtemp(join(tmpdir(),"mo-ie-reader-"));const first=yearlyBundle(cacheDir,[2500],"C111111");
    await storeMissouriMecOutsideSpendingArtifactBundle(first);const root=await yearlyRoot(cacheDir);
    let release!:()=>void,entered!:()=>void;const barrier=new Promise<void>(r=>{release=r;}),waiting=new Promise<void>(r=>{entered=r;});
    io.beforeRead=async path=>{if(path===join(root,"_outside/2026/outside_spending.xls.html")){entered();await barrier;}};
    const pending=readMissouriMecQualifiedOutsideSpendingArtifacts(first);await waiting;
    await storeMissouriMecOutsideSpendingArtifactBundle(yearlyBundle(cacheDir,[3000],"C222222"));release();
    const old=await pending;if (old.sourceKind !== "grid_reconciled_export") throw new Error("expected grid source");expect(old.rows[0]!.amountCents).toBe(2500);expect(old.identities[0]!.mecid).toBe("C111111");
    io.beforeRead=undefined;expect((await readMissouriMecQualifiedOutsideSpendingArtifacts(first)).rows[0]!.amountCents).toBe(3000);
  });
  it("revalidates exact raw controls and cannot fall back to loose artifacts after corruption", async () => {
    const cacheDir=await mkdtemp(join(tmpdir(),"mo-ie-corruption-"));const b=yearlyBundle(cacheDir);await storeMissouriMecOutsideSpendingArtifactBundle(b);
    await storeMissouriMecOutsideSpendingArtifacts({...b,exportBody:b.exportBody.replace("$25.00","$99.00")});
    const root=await yearlyRoot(cacheDir);const raw=b.resultsBody.replace("1 records found","2 records found");await writeFile(join(root,"results.html"),raw);
    const meta=JSON.parse(await readFile(join(root,"qualification.json"),"utf8"));meta.files[0].sha256=createHash("sha256").update(raw).digest("hex");meta.files[0].byteSize=Buffer.byteLength(raw);await writeFile(join(root,"qualification.json"),JSON.stringify(meta));
    await expect(readMissouriMecQualifiedOutsideSpendingArtifacts(b)).rejects.toThrow("failed qualification");
    await expect(readMissouriMecOutsideSpendingArtifacts(b)).rejects.toThrow("failed qualification");
  });
  it("requires a native generation for new money while retaining explicit loose legacy compatibility", async () => {
    const cacheDir=await mkdtemp(join(tmpdir(),"mo-ie-legacy-"));const b=yearlyBundle(cacheDir);await storeMissouriMecOutsideSpendingArtifacts(b);
    await expect(readMissouriMecOutsideSpendingArtifacts(b)).resolves.toMatchObject({rows:[{amountCents:2500}]});
    await expect(readMissouriMecQualifiedOutsideSpendingArtifacts(b)).rejects.toThrow("Missing qualified");
  });
});

function snapshotBundle(cacheDir: string, amounts = [2500]) {
  const b=yearlyBundle(cacheDir,amounts);
  return {...b,resultsBody:`<select id="ctl00_ContentPlaceHolder_ddYear"><option value="2025">2025</option><option selected="selected" value="2026">2026</option></select>${b.resultsBody}<input type="submit" value="Export Results to Excel">`};
}
async function snapshotRoot(cacheDir: string) {
  const pointer=JSON.parse(await readFile(join(cacheDir,"_outside/2026/registered-ie-export-current.json"),"utf8"));
  return join(cacheDir,"_outside/2026/registered-ie-export-generations",pointer.generation);
}
describe("native export snapshot financial source",()=>{
  it("retains original occurrences/provenance without an identity or grid-enumeration claim",async()=>{
    const cacheDir=await mkdtemp(join(tmpdir(),"mo-ie-export-"));const b=snapshotBundle(cacheDir,[2500,2500]);
    await storeMissouriMecOutsideSpendingExportSnapshot(b);
    const source=await readMissouriMecQualifiedOutsideSpendingArtifacts(b);
    expect(source.sourceKind).toBe("native_export_snapshot");expect(source.rows.map(r=>r.amountCents)).toEqual([2500,2500]);
    expect(source.sourcePageCount).toBeNull();expect("identities" in source).toBe(false);
    expect(source.sourceRetrievedAt).toBe(b.retrievedAt.toISOString());expect(source.sourceSha256).toBe(createHash("sha256").update(b.exportBody).digest("hex"));
    expect(source.sourceByteSize).toBe(Buffer.byteLength(b.exportBody));expect(source.sourceControls).toEqual([{file:"results.html",sha256:createHash("sha256").update(b.resultsBody).digest("hex"),byteSize:Buffer.byteLength(b.resultsBody)}]);
    await expect(readMissouriMecOutsideSpendingArtifacts(b)).rejects.toThrow("Missing Missouri MEC artifact");
    const root=await snapshotRoot(cacheDir);expect((await stat(root)).mode&0o777).toBe(0o700);expect((await stat(join(root,"results.html"))).mode&0o777).toBe(0o600);
  });
  it("supports explicit native zero with a complete header-only export",async()=>{
    const cacheDir=await mkdtemp(join(tmpdir(),"mo-ie-export-zero-"));const b=snapshotBundle(cacheDir,[]);
    await storeMissouriMecOutsideSpendingExportSnapshot(b);
    await expect(readMissouriMecQualifiedOutsideSpendingArtifacts(b)).resolves.toMatchObject({sourceKind:"native_export_snapshot",rows:[],sourceRowCount:0,sourcePageCount:null});
  });
  it.each(["wrong_year","missing_year","duplicate_selected","duplicate_year_control","missing_count","conflicting_count","malformed_count","missing_table_close","extra_table","missing_cell_close","unsafe_cents","unknown_stance","invalid_unicode"])("rejects invalid original %s controls before replacing a snapshot",async mode=>{
    const cacheDir=await mkdtemp(join(tmpdir(),"mo-ie-export-controls-"));const b=snapshotBundle(cacheDir);await storeMissouriMecOutsideSpendingExportSnapshot(b);
    const pointer=await readFile(join(cacheDir,"_outside/2026/registered-ie-export-current.json"),"utf8");const bad=snapshotBundle(cacheDir);
    if(mode==="wrong_year")bad.resultsBody=bad.resultsBody.replace('selected="selected" value="2026"','selected="selected" value="2025"');
    if(mode==="missing_year")bad.resultsBody=bad.resultsBody.replace(/<select[\s\S]*?<\/select>/,"");
    if(mode==="duplicate_selected")bad.resultsBody=bad.resultsBody.replace('value="2025"','selected="selected" value="2025"');
    if(mode==="duplicate_year_control")bad.resultsBody+=bad.resultsBody.match(/<select[\s\S]*?<\/select>/)![0];
    if(mode==="missing_count")bad.resultsBody=bad.resultsBody.replace("1 records found","count unavailable");
    if(mode==="conflicting_count")bad.resultsBody+="<span>2 records found</span>";
    if(mode==="malformed_count")bad.resultsBody=bad.resultsBody.replace("1 records found","1,0 records found");
    if(mode==="missing_table_close")bad.exportBody=bad.exportBody.replace("</table>","");
    if(mode==="extra_table")bad.exportBody+="<table></table>";
    if(mode==="missing_cell_close")bad.exportBody=bad.exportBody.replace("</td>","");
    if(mode==="unsafe_cents")bad.exportBody=bad.exportBody.replace("$25.00","$9007199254740992.00");
    if(mode==="unknown_stance")bad.exportBody=bad.exportBody.replace(">Support<",">Unknown Stance<");
    if(mode==="invalid_unicode")bad.resultsBody+="\ud800";
    await expect(storeMissouriMecOutsideSpendingExportSnapshot(bad)).rejects.toThrow("export snapshot failed qualification");
    expect(await readFile(join(cacheDir,"_outside/2026/registered-ie-export-current.json"),"utf8")).toBe(pointer);
  });
  it("accepts selected option attribute order while preserving strict one-year authority",()=>{
    const b=snapshotBundle("unused");b.resultsBody=b.resultsBody.replace('selected="selected" value="2026"','value="2026" selected="selected"');
    expect(()=>qualifyMissouriMecOutsideSpendingExportSnapshot(b)).not.toThrow();
  });
  it("does not weaken the separate strict grid financial guard",async()=>{
    const cacheDir=await mkdtemp(join(tmpdir(),"mo-ie-separate-contract-"));const grid=yearlyBundle(cacheDir,[2500,3000]);
    grid.gridPageBodies[1]=grid.gridPageBodies[1]!.replace("$30.00","$25.00");
    await expect(storeMissouriMecOutsideSpendingArtifactBundle(grid)).rejects.toThrow("failed qualification");
    await storeMissouriMecOutsideSpendingExportSnapshot(snapshotBundle(cacheDir,[2500,3000]));
    await expect(readMissouriMecQualifiedOutsideSpendingArtifacts(grid)).resolves.toMatchObject({sourceKind:"native_export_snapshot",sourceRowCount:2});
    await expect(readMissouriMecOutsideSpendingArtifacts(grid)).rejects.toThrow("Missing Missouri MEC artifact");
  });
  it("prefers a valid snapshot for financial reads but keeps legacy identity packet separate",async()=>{
    const cacheDir=await mkdtemp(join(tmpdir(),"mo-ie-preference-"));await storeMissouriMecOutsideSpendingArtifactBundle(yearlyBundle(cacheDir,[2500],"C123456"));
    await storeMissouriMecOutsideSpendingExportSnapshot(snapshotBundle(cacheDir,[3000]));
    expect((await readMissouriMecQualifiedOutsideSpendingArtifacts({cacheDir,year:2026})).rows[0]!.amountCents).toBe(3000);
    expect((await readMissouriMecOutsideSpendingArtifacts({cacheDir,year:2026})).rows[0]!.amountCents).toBe(2500);
    const root=await snapshotRoot(cacheDir);await writeFile(join(root,"results.html"),"corrupt original control");
    await expect(readMissouriMecQualifiedOutsideSpendingArtifacts({cacheDir,year:2026})).rejects.toThrow("export snapshot failed qualification");
    expect((await readMissouriMecOutsideSpendingArtifacts({cacheDir,year:2026})).rows[0]!.amountCents).toBe(2500);
  });
  it.each(["results.html","qualification.json","registered-ie-export-current.json.tmp-"])("retains prior source on actual staging/publication fault at %s",async fragment=>{
    const cacheDir=await mkdtemp(join(tmpdir(),"mo-ie-export-fault-"));const first=snapshotBundle(cacheDir);await storeMissouriMecOutsideSpendingExportSnapshot(first);
    const pointer=await readFile(join(cacheDir,"_outside/2026/registered-ie-export-current.json"),"utf8");
    io.beforeWrite=async path=>{if(path.includes(fragment))throw new Error("synthetic_disk_failure");};
    try{await expect(storeMissouriMecOutsideSpendingExportSnapshot(snapshotBundle(cacheDir,[3000]))).rejects.toThrow("export snapshot publication failed");}finally{io.beforeWrite=undefined;}
    expect(await readFile(join(cacheDir,"_outside/2026/registered-ie-export-current.json"),"utf8")).toBe(pointer);
    expect((await readMissouriMecQualifiedOutsideSpendingArtifacts(first)).rows[0]!.amountCents).toBe(2500);
  });
  it("same-clock publishers and an in-flight reader see whole immutable snapshots",async()=>{
    const cacheDir=await mkdtemp(join(tmpdir(),"mo-ie-export-concurrent-"));const first=snapshotBundle(cacheDir,[2500]);await storeMissouriMecOutsideSpendingExportSnapshot(first);
    const root=await snapshotRoot(cacheDir);let release!:()=>void,entered!:()=>void;const barrier=new Promise<void>(r=>{release=r;}),waiting=new Promise<void>(r=>{entered=r;});
    io.beforeRead=async path=>{if(path===join(root,"_outside/2026/outside_spending.xls.html")){entered();await barrier;}};
    const pending=readMissouriMecQualifiedOutsideSpendingArtifacts(first);await waiting;
    await Promise.all([storeMissouriMecOutsideSpendingExportSnapshot(snapshotBundle(cacheDir,[3000])),storeMissouriMecOutsideSpendingExportSnapshot(snapshotBundle(cacheDir,[4000]))]);release();
    expect((await pending).rows[0]!.amountCents).toBe(2500);io.beforeRead=undefined;
    const source=await readMissouriMecQualifiedOutsideSpendingArtifacts(first);expect([3000,4000]).toContain(source.rows[0]!.amountCents);
    const expected=snapshotBundle(cacheDir,[source.rows[0]!.amountCents]);expect(source.sourceSha256).toBe(createHash("sha256").update(expected.exportBody).digest("hex"));
  });
  it("rejects invalid original UTF8 even when an internal control hash matches bytes",async()=>{
    const cacheDir=await mkdtemp(join(tmpdir(),"mo-ie-export-utf8-"));const b=snapshotBundle(cacheDir);await storeMissouriMecOutsideSpendingExportSnapshot(b);
    const root=await snapshotRoot(cacheDir),raw=Buffer.from([0xff]);await writeFile(join(root,"results.html"),raw);
    const meta=JSON.parse(await readFile(join(root,"qualification.json"),"utf8"));meta.files[0].sha256=createHash("sha256").update(raw).digest("hex");meta.files[0].byteSize=raw.length;await writeFile(join(root,"qualification.json"),JSON.stringify(meta));
    await expect(readMissouriMecQualifiedOutsideSpendingArtifacts(b)).rejects.toThrow("export snapshot failed qualification");
  });
});
