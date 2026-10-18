import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWashingtonPacSourceProducer, type WashingtonPacSourcePacket } from "../../../src/pipeline/washingtonFinance/washingtonReportedPacCache.js";
import { qualifyWashingtonPacReceiver, type WashingtonPacReceiver } from "../../../src/pipeline/washingtonFinance/washingtonReportedPacReceiver.js";
import { aggregateWashingtonPacRows } from "../../../src/pipeline/washingtonFinance/washingtonReportedPacSource.js";
import { readStoredWashingtonPacComponent, washingtonPacFacts, writeWashingtonReportedPacReceipts } from "../../../src/pipeline/washingtonFinance/washingtonReportedPacWriter.js";
import { fixture, guid, scope } from "./washingtonReportedPacFixtures.js";
export const receiver: WashingtonPacReceiver = { link_id: guid(1), candidate_id: guid(2), election_id: guid(3), election_year: 2026,
  filer_id: scope.filerId, committee_id: scope.committeeId, candidacy_id: "2000", link_source: "pdc_api",
  candidate_name: "Synthetic Candidate", full_name: "Synthetic Candidate", office_scope: "state_lower",
  office_name: "State Lower Chamber Legislator", district: "1", district_name: "Legislative District 1",
  ballot_title: "State Representative Position 1", election_date: "2026-11-03" };
export function stored(p: WashingtonPacSourcePacket) {
  const a = aggregateWashingtonPacRows(p.rows), { groups: list, ...controls } = a;
  const source = { link_id: receiver.link_id, candidate_id: receiver.candidate_id, election_id: receiver.election_id, election_year: 2026,
    receiving_filer_id: receiver.filer_id, receiving_committee_id: receiver.committee_id, total_cents: String(a.totalCents), group_count: list.length,
    source_row_count: a.sourceRowCount, source_retrieved_at: p.sourceRetrievedAt, source_completed_at: p.sourceCompletedAt,
    source_manifest_sha256: p.sourceManifestSha256, source_byte_size: String(p.sourceByteSize), source_facts: washingtonPacFacts(p),
    aggregation_controls: controls, last_synced_at: new Date().toISOString() };
  const groups = list.map(g => ({ link_id: receiver.link_id, election_year: 2026, reported_name_key: g.key, reported_name: g.name,
    amount_cents: String(g.cents), source_row_count: g.rowCount })); return { source, groups };
}
let cacheDir: string, packet: WashingtonPacSourcePacket;
beforeEach(async () => { cacheDir = await mkdtemp(join(tmpdir(), "wa-pac-write-")); packet = (await createWashingtonPacSourceProducer({ cacheDir, fetchImpl: fixture().fetchImpl, minimumGapMs: 0 }).refresh(scope))!; });
afterEach(async () => { await rm(cacheDir, { recursive: true, force: true }); });
function database(options: { changed?: boolean; siblings?: boolean; failGroups?: boolean; prior?: Record<string, unknown>; groups?: Record<string, unknown>[] } = {}) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("SELECT l.id::text link_id")) return { rows: [{ ...receiver, ...(options.changed ? { candidate_name: "Changed Person" } : {}) }] };
    if (sql.includes("SELECT id::text,link_status")) return { rows: [{ id: receiver.link_id, link_status: "active" }, ...(options.siblings ? [{ id: guid(4), link_status: "active" }] : [])] };
    if (sql.includes("SELECT * FROM public.wa_reported_pac_sources")) return { rows: options.prior ? [options.prior] : [] };
    if (sql.includes("SELECT * FROM public.wa_reported_pac_groups")) return { rows: options.groups ?? [] };
    if (sql.includes("INSERT INTO public.wa_reported_pac_groups") && options.failGroups) throw Error("synthetic_group_failure");
    return { rows: [] };
  });
  const client = { query, release: vi.fn() }, db = { connect: vi.fn(async () => client) } as unknown as Pool;
  return { db, query, client };
}
describe("Washington PAC canonical atomic writer", () => {
  it("binds current person, office, district, registration and candidacy", () => {
    expect(() => qualifyWashingtonPacReceiver(receiver, packet.scope, packet.summary)).not.toThrow();
    for (const changed of [{ candidate_name: "Different Person", full_name: "Different Person" }, { district: "2" }, { candidacy_id: "3000" }])
      expect(() => qualifyWashingtonPacReceiver({ ...receiver, ...changed }, packet.scope, packet.summary)).toThrow();
    expect(() => qualifyWashingtonPacReceiver(receiver, packet.scope, { ...packet.summary, active_candidate: false })).toThrow();
    expect(() => qualifyWashingtonPacReceiver({ ...receiver, candidate_name: "Synthetic A Candidate" }, packet.scope,
      { ...packet.summary, filer_name: "Synthetic B Candidate" })).toThrow();
  });
  it("refuses an unbranded lookalike before connecting", async () => {
    const { db } = database();
    await expect(writeWashingtonReportedPacReceipts({ db, receiver, source: { ...packet } })).rejects.toMatchObject({ code: "unverified_source_packet" });
    expect(db.connect).not.toHaveBeenCalled();
  });
  it("uses one pinned transaction and writes only the two financial component tables", async () => {
    const { db, query, client } = database(); const result = await writeWashingtonReportedPacReceipts({ db, receiver, source: packet });
    expect(result).toEqual({ groupCount: 1, totalCents: 13000, idempotent: false });
    const sql = query.mock.calls.map(c => c[0]); expect(sql[0]).toBe("BEGIN"); expect(sql.at(-1)).toBe("COMMIT");
    expect(sql.filter(s => /^(INSERT|UPDATE|DELETE)/.test(s)).every(s => /public\.wa_reported_pac_(sources|groups)/.test(s))).toBe(true);
    expect(sql.some(s => s.includes("FOR UPDATE OF c,ce,e,d,o,l"))).toBe(true); expect(client.release).toHaveBeenCalledOnce();
  });
  it.each([{ changed: true }, { siblings: true }])("rolls back changed/ambiguous canonical context %j", async options => {
    const { db, query } = database(options);
    await expect(writeWashingtonReportedPacReceipts({ db, receiver, source: packet })).rejects.toMatchObject({ code: "receiving_context_changed" });
    expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK"); expect(query.mock.calls.some(c => c[0].startsWith("INSERT"))).toBe(false);
  });
  it("rolls back a group failure instead of committing a source with partial groups", async () => {
    const { db, query } = database({ failGroups: true });
    await expect(writeWashingtonReportedPacReceipts({ db, receiver, source: packet })).rejects.toThrow("synthetic_group_failure");
    expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK"); expect(query.mock.calls.some(c => c[0] === "COMMIT")).toBe(false);
  });
  it("rejects stale sources and conflicting equal-clock full groups", async () => {
    const { source, groups } = stored(packet);
    const stale = database({ prior: { ...source, source_retrieved_at: new Date(Date.parse(packet.sourceRetrievedAt) + 1000).toISOString() } });
    await expect(writeWashingtonReportedPacReceipts({ db: stale.db, receiver, source: packet })).rejects.toMatchObject({ code: "stale_source" });
    const conflicting = database({ prior: { ...source, source_manifest_sha256: "a".repeat(64) }, groups });
    await expect(writeWashingtonReportedPacReceipts({ db: conflicting.db, receiver, source: packet })).rejects.toMatchObject({ code: "equal_source_conflict" });
  });
  it("permits exact equal-clock replay only after checking complete stored money and provenance", async () => {
    const { source, groups } = stored(packet), { db, query } = database({ prior: source, groups });
    expect((await writeWashingtonReportedPacReceipts({ db, receiver, source: packet })).idempotent).toBe(true);
    expect(query.mock.calls.some(c => c[0].startsWith("DELETE"))).toBe(false);
  });
  it("rejects incomplete groups, changed identity, correction totals and provenance", () => {
    const { source, groups } = stored(packet);
    expect(readStoredWashingtonPacComponent(source, groups, receiver).aggregation.totalCents).toBe(13000);
    for (const invalid of [{ candidate_id: guid(8) }, { total_cents: "15000" }, { source_byte_size: "1" },
      { aggregation_controls: { ...source.aggregation_controls, negativeCents: 0 } }])
      expect(() => readStoredWashingtonPacComponent({ ...source, ...invalid }, groups, receiver)).toThrow();
    expect(() => readStoredWashingtonPacComponent(source, [], receiver)).toThrow();
  });
});
