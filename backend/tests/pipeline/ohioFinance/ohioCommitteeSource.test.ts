import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureOhioCommitteeSource, isVerifiedOhioCommitteeSource, ohioCommitteeSourceCandidates, ohioCommitteeSourceComponent,
  readOhioCommitteeSource, readOhioCommitteeSourceHint, validateOhioCommitteeSourceFacts } from "../../../src/pipeline/ohioFinance/ohioCommitteeSource.js";
import { makeOhioCommitteeNativeFixture } from "./ohioCommitteeSourceFixtures.js";

let root: string, cacheDir: string, fixture: Awaited<ReturnType<typeof makeOhioCommitteeNativeFixture>>;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "oh-committee-source-")); cacheDir = join(root, "captures"); fixture = await makeOhioCommitteeNativeFixture(root); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const capture = () => captureOhioCommitteeSource({ cycleYear: 2026, cacheDir, nativeCacheDir: fixture.nativeRoot });
describe("Ohio original-byte committee source packets", () => {
  it("replays all seven native roles and brands only the original packet", async () => {
    const p = await capture(); expect(p.sourceControls).toHaveLength(7); expect(isVerifiedOhioCommitteeSource(p)).toBe(true);
    expect(isVerifiedOhioCommitteeSource({ ...p })).toBe(false);
    expect(() => ohioCommitteeSourceComponent({ ...p }, "100")).toThrow(/unverified_source_packet/);
    expect(ohioCommitteeSourceComponent(p, "100")).toMatchObject({ totalCents: 11000, selectedRows: 2, groups: [{ cents: 11000, rowCount: 2 }] });
    expect(Object.isFrozen(ohioCommitteeSourceCandidates(p)[0])).toBe(true);
  });
  it("preserves native observation clocks and reuses an unchanged capture", async () => {
    const p = await capture(), again = await capture();
    expect(p.sourceRetrievedAt).toBe("2026-01-03T00:00:00.000Z"); expect(p.sourceCompletedAt).toBe(p.sourceRetrievedAt);
    expect(again.sourceManifestSha256).toBe(p.sourceManifestSha256);
    expect(() => validateOhioCommitteeSourceFacts(p)).not.toThrow();
  });
  it("replays saved originals without access to the mutable native cache", async () => {
    const p = await capture(); await rm(fixture.nativeRoot, { recursive: true, force: true });
    const saved = (await readOhioCommitteeSource({ cycleYear: 2026, cacheDir }))!;
    expect(saved.sourceManifestSha256).toBe(p.sourceManifestSha256); expect(ohioCommitteeSourceComponent(saved, "100").totalCents).toBe(11000);
  });
  it("keeps oldest freshness and newest version clocks separate for a partial native update", async () => {
    const p = await capture(); await fixture.install(20000, true); const next = await capture();
    expect(next.sourceRetrievedAt).toBe(p.sourceRetrievedAt); expect(next.sourceCompletedAt).toBe("2026-01-04T00:00:00.000Z");
    expect(next.sourceManifestSha256).not.toBe(p.sourceManifestSha256); expect(ohioCommitteeSourceComponent(next, "100").totalCents).toBe(21000);
  });
  it("does not let an advisory pointer authorize changed financial bytes", async () => {
    const p = await capture(), pointer = JSON.parse(await readFile(join(cacheDir, "latest-2026.json"), "utf8")), gen = pointer.manifest.split("/")[0];
    await writeFile(join(cacheDir, gen, "CAC_CON_2026.CSV"), "corrupt", { mode: 0o600 });
    expect((await readOhioCommitteeSourceHint({ cycleYear: 2026, cacheDir }))?.manifestSha256).toBe(p.sourceManifestSha256);
    await expect(readOhioCommitteeSource({ cycleYear: 2026, cacheDir })).rejects.toThrow(/native_original_hash_mismatch/);
    const repaired = await capture(); expect(repaired.sourceManifestSha256).toBe(p.sourceManifestSha256);
    expect(repaired.sourceRetrievedAt).toBe(p.sourceRetrievedAt);
  });
  it("keeps the prior qualified pointer when a new native manifest contradicts its rows", async () => {
    const p = await capture(), path = join(fixture.nativeRoot, "CAC_CON_2026.CSV.manifest.json"), m = JSON.parse(await readFile(path, "utf8"));
    m.rowCount++; await writeFile(path, JSON.stringify(m), { mode: 0o600 });
    await expect(capture()).rejects.toThrow(/native_row_count_mismatch/);
    expect((await readOhioCommitteeSourceHint({ cycleYear: 2026, cacheDir }))?.manifestSha256).toBe(p.sourceManifestSha256);
    expect(ohioCommitteeSourceComponent((await readOhioCommitteeSource({ cycleYear: 2026, cacheDir }))!, "100").totalCents).toBe(11000);
  });
  it("never rounds raw fractional cents into a published contribution", async () => {
    await fixture.install(10000, true, ".145"); const p = await capture();
    expect(() => ohioCommitteeSourceComponent(p, "100")).toThrow(/report_reconciliation_mismatch|invalid_receipt_money/);
  });
});
