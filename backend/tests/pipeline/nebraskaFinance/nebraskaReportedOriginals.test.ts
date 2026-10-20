import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NebraskaOriginalSequence,
} from "../../../src/pipeline/nebraskaFinance/nebraskaReportedOriginals.js";
import {
  getNebraskaReportedSource,
  isVerifiedNebraskaReportedSource,
} from "../../../src/pipeline/nebraskaFinance/nebraskaReportedSource.js";
import { NEBRASKA_NATIVE_URLS } from "../../../src/pipeline/nebraskaFinance/nebraskaReportedNative.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
async function capture() {
  const root = await fs.mkdtemp(join(tmpdir(), "ne-synthetic-"));
  roots.push(root);
  await fs.chmod(root, 0o700);
  const transport = vi.fn(
    async () =>
      new Response("Synthetic public body", {
        status: 200,
        headers: { "content-type": "text/plain", "content-length": "21" },
      }),
  );
  const sequence = await NebraskaOriginalSequence.capture(
      "ie",
      2026,
      root,
      transport as unknown as typeof fetch,
    ),
    fields = new URLSearchParams({ synthetic: "state" });
  await sequence.request("ie:synthetic", fields);
  return { root, sequence, manifest: sequence.finish(), fields, transport };
}
describe("Nebraska immutable original request replay", () => {
  it("replays a complete saved native empty query before fetch and preserves original clocks after mtime changes", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "ne-synthetic-"));
    roots.push(root);
    await fs.chmod(root, 0o700);
    const transport = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const fields = new URLSearchParams(String(init?.body ?? "")),
        input = (name: string) =>
          `<input name="ctl$${name}$x" value="${fields.get(`ctl$${name}$x`) ?? ""}">`;
      const select = (name: string, ie = false) =>
        `<select name="ctl$${name}$x"><option value=""></option>${ie ? `<option value="ie" ${fields.get(`ctl$${name}$x`) === "ie" ? "selected" : ""}>Independent Expenditure</option>` : ""}</select>`;
      const body = `<form method="post" action="${NEBRASKA_NATIVE_URLS.ie}"><input name="__VIEWSTATE" value="synthetic"><input name="__EVENTVALIDATION" value="synthetic"><input type="button" name="ctl$Expenditure_SearchButton$x">
        ${select("OrganizationCodeHook")}${select("DonorPayeeCodeHook")}${select("DisbursementCodeHook", true)}
        ${["DateFrom", "DateThrough", "FirstName", "LastName", "RegistrationID", "DonorPayeeFirstName", "DonorPayeeLastName", "AmountFrom", "AmountThrough"].map(input).join("")}
        ${init?.method === "POST" ? "<p>Please correct the following errors: No records found for this search criteria.</p>" : ""}</form>`;
      return new Response(body, { headers: { "content-type": "text/html" } });
    });
    const original = await getNebraskaReportedSource({
      kind: "ie",
      year: 2026,
      cacheDir: root,
      transport,
    });
    expect(original.allocations).toEqual([]);
    expect(isVerifiedNebraskaReportedSource(original)).toBe(true);
    expect(transport).toHaveBeenCalledTimes(3);
    await fs.utimes(join(root, "source-ie-2026.json"), new Date(), new Date());
    const saved = await getNebraskaReportedSource({
      kind: "ie",
      year: 2026,
      cacheDir: root,
      transport,
    });
    expect(saved.source).toEqual(original.source);
    expect(transport).toHaveBeenCalledTimes(3);
  });
  it("binds exact request, original bytes and clocks without another request", async () => {
    const { sequence, manifest, fields, transport } = await capture(),
      replay = await NebraskaOriginalSequence.reopen(
        sequence.directory,
        manifest,
      );
    expect((await replay.request("ie:synthetic", fields)).toString()).toBe(
      "Synthetic public body",
    );
    expect(replay.finish()).toEqual(manifest);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("rejects a changed request selector and unconsumed originals", async () => {
    const { sequence, manifest } = await capture(),
      replay = await NebraskaOriginalSequence.reopen(
        sequence.directory,
        manifest,
      );
    expect(() => replay.finish()).toThrow(/unconsumed_source_originals/);
    await expect(
      replay.request(
        "ie:synthetic",
        new URLSearchParams({ synthetic: "changed" }),
      ),
    ).rejects.toThrow(/original_post_binding/);
  });
  it.each(["status", "eof", "clock", "mime", "hash", "length"])(
    "rejects corrupted original %s",
    async (fault) => {
      const { sequence, manifest, fields } = await capture(),
        m = structuredClone(manifest),
        r = m.records[0]!;
      if (fault === "status") r.status = 503;
      if (fault === "eof") r.eof = false;
      if (fault === "clock") r.completedAt = "2099-01-01T00:00:00.000Z";
      if (fault === "mime") r.contentType = "application/json";
      if (fault === "hash") r.sha256 = "0".repeat(64);
      if (fault === "length") r.declaredLength = "1";
      const replay = await NebraskaOriginalSequence.reopen(
        sequence.directory,
        m,
      );
      await expect(replay.request("ie:synthetic", fields)).rejects.toThrow();
    },
  );
  it("rejects changed response bytes even when file mtime is new", async () => {
    const { sequence, manifest, fields } = await capture();
    await fs.writeFile(
      join(sequence.directory, manifest.records[0]!.file),
      "Synthetic altered body",
      { mode: 0o600 },
    );
    const replay = await NebraskaOriginalSequence.reopen(
      sequence.directory,
      manifest,
    );
    await expect(replay.request("ie:synthetic", fields)).rejects.toThrow(
      /original_body_integrity/,
    );
  });
  it("does not grant money authority to a bare DTO or source-health body", async () => {
    expect(
      isVerifiedNebraskaReportedSource({
        kind: "ie",
        year: 2026,
        allocations: [],
      }),
    ).toBe(false);
    const root = await fs.mkdtemp(join(tmpdir(), "ne-synthetic-"));
    roots.push(root);
    await fs.chmod(root, 0o700);
    await expect(
      getNebraskaReportedSource({
        kind: "ie",
        year: 2026,
        cacheDir: root,
        transport: async () =>
          new Response("healthy", {
            headers: { "content-type": "text/plain" },
          }),
      }),
    ).rejects.toThrow(/native_form/);
    expect(await fs.readdir(root)).not.toContain("source-ie-2026.json");
  });
});
