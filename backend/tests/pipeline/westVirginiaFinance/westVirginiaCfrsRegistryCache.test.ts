import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readWestVirginiaCommitteeRegistryArtifact,
  refreshWestVirginiaCommitteeRegistryArtifact,
} from "../../../src/pipeline/westVirginiaFinance/westVirginiaCfrsRegistryCache.js";
import type { WestVirginiaCommitteeRow } from "../../../src/pipeline/westVirginiaFinance/westVirginiaCfrsClient.js";

const directories: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "voteapp-wv-registry-"));
  directories.push(path);
  return path;
}
function row(overrides: Partial<WestVirginiaCommitteeRow> = {}): WestVirginiaCommitteeRow {
  return {
    orgID: 1446, entityId: "1020001446", orgName: "UMWA PAC", candidateName: null,
    orgType: "State Political Action Committee", orgTypeCode: "102", orgSubType: "Regular PAC",
    office: null, district: null, party: null, election: "2018 Election",
    registrationYear: "2018", orgStatus: "Active", ...overrides,
  };
}
function refresh(cacheDir: string, rows: WestVirginiaCommitteeRow[] = [row()]) {
  return refreshWestVirginiaCommitteeRegistryArtifact({ cacheDir, fetchCommittees: vi.fn(async () => rows),
    now: new Date("2026-10-11T12:00:00Z") });
}
function response(rows: WestVirginiaCommitteeRow[], totalRecords: number) {
  return new Response(JSON.stringify({ isSuccess: true, responseData: { totalRecords, data: rows } }),
    { status: 200, headers: { "content-type": "application/json" } });
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("West Virginia full committee registry cache", () => {
  it("retains all statuses, old elections, duplicate aliases, conflicting types and future types", async () => {
    const cacheDir = await directory();
    const rows = [
      row(), row(), row({ orgTypeCode: "101", orgType: "State Candidate", orgStatus: "Terminated" }),
      row({ entityId: "1060001447", orgID: 1447, orgTypeCode: "106", orgType: "Future organization", orgName: null }),
    ];
    const result = await refresh(cacheDir, rows);
    const read = await readWestVirginiaCommitteeRegistryArtifact({ cacheDir });
    expect(read.rows).toHaveLength(4);
    expect(read.rows).toEqual(expect.arrayContaining(rows));
    expect(result.current.recordCount).toBe(4);
    expect(result.current).not.toHaveProperty("year");
    expect(result.current.filePath).toContain(result.current.sha256);
    expect((await stat(cacheDir)).mode & 0o777).toBe(0o700);
    expect((await stat(result.filePath)).mode & 0o777).toBe(0o600);
    expect((await stat(result.metadataPath)).mode & 0o777).toBe(0o600);
  });

  it("fetches the complete unfiltered paginated endpoint and passes client options", async () => {
    const cacheDir = await directory();
    const fetchImpl = vi.fn().mockResolvedValueOnce(response([row()], 2))
      .mockResolvedValueOnce(response([row({ entityId: "1030001447", orgID: 1447, orgTypeCode: "103" })], 2));
    await refreshWestVirginiaCommitteeRegistryArtifact({ cacheDir, clientOptions: { fetchImpl, timeoutMs: 1000 } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.map((call) => JSON.parse(call[1].body))).toEqual([
      { pageNumber: 1, pageSize: 5000 }, { pageNumber: 2, pageSize: 5000 },
    ]);
    expect(String(fetchImpl.mock.calls[0]![0])).toContain("Committee/getPublicCandidatesCommitteeDataList");
    expect((await readWestVirginiaCommitteeRegistryArtifact({ cacheDir })).rows).toHaveLength(2);
  });

  it("uses stable hashes across row and object-key order while recording fresh retrieval", async () => {
    const cacheDir = await directory();
    const a = row(); const b = row({ entityId: "1030001447", orgID: 1447, orgTypeCode: "103" });
    const first = await refresh(cacheDir, [a, b]);
    const reversed = Object.fromEntries(Object.entries(a).reverse()) as WestVirginiaCommitteeRow;
    const second = await refreshWestVirginiaCommitteeRegistryArtifact({ cacheDir, fetchCommittees: async () => [b, reversed],
      now: new Date("2026-10-12T12:00:00Z") });
    expect(second.status).toBe("unchanged");
    expect(second.filePath).toBe(first.filePath);
    expect(second.current.downloadedAt).toBe("2026-10-12T12:00:00.000Z");
  });

  it("reads without calling the network and rejects missing cache instead of returning []", async () => {
    const cacheDir = await directory();
    await expect(readWestVirginiaCommitteeRegistryArtifact({ cacheDir })).rejects.toThrow("registry cache unavailable");
    await refresh(cacheDir);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network must not be called"));
    expect((await readWestVirginiaCommitteeRegistryArtifact({ cacheDir })).rows).toEqual([row()]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("detects content corruption before returning registry rows", async () => {
    const cacheDir = await directory();
    const result = await refresh(cacheDir);
    await writeFile(result.filePath, (await readFile(result.filePath, "utf8")).replace("UMWA", "XXXX"));
    await expect(readWestVirginiaCommitteeRegistryArtifact({ cacheDir })).rejects.toThrow("checksum mismatch");
  });

  it.each(["request", "scope", "filePath", "recordCount", "bytes", "sourceUrl"] as const)("rejects invalid metadata %s", async (field) => {
    const cacheDir = await directory();
    const result = await refresh(cacheDir);
    const metadata = JSON.parse(await readFile(result.metadataPath, "utf8"));
    const replacements = { request: { pageSize: 5000, electionYear: 2026 }, scope: "active_pacs",
      filePath: join(cacheDir, "..", "outside.json"), recordCount: 999, bytes: 1, sourceUrl: "https://example.test" };
    metadata[field] = replacements[field];
    await writeFile(result.metadataPath, JSON.stringify(metadata));
    await expect(readWestVirginiaCommitteeRegistryArtifact({ cacheDir })).rejects.toThrow(/registry cache/);
  });

  it.each(["request", "scope", "row"] as const)("validates the cached body independently of a matching checksum: %s", async (change) => {
    const cacheDir = await directory();
    const result = await refresh(cacheDir);
    const body = JSON.parse(await readFile(result.filePath, "utf8"));
    if (change === "request") body.request.orgTypeCode = "102";
    if (change === "scope") body.scope = "active_only";
    if (change === "row") delete body.rows[0].orgName;
    const bytes = JSON.stringify(body);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const filePath = join(cacheDir, `REGISTRY.${sha256}.json`);
    await writeFile(filePath, bytes);
    await writeFile(result.metadataPath, JSON.stringify({ ...result.current, sha256, filePath, bytes: Buffer.byteLength(bytes) }));
    await expect(readWestVirginiaCommitteeRegistryArtifact({ cacheDir })).rejects.toThrow("registry cache unavailable");
  });

  it.each(["empty", "invalid row", "network", "pagination"] as const)("preserves the last good snapshot on failed %s refresh", async (failure) => {
    const cacheDir = await directory();
    const first = await refresh(cacheDir);
    const before = await readFile(first.metadataPath, "utf8");
    if (failure === "network") {
      await expect(refreshWestVirginiaCommitteeRegistryArtifact({ cacheDir, fetchCommittees: async () => { throw new Error("source unavailable"); } })).rejects.toThrow("source unavailable");
    } else if (failure === "pagination") {
      const fetchImpl = vi.fn().mockResolvedValueOnce(response([row()], 2)).mockResolvedValueOnce(response([row()], 3));
      await expect(refreshWestVirginiaCommitteeRegistryArtifact({ cacheDir, clientOptions: { fetchImpl } })).rejects.toThrow("totalRecords changed");
    } else await expect(refresh(cacheDir, failure === "empty" ? [] : [row({ orgStatus: "" })])).rejects.toThrow(/registry/);
    expect(await readFile(first.metadataPath, "utf8")).toBe(before);
    expect((await readWestVirginiaCommitteeRegistryArtifact({ cacheDir })).rows).toEqual([row()]);
  });
});
