import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { aggregateWashingtonPacRows as aggregate, validateWashingtonPacScope } from "../../../src/pipeline/washingtonFinance/washingtonReportedPacSource.js";
import { createWashingtonPacSourceProducer as producer, isVerifiedWashingtonPacSource, readWashingtonPacSource,
  readWashingtonPacSourceHint } from "../../../src/pipeline/washingtonFinance/washingtonReportedPacCache.js";
import { fixture, receipt, scope } from "./washingtonReportedPacFixtures.js";
let cacheDir: string;
beforeEach(async () => { cacheDir = await mkdtemp(join(tmpdir(), "wa-pac-test-")); });
afterEach(async () => { await rm(cacheDir, { recursive: true, force: true }); });
async function saved() { const f = fixture(), p = producer({ cacheDir, fetchImpl: f.fetchImpl, minimumGapMs: 0 }); return { f, p, source: (await p.refresh(scope))! }; }
async function manifest() {
  const pointerFile = (await readdir(cacheDir)).find(n => n.endsWith(".latest.json"))!;
  const ref = JSON.parse(await readFile(join(cacheDir, pointerFile), "utf8"));
  const body = JSON.parse(await readFile(join(cacheDir, ref.manifest), "utf8")); return { pointerFile, ref, body };
}
describe("Washington current reported PAC source", () => {
  it("preserves opaque filer IDs with repeated spaces instead of normalizing their identity", () => {
    expect(() => validateWashingtonPacScope({ ...scope, filerId: "SYNTH  001" })).not.toThrow();
    expect(() => validateWashingtonPacScope({ ...scope, filerId: "SYNTH\n001" })).toThrow();
  });
  it("replays complete native count/page/closing/context evidence and applies signed adjustments", async () => {
    const { f, source } = await saved();
    expect(source.sourceControls).toHaveLength(8); expect(source.rows).toHaveLength(3);
    expect(aggregate(source.rows)).toMatchObject({ totalCents: 13000, positiveCents: 15000, negativeCents: -2000,
      sourceRowCount: 3, positiveRows: 2, negativeRows: 1, groups: [{ cents: 13000, rowCount: 3 }] });
    expect(f.requests.filter(u => u.searchParams.get("$select")?.startsWith("id,report_number")).every(u => u.searchParams.get("$where")?.includes("code='Political Action Committee'"))).toBe(true);
    expect(isVerifiedWashingtonPacSource(source)).toBe(true); expect(isVerifiedWashingtonPacSource({ ...source })).toBe(false);
    expect(Object.isFrozen(source.rows[0])).toBe(true);
  });
  it("keeps source observation clocks on saved replay rather than assigning the read time", async () => {
    const { source } = await saved(); const replay = await readWashingtonPacSource({ ...scope, cacheDir });
    expect(replay?.sourceRetrievedAt).toBe(source.sourceRetrievedAt); expect(replay?.sourceManifestSha256).toBe(source.sourceManifestSha256);
    expect((await readWashingtonPacSourceHint({ ...scope, cacheDir }))?.retrievedAt).toBe(source.sourceRetrievedAt);
  });
  it("preserves an older qualified generation when a real failure response arrives", async () => {
    const { f, p, source } = await saved(); f.state.status = 503;
    await expect(p.refresh(scope)).rejects.toMatchObject({ code: "native_transport_unavailable" });
    expect((await readWashingtonPacSource({ ...scope, cacheDir }))?.sourceRetrievedAt).toBe(source.sourceRetrievedAt);
    const held = await Promise.all((await readdir(cacheDir)).filter(n => n.startsWith("generation-")).map(async n => JSON.parse(await readFile(join(cacheDir, n, "manifest.json"), "utf8"))));
    expect(held.find(m => m.outcome === "held").records[0].control).toMatchObject({ status: 503, eof: true });
  });
  it("distinguishes a complete empty PAC scope from mini-reporting unavailability", async () => {
    const f = fixture(); f.state.rows = []; const p = producer({ cacheDir, fetchImpl: f.fetchImpl, minimumGapMs: 0 });
    expect(aggregate((await p.refresh(scope))!.rows).totalCents).toBe(0);
    f.state.mini = true; await expect(p.refresh(scope)).rejects.toMatchObject({ code: "itemized_receipts_unavailable" });
  });
  it.each(["summaryChanged", "countChanged", "catalogChanged"] as const)("holds changing %s", async flag => {
    const f = fixture(); f.state[flag] = true;
    await expect(producer({ cacheDir, fetchImpl: f.fetchImpl, minimumGapMs: 0 }).refresh(scope)).rejects.toBeInstanceOf(Error);
    expect(await readWashingtonPacSource({ ...scope, cacheDir })).toBeNull();
  });
  it("rejects a returned business row rather than inferring a PAC from its name", async () => {
    const f = fixture(); f.state.rows[0]!.code = "Business";
    await expect(producer({ cacheDir, fetchImpl: f.fetchImpl, minimumGapMs: 0 }).refresh(scope)).rejects.toMatchObject({ code: "receipt_scope_mismatch" });
  });
  it("rejects duplicate native occurrences before accepting money", async () => {
    const f = fixture(); f.state.rows.push({ ...f.state.rows[0]! });
    await expect(producer({ cacheDir, fetchImpl: f.fetchImpl, minimumGapMs: 0 }).refresh(scope)).rejects.toMatchObject({ code: "duplicate_native_occurrence" });
  });
  it("detects changed original bytes even when the source pointer is unchanged", async () => {
    await saved(); const { body } = await manifest(); await writeFile(join(cacheDir, body.records[3].control.file), "[]", { mode: 0o600 });
    await expect(readWashingtonPacSource({ ...scope, cacheDir })).rejects.toMatchObject({ code: "original_hash_mismatch" });
  });
  it("rejects a rehashed manifest with a different query rather than trusting its replacement hash", async () => {
    await saved(); const { pointerFile, ref, body } = await manifest(); body.records[3].request.params.$where = "code='Business'";
    const b = Buffer.from(JSON.stringify(body)); await writeFile(join(cacheDir, ref.manifest), b, { mode: 0o600 });
    ref.sha256 = createHash("sha256").update(b).digest("hex"); await writeFile(join(cacheDir, pointerFile), JSON.stringify(ref), { mode: 0o600 });
    await expect(readWashingtonPacSource({ ...scope, cacheDir })).rejects.toMatchObject({ code: "request_replay_mismatch" });
  });
  it("retains full counts through canceled groups and refuses contradictory negative balances", () => {
    const a = aggregate([receipt(), receipt("2", "Synthetic PAC", "-100.00", "C.1"), receipt("3", "Another PAC", "20.00", "B.1")]);
    expect(a).toMatchObject({ totalCents: 2000, canceledGroupCount: 1, canceledRowCount: 2, groups: [{ cents: 2000, rowCount: 1 }] });
    expect(() => aggregate([receipt("1", "Synthetic PAC", "-1.00", "C.1")])).toThrow(/negative_reported_pac_balance/);
    expect(() => aggregate([receipt("1", "Synthetic PAC", "-1.00", "C3")])).toThrow(/unsupported_pac_receipt_role/);
  });
  it("never caps large donor sets before full totals", () => {
    const a = aggregate(Array.from({ length: 40 }, (_, i) => receipt(String(i + 1), `Synthetic PAC ${i}`, "10.00")));
    expect(a.totalCents).toBe(40000); expect(a.groups).toHaveLength(40);
  });
});
