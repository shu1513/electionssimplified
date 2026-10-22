import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IndianaNativeOriginalArchive,
  inFreshOriginal,
  inHash,
  inSuccessfulOriginal,
} from "../../../src/pipeline/indianaFinance/indianaNativeOriginals.js";
const sourceUrl="https://campaignfinance.in.gov/PublicSite/SearchPages/ContributionSearch.aspx";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});
const temporary = async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "in-synthetic-originals-"));
  directories.push(directory);
  return directory;
};

describe("Indiana genuine-observation archive", () => {
  it("retains an interrupted HTTP 200 body and refuses to call it financial success", async () => {
    const prefix = new TextEncoder().encode("synthetic partial body");
    let reads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>(
              {
                pull(controller) {
                  if (reads++ === 0) controller.enqueue(prefix);
                  else
                    controller.error(
                      new Error("synthetic interrupted response"),
                    );
                },
              },
              { highWaterMark: 0 },
            ),
            {
              status: 200,
              headers: {
                "content-type": "text/html",
                "content-length": String(prefix.length + 20),
              },
            },
          ),
      ),
    );
    const archive = new IndianaNativeOriginalArchive(await temporary()),
      record = await archive.observe(sourceUrl);
    expect(record.meta.status).toBe(200);
    expect(record.meta.eof).toBe(false);
    expect(record.raw).toEqual(Buffer.from(prefix));
    expect(record.meta.sha256).toBe(inHash(prefix));
    expect(inSuccessfulOriginal(record, "html")).toBe(false);
    const stored = await archive.read();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.raw).toEqual(record.raw);
    expect(stored[0]?.meta.startedAt).toBe(record.meta.startedAt);
  });
  it("checks original integrity and privacy instead of using file timestamps as source clocks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("synthetic complete original", {
            headers: { "content-type": "text/html" },
          }),
      ),
    );
    const archive = new IndianaNativeOriginalArchive(await temporary()),
      record = await archive.observe(sourceUrl);
    expect(inSuccessfulOriginal(record, "html")).toBe(true);
    expect(
      inFreshOriginal(
        record,
        new Date(Date.parse(record.meta.startedAt) + 8 * 86400000),
      ),
    ).toBe(false);
    const path = join(record.directory, record.meta.file);
    await fs.utimes(path, new Date(), new Date());
    expect((await archive.read())[0]?.meta.startedAt).toBe(
      record.meta.startedAt,
    );
    await fs.appendFile(path, "changed synthetic bytes");
    await expect(archive.read()).rejects.toThrow("source_original_integrity");
  });
  it("skips stale originals without loading their bytes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("synthetic complete original", {
            headers: { "content-type": "text/html" },
          }),
      ),
    );
    const archive = new IndianaNativeOriginalArchive(await temporary()),
      record = await archive.observe(sourceUrl),
      manifest = join(record.directory, "manifest.ndjson"),
      shift = (value: string) =>
        new Date(Date.parse(value) - 8 * 86400000).toISOString();
    await fs.writeFile(
      manifest,
      JSON.stringify({
        ...record.meta,
        startedAt: shift(record.meta.startedAt),
        completedAt: shift(record.meta.completedAt),
      }) + "\n",
    );
    // The stale body is corrupt, yet never read: integrity is not checked.
    await fs.appendFile(join(record.directory, record.meta.file), "x");
    expect(await archive.read()).toEqual([]);
  });
  it("rejects unapproved destinations before fetching or creating an archive", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const archive = new IndianaNativeOriginalArchive(
      join(await temporary(), "not-created"),
    );
    await expect(
      archive.observe("https://example.invalid/source"),
    ).rejects.toThrow("invalid_public_origin");
    await expect(
      archive.observe("https://campaignfinance.in.gov/PublicSite/SearchPages/Delete.aspx"),
    ).rejects.toThrow("invalid_public_path");
    expect(fetch).not.toHaveBeenCalled();
    await expect(fs.stat(archive.cacheDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
