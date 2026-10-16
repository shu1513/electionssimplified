import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { GeorgiaReportedCommitteeComponent, GeorgiaReportedIeComponent } from "../../../src/pipeline/georgiaFinance/georgiaReportedFinanceTypes.js";
import {
  GeorgiaReportedFinanceWriteError, writeGeorgiaReportedCommitteeComponent, writeGeorgiaReportedIeComponent,
} from "../../../src/pipeline/georgiaFinance/georgiaReportedFinanceWriter.js";

type Row = Record<string, unknown>;
const linkId = "11111111-1111-4111-8111-111111111111";
const candidateId = "22222222-2222-4222-8222-222222222222";
const electionId = "33333333-3333-4333-8333-333333333333";
const registrationGuid = "44444444-4444-4444-8444-444444444444";
const generation = "generation-55555555-5555-4555-8555-555555555555";
const syncedAt = new Date("2026-01-02T00:00:00.000Z");
function receiver() {
  return { linkId, candidateId, electionId, electionDate: "2026-11-03", electionYear: 2026, candidateName: "Synthetic Candidate",
    officeScope: "statewide", officeName: "Governor", district: null, committeeId: "100", committeeName: "Synthetic Campaign",
    linkSource: "manual" as const, sourceUrl: "https://ethics.ga.gov/records-search-all/", lastSyncedAt: null };
}
function source(kind: "committee" | "ie") {
  const controls = Array.from({ length: kind === "committee" ? 1 : 2 }, (_, i) => ({ file: `${generation}/${String(i + 1).padStart(4, "0")}.raw`,
    sha256: "a".repeat(64), byteSize: 100, startedAt: `2026-01-01T00:00:0${i * 2}.000Z`, completedAt: `2026-01-01T00:00:0${i * 2 + 1}.000Z`,
    status: 200, contentType: kind === "committee" ? "text/csv" : "application/json; charset=utf-8" }));
  return { filingYear: 2026, electionYear: 2026, sourceRetrievedAt: controls[0]!.startedAt, sourceCompletedAt: controls.at(-1)!.completedAt,
    sourceUrl: "https://ethics.ga.gov/records-search-all/", sourceRowCount: 1000, sourceByteSize: controls.length * 100,
    sourceManifestSha256: "b".repeat(64), sourceControls: controls };
}
function committee(): GeorgiaReportedCommitteeComponent {
  return { receiver: receiver(), context: { receivingCommitteeId: "100", registrationGuid }, source: source("committee"), heldReceivingCount: 4,
    aggregation: { status: "qualified", contributionCount: 3, totalAmountCents: 1500, groups: [
      { reportedClass: "Non-Candidate Committee", reportedName: "Example Committee", reportedNameKey: "EXAMPLE COMMITTEE", amountCents: 1250, contributionCount: 2 },
      { reportedClass: "Candidate / Candidate Committee", reportedName: "Example Campaign", reportedNameKey: "EXAMPLE CAMPAIGN", amountCents: 250, contributionCount: 1 },
    ] } };
}
function ie(): GeorgiaReportedIeComponent {
  return { receiver: receiver(), context: { receivingCommitteeId: "100", registrationGuid }, source: source("ie"),
    aggregation: { status: "qualified", sourceRowCount: 1000, candidateTargetRowCount: 5, expenditureCount: 3,
      otherAllocationYearRowCount: 1, multiTargetRowCount: 1, multiTargetAmountCents: 500, supportTotalCents: 1250, opposeTotalCents: 250,
      groups: [ { reportedSpenderId: "native-spender-a", reportedSpenderName: "Example Spender", supportOppose: "support", amountCents: 1250, expenditureCount: 2 },
        { reportedSpenderId: "native-spender-b", reportedSpenderName: "Another Spender", supportOppose: "oppose", amountCents: 250, expenditureCount: 1 } ] } };
}
function later<T extends GeorgiaReportedCommitteeComponent | GeorgiaReportedIeComponent>(value: T): T {
  const result = structuredClone(value);
  const shift = (s: string) => new Date(Date.parse(s) + 3600000).toISOString();
  result.source.sourceRetrievedAt = shift(result.source.sourceRetrievedAt);
  result.source.sourceCompletedAt = shift(result.source.sourceCompletedAt);
  result.source.sourceControls = result.source.sourceControls.map(c => ({ ...c, startedAt: shift(c.startedAt), completedAt: shift(c.completedAt) }));
  result.source.sourceManifestSha256 = "c".repeat(64);
  return result;
}

/** Transactional in-memory database model. No database, source acquisition or
 * provider calls. Its externally inserted race survives this transaction's rollback. */
function harness() {
  let data = { sources: new Map<string, Row>(), groups: new Map<string, Row[]>(), legacy: { direct: 123, lastSyncedAt: "unchanged" } };
  let snapshot: typeof data | null = null;
  const state = {
    parent: { candidate_id: candidateId, election_id: electionId, election_date: "2026-11-03", election_year: 2026, deleted_at: null,
      candidate_election_status: "active", district_state: "GA", race_type: "office", office_scope: "statewide", office_canonical_name: "Governor" } as Row,
    links: [{ link_id: linkId, candidate_id: candidateId, election_id: electionId, election_year: 2026, committee_id: "100",
      link_source: "manual", link_status: "active", office_name: "Governor", district: null }] as Row[],
    failStage: "" as "" | "begin" | "groups" | "commit", rejectUpsert: false,
    race: null as null | { source: Row; groups: Row[] }, pgNumbers: false,
  };
  const calls: { sql: string; values: unknown[] }[] = [];
  const release = vi.fn();
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values: structuredClone(values) });
    const result = (rows: Row[] = []) => ({ rows, rowCount: rows.length });
    if (sql === "BEGIN") { if (state.failStage === "begin") throw new Error("synthetic_begin_failure"); snapshot = structuredClone(data); return result(); }
    if (sql === "COMMIT") { if (state.failStage === "commit") throw new Error("synthetic_commit_failure"); snapshot = null; return result(); }
    if (sql === "ROLLBACK") { if (snapshot) data = snapshot; snapshot = null; return result(); }
    if (sql.includes("FROM public.candidates c")) return result([structuredClone(state.parent)]);
    if (sql.includes("FROM public.ga_candidate_finance_links")) return result(structuredClone(state.links));
    const read = /SELECT \* FROM public\.(\w+)/.exec(sql);
    if (read) {
      const table = read[1]!;
      const rows = table.endsWith("_sources") ? (data.sources.has(table) ? [data.sources.get(table)!] : []) : data.groups.get(table) ?? [];
      return result(rows.map(row => Object.fromEntries(Object.entries(row).map(([key, v]) => [key,
        state.pgNumbers && typeof v === "number" ? String(v) : v]))));
    }
    const insert = /INSERT INTO public\.(\w+)\s*\(([^)]+)\)/.exec(sql);
    if (insert) {
      const table = insert[1]!;
      if (table.endsWith("_sources")) {
        const columns = insert[2]!.split(",").map(s => s.trim());
        const row = Object.fromEntries(columns.map((key, i) => [key, key === "source_controls" ? JSON.parse(values[i] as string) : values[i]]));
        if (state.race) {
          data.sources.set(table, structuredClone(state.race.source)); data.groups.set(table.replace("_sources", "_groups"), structuredClone(state.race.groups));
          snapshot = structuredClone(data); state.race = null;
        }
        const old = data.sources.get(table);
        if (state.rejectUpsert || old && String(old.source_retrieved_at) >= String(row.source_retrieved_at)) return result();
        data.sources.set(table, row); return result([{ accepted: 1 }]);
      }
      if (state.failStage === "groups") throw new Error("synthetic_group_failure");
      data.groups.set(table, JSON.parse(values[0] as string)); return result();
    }
    const remove = /DELETE FROM public\.(\w+)/.exec(sql);
    if (remove) { data.groups.set(remove[1]!, []); return result(); }
    const update = /UPDATE public\.(\w+) SET last_synced_at/.exec(sql);
    if (update) {
      const old = data.sources.get(update[1]!);
      if (!old || old.source_retrieved_at !== values.at(-1)) return result();
      old.last_synced_at = [String(old.last_synced_at), String(values.at(-2))].sort().at(-1);
      return result([{ accepted: 1 }]);
    }
    throw new Error("unexpected_synthetic_query");
  });
  const connect = vi.fn(async () => ({ query, release }));
  return { db: { connect } as unknown as Pick<Pool, "connect">, state, calls, connect, release,
    data: () => structuredClone(data), replaceGroups: (table: string, groups: Row[]) => data.groups.set(table, groups) };
}
const writeCommittee = (h: ReturnType<typeof harness>, value = committee(), clock = syncedAt) => writeGeorgiaReportedCommitteeComponent({ db: h.db, ...value, syncedAt: clock });
const writeIe = (h: ReturnType<typeof harness>, value = ie(), clock = syncedAt) => writeGeorgiaReportedIeComponent({ db: h.db, ...value, syncedAt: clock });

describe("Georgia protected reported component writer", () => {
  it.each(["committee", "ie"] as const)("writes uncapped %s groups atomically without touching legacy money or links", async kind => {
    const h = harness(); const before = h.data().legacy;
    const result = await (kind === "committee" ? writeCommittee(h) : writeIe(h));
    expect(result).toEqual({ sourceWritten: true, groupCount: 2, idempotent: false });
    expect(h.calls[0]?.sql).toBe("BEGIN"); expect(h.calls.at(-1)?.sql).toBe("COMMIT");
    expect(h.calls.find(c => c.sql.includes("FROM public.candidates c"))?.sql).toContain("FOR UPDATE OF c, e, ce, d, o");
    expect(h.calls.find(c => c.sql.includes("FROM public.ga_candidate_finance_links"))?.sql).toContain("ORDER BY id FOR UPDATE");
    expect(h.calls.filter(c => /^(?:INSERT|UPDATE|DELETE)/.test(c.sql.trim())).every(c => /public\.ga_reported_(?:committee|ie)_/.test(c.sql))).toBe(true);
    expect(h.data().legacy).toEqual(before); expect(h.release).toHaveBeenCalledOnce();
    const saved = [...h.data().sources.values()][0]!;
    expect(saved.source_retrieved_at).toBe("2026-01-01T00:00:00.000Z"); expect(saved.last_synced_at).toBe(syncedAt.toISOString());
  });

  it("does not cap 61 receipt groups", async () => {
    const value = committee();
    value.aggregation.groups = Array.from({ length: 61 }, (_, i) => ({ reportedClass: "Non-Candidate Committee", reportedName: `Example Committee ${i}`,
      reportedNameKey: `EXAMPLE COMMITTEE ${i}`, amountCents: 1, contributionCount: 1 }));
    value.aggregation.contributionCount = 61; value.aggregation.totalAmountCents = 61;
    const h = harness(); expect((await writeCommittee(h, value)).groupCount).toBe(61);
    expect(h.data().groups.get("ga_reported_committee_groups")).toHaveLength(61);
  });

  it("uses actual default write clock independently of original capture", async () => {
    vi.useFakeTimers(); vi.setSystemTime(syncedAt);
    try {
      const h = harness(); await writeGeorgiaReportedCommitteeComponent({ db: h.db, ...committee() });
      expect(h.data().sources.get("ga_reported_committee_sources")?.last_synced_at).toBe(syncedAt.toISOString());
      expect(h.data().sources.get("ga_reported_committee_sources")?.source_completed_at).toBe("2026-01-01T00:00:01.000Z");
    } finally { vi.useRealTimers(); }
  });

  it.each(["committee", "ie"] as const)("replaces %s with qualified zero while retaining its observed source", async kind => {
    const h = harness(); await (kind === "committee" ? writeCommittee(h) : writeIe(h));
    if (kind === "committee") {
      const zero = later(committee()); zero.aggregation = { status: "qualified", groups: [], contributionCount: 0, totalAmountCents: 0 };
      await writeCommittee(h, zero);
    } else {
      const zero = later(ie()); zero.aggregation = { status: "qualified", groups: [], sourceRowCount: 1000, candidateTargetRowCount: 0,
        expenditureCount: 0, otherAllocationYearRowCount: 0, multiTargetRowCount: 0, multiTargetAmountCents: 0, supportTotalCents: 0, opposeTotalCents: 0 };
      await writeIe(h, zero);
    }
    expect(h.data().groups.get(`ga_reported_${kind}_groups`)).toEqual([]);
    expect(h.data().sources.get(`ga_reported_${kind}_sources`)?.group_count).toBe(0);
    expect(h.data().sources.get(`ga_reported_${kind}_sources`)?.source_row_count).toBe(1000);
  });

  it.each(["groups", "commit"] as const)("rolls back source and all groups on %s failure", async stage => {
    const h = harness(); await writeCommittee(h); const before = h.data(); h.state.failStage = stage;
    await expect(writeCommittee(h, later(committee()))).rejects.toThrow(`synthetic_${stage === "groups" ? "group" : stage}_failure`);
    expect(h.data()).toEqual(before); expect(h.calls.at(-1)?.sql).toBe("ROLLBACK"); expect(h.release).toHaveBeenCalledTimes(2);
  });

  it("rejects client-only mode before any SQL", async () => {
    await expect(writeGeorgiaReportedCommitteeComponent({ ...committee(), db: { query: vi.fn() } as unknown as Pick<Pool, "connect">, syncedAt }))
      .rejects.toMatchObject({ code: "invalid_component" });
  });

  it.each([
    ["committee_id", "200"], ["link_source", "peachfile_api"], ["link_status", "inactive"], ["link_id", registrationGuid],
    ["office_name", "Different office"], ["district", "7"], ["election_year", 2028],
  ])("preserves a changed selected link (%s)", async (field, changed) => {
    const h = harness(); h.state.links[0]![field as string] = changed;
    await expect(writeCommittee(h)).rejects.toMatchObject({ code: "receiving_context_changed" });
    expect(h.data().sources.size).toBe(0); expect(h.calls.some(c => c.sql.startsWith("INSERT"))).toBe(false);
    expect(h.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("never treats a newly manual source as the stale selected automatic intent", async () => {
    const h = harness(); const selected = committee(); selected.receiver.linkSource = "peachfile_api";
    await expect(writeCommittee(h, selected)).rejects.toMatchObject({ code: "receiving_context_changed" });
    expect(h.data().sources.size).toBe(0);
  });

  it("holds an ambiguous multiple-active receiver context", async () => {
    const h = harness(); h.state.links.push({ ...h.state.links[0], link_id: registrationGuid, committee_id: "200" });
    await expect(writeIe(h)).rejects.toMatchObject({ code: "receiving_context_changed" });
    expect(h.data().sources.size).toBe(0);
  });

  it.each([
    ["deleted_at", "2026-01-01"], ["candidate_election_status", "withdrawn"], ["candidate_election_status", "lost"],
    ["district_state", "NC"], ["race_type", "ballot_measure"], ["office_scope", "federal"], ["office_canonical_name", "Federal office"],
    ["election_date", "2026-11-04"], ["election_year", 2025],
  ])("rechecks current candidate/election eligibility (%s)", async (field, changed) => {
    const h = harness(); h.state.parent[field as string] = changed;
    await expect(writeCommittee(h)).rejects.toMatchObject({ code: "receiving_context_changed" });
    expect(h.data().sources.size).toBe(0);
  });

  it("rejects older source without deleting prior groups or freshening its source clock", async () => {
    const h = harness(); await writeCommittee(h, later(committee())); const before = h.data(); const deletes = h.calls.filter(c => c.sql.startsWith("DELETE")).length;
    await expect(writeCommittee(h)).rejects.toMatchObject({ code: "stale_source" });
    expect(h.data()).toEqual(before); expect(h.calls.filter(c => c.sql.startsWith("DELETE"))).toHaveLength(deletes);
  });

  it("compares full equal-clock groups, accepting identical retries with PG numeric strings and group order changes", async () => {
    const h = harness(); await writeCommittee(h); h.state.pgNumbers = true;
    const old = h.data().groups.get("ga_reported_committee_groups")!; h.replaceGroups("ga_reported_committee_groups", [...old].reverse());
    const result = await writeCommittee(h, committee(), new Date("2026-01-03T00:00:00.000Z"));
    expect(result.idempotent).toBe(true);
    expect(h.calls.filter(c => c.sql.startsWith("DELETE"))).toHaveLength(1);
    expect(h.data().sources.get("ga_reported_committee_sources")?.source_retrieved_at).toBe("2026-01-01T00:00:00.000Z");
    expect(h.data().sources.get("ga_reported_committee_sources")?.last_synced_at).toBe("2026-01-03T00:00:00.000Z");
    await writeCommittee(h, committee(), syncedAt);
    expect(h.data().sources.get("ga_reported_committee_sources")?.last_synced_at).toBe("2026-01-03T00:00:00.000Z");
  });

  it("rejects equal-clock metadata conflict and equal totals with a changed reported group", async () => {
    const h = harness(); await writeCommittee(h); const before = h.data();
    const changedMetadata = committee(); changedMetadata.source.sourceManifestSha256 = "d".repeat(64);
    await expect(writeCommittee(h, changedMetadata)).rejects.toMatchObject({ code: "equal_source_conflict" });
    const changedGroup = committee(); changedGroup.aggregation.groups[0]!.reportedName = "Different Committee"; changedGroup.aggregation.groups[0]!.reportedNameKey = "DIFFERENT COMMITTEE";
    await expect(writeCommittee(h, changedGroup)).rejects.toMatchObject({ code: "equal_source_conflict" });
    expect(h.data()).toEqual(before);
  });

  it("rejects an extra stored group on an equal-clock retry", async () => {
    const h = harness(); await writeIe(h); const groups = h.data().groups.get("ga_reported_ie_groups")!;
    h.replaceGroups("ga_reported_ie_groups", [...groups, { ...groups[0], reported_spender_id: "extra" }]);
    const before = h.data(); await expect(writeIe(h)).rejects.toMatchObject({ code: "equal_source_conflict" }); expect(h.data()).toEqual(before);
  });

  it("closes an unobserved insert conflict before deleting any groups and preserves the competing source", async () => {
    const seed = harness(); await writeCommittee(seed, later(committee()));
    const h = harness(); h.state.race = { source: seed.data().sources.get("ga_reported_committee_sources")!, groups: seed.data().groups.get("ga_reported_committee_groups")! };
    await expect(writeCommittee(h)).rejects.toMatchObject({ code: "stale_source" });
    expect(h.calls.some(c => c.sql.startsWith("DELETE"))).toBe(false);
    expect(h.calls.find(c => c.sql.startsWith("INSERT INTO public.ga_reported_committee_sources"))?.sql)
      .toContain("ga_reported_committee_sources.source_retrieved_at < EXCLUDED.source_retrieved_at");
    expect(h.data().sources).toEqual(seed.data().sources); expect(h.data().groups).toEqual(seed.data().groups);
  });

  it("does not erase the independent committee component when IE group storage fails", async () => {
    const h = harness(); await writeCommittee(h); const before = h.data(); h.state.failStage = "groups";
    await expect(writeIe(h)).rejects.toThrow("synthetic_group_failure"); expect(h.data()).toEqual(before);
  });

  it.each([
    (v: GeorgiaReportedCommitteeComponent) => { v.aggregation.totalAmountCents++; },
    (v: GeorgiaReportedCommitteeComponent) => { v.aggregation.contributionCount++; },
    (v: GeorgiaReportedCommitteeComponent) => { v.aggregation.groups[0]!.amountCents = 1.1; },
    (v: GeorgiaReportedCommitteeComponent) => { v.aggregation.groups.push({ ...v.aggregation.groups[0]! }); },
    (v: GeorgiaReportedCommitteeComponent) => { v.aggregation.groups[0]!.reportedNameKey = "wrong key"; },
    (v: GeorgiaReportedCommitteeComponent) => { v.source.sourceByteSize++; },
    (v: GeorgiaReportedCommitteeComponent) => { v.source.sourceRowCount = 0; },
    (v: GeorgiaReportedCommitteeComponent) => { v.source.sourceControls[0]!.status = 302; },
    (v: GeorgiaReportedCommitteeComponent) => { v.source.sourceControls[0]!.file = "../selector.raw"; },
    (v: GeorgiaReportedCommitteeComponent) => { v.source.sourceControls[0]!.sha256 = "invalid"; },
    (v: GeorgiaReportedCommitteeComponent) => { v.source.sourceControls[0]!.contentType = "text/html"; },
    (v: GeorgiaReportedCommitteeComponent) => { v.context.receivingCommitteeId = "200"; },
    (v: GeorgiaReportedCommitteeComponent) => { v.source.electionYear = 2028; },
    (v: GeorgiaReportedCommitteeComponent) => { v.heldReceivingCount = -1; },
  ])("rejects invalid source/receipt controls before acquiring any connection", async change => {
    const value = committee(); change(value); const h = harness();
    await expect(writeCommittee(h, value)).rejects.toMatchObject({ code: "invalid_component" }); expect(h.connect).not.toHaveBeenCalled();
  });

  it.each([
    (v: GeorgiaReportedIeComponent) => { v.aggregation.candidateTargetRowCount++; },
    (v: GeorgiaReportedIeComponent) => { v.aggregation.supportTotalCents++; },
    (v: GeorgiaReportedIeComponent) => { v.aggregation.multiTargetAmountCents = 0; },
    (v: GeorgiaReportedIeComponent) => { v.aggregation.sourceRowCount--; },
    (v: GeorgiaReportedIeComponent) => { v.aggregation.groups[0]!.expenditureCount = 0; },
    (v: GeorgiaReportedIeComponent) => { v.source.sourceControls = [v.source.sourceControls[0]!]; },
    (v: GeorgiaReportedIeComponent) => { v.source.sourceControls[1]!.startedAt = "2025-12-31T23:59:59.000Z"; },
  ])("rejects invalid IE group/source controls before SQL", async change => {
    const value = ie(); change(value); const h = harness(); await expect(writeIe(h, value)).rejects.toMatchObject({ code: "invalid_component" });
    expect(h.connect).not.toHaveBeenCalled();
  });

  it("rejects source bodies and total bytes above the production cache envelope", async () => {
    const h = harness();
    const csv = committee(); csv.source.sourceControls[0]!.byteSize = 160 * 1024 * 1024 + 1; csv.source.sourceByteSize = csv.source.sourceControls[0]!.byteSize;
    await expect(writeCommittee(h, csv)).rejects.toMatchObject({ code: "invalid_component" });
    const largeBody = ie(); largeBody.source.sourceControls[0]!.byteSize = 2 * 1024 * 1024 + 1;
    largeBody.source.sourceByteSize = largeBody.source.sourceControls.reduce((n, c) => n + c.byteSize, 0);
    await expect(writeIe(h, largeBody)).rejects.toMatchObject({ code: "invalid_component" });
    const largeTotal = ie();
    largeTotal.source.sourceControls = Array.from({ length: 17 }, (_, i) => ({ ...source("ie").sourceControls[0]!,
      file: `${generation}/${String(i + 1).padStart(4, "0")}.raw`, byteSize: 2 * 1024 * 1024,
      startedAt: new Date(Date.parse("2026-01-01T00:00:00.000Z") + i * 2000).toISOString(),
      completedAt: new Date(Date.parse("2026-01-01T00:00:00.000Z") + i * 2000 + 1000).toISOString() }));
    largeTotal.source.sourceByteSize = 34 * 1024 * 1024; largeTotal.source.sourceCompletedAt = largeTotal.source.sourceControls.at(-1)!.completedAt;
    await expect(writeIe(h, largeTotal)).rejects.toMatchObject({ code: "invalid_component" });
    expect(h.connect).not.toHaveBeenCalled();
  });

  it("rejects future source completion and source completion after write time", async () => {
    const h = harness(); const value = committee();
    const future = new Date(Date.now() + 86400000).toISOString(); value.source.sourceCompletedAt = future; value.source.sourceControls[0]!.completedAt = future;
    await expect(writeCommittee(h, value)).rejects.toMatchObject({ code: "invalid_component" });
    await expect(writeCommittee(h, committee(), new Date("2026-01-01T00:00:00.000Z"))).rejects.toMatchObject({ code: "invalid_component" });
    expect(h.connect).not.toHaveBeenCalled();
  });

  it("emits safe own-error strings without native IDs or donor names", () => {
    for (const code of ["invalid_component", "receiving_context_changed", "stale_source", "equal_source_conflict"] as const) {
      const error = new GeorgiaReportedFinanceWriteError(code);
      expect(error.message).toBe(`Georgia reported finance write unavailable: ${code}`);
      expect(error.message).not.toContain("Example Committee"); expect(error.message).not.toContain(linkId);
    }
  });
});
