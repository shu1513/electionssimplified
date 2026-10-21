import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VirginiaOriginalArchive,
  vaFreshOriginal,
  vaHash,
  vaSuccessfulOriginal,
} from "../../../src/pipeline/virginiaFinance/virginiaReportedOriginals.js";
import { VIRGINIA_REPORTED_URLS } from "../../../src/pipeline/virginiaFinance/virginiaReportedNative.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});
const temporary = async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "va-synthetic-originals-"));
  directories.push(directory);
  return directory;
};

describe("Virginia genuine-observation archive", () => {
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
    const archive = new VirginiaOriginalArchive(await temporary()),
      record = await archive.observe(VIRGINIA_REPORTED_URLS.ie);
    expect(record.meta.status).toBe(200);
    expect(record.meta.eof).toBe(false);
    expect(record.raw).toEqual(Buffer.from(prefix));
    expect(record.meta.sha256).toBe(vaHash(prefix));
    expect(vaSuccessfulOriginal(record, "html")).toBe(false);
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
    const archive = new VirginiaOriginalArchive(await temporary()),
      record = await archive.observe(VIRGINIA_REPORTED_URLS.ie);
    expect(vaSuccessfulOriginal(record, "html")).toBe(true);
    expect(
      vaFreshOriginal(
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
  it("rejects unapproved destinations before fetching or creating an archive", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const archive = new VirginiaOriginalArchive(
      join(await temporary(), "not-created"),
    );
    await expect(
      archive.observe("https://example.invalid/source"),
    ).rejects.toThrow("source_origin");
    await expect(
      archive.observe(VIRGINIA_REPORTED_URLS.ie + "?delete=1"),
    ).rejects.toThrow("public_source_scope");
    expect(fetch).not.toHaveBeenCalled();
    await expect(fs.stat(archive.cacheDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
