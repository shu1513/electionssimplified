import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createArkansasVerifiedRawCache, type ArkansasVerifiedRawCapture } from "../../../src/pipeline/arkansasFinance/arkansasVerifiedRawCache.js";

function event(): ArkansasVerifiedRawCapture {
  const bytesRaw = Buffer.from('{"data":{"literal":"line\\nbreak"}}\n');
  return { component: "pac", phase: "native_after", electionYear: 2026, registrationGuid: "source-guid", entityId: "7243",
    raw: { url: "https://api-ethics-disclosures.sos.arkansas.gov/api/PublicTransactionDetails/GetTransactionDetails",
      method: "POST", requestBody: { filerRegistrationGuid: "source-guid", transactionTypeCode: "TCON", pageNumber: 1, pageSize: 1000 },
      startedAt: "2026-10-11T17:00:00Z", endedAt: "2026-10-11T17:00:01Z", status: 200, contentType: "application/json",
      bytes: bytesRaw.length, sha256: createHash("sha256").update(bytesRaw).digest("hex"), bytesRaw } };
}
describe("Arkansas source response cache", () => {
  it("stores exact distinct response bytes and actual phase/request metadata without overwriting generations", async () => {
    const root = await mkdtemp(join(tmpdir(), "arkansas-cache-test-"));
    try {
      const cache = await createArkansasVerifiedRawCache(root), second = await createArkansasVerifiedRawCache(root);
      expect(cache.directory).not.toBe(second.directory);
      const e = event();
      await Promise.all([cache.capture(e), cache.capture({ ...e, phase: "native_before" })]);
      expect(await readFile(join(cache.directory, "000001.body"))).toEqual(e.raw.bytesRaw);
      const metadata = JSON.parse(await readFile(join(cache.directory, "000001.json"), "utf8"));
      expect(metadata).toMatchObject({ phase: "native_after", electionYear: 2026, requestBody: e.raw.requestBody,
        sha256: e.raw.sha256, bodyFile: "000001.body" });
      expect(metadata).not.toHaveProperty("bytesRaw");
      expect(await readdir(cache.directory)).toHaveLength(4);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("rejects altered bytes or length before writing acceptance metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "arkansas-cache-test-"));
    try {
      const cache = await createArkansasVerifiedRawCache(root), e = event();
      await expect(cache.capture({ ...e, raw: { ...e.raw, sha256: "0".repeat(64) } })).rejects.toThrow("hash/length mismatch");
      await expect(cache.capture({ ...e, raw: { ...e.raw, bytes: 1 } })).rejects.toThrow("hash/length mismatch");
      expect(await readdir(cache.directory)).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
