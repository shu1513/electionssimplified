import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NewMexicoOriginalSequence,
  nmPrivateRead,
} from "../../../src/pipeline/newMexicoFinance/newMexicoReportedOriginals.js";
import { NM_REPORTED_PATHS } from "../../../src/pipeline/newMexicoFinance/newMexicoReportedNative.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
async function root() {
  const value = await fs.mkdtemp(
    join(await fs.realpath(tmpdir()), "nm-native-synthetic-"),
  );
  roots.push(value);
  await fs.chmod(value, 0o700);
  return value;
}
async function capture() {
  const directory = await root(),
    transport = vi.fn(
      async () =>
        new Response('[{"Amount":12.34,"Name":"Synthetic committee"}]', {
          headers: { "content-type": "application/json" },
        }),
    );
  const sequence = await NewMexicoOriginalSequence.capture(
    { kind: "ie", year: 2026, selector: null },
    directory,
    transport,
  );
  const payload = { TransactionType: "IE", ElectionYear: "2026" };
  const result = await sequence.request(
    "ie_opening_1",
    NM_REPORTED_PATHS.transactions,
    payload,
  );
  return {
    directory,
    sequence,
    manifest: sequence.finish(),
    payload,
    result,
    transport,
  };
}
describe("New Mexico immutable native originals", () => {
  it("replays unchanged requests and exact cents, retaining original clocks after mtime changes", async () => {
    const c = await capture();
    await fs.utimes(
      join(c.sequence.directory, c.manifest.records[0]!.file),
      new Date(),
      new Date(),
    );
    const replay = await NewMexicoOriginalSequence.reopen(
      c.sequence.directory,
      c.manifest,
    );
    expect(
      await replay.request(
        "ie_opening_1",
        NM_REPORTED_PATHS.transactions,
        c.payload,
      ),
    ).toEqual(c.result);
    expect(replay.finish()).toEqual(c.manifest);
    expect(c.transport).toHaveBeenCalledTimes(1);
    expect(c.result.value).toEqual([
      { Amount: "12.34", Name: "Synthetic committee" },
    ]);
  });
  it("binds the original POST body and consumes every observation", async () => {
    const c = await capture(),
      replay = await NewMexicoOriginalSequence.reopen(
        c.sequence.directory,
        c.manifest,
      );
    expect(() => replay.finish()).toThrow("unconsumed_originals");
    await expect(
      replay.request("ie_opening_1", NM_REPORTED_PATHS.transactions, {
        ...c.payload,
        ElectionYear: "2024",
      }),
    ).rejects.toThrow("original_post_binding");
  });
  it.each(["status", "eof", "clock", "mime", "hash", "length", "url", "role"])(
    "holds corrupted %s without a replacement fetch",
    async (fault) => {
      const c = await capture(),
        manifest = structuredClone(c.manifest),
        record = manifest.records[0]!;
      if (fault === "status") record.status = 503;
      if (fault === "eof") record.eof = false;
      if (fault === "clock") record.completedAt = "2099-01-01T00:00:00.000Z";
      if (fault === "mime") record.contentType = "text/html";
      if (fault === "hash") record.sha256 = "0".repeat(64);
      if (fault === "length") record.declaredLength = "1";
      if (fault === "url") record.url += "?different=scope";
      if (fault === "role") record.role = "different";
      const replay = await NewMexicoOriginalSequence.reopen(
        c.sequence.directory,
        manifest,
      );
      await expect(
        replay.request(
          "ie_opening_1",
          NM_REPORTED_PATHS.transactions,
          c.payload,
        ),
      ).rejects.toThrow();
      expect(c.transport).toHaveBeenCalledTimes(1);
    },
  );
  it("detects changed raw request bytes even when the replay metadata was left intact", async () => {
    const c = await capture();
    await fs.writeFile(
      join(c.sequence.directory, c.manifest.records[0]!.requestFile!),
      "{}",
      { mode: 0o600 },
    );
    const replay = await NewMexicoOriginalSequence.reopen(
      c.sequence.directory,
      c.manifest,
    );
    await expect(
      replay.request("ie_opening_1", NM_REPORTED_PATHS.transactions, c.payload),
    ).rejects.toThrow("original_post_integrity");
  });
  it("retains failure originals truthfully and cannot finish a complete source from them", async () => {
    const directory = await root(),
      transport = vi.fn(
        async () =>
          new Response("Native source unavailable", {
            status: 503,
            headers: { "content-type": "text/plain" },
          }),
      );
    const sequence = await NewMexicoOriginalSequence.capture(
      { kind: "registry", year: 2026, selector: null },
      directory,
      transport,
    );
    await expect(
      sequence.request("registry_opening_1", NM_REPORTED_PATHS.registry, {
        ElectionYear: "2026",
      }),
    ).rejects.toThrow("original_integrity_or_eof");
    expect(sequence.records[0]).toMatchObject({ status: 503, eof: true });
    expect(
      (
        await nmPrivateRead(join(sequence.directory, sequence.records[0]!.file))
      ).toString(),
    ).toBe("Native source unavailable");
  });
  it("rejects an incomplete response while saving its actual prefix", async () => {
    const directory = await root(),
      body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from("["));
          controller.error(new Error("Synthetic interrupted read"));
        },
      });
    const transport = vi.fn(
      async () =>
        new Response(body, { headers: { "content-type": "application/json" } }),
    );
    const sequence = await NewMexicoOriginalSequence.capture(
      { kind: "ie", year: 2026, selector: null },
      directory,
      transport,
    );
    await expect(
      sequence.request("ie_opening_1", NM_REPORTED_PATHS.transactions, {
        ElectionYear: "2026",
      }),
    ).rejects.toThrow("original_integrity_or_eof");
    expect(sequence.records[0]).toMatchObject({ status: 200, eof: false });
  });
  it("blocks unknown paths, credential-bearing URLs and mutation methods before transport", async () => {
    const c = await capture();
    for (const url of [
      "https://example.invalid/api/Search/TransactionSearchInformation",
      "/api/Registrant/PostContributions",
      "https://user:password@login.cfis.sos.state.nm.us/api/Public/GetExpenditureDetails",
    ])
      await expect(c.sequence.request("bad", url)).rejects.toThrow();
    await expect(
      c.sequence.request("bad", NM_REPORTED_PATHS.expenditure, {}),
    ).rejects.toThrow("source_request_method");
    expect(c.transport).toHaveBeenCalledTimes(1);
  });
  it("holds symlinked and readable-by-others originals", async () => {
    const c = await capture(),
      file = join(c.sequence.directory, c.manifest.records[0]!.file);
    await fs.chmod(file, 0o644);
    await expect(nmPrivateRead(file)).rejects.toThrow("private_original_file");
    await fs.chmod(file, 0o600);
    const link = join(c.directory, "link");
    await fs.symlink(c.sequence.directory, link);
    await expect(
      NewMexicoOriginalSequence.capture(
        { kind: "ie", year: 2026, selector: null },
        link,
      ),
    ).rejects.toThrow("private_directory_symlink");
  });
  it("does not allow a caller to change source scope after capture starts", async () => {
    const directory = await root(),
      scope = { kind: "ie" as const, year: 2026, selector: null };
    const sequence = await NewMexicoOriginalSequence.capture(scope, directory);
    scope.year = 2024;
    expect(sequence.scope.year).toBe(2026);
    expect(Object.isFrozen(sequence.scope)).toBe(true);
  });
});
