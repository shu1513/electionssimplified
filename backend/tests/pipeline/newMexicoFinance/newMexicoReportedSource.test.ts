import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getNewMexicoReportedSource,
  isVerifiedNewMexicoReportedSource,
} from "../../../src/pipeline/newMexicoFinance/newMexicoReportedSource.js";

const roots: string[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-20T18:00:00.000Z"));
});
afterEach(async () => {
  vi.useRealTimers();
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
async function root() {
  const value = await fs.mkdtemp(
    join(await fs.realpath(tmpdir()), "nm-cache-synthetic-"),
  );
  roots.push(value);
  await fs.chmod(value, 0o700);
  return value;
}
const scope = { kind: "registry" as const, year: 2026, selector: null };
function transport() {
  return vi.fn(
    async () =>
      new Response(
        JSON.stringify([
          {
            IDNumber: "synthetic-native",
            RegistrationId: "synthetic-registration",
            CandidateName: "Avery Sample",
            OfficeName: "GOVERNOR",
            ElectionYear: 2026,
            OfficeId: 1,
            ElectionId: 2,
            DistrictId: 0,
            District: null,
            TotalRows: 1,
          },
        ]),
        { headers: { "content-type": "application/json" } },
      ),
  );
}
describe("New Mexico verified saved-original packets", () => {
  it("seals only replayed complete originals, freezes their contents and rejects lookalike DTOs", async () => {
    const cacheDir = await root(),
      fetcher = transport(),
      packet = await getNewMexicoReportedSource({
        scope,
        cacheDir,
        transport: fetcher,
      });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(isVerifiedNewMexicoReportedSource(packet)).toBe(true);
    expect(isVerifiedNewMexicoReportedSource({ ...packet })).toBe(false);
    expect(
      isVerifiedNewMexicoReportedSource({ ok: true, amountCents: 1234 }),
    ).toBe(false);
    expect(Object.isFrozen(packet)).toBe(true);
    expect(Object.isFrozen(packet.registrations)).toBe(true);
    expect(Object.isFrozen(packet.registrations![0])).toBe(true);
    expect(Object.isFrozen(packet.source.observations[0])).toBe(true);
  });
  it("replays saved originals first and retains source clocks despite newer file mtimes", async () => {
    const cacheDir = await root(),
      fetcher = transport(),
      first = await getNewMexicoReportedSource({
        scope,
        cacheDir,
        transport: fetcher,
      });
    for (const directory of await fs.readdir(cacheDir))
      await fs.utimes(
        join(cacheDir, directory, "manifest.json"),
        new Date("2026-10-21T00:00:00Z"),
        new Date("2026-10-21T00:00:00Z"),
      );
    const second = await getNewMexicoReportedSource({
      scope,
      cacheDir,
      transport: fetcher,
    });
    expect(second.source).toEqual(first.source);
    expect(second.registrations).toEqual(first.registrations);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("acquires fresh originals after corrupt saved bytes, preserving the damaged original", async () => {
    const cacheDir = await root(),
      fetcher = transport();
    await getNewMexicoReportedSource({ scope, cacheDir, transport: fetcher });
    const directory = (await fs.readdir(cacheDir))[0]!,
      file = join(cacheDir, directory, "000001.original");
    await fs.writeFile(file, "[]", { mode: 0o600 });
    const second = await getNewMexicoReportedSource({
      scope,
      cacheDir,
      transport: fetcher,
    });
    expect(isVerifiedNewMexicoReportedSource(second)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(await fs.readFile(file, "utf8")).toBe("[]");
  });
  it("never grants monetary authority to a saved health/success envelope", async () => {
    const cacheDir = await root(),
      directory = join(cacheDir, "packet-00000000-0000-0000-0000-000000000000");
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.writeFile(
      join(directory, "manifest.json"),
      JSON.stringify({
        version: 1,
        scope,
        records: [],
        ok: true,
        amountCents: 999999,
      }),
      { mode: 0o600 },
    );
    const fetcher = vi.fn(async () => {
      throw new Error("Synthetic unavailable source");
    });
    await expect(
      getNewMexicoReportedSource({ scope, cacheDir, transport: fetcher }),
    ).rejects.toThrow("public_fetch_failed");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("honors explicit refresh with new observations rather than retiming old ones", async () => {
    const cacheDir = await root(),
      fetcher = transport(),
      first = await getNewMexicoReportedSource({
        scope,
        cacheDir,
        transport: fetcher,
      });
    vi.setSystemTime(new Date("2026-10-21T18:00:00.000Z"));
    const refreshed = await getNewMexicoReportedSource({
      scope,
      cacheDir,
      refresh: true,
      transport: fetcher,
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(refreshed.source.observedAt).not.toBe(first.source.observedAt);
    expect(first.source.observedAt).toBe("2026-10-20T18:00:00.000Z");
  });
  it("rejects cached observations older than seven days", async () => {
    const cacheDir = await root(),
      fetcher = transport();
    await getNewMexicoReportedSource({ scope, cacheDir, transport: fetcher });
    vi.setSystemTime(new Date("2026-10-28T18:00:00.000Z"));
    await getNewMexicoReportedSource({ scope, cacheDir, transport: fetcher });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});
