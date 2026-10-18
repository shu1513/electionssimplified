import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireNorthDakotaReportedPacket, type NorthDakotaReportedPacket } from "../../../src/pipeline/northDakotaFinance/northDakotaReportedSource.js";
import { aggregateNorthDakotaReported, northDakotaReportedSourceFacts, validateNorthDakotaReportedClosure, writeNorthDakotaReportedComponent, type NorthDakotaReportedReceiver } from "../../../src/pipeline/northDakotaFinance/northDakotaReportedStore.js";
import { northDakotaReportedCommitteeFixture, northDakotaReportedIeFixture } from "./northDakotaReportedFixture.js";

const receiver: NorthDakotaReportedReceiver = {
  linkId: "11111111-1111-4111-8111-111111111111", candidateId: "22222222-2222-4222-8222-222222222222", electionId: "33333333-3333-4333-8333-333333333333",
  electionYear: 2026, electionDate: "2026-11-03", candidateName: "Jane Example", officeScope: "state_upper", canonicalOffice: "State Senator", canonicalDistrict: "1",
  entityId: "1010000002", committeeName: "Friends of Example", linkSource: "cfrs_registry", linkOffice: "State Senator", linkDistrict: "District 1",
};
let cacheDir: string, source: NorthDakotaReportedPacket;
beforeEach(async () => {
  vi.stubEnv("NORTH_DAKOTA_CAMPAIGN_FINANCE_ENABLED", "true"); vi.stubEnv("NORTH_DAKOTA_CFRS_RAW_DATA_REFRESH_ENABLED", "true");
  cacheDir = await mkdtemp(resolve(tmpdir(), "nd-reported-store-"));
  source = await acquireNorthDakotaReportedPacket("ie", { cacheDir, clientOptions: northDakotaReportedIeFixture() });
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(cacheDir, { recursive: true, force: true }); });
function database(options: { context?: Partial<NorthDakotaReportedReceiver>; prior?: any; groups?: any[]; failInsert?: boolean } = {}) {
  const statements: { sql: string; values: any[] }[] = [];
  const query = vi.fn(async (sql: string, values: any[] = []) => {
    statements.push({ sql, values });
    if (sql.startsWith("SELECT id::text FROM")) return { rows: [{ id: receiver.linkId }] };
    if (sql.startsWith("SELECT l.id::text")) return { rows: [{ ...receiver, ...options.context }] };
    if (sql.startsWith("SELECT * FROM public.nd_reported_finance_components")) return { rows: options.prior ? [options.prior] : [] };
    if (sql.startsWith("SELECT group_key")) return { rows: options.groups ?? [] };
    if (sql.startsWith("INSERT INTO public.nd_reported_finance_groups") && options.failInsert) throw Error("group_insert_failed");
    return { rows: [] };
  });
  const release = vi.fn(), connect = vi.fn(async () => ({ query, release }));
  return { db: { connect } as unknown as Pool, statements, connect, release };
}
function prior() {
  const { groups, ...controls } = aggregateNorthDakotaReported(receiver, source);
  return { row: { source_observed_at: source.sourceAt, receiver_context: receiver, source_facts: northDakotaReportedSourceFacts(source), aggregation_controls: controls }, groups };
}
describe("North Dakota canonical component transactions", () => {
  it("writes independently qualified IE groups and never addresses legacy finance tables", async () => {
    const d = database(), r = await writeNorthDakotaReportedComponent({ db: d.db, receiver, source });
    expect(r).toEqual({ groups: 1, idempotent: false }); expect(d.statements.at(-1)?.sql).toBe("COMMIT"); expect(d.release).toHaveBeenCalledOnce();
    const mutations = d.statements.filter(x => /^(INSERT|DELETE|UPDATE)/.test(x.sql));
    expect(mutations).toHaveLength(3); expect(mutations.every(x => x.sql.includes("nd_reported_finance_"))).toBe(true);
  });
  it("requires canonical office/seat/source identity before connecting", async () => {
    const d = database();
    await expect(writeNorthDakotaReportedComponent({ db: d.db, receiver: { ...receiver, canonicalDistrict: "2" }, source })).rejects.toThrow(/source_receiving_identity/);
    expect(d.connect).not.toHaveBeenCalled();
  });
  it("rechecks canonical context while locked and rolls back a changed receiver", async () => {
    const d = database({ context: { candidateName: "Other Example" } });
    await expect(writeNorthDakotaReportedComponent({ db: d.db, receiver, source })).rejects.toThrow(/canonical_receiver_changed/);
    expect(d.statements.at(-1)?.sql).toBe("ROLLBACK"); expect(d.statements.some(x => x.sql.startsWith("INSERT"))).toBe(false);
  });
  it("rejects older source and preserves all rows", async () => {
    const d = database({ prior: { ...prior().row, source_observed_at: new Date(Date.parse(source.sourceAt) + 1).toISOString() } });
    await expect(writeNorthDakotaReportedComponent({ db: d.db, receiver, source })).rejects.toThrow(/older_source/);
    expect(d.statements.some(x => /^(INSERT|DELETE)/.test(x.sql))).toBe(false);
  });
  it("keeps publication clocks unchanged for an equal verified replay", async () => {
    const p = prior(), d = database({ prior: p.row, groups: p.groups });
    expect(await writeNorthDakotaReportedComponent({ db: d.db, receiver, source })).toEqual({ groups: 1, idempotent: true });
    expect(d.statements.some(x => /^(INSERT|DELETE|UPDATE)/.test(x.sql))).toBe(false);
  });
  it("holds conflicting groups at an equal source clock", async () => {
    const p = prior(), d = database({ prior: p.row, groups: [{ ...p.groups[0], cents: 9999 }] });
    await expect(writeNorthDakotaReportedComponent({ db: d.db, receiver, source })).rejects.toThrow(/equal_source_conflict/);
    expect(d.statements.at(-1)?.sql).toBe("ROLLBACK");
  });
  it("rolls back replacement groups atomically on a database failure", async () => {
    const d = database({ failInsert: true });
    await expect(writeNorthDakotaReportedComponent({ db: d.db, receiver, source })).rejects.toThrow("group_insert_failed");
    expect(d.statements.at(-1)?.sql).toBe("ROLLBACK"); expect(d.statements.some(x => x.sql === "COMMIT")).toBe(false);
  });
  it("rejects a copied/forged packet before connecting", async () => {
    const d = database();
    await expect(writeNorthDakotaReportedComponent({ db: d.db, receiver, source: { ...source } })).rejects.toThrow(/unverified_source/);
    expect(d.connect).not.toHaveBeenCalled();
  });
  it("produces committee groups from the full source while excluding unrelated totals", async () => {
    const committee = await acquireNorthDakotaReportedPacket("committee", { cacheDir, clientOptions: northDakotaReportedCommitteeFixture() });
    const a = aggregateNorthDakotaReported(receiver, committee);
    expect(a).toMatchObject({ totalCents: 10000, supportCents: 0, opposeCents: 0, includedRows: 1 });
    expect(() => validateNorthDakotaReportedClosure(a, "committee")).not.toThrow();
  });
  it("checks uncapped group/count/money/stance closure", () => {
    const a = aggregateNorthDakotaReported(receiver, source);
    expect(() => validateNorthDakotaReportedClosure({ ...a, groups: [] }, "ie")).toThrow(/closure/);
    expect(() => validateNorthDakotaReportedClosure({ ...a, groups: [{ ...a.groups[0]!, occurrences: 2 }] }, "ie")).toThrow(/closure/);
    expect(() => validateNorthDakotaReportedClosure({ ...a, groups: [{ ...a.groups[0]!, stance: "direct" }] }, "ie")).toThrow(/identity/);
  });
});
