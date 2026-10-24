import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadWisconsinCommitteeCashPacket, type WisconsinCashPacket } from "../../../src/pipeline/wisconsinFinance/wisconsinCommitteeCashSource.js";
import { replaceWisconsinCommitteeCash } from "../../../src/pipeline/wisconsinFinance/wisconsinCommitteeCashWriter.js";
import { context, source } from "./wisconsinCashTestFixture.js";

const paths: string[] = [];
beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }).setSystemTime(new Date("2026-10-24T05:00:00Z")));
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await Promise.all(paths.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function packet() {
  const cacheDir = await mkdtemp(join(tmpdir(), "wi-writer-test-")); paths.push(cacheDir);
  return loadWisconsinCommitteeCashPacket(context, { cacheDir, allowNetwork: true, fetchImpl: source().fetchImpl });
}
function database(options: { contextMatches?: boolean; observedAt?: string; conflictWins?: boolean; insertFails?: boolean } = {}) {
  const query = vi.fn(async (sql: string, _values?: unknown[]) => {
    if (sql.includes("SELECT ce.id")) return { rows: options.contextMatches === false ? [] : [{ id: "membership" }] };
    if (sql.includes("SELECT observed_at")) return { rows: options.observedAt ? [{ observed_at: options.observedAt }] : [] };
    if (sql.includes("INSERT INTO public.wi_candidate_finance_reported_cash_sources")) return { rows: options.conflictWins ? [] : [{ candidate_id: context.candidateId }] };
    if (sql.includes("INSERT INTO public.wi_candidate_finance_reported_cash_donors") && options.insertFails) throw new Error("simulated insert failure");
    return { rows: [] };
  });
  const release = vi.fn(), connect = vi.fn(async () => ({ query, release }));
  return { db: { connect } as unknown as Pool, query, release, connect };
}

describe("Wisconsin reported cash atomic snapshots", () => {
  it("rejects forged packets before any connection", async () => {
    const d = database();
    await expect(replaceWisconsinCommitteeCash(d.db, {} as WisconsinCashPacket)).rejects.toThrow("unverified_packet");
    expect(d.connect).not.toHaveBeenCalled();
  });
  it("rejects a PoolClient even with a verified packet", async () => {
    const p = await packet(), d = database(); (d.db as any).release = vi.fn();
    await expect(replaceWisconsinCommitteeCash(d.db, p)).rejects.toThrow("Pool, not a PoolClient"); expect(d.connect).not.toHaveBeenCalled();
  });
  it("locks canonical identity before atomically storing source and signed donor rows", async () => {
    const p = await packet(), d = database(); expect(await replaceWisconsinCommitteeCash(d.db, p)).toBe(true);
    const sql = d.query.mock.calls.map(c => c[0]);
    expect(sql[0]).toBe("BEGIN"); expect(sql.at(-1)).toBe("COMMIT"); expect(d.release).toHaveBeenCalledTimes(1);
    expect(sql[1]).toContain("FOR UPDATE OF ce FOR SHARE OF c,e,d,o");
    expect(sql[1]).toContain("e.election_stage='general'"); expect(sql[1]).toContain("d.state='WI'");
    expect(sql[1]).toContain("c.last_name=$4"); expect(sql[1]).toContain("e.election_date=$6::date");
    const sourceInsert = d.query.mock.calls.find(c => c[0].includes("INSERT INTO public.wi_candidate_finance_reported_cash_sources"))!;
    expect(sourceInsert[1]?.at(-1)).toBe(95000);
    expect(sourceInsert[0]).toContain("prior.observed_at < EXCLUDED.observed_at");
    const donorInsert = d.query.mock.calls.find(c => c[0].includes("INSERT INTO public.wi_candidate_finance_reported_cash_donors"))!;
    expect(donorInsert[1]).toEqual([context.candidateId,context.electionId,"77","Example Labor PAC",95000,1,"native_registry_class","https://campaignfinance.wi.gov/browse-data/registrant/77"]);
    expect(sql.filter(s => /^(?:INSERT|DELETE|UPDATE)/.test(s.trim())).every(s => s.includes("public.wi_candidate_finance_reported_cash_"))).toBe(true);
  });
  it("rolls back a changed canonical context before touching stored money", async () => {
    const d = database({ contextMatches: false });
    await expect(replaceWisconsinCommitteeCash(d.db, await packet())).rejects.toThrow("canonical_context_changed");
    expect(d.query.mock.calls.map(c => c[0]).at(-1)).toBe("ROLLBACK");
    expect(d.query.mock.calls.some(c => /INSERT|DELETE/.test(c[0]))).toBe(false); expect(d.release).toHaveBeenCalled();
  });
  it("keeps rows and clocks on identical or older observations", async () => {
    const p = await packet();
    for (const observedAt of [p.observedAt, "2026-10-25T00:00:00.000Z"]) {
      const d = database({ observedAt }); expect(await replaceWisconsinCommitteeCash(d.db, p)).toBe(false);
      expect(d.query.mock.calls.some(c => /INSERT|DELETE/.test(c[0]))).toBe(false); expect(d.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    }
  });
  it("does not delete donors if an upsert loses a newer-clock conflict", async () => {
    const d = database({ conflictWins: true }); expect(await replaceWisconsinCommitteeCash(d.db, await packet())).toBe(false);
    expect(d.query.mock.calls.some(c => c[0].includes("DELETE FROM"))).toBe(false); expect(d.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });
  it("rolls back both source and donor replacement on an insert failure", async () => {
    const d = database({ insertFails: true }); await expect(replaceWisconsinCommitteeCash(d.db, await packet())).rejects.toThrow("simulated insert failure");
    expect(d.query.mock.calls.some(c => c[0] === "COMMIT")).toBe(false); expect(d.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK"); expect(d.release).toHaveBeenCalledTimes(1);
  });
});
