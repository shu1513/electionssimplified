import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createOregonVerifiedSourceArtifactCache } from "../../../src/pipeline/oregonFinance/oregonVerifiedSourceArtifactCache.js";
import { hashOregonVerifiedBytes } from "../../../src/pipeline/oregonFinance/oregonVerifiedSourceDecoders.js";
import type { OregonPacRawEvidence } from "../../../src/pipeline/oregonFinance/oregonVerifiedPacSource.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function cache() {
  const path = await mkdtemp(resolve(tmpdir(), "oregon-raw-cache-test-"));
  directories.push(path);
  return { path, ...(await createOregonVerifiedSourceArtifactCache(path)) };
}
const publicUrl = "https://secure.sos.state.or.us/orestar/gotoPublicTransactionDetail.do?tranRsn=5868897";
function evidence(url = publicUrl): OregonPacRawEvidence {
  const bytes = new TextEncoder().encode("Untouched source fixture\n");
  return { bytes, request: { url, method: "GET", requestFields: {}, startedAt: "2026-10-10T15:00:00.000Z",
    endedAt: "2026-10-10T15:00:01.000Z", status: 200, byteCount: bytes.length, sha256: hashOregonVerifiedBytes(bytes) } };
}

describe("Oregon immutable source artifact cache", () => {
  it("returns saved bytes with their original capture interval and hash", async () => {
    const store = await cache(), source = evidence();
    await store.writeCapture({ kind: "public_response", outcome: "complete", evidence: source });
    const saved = await store.readSavedPublicGet(publicUrl);
    expect(saved).toEqual(source);
    expect(saved?.request.startedAt).toBe("2026-10-10T15:00:00.000Z");
    source.bytes[0] = 0;
    source.request.startedAt = "2026-10-11T15:00:00.000Z";
    expect((await store.readSavedPublicGet(publicUrl))?.request.startedAt).toBe("2026-10-10T15:00:00.000Z");
    expect((await store.readSavedPublicGet(publicUrl))?.bytes[0]).toBe("U".charCodeAt(0));
    expect(await readdir(store.generationDir)).toEqual(["000001.body", "000001.json"]);
  });

  it("journals successive observations without overwriting earlier generations", async () => {
    const first = await cache(), source = evidence();
    await first.writeCapture({ kind: "public_response", outcome: "complete", evidence: source });
    const later = await createOregonVerifiedSourceArtifactCache(first.path);
    const fresh = evidence(); fresh.request.startedAt = "2026-10-11T15:00:00.000Z"; fresh.request.endedAt = "2026-10-11T15:00:01.000Z";
    await later.writeCapture({ kind: "public_response", outcome: "complete", evidence: fresh });
    expect(later.generationDir).not.toBe(first.generationDir);
    expect(JSON.parse(await readFile(resolve(first.generationDir, "000001.json"), "utf8")).request.startedAt).toBe(source.request.startedAt);
    expect((await first.readSavedPublicGet(publicUrl))?.request.startedAt).toBe(fresh.request.startedAt);
  });

  it("stores standalone token response metadata without a reusable token body", async () => {
    const store = await cache();
    const tokenBytes = new TextEncoder().encode("OWASP_CSRFTOKEN: synthetic-do-not-save");
    await store.writeCapture({ kind: "credential_metadata", outcome: "complete", request: {
      ...evidence().request, url: "https://secure.sos.state.or.us/orestar/JavaScriptServlet", method: "POST",
      byteCount: tokenBytes.length, sha256: hashOregonVerifiedBytes(tokenBytes),
    } });
    expect(await readdir(store.generationDir)).toEqual(["000001.json"]);
    expect(await readFile(resolve(store.generationDir, "000001.json"), "utf8")).not.toContain("synthetic-do-not-save");
    expect(await readdir(resolve(store.path, "latest"))).toEqual([]);
  });

  it("does not make failed or session-bound responses reusable public evidence", async () => {
    const store = await cache(), source = evidence();
    await store.writeCapture({ kind: "failed_response", outcome: "failed", bytes: source.bytes,
      request: { ...source.request, status: 500 }, failureKind: "http" });
    expect(await store.readSavedPublicGet(publicUrl)).toBeUndefined();
    for (const url of ["https://secure.sos.state.or.us/orestar/XcelCNESearch", "https://secure.sos.state.or.us/orestar/gotoPublicTransactionSearch.do"]) {
      await store.writeCapture({ kind: "public_response", outcome: "complete", evidence: evidence(url) });
      expect(await store.readSavedPublicGet(url)).toBeUndefined();
    }
    expect(await readdir(resolve(store.path, "latest"))).toEqual([]);
  });

  it("preserves actual partial failure bytes and null status without inventing success", async () => {
    const store = await cache(), source = evidence();
    await store.writeCapture({ kind: "failed_response", outcome: "failed", bytes: source.bytes,
      request: { ...source.request, status: null }, failureKind: "transport" });
    const journal = JSON.parse(await readFile(resolve(store.generationDir, "000001.json"), "utf8"));
    expect(journal.request.status).toBeNull();
    expect(journal.outcome).toBe("failed");
    expect(new Uint8Array(await readFile(resolve(store.generationDir, "000001.body")))).toEqual(source.bytes);
    expect(await store.readSavedPublicGet(publicUrl)).toBeUndefined();
  });

  it("treats corrupted bodies, metadata and pointers as missing evidence", async () => {
    const store = await cache(), source = evidence();
    await store.writeCapture({ kind: "public_response", outcome: "complete", evidence: source });
    await writeFile(resolve(store.generationDir, "000001.body"), "changed");
    expect(await store.readSavedPublicGet(publicUrl)).toBeUndefined();
    await writeFile(resolve(store.generationDir, "000001.body"), source.bytes);
    const journalPath = resolve(store.generationDir, "000001.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")); journal.request.url = publicUrl.replace("5868897", "5874824");
    await writeFile(journalPath, JSON.stringify(journal));
    expect(await store.readSavedPublicGet(publicUrl)).toBeUndefined();
    const pointer = resolve(store.path, "latest", `${hashOregonVerifiedBytes(Buffer.from(publicUrl))}.json`);
    await writeFile(pointer, JSON.stringify({ version: 1, generation: "../../outside", record: "000001.json" }));
    expect(await store.readSavedPublicGet(publicUrl)).toBeUndefined();
  });

  it("indexes exact public source IDs, including qualified SOOs, without broad URL aliases", async () => {
    const store = await cache();
    for (const url of ["https://secure.sos.state.or.us/orestar/sooDetail.do?cneCommitteeId=21892", "https://secure.sos.state.or.us/orestar/sooDetail.do?sooRsn=12345", "https://secure.sos.state.or.us/orestar/ceTransactionHistory.do?tranRsn=5868897"]) {
      await store.writeCapture({ kind: "public_response", outcome: "complete", evidence: evidence(url) });
      expect(await store.readSavedPublicGet(url)).toEqual(evidence(url));
    }
    for (const url of [publicUrl + "&tranRsn=5874824", publicUrl + "&OWASP_CSRFTOKEN=secret", publicUrl + "#fragment", publicUrl.replace("secure.sos.state.or.us", "example.org"), publicUrl.replace("5868897", "0")]) {
      expect(await store.readSavedPublicGet(url)).toBeUndefined();
    }
  });

  it("rejects corrupt body metadata and credential-bearing request fields before writing", async () => {
    const store = await cache(), source = evidence(); source.request.byteCount += 1;
    await expect(store.writeCapture({ kind: "public_response", outcome: "complete", evidence: source })).rejects.toThrow("body metadata mismatch");
    const unsafe = evidence(); unsafe.request.requestFields = { OWASP_CSRFTOKEN: "never-persist" };
    await expect(store.writeCapture({ kind: "public_response", outcome: "complete", evidence: unsafe })).rejects.toThrow("credential metadata");
    expect(await readdir(store.generationDir)).toEqual([]);
  });

  it("does not serialize extra headers or environment fields from the caller", async () => {
    const store = await cache(), source = evidence();
    Object.assign(source.request, { headers: { Cookie: "never-persist" }, environment: { DATABASE_URL: "never-persist" } });
    await store.writeCapture({ kind: "public_response", outcome: "complete", evidence: source });
    const journal = await readFile(resolve(store.generationDir, "000001.json"), "utf8");
    expect(journal).not.toContain("never-persist");
    expect(journal).not.toContain("DATABASE_URL");
  });

  it("rejects credential-bearing URLs and plain CSRF fields before journaling", async () => {
    const store = await cache();
    for (const url of [publicUrl + "&csrf=never-persist", publicUrl + "&session=never-persist",
      publicUrl.replace(".do?", ".do;JSESSIONID=never-persist?"),
      publicUrl.replace("https://", "https://secret:never-persist@")]) {
      await expect(store.writeCapture({ kind: "public_response", outcome: "complete", evidence: evidence(url) }))
        .rejects.toThrow("credential metadata");
    }
    const unsafe = evidence(); unsafe.request.requestFields = { csrf: "never-persist" };
    await expect(store.writeCapture({ kind: "public_response", outcome: "complete", evidence: unsafe }))
      .rejects.toThrow("credential metadata");
    expect(await readdir(store.generationDir)).toEqual([]);
  });
});
