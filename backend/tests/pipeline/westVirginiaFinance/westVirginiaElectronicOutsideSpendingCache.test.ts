import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  refreshWestVirginiaElectronicOutsideSpendingArtifact as refreshIE,
  readWestVirginiaElectronicOutsideSpendingArtifact as readIE,
} from "../../../src/pipeline/westVirginiaFinance/westVirginiaElectronicOutsideSpendingCache.js";
import { refreshWestVirginiaCommitteeRegistryArtifact } from "../../../src/pipeline/westVirginiaFinance/westVirginiaCfrsRegistryCache.js";
import type { WestVirginiaCommitteeRow, WestVirginiaCurrentFilingRow, WestVirginiaTransactionRow } from
  "../../../src/pipeline/westVirginiaFinance/westVirginiaCfrsClient.js";

const SPENDER: WestVirginiaCommitteeRow = {
  orgID: 2875, entityId: "1040002875", orgName: "West Virginia Strong, Inc.", candidateName: null,
  orgType: "Independent Expenditure Committee", orgTypeCode: "104", orgSubType: "Organization",
  office: null, district: null, party: null, election: "2018 Election", registrationYear: "2022", orgStatus: "Active",
};
const IE: WestVirginiaTransactionRow = {
  transactionID: 562631, entityID: SPENDER.entityId, orgID: 2875, committeeName: SPENDER.orgName, candidateName: null,
  transactionAmount: 897.1, transactionDate: "2026-02-06T00:00:00", filedDate: "2026-04-29T00:00:00",
  entityTypeDesc: "Business or Organization", transactionCategoryDesc: "Monetary", transactionTypeDesc: "Independent Expenditures",
  transactionPurpose: "Direct Mail", contributorPayeeName: "Dunbar Printing", employerName: null, employerOccupation: null,
  transactionTotalYTD: "10192.6200", amendedFlag: false, reportVersionID: "2", reportFileName: "2026 1st Quarter Report",
  s3ReportFilePath: "prd/Reports/2875/9357de47-f931-4240-a6aa-6d15a4cac5c1.pdf", stanceDescription: "Support",
  candidateNameAssocation: "Criss, Vernon", ballotMeasureDescription: null, orgType: SPENDER.orgType, electionYear: 2026,
};
const FILING: WestVirginiaCurrentFilingRow = {
  orgID: 2875, reportID: 32245, reportVersionID: 2, registrantID: SPENDER.entityId, committeeName: SPENDER.orgName!,
  reportFileName: "2026 1st Quarter Report", reportFormType: "Campaign Financial Statement",
  startDate: "2026-01-01T00:00:00", endDate: "2026-03-31T00:00:00", dueDate: "2026-04-07T00:00:00",
  filedDate: "2026-04-29T00:00:00", reportStatus: "Amended", documentBarCode: "F5BA3496AFAF45AE",
};
const directories: string[] = [];
async function setup() {
  const cacheDir = await mkdtemp(join(tmpdir(), "voteapp-wv-ie-"));
  directories.push(cacheDir);
  await refreshWestVirginiaCommitteeRegistryArtifact({ cacheDir, fetchCommittees: async () => [SPENDER] });
  return cacheDir;
}
function acquisition(cacheDir: string) {
  return {
    cacheDir, years: [2026],
    fetchTransactions: vi.fn(async (query: { orgTypeCode: string }) => query.orgTypeCode === "104" ? [IE] : []),
    fetchCurrentFilings: vi.fn(async () => [FILING]),
    now: new Date("2026-10-11T12:00:00Z"),
  };
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("WV coherent electronic IE cache", () => {
  it("harvests every mode/year twice, retains actual IE only, and checks full current manifests around the second harvest", async () => {
    const cacheDir = await setup();
    const fetchTransactions = vi.fn(async ({ orgTypeCode }: { orgTypeCode: string }) => {
      if (orgTypeCode === "102" || orgTypeCode === "104") return [IE];
      return [{ ...IE, transactionTypeDesc: "Expenditures", stanceDescription: null, candidateNameAssocation: null, electionYear: null }];
    });
    const fetchCurrentFilings = vi.fn(async () => [FILING]);
    const result = await refreshIE({ ...acquisition(cacheDir), years: [2026, 2025, 2026], fetchTransactions, fetchCurrentFilings });
    expect(fetchTransactions).toHaveBeenCalledTimes(16);
    expect(fetchTransactions.mock.calls.slice(0, 8).map(([query]) => query)).toEqual(
      [2025, 2026].flatMap((transactionYear) => ["102", "103", "104", "105"].map((orgTypeCode) =>
        ({ transactionYear, orgTypeCode, transactionCategory: "IE", pageSize: 5000 })))
    );
    expect(fetchCurrentFilings).toHaveBeenCalledTimes(2);
    expect(fetchCurrentFilings).toHaveBeenCalledWith({ orgID: 2875, pageSize: 5000 }, undefined);
    const read = await readIE({ cacheDir });
    expect(read.rows).toEqual([IE]); // Four exact query-mode/year copies are one source row.
    expect(read.currentFilingsByOrg.get(2875)).toEqual([FILING]);
    expect(read.registryRows).toEqual([expect.objectContaining({ election: "2018 Election" })]);
    expect(read.metadata.years).toEqual([2025, 2026]);
    expect(read.metadata.queryCounts.before).toHaveLength(8);
    expect(read.metadata.queryCounts.after.filter((query) => query.orgTypeCode === "103"))
      .toEqual([expect.objectContaining({ returnedRowCount: 1, actualIeRowCount: 0 }), expect.objectContaining({ returnedRowCount: 1, actualIeRowCount: 0 })]);
    expect(result.current.recordCount).toBe(1);
    for (const path of [result.filePath, result.metadataPath]) expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("embeds the exact registry generation and stays cache-only when the separate registry later changes", async () => {
    const cacheDir = await setup();
    const result = await refreshIE(acquisition(cacheDir));
    await refreshWestVirginiaCommitteeRegistryArtifact({ cacheDir, fetchCommittees: async () => [{ ...SPENDER, orgName: "New source name" }] });
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no live fetch"));
    const read = await readIE({ cacheDir });
    expect(read.registryRows).toEqual([SPENDER]);
    expect(read.metadata.registrySha256).toBe(result.current.registrySha256);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("allows changing ordinary-query counts while requiring the actual IE snapshot to stay identical", async () => {
    const cacheDir = await setup();
    let calls = 0;
    const result = await refreshIE({ ...acquisition(cacheDir), fetchTransactions: async ({ orgTypeCode }) => {
      const after = calls++ >= 4;
      if (orgTypeCode === "104") return [IE];
      return Array.from({ length: after ? 2 : 1 }, () => ({ ...IE, transactionTypeDesc: "Contributions" }));
    } });
    expect(result.current.queryCounts.before[0]?.returnedRowCount).toBe(1);
    expect(result.current.queryCounts.after[0]?.returnedRowCount).toBe(2);
    expect((await readIE({ cacheDir })).rows).toEqual([IE]);
  });

  it.each(["amount", "new org", "filing version", "filing date", "empty", "network", "missing registry"] as const)
    ("preserves the last complete cache after %s acquisition fails", async (failure) => {
      const cacheDir = await setup();
      const good = await refreshIE(acquisition(cacheDir));
      const pointer = await readFile(good.metadataPath, "utf8");
      const input = acquisition(cacheDir);
      if (failure === "amount" || failure === "new org") {
        let calls = 0;
        input.fetchTransactions = vi.fn(async ({ orgTypeCode }) => {
          const after = calls++ >= 4;
          if (orgTypeCode !== "104") return [];
          return [after ? { ...IE, ...(failure === "amount" ? { transactionAmount: 900 } : { orgID: 3981 }) } : IE];
        });
      } else if (failure === "filing version" || failure === "filing date") {
        let calls = 0;
        input.fetchCurrentFilings = vi.fn(async () => [calls++ === 0 ? FILING : {
          ...FILING, ...(failure === "filing version" ? { reportVersionID: 3 } : { filedDate: "2026-05-01T00:00:00" }),
        }]);
      } else if (failure === "empty") input.fetchTransactions = vi.fn(async () => []);
      else if (failure === "network") input.fetchTransactions = vi.fn(async () => { throw new Error("source down"); });
      else await rm(join(cacheDir, "REGISTRY.metadata.json"));
      await expect(refreshIE(input)).rejects.toThrow();
      expect(await readFile(good.metadataPath, "utf8")).toBe(pointer);
      expect((await readIE({ cacheDir })).rows).toEqual([IE]);
    });

  it("saves an initially empty explicit query generation without representing it as measured outside zero", async () => {
    const cacheDir = await setup();
    const input = acquisition(cacheDir);
    input.fetchTransactions = vi.fn(async () => []);
    const result = await refreshIE(input);
    expect(input.fetchCurrentFilings).not.toHaveBeenCalled();
    expect(result.current.scope).toBe("electronic_regular_report_ie");
    const read = await readIE({ cacheDir });
    expect(read.rows).toEqual([]);
    expect(read.currentFilingsByOrg.size).toBe(0);
    expect(read).not.toHaveProperty("summary");
  });

  it("throws on missing or corrupt cache", async () => {
    const cacheDir = await setup();
    await expect(readIE({ cacheDir })).rejects.toThrow("cache unavailable");
    const good = await refreshIE(acquisition(cacheDir));
    await writeFile(good.filePath, "invalid content");
    await expect(readIE({ cacheDir })).rejects.toThrow("checksum mismatch");
  });

  it.each(["scope", "request", "count", "path", "query coverage"] as const)("validates metadata %s", async (field) => {
    const cacheDir = await setup();
    const good = await refreshIE(acquisition(cacheDir));
    const metadata = JSON.parse(await readFile(good.metadataPath, "utf8"));
    if (field === "scope") metadata.scope = "all_outside";
    if (field === "request") metadata.request.modes = ["104"];
    if (field === "count") metadata.recordCount = 99;
    if (field === "path") metadata.filePath = join(cacheDir, "..", "elsewhere.json");
    if (field === "query coverage") metadata.queryCounts.after.pop();
    await writeFile(good.metadataPath, JSON.stringify(metadata));
    await expect(readIE({ cacheDir })).rejects.toThrow("cache unavailable");
  });

  it.each(["registry", "ordinary row", "wrong org", "invalid date", "duplicate report"] as const)
    ("validates checksum-consistent body %s", async (field) => {
      const cacheDir = await setup();
      const good = await refreshIE(acquisition(cacheDir));
      const body = JSON.parse(await readFile(good.filePath, "utf8"));
      if (field === "registry") body.registryRows[0].orgName = "Tampered";
      if (field === "ordinary row") body.rows[0].transactionTypeDesc = "Expenditures";
      if (field === "wrong org") body.filingsByOrg[0].rows[0].orgID = 3981;
      if (field === "invalid date") body.filingsByOrg[0].rows[0].endDate = "2026-02-30";
      if (field === "duplicate report") body.filingsByOrg[0].rows.push(body.filingsByOrg[0].rows[0]);
      const bytes = JSON.stringify(body);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const filePath = join(cacheDir, "ELECTRONIC_IE." + sha256 + ".json");
      await writeFile(filePath, bytes);
      await writeFile(good.metadataPath, JSON.stringify({ ...good.current, filePath, sha256, bytes: Buffer.byteLength(bytes) }));
      await expect(readIE({ cacheDir })).rejects.toThrow("cache unavailable");
    });
});
