import { createHash } from "node:crypto";
import { appendFile, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createNewHampshireReportedSourceProducer, readNewHampshireReportedSource } from "../../../src/pipeline/newHampshireFinance/newHampshireReportedSourceCache.js";
import { aggregateNewHampshireReportedCommitteeReceipts, aggregateNewHampshireReportedIe } from "../../../src/pipeline/newHampshireFinance/newHampshireReportedFinanceAggregation.js";

import { guid, nativeFixture } from "./newHampshireReportedTestFixtures.js";
let cacheDir: string;
beforeEach(async () => { cacheDir = await mkdtemp(join(tmpdir(), "nh-reported-source-test-")); });
afterEach(async () => { await rm(cacheDir, { recursive: true, force: true }); });
async function setup() {
  const fixture = nativeFixture();
  const producer = createNewHampshireReportedSourceProducer({ cacheDir, fetchImpl: fixture.fetchImpl, minimumGapMs: 0 });
  const base = await producer.refreshBase(2026);
  if (!base) throw new Error("Synthetic base missing");
  return { ...fixture, producer, base };
}

describe("New Hampshire immutable reported-source cache", () => {
  it("replays complete native scope, excludes superseded rows and retains uncapped gross committee occurrences", async () => {
    const { producer, base } = await setup();
    const source = await producer.refreshComponent({ kind: "committee", electionYear: 2026, base: base.reference, filingEntityId: 1000 });
    expect(source).toMatchObject({ sourceRowCount: 5, historicalRowCount: 1 });
    expect(aggregateNewHampshireReportedCommitteeReceipts(source!)).toMatchObject({ totalAmountCents: 10000, contributionCount: 2,
      excludedCurrentRowCount: 2, groups: [{ amountCents: 10000, contributionCount: 2 }] });
    expect(source!.sourceControls.every(c => c.eof && c.status === 200)).toBe(true);
    for (const c of source!.sourceControls) expect((await lstat(join(cacheDir, c.file))).mode & 0o777).toBe(0o600);
  });

  it("qualifies IE independently when the receiver has no direct filing inventory", async () => {
    const { producer, base, state } = await setup();
    state.emptyReceiver = true;
    await expect(producer.refreshComponent({ kind: "committee", electionYear: 2026, base: base.reference, filingEntityId: 1000 })).rejects.toMatchObject({ code: "empty_current_inventory" });
    const source = await producer.refreshComponent({ kind: "ie", electionYear: 2026, base: base.reference });
    expect(source).toMatchObject({ sourceRowCount: 2, historicalRowCount: 1 });
    expect(aggregateNewHampshireReportedIe({ source: source!, candidateAliases: ["Candidate, Synthetic"] })).toMatchObject({ supportTotalCents: 1200000, opposeTotalCents: 0, expenditureCount: 1 });
    expect(await readNewHampshireReportedSource({ cacheDir, kind: "committee", electionYear: 2026, filingEntityId: 1000 })).toBeNull();
  });

  it("keeps the last qualified source and original observation clock after transport failure", async () => {
    const { producer, base, state } = await setup();
    const input = { kind: "committee" as const, electionYear: 2026, base: base.reference, filingEntityId: 1000 };
    const first = await producer.refreshComponent(input);
    state.failReceipts = true;
    await expect(producer.refreshComponent(input)).rejects.toMatchObject({ code: "source_transport_unavailable" });
    const saved = await readNewHampshireReportedSource({ ...input, cacheDir });
    expect(saved!.sourceRetrievedAt).toBe(first!.sourceRetrievedAt);
    expect(saved!.sourceManifestSha256).toBe(first!.sourceManifestSha256);
  });

  it("rejects changed closing reports without replacing the qualified pointer", async () => {
    const { producer, base, state } = await setup();
    const input = { kind: "committee" as const, electionYear: 2026, base: base.reference, filingEntityId: 1000 };
    const first = await producer.refreshComponent(input);
    state.changeClosing = true;
    await expect(producer.refreshComponent(input)).rejects.toMatchObject({ code: "closing_inventory_changed" });
    expect((await readNewHampshireReportedSource({ ...input, cacheDir }))!.reference).toEqual(first!.reference);
  });

  it("rejects cross-filer receipts even when the public API ignores a filter", async () => {
    const { producer, base, state } = await setup();
    state.receipts[0]!.filerEntityId = 2000;
    await expect(producer.refreshComponent({ kind: "committee", electionYear: 2026, base: base.reference, filingEntityId: 1000 })).rejects.toMatchObject({ code: "receiver_scope_mismatch" });
  });

  it("holds an empty receipt search even when reports exist", async () => {
    const {producer,base,state}=await setup();state.receipts=[];
    await expect(producer.refreshComponent({kind:"committee",electionYear:2026,base:base.reference,filingEntityId:1000})).rejects.toMatchObject({code:"empty_receipt_inventory"});
  });

  it("checks the receiving registration again before accepting name-filtered receipts", async () => {
    const {producer,base,state}=await setup();state.renameReceiverAfterReceipts=true;
    await expect(producer.refreshComponent({kind:"committee",electionYear:2026,base:base.reference,filingEntityId:1000})).rejects.toMatchObject({code:"registration_inventory_changed"});
  });

  it("holds a paper amendment replacing structured rows instead of treating it as an empty current ledger", async () => {
    const {producer,base,state}=await setup();state.paperAmendment=true;
    state.receipts=state.receipts.filter(row=>row.filerReportVersionId===1);
    await expect(producer.refreshComponent({kind:"committee",electionYear:2026,base:base.reference,filingEntityId:1000})).rejects.toMatchObject({code:"paper_amendment_requires_review"});
  });

  it("holds an empty IE search rather than publishing a statewide zero", async () => {
    const { producer, base, state } = await setup();
    const input = { kind: "ie" as const, electionYear: 2026, base: base.reference };
    const first = await producer.refreshComponent(input);
    state.emptyIe = true;
    await expect(producer.refreshComponent(input)).rejects.toMatchObject({ code: "empty_ie_inventory" });
    expect((await readNewHampshireReportedSource({ ...input, cacheDir }))!.reference).toEqual(first!.reference);
  });

  it("rechecks whole original bytes on every cache read", async () => {
    const { producer, base } = await setup();
    const source = await producer.refreshComponent({ kind: "committee", electionYear: 2026, base: base.reference, filingEntityId: 1000 });
    await appendFile(join(cacheDir, source!.sourceControls.at(-1)!.file), " ");
    await expect(readNewHampshireReportedSource({ cacheDir, kind: "committee", electionYear: 2026, filingEntityId: 1000 })).rejects.toMatchObject({ code: "original_hash_mismatch" });
  });

  it("replays native request selectors rather than trusting a rewritten manifest", async () => {
    const { producer, base } = await setup();
    const source = await producer.refreshComponent({ kind: "committee", electionYear: 2026, base: base.reference, filingEntityId: 1000 });
    const manifestPath = join(cacheDir, source!.reference.manifest);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.records[0].request.body.filerRegistrationGuid = guid(9999);
    const bytes = Buffer.from(JSON.stringify(manifest));
    await writeFile(manifestPath, bytes);
    await writeFile(join(cacheDir, "committee-2026-1000.latest.json"), JSON.stringify({ manifest: source!.reference.manifest,
      sha256: createHash("sha256").update(bytes).digest("hex") }));
    await expect(readNewHampshireReportedSource({ cacheDir, kind: "committee", electionYear: 2026, filingEntityId: 1000 })).rejects.toMatchObject({ code: "request_replay_mismatch" });
  });

  it("holds financial use if a required base original becomes unavailable", async () => {
    const { producer, base } = await setup();
    await producer.refreshComponent({ kind: "ie", electionYear: 2026, base: base.reference });
    await rm(join(cacheDir, base.controls[0]!.file));
    await expect(readNewHampshireReportedSource({ cacheDir, kind: "ie", electionYear: 2026 })).rejects.toMatchObject({ code: "cache_io_unavailable" });
  });

  it("holds ambiguous candidate aliases instead of guessing target identity", async () => {
    const { producer, base } = await setup();
    const source = await producer.refreshComponent({ kind: "ie", electionYear: 2026, base: base.reference });
    expect(() => aggregateNewHampshireReportedIe({ source: source!, candidateAliases: ["Synthetic Candidate"], ambiguousAliases: new Set(["SYNTHETIC CANDIDATE"]) })).toThrow("ambiguous_candidate_target");
  });

  it("rejects copied or mutated packets at the financial aggregation boundary", async () => {
    const { producer, base } = await setup();
    const source = await producer.refreshComponent({ kind: "committee", electionYear: 2026, base: base.reference, filingEntityId: 1000 });
    expect(() => aggregateNewHampshireReportedCommitteeReceipts({ ...source! })).toThrow("aggregation_source_mismatch");
    expect(Object.isFrozen(source)).toBe(true);
    expect(Object.isFrozen(source!.currentRows)).toBe(true);
    expect(() => { source!.currentRows[0]!.transactionAmount = 999; }).toThrow();
  });
});
