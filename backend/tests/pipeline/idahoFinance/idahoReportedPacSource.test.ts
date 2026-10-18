import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { aggregateIdahoPacRows, idPacCents } from "../../../src/pipeline/idahoFinance/idahoReportedPacSource.js";
import { createIdahoPacSourceProducer, isVerifiedIdahoPacSource, readIdahoPacSource, readIdahoPacSourceHint } from "../../../src/pipeline/idahoFinance/idahoReportedPacCache.js";
import { idahoPacFixture, pacReceipt, pacScope } from "./idahoReportedPacFixtures.js";
let cacheDir: string;
beforeEach(async () => { cacheDir = await mkdtemp(join(tmpdir(), "id-pac-source-")); });
afterEach(async () => { await rm(cacheDir, { recursive: true, force: true }); });
async function saved() { const f = idahoPacFixture(), p = createIdahoPacSourceProducer({ cacheDir, fetchImpl: f.fetchImpl, minimumGapMs: 0 }); return { f, p, source: (await p.refresh(pacScope))! }; }
async function manifest() {
  const pointerFile = (await readdir(cacheDir)).find(n => n.endsWith(".latest.json"))!;
  const ref = JSON.parse(await readFile(join(cacheDir, pointerFile), "utf8")), body = JSON.parse(await readFile(join(cacheDir, ref.manifest), "utf8"));
  return { pointerFile, ref, body };
}
describe("Idaho native itemized Political Committee source", () => {
  it("replays nine native requests, including zero paging echoes, exact IDs and signed category closure", async () => {
    const { f, source } = await saved(); expect(source.sourceControls).toHaveLength(9);
    expect(aggregateIdahoPacRows(source.rows)).toMatchObject({ totalCents: 13000, positiveCents: 15000, negativeCents: -2000,
      selectedRowCount: 3, groups: [{ key: "source:10", cents: 13000, rowCount: 3 }] });
    expect(source.categoryCents).toBe(13000); expect(isVerifiedIdahoPacSource(source)).toBe(true);
    expect(isVerifiedIdahoPacSource({ ...source })).toBe(false); expect(Object.isFrozen(source.rows[0])).toBe(true);
    expect(f.requests.filter(r => r.endpoint === "GetContributionsDetails").every(r => r.body.filerRegistrationGuid === null && r.body.transactionTypeCode === "TCON")).toBe(true);
  });
  it("preserves real observation dates through saved replay and advisory hints", async () => {
    const { source } = await saved(), replay = await readIdahoPacSource({ ...pacScope, cacheDir });
    expect(replay?.sourceRetrievedAt).toBe(source.sourceRetrievedAt); expect(replay?.sourceManifestSha256).toBe(source.sourceManifestSha256);
    expect((await readIdahoPacSourceHint({ ...pacScope, cacheDir }))?.retrievedAt).toBe(source.sourceRetrievedAt);
  });
  it("keeps genuine HTTP failure originals without replacing the qualified pointer", async () => {
    const { f, p, source } = await saved(); f.state.status = 503;
    await expect(p.refresh(pacScope)).rejects.toMatchObject({ code: "native_transport_unavailable" });
    expect((await readIdahoPacSource({ ...pacScope, cacheDir }))?.sourceRetrievedAt).toBe(source.sourceRetrievedAt);
    const held = await Promise.all((await readdir(cacheDir)).filter(n => n.startsWith("generation-")).map(async n => JSON.parse(await readFile(join(cacheDir, n, "manifest.json"), "utf8"))));
    expect(held.find(m => m.outcome === "held").records[0].control).toMatchObject({ status: 503, eof: true });
  });
  it("holds successful but incomplete search data against the independent PAC category", async () => {
    const f = idahoPacFixture(); f.state.rows = f.state.rows.slice(0, 1);
    await expect(createIdahoPacSourceProducer({ cacheDir, fetchImpl: f.fetchImpl, minimumGapMs: 0 }).refresh(pacScope)).rejects.toMatchObject({ code: "reported_pac_category_mismatch" });
  });
  it("holds a native receiving-profile district changed from the grid identity", async () => {
    const f = idahoPacFixture(); f.state.profileDistrict = "Legislative, State Senator, Legislative District 11";
    await expect(createIdahoPacSourceProducer({ cacheDir, fetchImpl: f.fetchImpl, minimumGapMs: 0 }).refresh(pacScope)).rejects.toMatchObject({ code: "receiving_profile_district_mismatch" });
  });
  it("does not turn category resource-not-found into zero", async () => {
    const f = idahoPacFixture(); f.state.rows = []; f.state.categoryUnavailable = true;
    await expect(createIdahoPacSourceProducer({ cacheDir, fetchImpl: f.fetchImpl, minimumGapMs: 0 }).refresh(pacScope)).rejects.toMatchObject({ code: "native_envelope_unavailable" });
  });
  it("accepts a qualified empty PAC scope and excludes unitemized receipts explicitly", async () => {
    const f = idahoPacFixture(); f.state.rows = [pacReceipt(1, "Unitemized synthetic", 10, "NITMY")]; f.state.categoryCents = 0;
    const p = (await createIdahoPacSourceProducer({ cacheDir, fetchImpl: f.fetchImpl, minimumGapMs: 0 }).refresh(pacScope))!;
    expect(aggregateIdahoPacRows(p.rows)).toMatchObject({ totalCents: 0, selectedRowCount: 0, excludedPacUnitemizedRows: 1, excludedPacUnitemizedCents: 1000, groups: [] });
  });
  it.each(["changedProfile", "changedSummary", "changedReceipts", "missingFiledSummary"] as const)("holds changed/unavailable %s", async key => {
    const f = idahoPacFixture(); f.state[key] = true;
    await expect(createIdahoPacSourceProducer({ cacheDir, fetchImpl: f.fetchImpl, minimumGapMs: 0 }).refresh(pacScope)).rejects.toBeInstanceOf(Error);
  });
  it("compares complete closing sets independently of date-tie positions", async () => {
    const f = idahoPacFixture(); f.state.reversedClosing = true;
    expect((await createIdahoPacSourceProducer({ cacheDir, fetchImpl: f.fetchImpl, minimumGapMs: 0 }).refresh(pacScope))?.categoryCents).toBe(13000);
  });
  it("rejects duplicated current versions and nested PAC receipts", async () => {
    for (const nested of [false, true]) {
      const f = idahoPacFixture(); if (nested) f.state.rows[0]!.hasChild = true; else f.state.rows.push({ ...f.state.rows[0]! });
      await expect(createIdahoPacSourceProducer({ cacheDir, fetchImpl: f.fetchImpl, minimumGapMs: 0 }).refresh(pacScope)).rejects.toMatchObject({ code: nested ? "unsupported_nested_pac_receipt" : "duplicate_current_occurrence" });
    }
  });
  it("detects original-byte tampering and rehashed request substitution", async () => {
    await saved(); const { pointerFile, ref, body } = await manifest(); const file = join(cacheDir, body.records[4].control.file), original = await readFile(file);
    await writeFile(file, "{}", { mode: 0o600 }); await expect(readIdahoPacSource({ ...pacScope, cacheDir })).rejects.toMatchObject({ code: "original_hash_mismatch" });
    await writeFile(file, original, { mode: 0o600 }); body.records[4].request.body.sourceTypeCode = "TBSN";
    const bytes = Buffer.from(JSON.stringify(body)); await writeFile(join(cacheDir, ref.manifest), bytes, { mode: 0o600 });
    ref.sha256 = createHash("sha256").update(bytes).digest("hex"); await writeFile(join(cacheDir, pointerFile), JSON.stringify(ref), { mode: 0o600 });
    await expect(readIdahoPacSource({ ...pacScope, cacheDir })).rejects.toMatchObject({ code: "request_replay_mismatch" });
  });
  it("keeps complete uncapped entity totals, signed cancellation and safe exact cents", () => {
    expect(aggregateIdahoPacRows(Array.from({ length: 40 }, (_, i) => pacReceipt(i + 1, `Synthetic PAC ${i}`, 10, "ITMY", i + 1))).groups).toHaveLength(40);
    expect(aggregateIdahoPacRows([pacReceipt(), pacReceipt(2, "Synthetic PAC", -100)])).toMatchObject({ totalCents: 0, canceledGroupCount: 1, canceledRowCount: 2, groups: [] });
    expect(() => aggregateIdahoPacRows([pacReceipt(1, "Synthetic PAC", -1)])).toThrow(/negative_reported_pac_balance/);
    expect(idPacCents(0.29)).toBe(29); expect(() => idPacCents(0.001)).toThrow(/invalid_native_money/);
  });
});
