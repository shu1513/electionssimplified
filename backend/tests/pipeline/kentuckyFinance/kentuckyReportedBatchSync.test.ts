import { afterEach, describe, expect, it, vi } from "vitest";
import { syncDueKentuckyReportedFinance } from "../../../src/pipeline/kentuckyFinance/kentuckyReportedBatchSync.js";
import {
  isKentuckyReportedCommitteeEnabled,
  isKentuckyReportedIeEnabled,
  isKentuckyReportedRawRefreshEnabled,
} from "../../../src/config/featureFlags.js";
import { parseKentuckyReportedFinanceArgs } from "../../../src/scripts/syncDueKentuckyReportedFinance.js";
import { fixture, receiver } from "./kentuckyReportedFixture.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const c of cleanups.splice(0)) await c();
});
function gates() {
  vi.stubEnv("KENTUCKY_CAMPAIGN_FINANCE_ENABLED", "true");
  vi.stubEnv("KENTUCKY_REPORTED_IE_ENABLED", "true");
  vi.stubEnv("KENTUCKY_REPORTED_COMMITTEE_ENABLED", "true");
  vi.stubEnv("KENTUCKY_REPORTED_RAW_REFRESH_ENABLED", "false");
}
function dryDb(attempts: any[] = []) {
  return {
    connect: vi.fn(async () => {
      throw Error("unexpected_write");
    }),
    query: vi.fn(async (sql: string) => ({
      rows: sql.startsWith("SELECT l.id")
        ? [receiver]
        : sql.includes("FROM public.ky_reported_finance_attempts")
          ? attempts
          : [],
    })),
  };
}
describe("Kentucky independently scheduled source components", () => {
  it("retries changed canonical contexts even when a stored observation is fresh", async () => {
    gates();
    vi.stubEnv("KENTUCKY_REPORTED_COMMITTEE_ENABLED", "false");
    const f = await fixture("ie");
    cleanups.push(f.cleanup);
    const source = await f.source(),
      now = new Date();
    const db = {
      query: vi.fn(async (sql: string) => ({
        rows: sql.startsWith("SELECT l.id")
          ? [receiver]
          : sql.includes("FROM public.ky_reported_finance_components")
            ? [
                {
                  link_id: receiver.linkId,
                  component: "ie",
                  receiver_context: { ...receiver, candidateName: "Old Name" },
                  source_retrieved_at: source.retrievedAt,
                  last_synced_at: now.toISOString(),
                },
              ]
            : [
                {
                  link_id: receiver.linkId,
                  component: "ie",
                  receiver_context: { ...receiver, candidateName: "Old Name" },
                  source_revision: source.manifestHash,
                  last_attempted_at: now.toISOString(),
                },
              ],
      })),
    };
    const result = await syncDueKentuckyReportedFinance({
      db: db as any,
      cacheDir: f.cacheDir,
      dryRun: true,
      now,
    });
    expect(result.selectedCount).toBe(1);
    expect(result.supportCents).toBe(400000);
  });
  it("preserves IE acquisition when the direct cache is malformed", async () => {
    gates();
    const f = await fixture("ie");
    cleanups.push(f.cleanup);
    await f.source();
    await writeFile(join(f.cacheDir, "committee-2026.latest.json"), "{", {
      mode: 0o600,
    });
    const r = await syncDueKentuckyReportedFinance({
      db: dryDb() as any,
      cacheDir: f.cacheDir,
      dryRun: true,
    });
    expect(r.sourceUnavailableCount).toBe(1);
    expect(r.supportCents).toBe(400000);
    expect(r.heldCount).toBe(1);
  });
  it("defaults off and short-circuits all IO under master gate", async () => {
    vi.stubEnv("KENTUCKY_CAMPAIGN_FINANCE_ENABLED", "false");
    vi.stubEnv("KENTUCKY_REPORTED_IE_ENABLED", "true");
    const db = dryDb();
    expect(isKentuckyReportedIeEnabled()).toBe(false);
    expect(isKentuckyReportedCommitteeEnabled()).toBe(false);
    expect(isKentuckyReportedRawRefreshEnabled()).toBe(false);
    const r = await syncDueKentuckyReportedFinance({ db: db as any });
    expect(r.enabled).toBe(false);
    expect(db.query).not.toHaveBeenCalled();
  });
  it("acquires/qualifies IE even when direct source is missing, without any legacy IO", async () => {
    gates();
    const f = await fixture("ie");
    cleanups.push(f.cleanup);
    await f.source();
    const db = dryDb(),
      r = await syncDueKentuckyReportedFinance({
        db: db as any,
        cacheDir: f.cacheDir,
        dryRun: true,
      });
    expect(r.sourceUnavailableCount).toBe(1);
    expect(r.heldCount).toBe(1);
    expect(r.selectedCount).toBe(1);
    expect(r.supportCents).toBe(400000);
    expect(r.groupCount).toBe(1);
    expect(db.connect).not.toHaveBeenCalled();
    expect(
      db.query.mock.calls.every(
        ([sql]) => !sql.includes("ky_candidate_finance_summaries"),
      ),
    ).toBe(true);
  });
  it("backs held components off for 24h per source/context, avoiding starvation", async () => {
    gates();
    const f = await fixture("ie");
    cleanups.push(f.cleanup);
    const s = await f.source(),
      now = new Date(),
      attempts = ["committee", "ie"].map((component) => ({
        link_id: receiver.linkId,
        component,
        source_revision: component === "ie" ? s.manifestHash : "none",
        receiver_context: receiver,
        last_attempted_at: now.toISOString(),
      }));
    const r = await syncDueKentuckyReportedFinance({
      db: dryDb(attempts) as any,
      cacheDir: f.cacheDir,
      now,
      dryRun: true,
    });
    expect(r.selectedCount).toBe(0);
  });
  it("a new source revision retries immediately despite a recent hold", async () => {
    gates();
    const f = await fixture("ie");
    cleanups.push(f.cleanup);
    await f.source();
    const now = new Date(),
      attempts = [
        {
          link_id: receiver.linkId,
          component: "ie",
          source_revision: "0".repeat(64),
          receiver_context: receiver,
          last_attempted_at: now.toISOString(),
        },
      ];
    const r = await syncDueKentuckyReportedFinance({
      db: dryDb(attempts) as any,
      cacheDir: f.cacheDir,
      now,
      dryRun: true,
    });
    expect(r.selectedCount).toBe(1);
    expect(r.supportCents).toBe(400000);
  });
  it("a single component switch avoids the other source entirely", async () => {
    gates();
    vi.stubEnv("KENTUCKY_REPORTED_COMMITTEE_ENABLED", "false");
    const f = await fixture("ie");
    cleanups.push(f.cleanup);
    await f.source();
    const r = await syncDueKentuckyReportedFinance({
      db: dryDb() as any,
      cacheDir: f.cacheDir,
      dryRun: true,
    });
    expect(r.sourceUnavailableCount).toBe(0);
    expect(r.heldCount).toBe(0);
    expect(r.supportCents).toBe(400000);
  });
  it("rejects candidate selectors and unknown/invalid CLI flags", () => {
    expect(
      parseKentuckyReportedFinanceArgs(["--dry-run", "--max-candidates", "25"])
        .maxCandidates,
    ).toBe(25);
    expect(() =>
      parseKentuckyReportedFinanceArgs(["--candidate-id", "example"]),
    ).toThrow();
    expect(() =>
      parseKentuckyReportedFinanceArgs(["--max-candidates", "0"]),
    ).toThrow();
  });
});
