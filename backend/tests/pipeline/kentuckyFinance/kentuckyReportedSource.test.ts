import { afterEach, describe, expect, it } from "vitest";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  kyCents,
  parseKentuckyReportedCsv,
  readKentuckyReportedSource,
  isKentuckyReportedPacket,
} from "../../../src/pipeline/kentuckyFinance/kentuckyReportedSource.js";
import { fixture, receipt } from "./kentuckyReportedFixture.js";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
describe("Kentucky reported originals", () => {
  it.each([
    ["$1,234.56", 123456],
    ["($100.00)", -10000],
    ["-$2.05", -205],
    ["0", 0],
  ])("retains signed cents %s", (v, n) => expect(kyCents(String(v))).toBe(n));
  it.each([
    "",
    "NaN",
    "$1,23.00",
    "($-2.00)",
    "1.001",
    "1.1",
    "$9007199254740993.00",
    "($2.00",
    "--2.00",
  ])("holds malformed amount %s", (v) => expect(() => kyCents(v)).toThrow());
  it("retains duplicate occurrences, escaped quotes and embedded newlines", () => {
    const text = 'a,b\r\n"x, y","one\n""two"""\r\n"x, y","one\n""two"""\r\n';
    const rows = parseKentuckyReportedCsv(text, ["a", "b"]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ a: "x, y", b: 'one\n"two"' });
  });
  it.each([
    "a,b\nx\n",
    "a,b\nx,y,z\n",
    'a,b\n"unterminated,y',
    'a,b\n"x"oops,y',
    "a,a\nx,y",
    "b,a\nx,y",
  ])("holds damaged CSV", (text) =>
    expect(() => parseKentuckyReportedCsv(text, ["a", "b"])).toThrow(),
  );
  it("saves full graph and replays unchanged originals, despite reordered ties", async () => {
    const f = await fixture("committee", {
      rows: [receipt(), receipt({ Amount: "($10.00)" })],
      reverseClosing: true,
    });
    cleanups.push(f.cleanup);
    const source = await f.source();
    expect(f.requests()).toBe(16);
    expect(isKentuckyReportedPacket(source)).toBe(true);
    expect(Object.isFrozen(source.rows[0])).toBe(true);
    expect(
      await readKentuckyReportedSource({
        cacheDir: f.cacheDir,
        kind: "committee",
      }),
    ).toEqual(source);
  }, 10_000);
  it("detects changed raw bytes before money", async () => {
    const f = await fixture("ie");
    cleanups.push(f.cleanup);
    const s = await f.source(),
      p = join(f.cacheDir, s.controls[3]!.file);
    await writeFile(p, Buffer.concat([await readFile(p), Buffer.from(" ")]), {
      mode: 0o600,
    });
    await expect(
      readKentuckyReportedSource({ cacheDir: f.cacheDir, kind: "ie" }),
    ).rejects.toThrow("original_hash");
  });
  it.each([{ moveClosing: true }, { badCount: true }, { http: 503 }])(
    "holds moved/incomplete/non-success sources",
    async (options) => {
      const f = await fixture("committee", options);
      cleanups.push(f.cleanup);
      await expect(f.source()).rejects.toThrow();
      await expect(
        readKentuckyReportedSource({ cacheDir: f.cacheDir, kind: "committee" }),
      ).resolves.toBeNull();
    },
  );
  it("failed refresh preserves the previous pointer and source clock", async () => {
    const f = await fixture("ie");
    cleanups.push(f.cleanup);
    const s = await f.source();
    const module =
      await import("../../../src/pipeline/kentuckyFinance/kentuckyReportedSource.js");
    await expect(
      module.refreshKentuckyReportedSource({
        cacheDir: f.cacheDir,
        kind: "ie",
        fetchImpl: async () => new Response("unavailable", { status: 503 }),
      }),
    ).rejects.toThrow();
    expect(
      await readKentuckyReportedSource({ cacheDir: f.cacheDir, kind: "ie" }),
    ).toEqual(s);
  });
  it("holds a deleted original instead of crashing the batch", async () => {
    const f = await fixture("committee");
    cleanups.push(f.cleanup);
    const s = await f.source();
    await rm(join(f.cacheDir, s.controls[3]!.file));
    await expect(
      readKentuckyReportedSource({ cacheDir: f.cacheDir, kind: "committee" }),
    ).rejects.toThrow("cache_missing");
  });
});
