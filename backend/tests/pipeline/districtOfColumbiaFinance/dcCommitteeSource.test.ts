import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDcCommitteeSource } from "../../../src/pipeline/districtOfColumbiaFinance/dcCommitteeSource.js";
import { DcCommitteeOriginalSequence } from "../../../src/pipeline/districtOfColumbiaFinance/dcCommitteeOriginals.js";
import { syntheticNative, syntheticTransport } from "./dcCommitteeSynthetic.js";
const roots: string[] = [];
async function root() {
  const r = await fs.mkdtemp(join(tmpdir(), "dc-synthetic-"));
  await fs.chmod(r, 0o700);
  roots.push(r);
  return r;
}
afterEach(async () => {
  for (const r of roots.splice(0))
    await fs.rm(r, { recursive: true, force: true });
});
describe("DC genuine-original protocol and replay", () => {
  it("captures full financial/version context and replays before any network access", async () => {
    const cacheDir = await root(),
      fake = syntheticTransport(),
      source = await getDcCommitteeSource({
        year: 2026,
        cacheDir,
        transport: fake.transport,
      });
    expect(source.receipts).toHaveLength(4);
    expect(source.source.registryRows).toBe(1);
    expect(source.parentRows).toBe(2);
    expect(source.source.observations.some((r) => r.status === 302)).toBe(true);
    expect(
      source.source.observations.every(
        (r) => r.eof && r.completedAt >= r.startedAt,
      ),
    ).toBe(true);
    const fail = vi.fn(async () => {
      throw Error("network must not run");
    });
    const saved = await getDcCommitteeSource({
      year: 2026,
      cacheDir,
      transport: fail as typeof fetch,
    });
    expect(fail).not.toHaveBeenCalled();
    expect(saved.source).toEqual(source.source);
    expect(Object.isFrozen(saved.receipts)).toBe(true);
  });
  it("rejects a changed raw original without retiming or replacing the old pointer on failed fetch", async () => {
    const cacheDir = await root(),
      fake = syntheticTransport();
    await getDcCommitteeSource({
      year: 2026,
      cacheDir,
      transport: fake.transport,
    });
    const pointerRaw = await fs.readFile(join(cacheDir, "source-2026.json")),
      pointer = JSON.parse(pointerRaw.toString()),
      directory = join(cacheDir, pointer.directory),
      manifest = JSON.parse(
        await fs.readFile(join(directory, "manifest.json"), "utf8"),
      );
    await fs.appendFile(join(directory, manifest.records[0].file), "tamper");
    const fail = vi.fn(async () => {
      throw Error("unavailable");
    });
    await expect(
      getDcCommitteeSource({
        year: 2026,
        cacheDir,
        transport: fail as typeof fetch,
      }),
    ).rejects.toThrow(/public_fetch_failed/);
    expect(fail).toHaveBeenCalledOnce();
    expect(await fs.readFile(join(cacheDir, "source-2026.json"))).toEqual(
      pointerRaw,
    );
  });
  it("rejects an older financial version despite apparently healthy row counts", async () => {
    const data = syntheticNative();
    data.parents.push({
      ...data.parents[1]!,
      ScheduleMasterId: 3,
      ReportStatus: " Amendment2",
    });
    await expect(
      getDcCommitteeSource({
        year: 2026,
        cacheDir: await root(),
        transport: syntheticTransport(data).transport,
      }),
    ).rejects.toThrow(/current_financial_parent_binding/);
  });
  it("rejects a truncated native population instead of certifying zero", async () => {
    const fake = syntheticTransport(),
      transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const r = await fake.transport(input, init);
        if (String(input).endsWith("/DataDownload/Search")) {
          const v = await r.json();
          v.data.pop();
          return new Response(JSON.stringify(v), {
            headers: { "content-type": "application/json" },
          });
        }
        return r;
      }) as typeof fetch;
    await expect(
      getDcCommitteeSource({ year: 2026, cacheDir: await root(), transport }),
    ).rejects.toThrow(/native_page_population/);
  });
  it("does not fetch an unobserved or foreign route", async () => {
    const fake = syntheticTransport(),
      s = await DcCommitteeOriginalSequence.capture(
        2026,
        await root(),
        fake.transport,
      );
    await expect(
      s.request("foreign", "https://example.org/DataDownload"),
    ).rejects.toThrow(/scope/);
    expect(fake.calls()).toBe(0);
  });
  it("does not accept public originals with widened filesystem permissions", async () => {
    const cacheDir = await root(),
      fake = syntheticTransport();
    await getDcCommitteeSource({
      year: 2026,
      cacheDir,
      transport: fake.transport,
    });
    const p = JSON.parse(
        await fs.readFile(join(cacheDir, "source-2026.json"), "utf8"),
      ),
      dir = join(cacheDir, p.directory),
      m = JSON.parse(await fs.readFile(join(dir, "manifest.json"), "utf8"));
    await fs.chmod(join(dir, m.records[0].file), 0o644);
    await expect(
      getDcCommitteeSource({
        year: 2026,
        cacheDir,
        transport: (async () => {
          throw Error("unavailable");
        }) as typeof fetch,
      }),
    ).rejects.toThrow(/public_fetch_failed/);
  });
});
