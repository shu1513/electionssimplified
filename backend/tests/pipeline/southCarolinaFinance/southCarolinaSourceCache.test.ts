import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSouthCarolinaSourceSession } from "../../../src/pipeline/southCarolinaFinance/southCarolinaSourceCache.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const url = "https://ethicsfiling.sc.gov/api/Ethics/Get/Public/Candidate/Reports";
const init = { method: "POST", body: JSON.stringify({ candidateFilerId: 44315 }) };
async function setup() {
  const cacheDir = await mkdtemp(join(tmpdir(), "sc-source-test-"));
  directories.push(cacheDir);
  return { cacheDir, candidateFilerId: 44315, electionYear: 2026 };
}
function source(body: unknown): typeof fetch {
  return async () => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

describe("South Carolina immutable source observations", () => {
  it("requires independent full observations; preserves bytes and harmless ordering", async () => {
    const scope = await setup();
    const first = await createSouthCarolinaSourceSession({ ...scope, fetchImpl: source([{ id: 1 }, { id: 2 }]) });
    await first.fetchImpl(url, init);
    const opening = await first.finish();
    expect(opening.stablePair).toBe(false);
    const second = await createSouthCarolinaSourceSession({ ...scope, fetchImpl: source([{ id: 2 }, { id: 1 }]) });
    await second.fetchImpl(url, init);
    expect((await second.finish()).stablePair).toBe(true);
    expect((await stat(opening.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(opening.directory, "0000.raw"))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(opening.directory, "0000.raw"), "utf8")).toBe('[{"id":1},{"id":2}]');
  });

  it("retains occurrence multiplicity, full field changes and current version ordering", async () => {
    const scope = await setup();
    for (const [body, stable] of [
      [{ versions: [{ id: 2 }, { id: 1 }], rows: [{ amount: 100 }, { amount: 100 }] }, false],
      [{ versions: [{ id: 2 }, { id: 1 }], rows: [{ amount: 100 }] }, false],
      [{ versions: [{ id: 1 }, { id: 2 }], rows: [{ amount: 100 }] }, false],
      [{ versions: [{ id: 1 }, { id: 2 }], rows: [{ amount: 100, description: "changed" }] }, false],
    ] as const) {
      const session = await createSouthCarolinaSourceSession({ ...scope, fetchImpl: source(body) });
      await session.fetchImpl(url, init);
      expect((await session.finish()).stablePair).toBe(stable);
    }
  });

  it("never indexes incomplete, moved or corrupt observations", async () => {
    const scope = await setup();
    const good = await createSouthCarolinaSourceSession({ ...scope, fetchImpl: source({ id: 1 }) });
    await good.fetchImpl(url, init);
    const accepted = await good.finish();
    const pointerPath = join(scope.cacheDir, "44315-2026", "latest.json");
    const originalPointer = await readFile(pointerPath, "utf8");
    let call = 0;
    const moved = await createSouthCarolinaSourceSession({ ...scope, fetchImpl: async () => source({ id: ++call })(url) });
    await moved.fetchImpl(url, init);
    await moved.fetchImpl(url, init);
    await expect(moved.finish()).rejects.toThrow("changed inside an observation");
    expect(await readFile(pointerPath, "utf8")).toBe(originalPointer);
    await writeFile(join(accepted.directory, "0000.raw"), "corrupt");
    const afterCorruption = await createSouthCarolinaSourceSession({ ...scope, fetchImpl: source({ id: 1 }) });
    await afterCorruption.fetchImpl(url, init);
    const proof = await afterCorruption.finish();
    expect(proof.stablePair).toBe(false);
    expect(proof.diagnostics).toContain("Saved financial observation failed integrity checks");
    expect((await readdir(join(scope.cacheDir, "44315-2026"))).length).toBeGreaterThan(2);
  });
  it("returns valid HTTP bytes on raw write failure but forbids donor acceptance", async () => {
    const scope = await setup();
    const session = await createSouthCarolinaSourceSession({ ...scope, fetchImpl: async () => {
      await rm(scope.cacheDir, { recursive: true, force: true });
      return source({ direct: 100 })(url);
    } });
    expect(await (await session.fetchImpl(url, init)).json()).toEqual({ direct: 100 });
    await expect(session.finish()).rejects.toThrow("raw capture unavailable");
  });
  it.each(["requests", "response bytes", "session bytes"])("capture %s limit preserves HTTP responses and the saved pointer", async limit => {
    const scope = await setup();
    const opening = await createSouthCarolinaSourceSession({ ...scope, fetchImpl: source({ id: 1 }) });
    await opening.fetchImpl(url, init);
    await opening.finish();
    const pointerPath = join(scope.cacheDir, "44315-2026", "latest.json");
    const pointer = await readFile(pointerPath, "utf8");
    const size = limit === "response bytes" ? 9 * 1024 * 1024 : limit === "session bytes" ? 8 * 1024 * 1024 : 8;
    const body = '{"id":1}'.padEnd(size, " ");
    const session = await createSouthCarolinaSourceSession({ ...scope, fetchImpl: async () => {
      let offset = 0;
      return new Response(new ReadableStream({
        pull(controller) {
          if (offset === body.length) { controller.close(); return; }
          const chunk = body.slice(offset, offset + 1024 * 1024);
          offset += chunk.length;
          controller.enqueue(new TextEncoder().encode(chunk));
        },
      }), { headers: { "content-type": "application/json" } });
    } });
    const requests = limit === "requests" ? 31 : limit === "session bytes" ? 8 : 1;
    for (let i = 0; i < requests; i++) {
      expect(await (await session.fetchImpl(url, init)).text()).toBe(body);
    }
    await expect(session.finish()).rejects.toThrow("raw capture unavailable");
    expect(await readFile(pointerPath, "utf8")).toBe(pointer);
    // Later direct requests still work, but no further response is journaled.
    expect(await (await session.fetchImpl(url, init)).text()).toBe(body);
    await expect(session.fetchImpl("https://example.com", init)).rejects.toThrow("outside bounded public scope");
    await expect(session.fetchImpl(url, { ...init, headers: { authorization: "test" } })).rejects.toThrow("unauthenticated");
  });

});
