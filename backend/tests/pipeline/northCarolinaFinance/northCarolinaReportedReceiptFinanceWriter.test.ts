import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { Qualified } from "../../../src/pipeline/northCarolinaFinance/northCarolinaReportedReceiptSourceTypes.js";
import type { NorthCarolinaReportedCommitteeReceiptClassControl as Control } from "../../../src/pipeline/northCarolinaFinance/northCarolinaReportedCommitteeReceiptAggregator.js";
import type { NorthCarolinaReportedReceiptFinanceComponent } from "../../../src/pipeline/northCarolinaFinance/northCarolinaReportedReceiptFinanceTypes.js";
import { ncsbeDocumentInventoryUrl, ncsbeReportDetailUrl, ncsbeReceiptsUrl, ncsbeExpendituresUrl } from "../../../src/pipeline/northCarolinaFinance/northCarolinaNcsbeClient.js";
import { validateNorthCarolinaReportedReceiptPacket, validateNorthCarolinaReportedReceiptSourceFacts,
  writeNorthCarolinaReportedReceiptComponent as write } from "../../../src/pipeline/northCarolinaFinance/northCarolinaReportedReceiptFinanceWriter.js";

type Row = Record<string, unknown>;
type Mutable<T> = { -readonly [K in keyof T]: T[K] extends readonly (infer U)[] ? Mutable<U>[] : T[K] extends object ? Mutable<T[K]> : T[K] };
type TestComponent = Mutable<NorthCarolinaReportedReceiptFinanceComponent>;
const linkId = "11111111-1111-4111-8111-111111111111", candidateId = "22222222-2222-4222-8222-222222222222", electionId = "33333333-3333-4333-8333-333333333333";
const receiverId = "STA-AA11BB-C-001", clock = new Date("2026-01-02T00:00:00.000Z");
function control(reportedClass: "CPCM" | "PPTY", occurrences: number, amount: number): Control {
  return { reportedClass, sourceOccurrenceCount: occurrences, signedSourceCents: amount, coverPeriodCents: amount,
    positiveOccurrenceCount: occurrences, positiveGrossCents: amount, zeroOccurrenceCount: 0,
    excludedAggregatedOccurrenceCount: 0, excludedAggregatedSignedCents: 0, excludedInKindOccurrenceCount: 0, excludedInKindSignedCents: 0 };
}
function component(zero = false): TestComponent {
  const cpcm = control("CPCM", zero ? 0 : 2, zero ? 0 : 300), ppty = control("PPTY", zero ? 0 : 1, zero ? 0 : 100);
  if (!zero) { cpcm.sourceOccurrenceCount++; cpcm.signedSourceCents += 50; cpcm.coverPeriodCents += 50; cpcm.excludedInKindOccurrenceCount++; cpcm.excludedInKindSignedCents = 50; }
  const inventoryUrl = ncsbeDocumentInventoryUrl({ sboeId: receiverId, orgGroupId: 17 });
  const bindings = [
    { role: "inventory_open" as const, url: inventoryUrl }, { role: "report_cover" as const, reportId: "11", url: ncsbeReportDetailUrl("11") },
    { role: "receipt_page" as const, reportId: "11", page: 0, url: ncsbeReceiptsUrl("11") },
    { role: "expenditure_page" as const, reportId: "11", page: 0, url: ncsbeExpendituresUrl("11") },
    { role: "native_csv" as const, reportId: "11", url: "https://cf.ncsbe.gov/CFOrgLkup/ReportDetail?handler=Export&RID=11&TP=ALL&sid=&cn=" },
    { role: "inventory_close" as const, url: inventoryUrl },
  ];
  const sourceControls = bindings.map((b, i) => ({ ...b, ordinal: i + 1, file: `originals/${String(i + 1).padStart(4, "0")}.raw`, status: 200, eof: true, byteSize: 100, sha256: "a".repeat(64),
    startedAt: `2026-01-01T00:00:${String(i * 2).padStart(2, "0")}.000Z`, completedAt: `2026-01-01T00:00:${String(i * 2 + 1).padStart(2, "0")}.000Z` }));
  const packet: Mutable<Qualified> = { source: { receivingCommitteeId: receiverId, electionYear: 2026, sourceGeneration: "44444444-4444-4444-8444-444444444444",
    sourceRetrievedAt: sourceControls[0]!.startedAt, sourceCompletedAt: sourceControls.at(-1)!.completedAt, sourceUrl: "https://cf.ncsbe.gov/CFOrgLkup/",
    sourceReceiptOccurrenceCount: zero ? 0 : 5, sourceReportCount: 1, sourceByteSize: 600, sourceManifestSha256: "b".repeat(64), sourceControls },
    aggregation: { status: "qualified", receivingCommitteeId: receiverId, electionYear: 2026, metric: "reported_itemized_committee_monetary_receipts_before_returns",
      positiveGrossCents: zero ? 0 : 400, positiveOccurrenceCount: zero ? 0 : 3,
      groups: zero ? [] : [ { reportedClass: "CPCM", displayName: "Synthetic Committee A", normalizedName: "SYNTHETIC COMMITTEE A", positiveGrossCents: 125, positiveOccurrenceCount: 1 },
        { reportedClass: "CPCM", displayName: "Synthetic Committee B", normalizedName: "SYNTHETIC COMMITTEE B", positiveGrossCents: 175, positiveOccurrenceCount: 1 },
        { reportedClass: "PPTY", displayName: "Synthetic Party", normalizedName: "SYNTHETIC PARTY", positiveGrossCents: 100, positiveOccurrenceCount: 1 } ],
      classControls: [cpcm, ppty], coveredPeriods: [{ reportId: "11", reportType: "First Quarter", periodStart: "2025-01-01", periodEnd: "2025-03-31", sourceOccurrenceCount: zero ? 0 : 5, classControls: structuredClone([cpcm, ppty]) }],
      diagnostics: { inventoryRowCount: 2, excludedOtherReceiverInventoryRowCount: 0, duplicateInventoryRowCount: 0, excludedNoTotalReportRowCount: 0,
        excludedOutsideLegReportRowCount: 0, excludedUndatedOutOfCycleRowCount: 0, reportCount: 1, sourceOccurrenceCount: zero ? 0 : 5,
        excludedOtherClassOccurrenceCount: zero ? 0 : 1, coverIdentityMetadataDisagreementReportCount: 0, coverPeriodDisagreementReportCount: 0 } } };
  return { receiver: { linkId, candidateId, electionId, electionYear: 2026, electionDate: "2026-11-03", candidateName: "Synthetic Candidate", officeScope: "state_upper",
    officeName: "State Senate", district: "1", committeeId: receiverId, committeeName: "Synthetic Campaign", linkSource: "manual", sourceUrl: null, lastSyncedAt: null }, packet };
}
function later(value = component()) {
  const next = structuredClone(value), shift = (v: string) => new Date(Date.parse(v) + 3600_000).toISOString();
  next.packet.source = { ...next.packet.source, sourceRetrievedAt: shift(next.packet.source.sourceRetrievedAt), sourceCompletedAt: shift(next.packet.source.sourceCompletedAt),
    sourceGeneration: "55555555-5555-4555-8555-555555555555", sourceManifestSha256: "c".repeat(64),
    sourceControls: next.packet.source.sourceControls.map(o => ({ ...o, startedAt: shift(o.startedAt), completedAt: shift(o.completedAt) })) };
  return next;
}
/** Transactional model, not a live DB. A concurrent accepted source survives
 * rollback of this transaction, exercising conditional-upsert preservation. */
function harness() {
  let data = { source: null as Row | null, groups: [] as Row[], legacy: { direct: 123, outside: 456, clock: "unchanged" } };
  let snapshot: typeof data | null = null;
  const state = { parent: { candidate_id: candidateId, election_id: electionId, election_date: "2026-11-03", election_year: 2026, deleted_at: null,
    candidate_election_status: "active", district_state: "NC", race_type: "office", office_scope: "state_upper", office_canonical_name: "State Senator" } as Row,
    links: [{ link_id: linkId, candidate_id: candidateId, election_id: electionId, election_year: 2026, committee_id: receiverId, link_source: "manual", link_status: "active", office_name: "State Senate", district: "1" }] as Row[],
    fail: "", rejectUpsert: false, pgTypes: false, race: null as null | { source: Row; groups: Row[] } };
  const calls: { sql: string; values: unknown[] }[] = [], release = vi.fn();
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values: structuredClone(values) }); const result = (rows: Row[] = []) => ({ rows, rowCount: rows.length });
    if (sql === "BEGIN") { if (state.fail === "begin") throw new Error("synthetic_private_failure"); snapshot = structuredClone(data); return result(); }
    if (sql === "COMMIT") { if (state.fail === "commit") throw new Error("synthetic_private_failure"); snapshot = null; return result(); }
    if (sql === "ROLLBACK") { if (snapshot) data = snapshot; snapshot = null; return result(); }
    if (sql.includes("FROM public.candidates c")) return result([structuredClone(state.parent)]);
    if (sql.includes("FROM public.nc_candidate_finance_links")) return result(structuredClone(state.links));
    if (sql.startsWith("SELECT * FROM public.nc_reported_receipt_")) {
      const rows = sql.includes("_sources") ? data.source ? [data.source] : [] : data.groups;
      return result(rows.map(row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k,
        state.pgTypes && typeof v === "number" ? String(v) : state.pgTypes && ["source_facts", "aggregation_controls"].includes(k) ? JSON.stringify(v)
          : state.pgTypes && ["source_retrieved_at", "source_completed_at"].includes(k) ? new Date(v as string) : v]))));
    }
    const insert = /INSERT INTO public\.nc_reported_receipt_sources\s*\(([^)]+)\)/.exec(sql);
    if (insert) {
      const cols = insert[1]!.split(",").map(s => s.trim());
      const row = Object.fromEntries(cols.map((k, i) => [k, ["source_facts", "aggregation_controls"].includes(k) ? JSON.parse(values[i] as string) : values[i]]));
      if (state.race) { data.source = structuredClone(state.race.source); data.groups = structuredClone(state.race.groups); snapshot = structuredClone(data); state.race = null; }
      if (state.rejectUpsert || data.source && String(data.source.source_retrieved_at) >= String(row.source_retrieved_at)) return result();
      data.source = row; return result([{ accepted: 1 }]);
    }
    if (sql.startsWith("DELETE FROM public.nc_reported_receipt_groups")) { data.groups = []; return result(); }
    if (sql.startsWith("INSERT INTO public.nc_reported_receipt_groups")) { if (state.fail === "groups") throw new Error("synthetic_private_failure"); data.groups = JSON.parse(values[0] as string); return result(state.fail === "partial_groups" ? data.groups.slice(1) : data.groups); }
    if (sql.startsWith("UPDATE public.nc_reported_receipt_sources")) {
      if (!data.source || data.source.source_retrieved_at !== values[3]) return result();
      data.source.last_synced_at = [String(data.source.last_synced_at), String(values[2])].sort().at(-1); return result([{ accepted: 1 }]);
    }
    throw new Error("unexpected_synthetic_query");
  });
  const connect = vi.fn(async () => { if (state.fail === "connect") throw new Error("synthetic_private_failure"); return { query, release }; });
  return { db: { connect } as unknown as Pick<Pool, "connect">, state, calls, connect, release, data: () => structuredClone(data),
    editSource: (edit: (s: Row) => void) => { if (data.source) edit(data.source); }, editGroups: (edit: (g: Row[]) => void) => edit(data.groups) };
}
const perform = (h: ReturnType<typeof harness>, value = component(), syncedAt = clock) => write({ db: h.db, ...value, syncedAt });
const validate = (value: NorthCarolinaReportedReceiptFinanceComponent) => validateNorthCarolinaReportedReceiptPacket({ packet: value.packet, receivingCommitteeId: receiverId, electionYear: 2026, syncedAt: clock });

describe("protected NC reported receipt finance writer", () => {
  it("writes a complete uncapped component atomically, preserving legacy money and manual link provenance", async () => {
    const h = harness(), legacy = h.data().legacy; expect(await perform(h)).toEqual({ sourceWritten: true, groupCount: 3, idempotent: false });
    expect(h.data().legacy).toEqual(legacy); expect(h.state.links[0]?.link_source).toBe("manual"); expect(h.release).toHaveBeenCalledOnce();
    expect(h.calls[0]?.sql).toBe("BEGIN"); expect(h.calls.at(-1)?.sql).toBe("COMMIT");
    expect(h.calls.find(c => c.sql.includes("FROM public.candidates c"))?.sql).toContain("FOR UPDATE OF c, e, ce, d, o");
    expect(h.calls.find(c => c.sql.includes("FROM public.nc_candidate_finance_links"))?.sql).toContain("ORDER BY id FOR UPDATE");
    expect(h.calls.filter(c => /^(?:INSERT|UPDATE|DELETE)/.test(c.sql.trim())).every(c => c.sql.includes("public.nc_reported_receipt_"))).toBe(true);
    expect(h.data().source).toMatchObject({ positive_gross_cents: 400, source_retrieved_at: "2026-01-01T00:00:00.000Z", last_synced_at: clock.toISOString() });
    expect(h.data().source?.source_facts).toEqual(component().packet.source);
    expect(h.data().source?.aggregation_controls).not.toHaveProperty("groups");
  });

  it("uses actual default write clock separately from original source clocks", async () => {
    vi.useFakeTimers(); vi.setSystemTime(clock);
    try { const h = harness(); await write({ db: h.db, ...component() }); expect(h.data().source?.last_synced_at).toBe(clock.toISOString()); expect(h.data().source?.source_completed_at).toBe("2026-01-01T00:00:11.000Z"); }
    finally { vi.useRealTimers(); }
  });

  it("locks inactive siblings before checking the unique active receiver", async () => {
    const h = harness();
    h.state.links.push({ ...h.state.links[0]!, link_id: "55555555-5555-4555-8555-555555555555", link_status: "inactive" });
    await expect(perform(h)).resolves.toMatchObject({ sourceWritten: true });
    const lock = h.calls.find(c => c.sql.includes("FROM public.nc_candidate_finance_links"))!.sql;
    expect(lock).toContain("ORDER BY id FOR UPDATE");
    expect(lock).not.toContain("link_status = 'active'");
    h.state.links[1]!.link_status = "active";
    const before = h.data();
    await expect(perform(h, later())).rejects.toMatchObject({ code: "receiving_context_changed" });
    expect(h.data()).toEqual(before);
  });

  it("replaces prior positive groups only with a newer fully qualified explicit zero", async () => {
    const h = harness(); await perform(h); await perform(h, later(component(true)));
    expect(h.data().groups).toEqual([]); expect(h.data().source).toMatchObject({ positive_gross_cents: 0, group_count: 0, source_receipt_occurrence_count: 0, source_report_count: 1 });
  });

  it.each(["groups", "partial_groups", "commit"])("rolls back source and every group on %s failure, returning only a safe error", async fail => {
    const h = harness(); await perform(h); const before = h.data(); h.state.fail = fail;
    await expect(perform(h, later())).rejects.toMatchObject({ code: "storage_unavailable", message: "North Carolina reported receipt write unavailable: storage_unavailable" });
    expect(h.data()).toEqual(before); expect(h.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  it.each(["connect", "begin"])("releases safely on %s failure", async fail => {
    const h = harness(); h.state.fail = fail; await expect(perform(h)).rejects.toMatchObject({ code: "storage_unavailable" });
    expect(h.calls.some(c => c.sql === "ROLLBACK")).toBe(false);
    if (fail === "begin") expect(h.release).toHaveBeenCalledOnce();
  });

  it("compares exact source and all groups on equal clocks, accepting PG numeric/time representations", async () => {
    const h = harness(); await perform(h); const first = h.data(); h.state.pgTypes = true;
    expect(await perform(h)).toEqual({ sourceWritten: true, groupCount: 3, idempotent: true });
    expect(h.data()).toEqual(first);
    h.editGroups(g => { g[2]!.reported_name = "Changed Synthetic Party"; });
    const corrupt = h.data(); await expect(perform(h)).rejects.toMatchObject({ code: "equal_source_conflict" }); expect(h.data()).toEqual(corrupt);
  });

  it("rejects equal-clock source metadata conflicts and older source without replacing any groups", async () => {
    const h = harness(); await perform(h, later()); const before = h.data();
    await expect(perform(h)).rejects.toMatchObject({ code: "stale_source" }); expect(h.data()).toEqual(before);
    const equal = later(); equal.packet.source.sourceManifestSha256 = "d".repeat(64);
    await expect(perform(h, equal)).rejects.toMatchObject({ code: "equal_source_conflict" }); expect(h.data()).toEqual(before);
  });

  it("requires successful conditional newer-source upsert before any group deletion", async () => {
    const h = harness(); h.state.rejectUpsert = true;
    await expect(perform(h)).rejects.toMatchObject({ code: "stale_source" }); expect(h.calls.some(c => c.sql.startsWith("DELETE"))).toBe(false);
  });

  it("preserves an externally inserted newer source during a failed concurrent insert", async () => {
    const external = harness(); await perform(external, later()); const accepted = external.data();
    const h = harness(); h.state.race = { source: accepted.source!, groups: accepted.groups };
    await expect(perform(h)).rejects.toMatchObject({ code: "stale_source" }); expect(h.data()).toEqual(accepted);
    expect(h.calls.some(c => c.sql.startsWith("DELETE"))).toBe(false);
  });

  it.each([
    (h: ReturnType<typeof harness>) => { h.state.parent.deleted_at = "2026-01-01"; },
    (h: ReturnType<typeof harness>) => { h.state.parent.candidate_election_status = "withdrawn"; },
    (h: ReturnType<typeof harness>) => { h.state.parent.office_canonical_name = "United States Senator"; },
    (h: ReturnType<typeof harness>) => { h.state.parent.election_date = "2026-05-01"; },
    (h: ReturnType<typeof harness>) => { h.state.links.push({ ...h.state.links[0]!, link_id: "55555555-5555-4555-8555-555555555555" }); },
    (h: ReturnType<typeof harness>) => { h.state.links[0]!.committee_id = "STA-AA11BB-C-002"; },
    (h: ReturnType<typeof harness>) => { h.state.links[0]!.link_source = "ncsbe_portal"; },
    (h: ReturnType<typeof harness>) => { h.state.links[0]!.district = "2"; },
  ])("rechecks unchanged eligible context and unique receiving link under locks", async edit => {
    const h = harness(); await perform(h); const before = h.data(); edit(h);
    await expect(perform(h, later())).rejects.toMatchObject({ code: "receiving_context_changed" }); expect(h.data()).toEqual(before);
  });

  it("preserves caller values by snapshotting before asynchronous context locks", async () => {
    const h = harness(), value = component(); const pending = perform(h, value);
    value.packet.aggregation.groups[0]!.displayName = "Changed after invocation";
    await pending; expect(h.data().groups[0]!.reported_name).toBe("Synthetic Committee A");
  });
});

describe("pure NC source and full packet controls", () => {
  it("is reusable without any DB connection for qualified positive and explicit zero", () => {
    expect(() => validate(component())).not.toThrow(); expect(() => validate(component(true))).not.toThrow();
    expect(() => validateNorthCarolinaReportedReceiptSourceFacts({ source: component().packet.source, receivingCommitteeId: receiverId, electionYear: 2026, syncedAt: clock })).not.toThrow();
  });

  it.each([
    (v: TestComponent) => { v.packet.aggregation.positiveGrossCents++; },
    (v: TestComponent) => { v.packet.aggregation.groups.pop(); },
    (v: TestComponent) => { v.packet.aggregation.groups.push({ ...v.packet.aggregation.groups[0]! }); },
    (v: TestComponent) => { v.packet.aggregation.classControls[0]!.signedSourceCents++; },
    (v: TestComponent) => { v.packet.aggregation.coveredPeriods[0]!.classControls[0]!.excludedInKindSignedCents++; },
    (v: TestComponent) => { v.packet.aggregation.groups[0]!.normalizedName = "incorrect"; },
    (v: TestComponent) => { v.packet.aggregation.groups[0]!.positiveGrossCents = Number.MAX_SAFE_INTEGER + 1; },
    (v: TestComponent) => { v.packet.aggregation.coveredPeriods[0]!.reportId = "12"; },
    (v: TestComponent) => { v.packet.aggregation.coveredPeriods[0]!.periodStart = "2024-12-31"; },
    (v: TestComponent) => { v.packet.aggregation.diagnostics.excludedOtherClassOccurrenceCount++; },
    (v: TestComponent) => { v.packet.source.sourceReceiptOccurrenceCount++; },
    (v: TestComponent) => { v.packet.source.sourceByteSize++; },
    (v: TestComponent) => { v.packet.source.sourceControls = v.packet.source.sourceControls.slice(0, -1); },
    (v: TestComponent) => { v.packet.source.sourceControls[2] = { ...v.packet.source.sourceControls[2]!, eof: false }; },
    (v: TestComponent) => { v.packet.source.sourceControls[2] = { ...v.packet.source.sourceControls[2]!, url: "https://other.invalid/" }; },
    (v: TestComponent) => { v.packet.source.sourceControls[2] = { ...v.packet.source.sourceControls[2]!, file: "../original.raw" }; },
    (v: TestComponent) => { v.packet.source.sourceControls[2] = { ...v.packet.source.sourceControls[2]!, sha256: "bad" }; },
    (v: TestComponent) => { v.packet.source.sourceControls[2] = { ...v.packet.source.sourceControls[2]!, startedAt: "2026-01-01T00:00:00.000Z" }; },
    (v: TestComponent) => { v.packet.source.sourceCompletedAt = "2026-01-03T00:00:00.000Z"; },
    (v: TestComponent) => { (v.packet.aggregation as unknown as Row).status = "held"; },
  ])("rejects malformed or nonclosing components before any SQL", async edit => {
    const h = harness(), value = component(); edit(value);
    await expect(perform(h, value)).rejects.toMatchObject({ code: "invalid_component" }); expect(h.connect).not.toHaveBeenCalled();
  });

  it("keeps native signed excluded controls without turning them into net monetary receipts", () => {
    const value = component();
    for (const c of [value.packet.aggregation.classControls[0]!, value.packet.aggregation.coveredPeriods[0]!.classControls[0]!]) {
      c.excludedInKindSignedCents = -50; c.signedSourceCents = c.coverPeriodCents = 250;
    }
    expect(() => validate(value)).not.toThrow(); expect(value.packet.aggregation.positiveGrossCents).toBe(400);
  });

  it("keeps structural chronology pure while the writer rejects a future actual write clock", async () => {
    const value = component(), future = new Date(Date.now() + 10 * 60_000), h = harness();
    expect(() => validateNorthCarolinaReportedReceiptPacket({ packet: value.packet, receivingCommitteeId: receiverId, electionYear: 2026, syncedAt: future })).not.toThrow();
    await expect(perform(h, value, future)).rejects.toMatchObject({ code: "invalid_component" }); expect(h.connect).not.toHaveBeenCalled();
  });

  it("keeps 61 uncapped distinct name groups and does not merge equal gift amounts", async () => {
    const h = harness(), value = component(), a = value.packet.aggregation;
    a.groups = Array.from({ length: 61 }, (_, i) => ({ reportedClass: "CPCM", displayName: `Synthetic Committee ${i}`, normalizedName: `SYNTHETIC COMMITTEE ${i}`, positiveGrossCents: 1, positiveOccurrenceCount: 1 }));
    a.positiveGrossCents = a.positiveOccurrenceCount = 61; a.classControls = [control("CPCM", 61, 61), control("PPTY", 0, 0)];
    a.coveredPeriods[0]!.classControls = structuredClone(a.classControls); a.coveredPeriods[0]!.sourceOccurrenceCount = 61;
    a.diagnostics.sourceOccurrenceCount = 61; a.diagnostics.excludedOtherClassOccurrenceCount = 0; value.packet.source.sourceReceiptOccurrenceCount = 61;
    expect((await perform(h, value)).groupCount).toBe(61); expect(h.data().groups).toHaveLength(61);
  });
});
