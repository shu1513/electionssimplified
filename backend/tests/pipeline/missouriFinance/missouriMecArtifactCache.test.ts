import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  readMissouriMecArtifact,
  readMissouriMecCandidateFinanceArtifacts,
  readMissouriMecCommitteeReceiptArtifacts,
  readMissouriMecOutsideSpendingArtifacts,
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
