import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  downloadNorthDakotaPresignedFile,
  getNorthDakotaChartData,
  getNorthDakotaDataDownloadCatalog,
  type NorthDakotaCfrsJsonCapture,
} from "../../../src/pipeline/northDakotaFinance/northDakotaCfrsClient.js";

describe("North Dakota native response capture", () => {
  it("never overwrites or deletes an existing immutable download", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "nd-original-")), outputPath = resolve(directory, "original");
    try {
      await writeFile(outputPath, "existing original", { mode: 0o600 });
      await expect(downloadNorthDakotaPresignedFile({ url: "https://example.invalid/file?temporary=secret", outputPath }, { fetchImpl: async () => new Response("new body") })).rejects.toThrow();
      expect(await readFile(outputPath, "utf8")).toBe("existing original");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("keeps temporary query credentials out of network error messages", async () => {
    await expect(downloadNorthDakotaPresignedFile({ url: "https://example.invalid/file?temporary=secret", outputPath: "/unused" }, { fetchImpl: async () => { throw Error("https://example.invalid/file?temporary=secret"); } })).rejects.toThrow("North Dakota CFRS presigned download failed (https://example.invalid/file)");
  });
  it("captures unchanged complete bytes and actual response facts before parsing", async () => {
    const raw = ' {"isSuccess":true,"responseData":[]}\n';
    const captured: NorthDakotaCfrsJsonCapture[] = [];
    expect(await getNorthDakotaChartData("contributions", {
      fetchImpl: async () => new Response(raw, { headers: { "content-type": "application/json" } }),
      onJsonResponse: capture => { captured.push(capture); },
    })).toEqual([]);
    expect(captured).toHaveLength(1);
    expect(new TextDecoder().decode(captured[0]!.bytes)).toBe(raw);
    expect(captured[0]).toMatchObject({ method: "GET", requestBody: null, status: 200, contentType: "application/json" });
    expect(Date.parse(captured[0]!.completedAt)).toBeGreaterThanOrEqual(Date.parse(captured[0]!.startedAt));
  });

  it.each([
    [503, "application/json", '{"isSuccess":false}', "http_error"],
    [200, "text/html", "<html>verification</html>", "bad_response"],
    [200, "application/json", "not json", "bad_response"],
    [200, "application/json", '{"isSuccess":false}', "bad_response"],
  ])("archives a held response before validation rejects it", async (status, mime, raw, code) => {
    const captured: NorthDakotaCfrsJsonCapture[] = [];
    await expect(getNorthDakotaChartData("contributions", {
      fetchImpl: async () => new Response(String(raw), { status: Number(status), headers: { "content-type": String(mime) } }),
      onJsonResponse: capture => { captured.push(capture); },
    })).rejects.toMatchObject({ code });
    expect(captured).toHaveLength(1);
    expect(new TextDecoder().decode(captured[0]!.bytes)).toBe(raw);
  });

  it("does not let an observer mutate response bytes or request interpretation", async () => {
    const raw = '{"isSuccess":true,"responseData":{"totalRecords":0,"data":[]}}';
    let requested: unknown;
    const rows = await getNorthDakotaDataDownloadCatalog({
      fetchImpl: async (_url, init) => { requested = JSON.parse(String(init?.body)); return new Response(raw, { headers: { "content-type": "application/json" } }); },
      onJsonResponse: capture => { capture.bytes.fill(0); capture.requestBody!.pageSize = 1; },
    });
    expect(rows).toEqual([]);
    expect(requested).toEqual({ pageNumber: 1, pageSize: 500 });
  });

  it("fails closed when saving originals fails", async () => {
    await expect(getNorthDakotaChartData("contributions", {
      fetchImpl: async () => new Response('{"isSuccess":true,"responseData":[]}', { headers: { "content-type": "application/json" } }),
      onJsonResponse: async () => { throw new Error("archive_failed"); },
    })).rejects.toThrow("archive_failed");
  });
});
