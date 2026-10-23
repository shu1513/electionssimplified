import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COLORADO_TRACER_REPORTS,
  ColoradoTracerObservations,
  coloradoSourceUrl,
  coloradoSourceDay,
} from "../../../src/pipeline/coloradoFinance/coloradoTracerObservations.js";

const roots: string[] = [];
const root = async () => {
  const path = await fs.mkdtemp(join(tmpdir(), "co-originals-"));
  await fs.chmod(path, 0o700);
  roots.push(path);
  return path;
};
afterEach(async () => {
  for (const path of roots.splice(0))
    await fs.rm(path, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const fetcher = (body = "native-original") =>
  vi.fn<typeof fetch>().mockImplementation(
    async () =>
      new Response(body, {
        status: 200,
        headers: {
          "Content-Type": "text/html",
          "Content-Length": String(new TextEncoder().encode(body).length),
        },
      }),
  );

describe("Colorado genuine observation sequence", () => {
  it.each([
    ["2026-10-23T01:00:00.000Z", "2026-10-22"],
    ["2026-10-23T06:00:00.000Z", "2026-10-23"],
    ["2026-12-10T06:59:59.000Z", "2026-12-09"],
    ["2026-12-10T07:00:00.000Z", "2026-12-10"],
  ])("uses the agency calendar day for %s", (clock, day) =>
    expect(coloradoSourceDay(clock)).toBe(day),
  );
  it("replays the actual request and complete original without network", async () => {
    const liveFetch = fetcher(),
      live = await ColoradoTracerObservations.create(
        await root(),
        "ie",
        2026,
        liveFetch,
      );
    const first = await live.request("catalog", COLORADO_TRACER_REPORTS);
    await live.finish();
    expect(liveFetch).toHaveBeenCalledTimes(1);
    const saved = await ColoradoTracerObservations.reopen(
        live.directory,
        live.manifest,
      ),
      next = await saved.request("catalog", COLORADO_TRACER_REPORTS);
    await saved.finish();
    expect(next.bytes).toEqual(first.bytes);
    expect(saved.manifest.records[0]!.startedAt).toBe(
      live.manifest.records[0]!.startedAt,
    );
    expect(liveFetch).toHaveBeenCalledTimes(1);
  });
  it("rejects mutated source bytes before consuming a saved original", async () => {
    const live = await ColoradoTracerObservations.create(
      await root(),
      "ie",
      2026,
      fetcher(),
    );
    await live.request("catalog", COLORADO_TRACER_REPORTS);
    await live.finish();
    await fs.writeFile(
      join(live.directory, live.manifest.records[0]!.file),
      "altered",
      { mode: 0o600 },
    );
    const saved = await ColoradoTracerObservations.reopen(
      live.directory,
      live.manifest,
    );
    await expect(
      saved.request("catalog", COLORADO_TRACER_REPORTS),
    ).rejects.toThrow("native_response_integrity");
  });
  it("rejects a changed request even when the response bytes match", async () => {
    const live = await ColoradoTracerObservations.create(
      await root(),
      "candidate",
      2026,
      fetcher(),
    );
    await live.request(
      "search",
      COLORADO_TRACER_REPORTS,
      new URLSearchParams({ selector: "synthetic-a" }),
    );
    await live.finish();
    const saved = await ColoradoTracerObservations.reopen(
      live.directory,
      live.manifest,
    );
    await expect(
      saved.request(
        "search",
        COLORADO_TRACER_REPORTS,
        new URLSearchParams({ selector: "synthetic-b" }),
      ),
    ).rejects.toThrow("saved_native_request_scope");
  });
  it("holds unconsumed originals", async () => {
    const live = await ColoradoTracerObservations.create(
      await root(),
      "ie",
      2026,
      fetcher(),
    );
    await live.request("catalog", COLORADO_TRACER_REPORTS);
    await live.finish();
    const saved = await ColoradoTracerObservations.reopen(
      live.directory,
      live.manifest,
    );
    await expect(saved.finish()).rejects.toThrow("unconsumed_native_originals");
  });
  it("preserves a failed HTTP response without certifying a complete packet", async () => {
    const unavailable = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("unavailable", { status: 503 }));
    const live = await ColoradoTracerObservations.create(
      await root(),
      "ie",
      2026,
      unavailable,
    );
    await expect(
      live.request("catalog", COLORADO_TRACER_REPORTS),
    ).rejects.toThrow("native_response_status");
    expect(live.manifest.complete).toBe(false);
    expect(live.manifest.records[0]).toMatchObject({
      status: 503,
      eof: true,
      bytes: 11,
    });
    expect(
      (await fs.stat(join(live.directory, live.manifest.records[0]!.file)))
        .mode & 0o077,
    ).toBe(0);
  });
  it("rejects a declared-length mismatch and keeps the actual bytes", async () => {
    const short = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("short", {
        status: 200,
        headers: { "Content-Length": "10" },
      }),
    );
    const live = await ColoradoTracerObservations.create(
      await root(),
      "ie",
      2026,
      short,
    );
    await expect(
      live.request("catalog", COLORADO_TRACER_REPORTS),
    ).rejects.toThrow("incomplete_native_response");
    expect(live.manifest.records[0]).toMatchObject({
      bytes: 5,
      declaredLength: "10",
    });
    expect(live.manifest.complete).toBe(false);
  });
  it("rejects a tampered declared length on replay", async () => {
    const live = await ColoradoTracerObservations.create(
      await root(),
      "ie",
      2026,
      fetcher(),
    );
    await live.request("catalog", COLORADO_TRACER_REPORTS);
    await live.finish();
    live.manifest.records[0]!.declaredLength = "1";
    await expect(
      ColoradoTracerObservations.reopen(live.directory, live.manifest),
    ).rejects.toThrow("native_declared_length");
  });
  it("rejects source path traversal and credentials before transport", () => {
    for (const url of [
      "https://example.test/PublicSite/Reports/Reports.aspx",
      "https://secret@tracer.sos.colorado.gov/PublicSite/Reports/Reports.aspx",
      "https://tracer.sos.colorado.gov/login",
      COLORADO_TRACER_REPORTS + "#fragment",
    ])
      expect(() => coloradoSourceUrl(url)).toThrow("native_source_url");
  });
});
