import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdahoPacSourceProducer, type IdahoPacSourcePacket } from "../../../src/pipeline/idahoFinance/idahoReportedPacCache.js";
import { qualifyIdahoPacReceiver, type IdahoPacReceiver } from "../../../src/pipeline/idahoFinance/idahoReportedPacReceiver.js";
import { aggregateIdahoPacRows } from "../../../src/pipeline/idahoFinance/idahoReportedPacSource.js";
import { idahoPacFacts, readStoredIdahoPacComponent, writeIdahoReportedPacReceipts } from "../../../src/pipeline/idahoFinance/idahoReportedPacWriter.js";
import { idahoPacFixture, pacGuid, pacScope } from "./idahoReportedPacFixtures.js";
const receiver: IdahoPacReceiver = { link_id: pacGuid(30), candidate_id: pacGuid(31), election_id: pacGuid(32), election_year: 2026,
  registration_guid: pacScope.registrationGuid, link_source: "sunshine_grid", link_candidate_name: "SYNTHETIC CANDIDATE",
  link_filer_name: "Candidate, Synthetic", link_district: "1", link_office_name: "State Senator", candidate_name: "Synthetic Candidate",
  full_name: "Synthetic Candidate", office_scope: "state_upper", office_name: "State Senator", district_name: "Legislative District 1",
  legislative_district: 1, ballot_title: "State Senator", election_date: "2026-11-03" };
let cacheDir: string, packet: IdahoPacSourcePacket;
beforeEach(async () => { cacheDir = await mkdtemp(join(tmpdir(), "id-pac-writer-")); packet = (await createIdahoPacSourceProducer({ cacheDir, fetchImpl: idahoPacFixture().fetchImpl, minimumGapMs: 0 }).refresh(pacScope))!; });
afterEach(async () => { await rm(cacheDir, { recursive: true, force: true }); });
function stored() {
  const a = aggregateIdahoPacRows(packet.rows), { groups: list, ...controls } = a;
  const source = { link_id: receiver.link_id, candidate_id: receiver.candidate_id, election_id: receiver.election_id, election_year: 2026,
    receiving_registration_guid: receiver.registration_guid, native_entity_id: "1000", native_registration_id: "2000", total_cents: String(a.totalCents),
    group_count: list.length, source_row_count: a.selectedRowCount, source_retrieved_at: packet.sourceRetrievedAt, source_completed_at: packet.sourceCompletedAt,
    source_manifest_sha256: packet.sourceManifestSha256, source_byte_size: String(packet.sourceByteSize), source_facts: idahoPacFacts(packet),
    aggregation_controls: controls, last_synced_at: new Date().toISOString() };
  const groups = list.map(g => ({ link_id: receiver.link_id, election_year: 2026, reported_source_key: g.key, reported_name: g.name,
    amount_cents: String(g.cents), source_row_count: g.rowCount })); return { source, groups };
}
function database(options: { changed?: boolean; siblings?: boolean; failGroups?: boolean; prior?: Record<string, unknown>; groups?: Record<string, unknown>[] } = {}) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("SELECT l.id::text link_id")) return { rows: [{ ...receiver, ...(options.changed ? { candidate_name: "Different Person" } : {}) }] };
    if (sql.includes("SELECT id::text,link_status")) return { rows: [{ link_status: "active" }, ...(options.siblings ? [{ link_status: "active" }] : [])] };
    if (sql.includes("SELECT * FROM public.id_reported_pac_sources")) return { rows: options.prior ? [options.prior] : [] };
    if (sql.includes("SELECT * FROM public.id_reported_pac_groups")) return { rows: options.groups ?? [] };
    if (sql.includes("INSERT INTO public.id_reported_pac_groups") && options.failGroups) throw Error("synthetic_group_failure");
    return { rows: [] };
  });
  const client = { query, release: vi.fn() }, db = { connect: vi.fn(async () => client) } as unknown as Pool; return { db, query, client };
}
describe("Idaho canonical reported PAC persistence", () => {
  it("binds person, native registration, canonical office, district and election", () => {
    expect(() => qualifyIdahoPacReceiver(receiver, packet.scope, packet.registration, packet.registrations)).not.toThrow();
    for (const change of [{ candidate_name: "Different Person" }, { legislative_district: 11 }, { election_year: 2027 }, { registration_guid: pacGuid(9) }])
      expect(() => qualifyIdahoPacReceiver({ ...receiver, ...change }, packet.scope, packet.registration, packet.registrations)).toThrow();
    expect(() => qualifyIdahoPacReceiver({ ...receiver, candidate_name: "Synthetic A Candidate" }, packet.scope,
      { ...packet.registration, middleName: "B", filerName: "Candidate, Synthetic B" }, [{ ...packet.registration, middleName: "B", filerName: "Candidate, Synthetic B" }])).toThrow();
  });
  it("retains reviewed manual alias evidence only while both names and canonical district agree", () => {
    const reviewed = { ...receiver, link_source: "manual", candidate_name: "Reviewed Alias", link_candidate_name: "REVIEWED ALIAS" };
    expect(() => qualifyIdahoPacReceiver(reviewed, packet.scope, packet.registration)).not.toThrow();
    expect(() => qualifyIdahoPacReceiver({ ...reviewed, candidate_name: "Retargeted Person" }, packet.scope, packet.registration)).toThrow();
    expect(() => qualifyIdahoPacReceiver({ ...reviewed, legislative_district: 11 }, packet.scope, packet.registration)).toThrow();
  });
  it("rejects unbranded money before obtaining a DB connection", async () => {
    const { db } = database(); await expect(writeIdahoReportedPacReceipts({ db, receiver, source: { ...packet } })).rejects.toMatchObject({ code: "unverified_source_packet" });
    expect(db.connect).not.toHaveBeenCalled();
  });
  it("writes uncapped source/groups on one client and touches only independent financial tables", async () => {
    const { db, query, client } = database(), result = await writeIdahoReportedPacReceipts({ db, receiver, source: packet });
    expect(result).toEqual({ totalCents: 13000, groupCount: 1, idempotent: false });
    const sql = query.mock.calls.map(c => c[0]); expect(sql[0]).toBe("BEGIN"); expect(sql.at(-1)).toBe("COMMIT");
    expect(sql.some(s => s.includes("FOR UPDATE OF c,ce,e,d,o,l"))).toBe(true);
    expect(sql.filter(s => /^(INSERT|UPDATE|DELETE)/.test(s)).every(s => /public\.id_reported_pac_(sources|groups)/.test(s))).toBe(true);
    expect(client.release).toHaveBeenCalledOnce();
  });
  it.each([{ changed: true }, { siblings: true }])("rolls back changed/ambiguous canonical context %j", async options => {
    const { db, query } = database(options); await expect(writeIdahoReportedPacReceipts({ db, receiver, source: packet })).rejects.toMatchObject({ code: "receiving_context_changed" });
    expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK"); expect(query.mock.calls.some(c => c[0].startsWith("INSERT"))).toBe(false);
  });
  it("rolls back a failed group replacement with its source", async () => {
    const { db, query } = database({ failGroups: true }); await expect(writeIdahoReportedPacReceipts({ db, receiver, source: packet })).rejects.toThrow("synthetic_group_failure");
    expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK"); expect(query.mock.calls.some(c => c[0] === "COMMIT")).toBe(false);
  });
  it("rejects stale and equal-clock conflicting sources, accepts exact verified replay", async () => {
    const { source, groups } = stored(), stale = database({ prior: { ...source, source_retrieved_at: new Date(Date.parse(packet.sourceRetrievedAt) + 1000).toISOString() } });
    await expect(writeIdahoReportedPacReceipts({ db: stale.db, receiver, source: packet })).rejects.toMatchObject({ code: "stale_source" });
    const conflict = database({ prior: { ...source, source_manifest_sha256: "a".repeat(64) }, groups });
    await expect(writeIdahoReportedPacReceipts({ db: conflict.db, receiver, source: packet })).rejects.toMatchObject({ code: "equal_source_conflict" });
    const exact = database({ prior: source, groups }); expect((await writeIdahoReportedPacReceipts({ db: exact.db, receiver, source: packet })).idempotent).toBe(true);
    expect(exact.query.mock.calls.some(c => c[0].startsWith("DELETE"))).toBe(false);
  });
  it("validates uncapped groups, source category totals and current native receiver before reading", () => {
    const { source, groups } = stored(); expect(readStoredIdahoPacComponent(source, groups, receiver).aggregation.totalCents).toBe(13000);
    for (const changed of [{ candidate_id: pacGuid(99) }, { native_entity_id: "999" }, { total_cents: "15000" }, { source_byte_size: "1" },
      { source_facts: { ...source.source_facts, categoryCents: 15000 } }, { aggregation_controls: { ...source.aggregation_controls, negativeCents: 0 } }])
      expect(() => readStoredIdahoPacComponent({ ...source, ...changed }, groups, receiver)).toThrow();
    expect(() => readStoredIdahoPacComponent(source, [], receiver)).toThrow();
  });
});
