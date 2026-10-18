import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWashingtonPacSourceProducer } from "../../../src/pipeline/washingtonFinance/washingtonReportedPacCache.js";
import { listDueWashingtonReportedPacReceipts, syncDueWashingtonReportedPacReceipts } from "../../../src/pipeline/washingtonFinance/washingtonReportedPacBatchSync.js";
import { fixture, guid, scope } from "./washingtonReportedPacFixtures.js";
const receiver = { link_id: guid(1), candidate_id: guid(2), election_id: guid(3), election_year: 2026, filer_id: scope.filerId,
  committee_id: scope.committeeId, candidacy_id: "2000", link_source: "pdc_api", candidate_name: "Synthetic Candidate", full_name: "Synthetic Candidate",
  office_scope: "state_lower", office_name: "State Lower Chamber Legislator", district: "1", district_name: "Legislative District 1", ballot_title: null, election_date: "2026-11-03" };
const missing = { ...receiver, source_clock: null, source_manifest: null, source_filer: null, source_committee: null, source_candidate: null,
  source_election: null, last_attempted_at: null, attempt_filer: null, attempt_committee: null, attempt_candidate: null, attempt_election: null, attempt_manifest: null };
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "wa-pac-batch-")); vi.stubEnv("WASHINGTON_CAMPAIGN_FINANCE_ENABLED", "true"); vi.stubEnv("WASHINGTON_REPORTED_PAC_RECEIPTS_ENABLED", "true"); vi.stubEnv("WASHINGTON_PDC_RAW_DATA_REFRESH_ENABLED", "false"); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
function database(rows: unknown[] = [missing]) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("LEFT JOIN public.wa_reported_pac_sources")) return { rows };
    if (sql.includes("SELECT l.id::text link_id")) return { rows: [receiver] };
    if (sql.includes("SELECT id::text,link_status")) return { rows: [{ id: guid(1), link_status: "active" }] };
    return { rows: [] };
  });
  return { db: { query, connect: vi.fn(async () => ({ query, release: vi.fn() })) } as unknown as Pool, query };
}
describe("independent Washington PAC ordinary sync", () => {
  it("selects missing components regardless of legacy freshness with canonical stage/year/window filters", async () => {
    const { db, query } = database(), due = await listDueWashingtonReportedPacReceipts({ db, cacheDir: dir });
    expect(due.rows).toEqual([receiver]); const sql = query.mock.calls[0]![0];
    expect(sql).toContain("e.election_stage='general'"); expect(sql).toContain("extract(year from e.election_date)::int=l.election_year");
    expect(sql).not.toMatch(/legacy\.last_synced_at\s*[<=>]/); expect(due.totalDueRows).toBe(1);
  });
  it("rotates recent held contexts, while refresh bypasses only component/attempt freshness", async () => {
    const { db } = database([{ ...missing, last_attempted_at: new Date().toISOString(), attempt_filer: scope.filerId,
      attempt_committee: scope.committeeId, attempt_candidate: guid(2), attempt_election: guid(3) }]);
    expect((await listDueWashingtonReportedPacReceipts({ db, cacheDir: dir })).rows).toHaveLength(0);
    expect((await listDueWashingtonReportedPacReceipts({ db, cacheDir: dir, refresh: true })).rows).toHaveLength(1);
  });
  it("wakes a newly saved source despite a recent held attempt", async () => {
    await createWashingtonPacSourceProducer({ cacheDir: dir, fetchImpl: fixture().fetchImpl, minimumGapMs: 0 }).refresh(scope);
    const { db } = database([{ ...missing, last_attempted_at: new Date().toISOString(), attempt_filer: scope.filerId,
      attempt_committee: scope.committeeId, attempt_candidate: guid(2), attempt_election: guid(3) }]);
    expect((await listDueWashingtonReportedPacReceipts({ db, cacheDir: dir })).rows).toHaveLength(1);
  });
  it("ordinary saved-source path performs real replay and atomic writing without transport", async () => {
    await createWashingtonPacSourceProducer({ cacheDir: dir, fetchImpl: fixture().fetchImpl, minimumGapMs: 0 }).refresh(scope);
    const { db, query } = database(), result = await syncDueWashingtonReportedPacReceipts({ db, cacheDir: dir });
    expect(result).toMatchObject({ attemptedCount: 1, savedSourceCount: 1, writtenCount: 1, heldCount: 0 });
    expect(query.mock.calls.some(c => c[0].includes("INSERT INTO public.wa_reported_pac_groups"))).toBe(true);
  });
  it("missing source writes only a nonfinancial attempt, never zeros", async () => {
    const { db, query } = database(), result = await syncDueWashingtonReportedPacReceipts({ db, cacheDir: dir });
    expect(result).toMatchObject({ writtenCount: 0, heldCount: 1, holds: { source_unavailable: 1 } });
    expect(query.mock.calls.filter(c => /^(INSERT|UPDATE|DELETE)/.test(c[0])).every(c => c[0].includes("wa_reported_pac_attempts"))).toBe(true);
  });
  it("disabled or dry-run sync performs no financial writes", async () => {
    const { db, query } = database(); vi.stubEnv("WASHINGTON_REPORTED_PAC_RECEIPTS_ENABLED", "false");
    expect((await syncDueWashingtonReportedPacReceipts({ db, cacheDir: dir })).enabled).toBe(false); expect(query).not.toHaveBeenCalled();
    vi.stubEnv("WASHINGTON_REPORTED_PAC_RECEIPTS_ENABLED", "true"); await syncDueWashingtonReportedPacReceipts({ db, cacheDir: dir, dryRun: true });
    expect(query.mock.calls.some(c => /^(INSERT|UPDATE|DELETE)/.test(c[0]))).toBe(false);
  });
});
