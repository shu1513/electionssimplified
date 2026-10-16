import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listDueNorthCarolinaReportedReceiptFinance,
  recordNorthCarolinaReportedReceiptFinanceAttempt,
  type NorthCarolinaReportedReceiptFinanceDueInput,
} from "../../../src/pipeline/northCarolinaFinance/northCarolinaReportedReceiptFinanceDueList.js";
import type { NorthCarolinaReportedReceiptFinanceReceiver } from "../../../src/pipeline/northCarolinaFinance/northCarolinaReportedReceiptFinanceTypes.js";
import { NORTH_CAROLINA_FINANCE_ELIGIBLE_OFFICE_KEYS } from "../../../src/pipeline/northCarolinaFinance/northCarolinaFinanceEligibleOffices.js";
import * as sourceCache from "../../../src/pipeline/northCarolinaFinance/northCarolinaReportedReceiptSourceCache.js";

// Synthetic scheduling metadata is never an accepted financial packet.
const NOW = new Date("2028-10-21T12:00:00.000Z");
const FRESH = "2028-10-20T12:00:00.000Z";
const OLD = "2028-10-01T12:00:00.000Z";
const receiverId = "STA-AA11BB-C-001";
const otherReceiverId = "STA-ZZ99YY-C-001";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hint = (manifest = "a".repeat(64)): sourceCache.NorthCarolinaReportedReceiptSourceRevision => ({
  sourceRetrievedAt: FRESH, sourceCompletedAt: FRESH, sourceManifestSha256: manifest, sourceGeneration: id(900),
});
function eligible(n = 1, overrides: Record<string, unknown> = {}) {
  return { id: id(n), candidate_id: id(n + 100), election_id: id(n + 200), candidate_name: `Synthetic Candidate ${n}`,
    election_year: 2028, election_date: "2028-11-07", office_scope: "state_upper", office_name: "Synthetic Senate Office",
    district: "Synthetic District", committee_id: receiverId, committee_name: "Synthetic Receiver", link_source: "manual",
    source_url: null, last_synced_at: NOW.toISOString(), total_due_rows: "1", ...overrides };
}
function metadata(n = 1, overrides: Record<string, unknown> = {}) {
  return { link_id: id(n), source_clock: FRESH, source_manifest: "a".repeat(64), source_receiver: receiverId,
    last_attempted_at: null, attempt_receiver: null, attempt_manifest: null, ...overrides };
}
function database(rows = [eligible()], meta = [metadata()]) {
  return { query: vi.fn().mockResolvedValueOnce({ rows }).mockResolvedValueOnce({ rows: meta }) };
}
const input = (overrides: Partial<NorthCarolinaReportedReceiptFinanceDueInput> = {}): NorthCarolinaReportedReceiptFinanceDueInput => ({
  now: NOW, maxCandidates: 5, staleAfterDays: 7, electionLookbackDays: 1, electionLookaheadDays: 730,
  refresh: false, electionYear: 2028, cacheDir: "/synthetic-cache", ...overrides,
});
function receiver(): NorthCarolinaReportedReceiptFinanceReceiver {
  return { linkId: id(1), candidateId: id(101), electionId: id(201), candidateName: "Synthetic Candidate",
    electionYear: 2028, electionDate: "2028-11-07", officeScope: "state_upper", officeName: "Synthetic Senate Office",
    district: "Synthetic District", committeeId: receiverId, committeeName: "Synthetic Receiver", linkSource: "manual",
    sourceUrl: null, lastSyncedAt: null };
}
let revision: ReturnType<typeof vi.spyOn>;
beforeEach(() => { revision = vi.spyOn(sourceCache, "readNorthCarolinaReportedReceiptSourceRevision").mockResolvedValue(null); });
afterEach(() => { vi.restoreAllMocks(); });

describe("independent North Carolina reported receipt due selection", () => {
  it("enumerates all canonical eligible rows with refresh true, ignoring legacy direct freshness", async () => {
    const db = database([eligible()], [metadata(1, { source_clock: null })]);
    const result = await listDueNorthCarolinaReportedReceiptFinance(db, input());
    expect(result.rows.map((row) => row.linkId)).toEqual([id(1)]);
    const [sql, params] = db.query.mock.calls[0]!;
    expect(sql).toContain("district.state = 'NC'");
    expect(sql).toContain("candidate_election.status NOT IN ('withdrawn', 'lost')");
    expect(params).toEqual([NOW.toISOString(), 7, 100_000, 1, 730, [...NORTH_CAROLINA_FINANCE_ELIGIBLE_OFFICE_KEYS], 2028, true]);
    expect(String(db.query.mock.calls[1]![0])).not.toMatch(/positive_gross|positive_occurrence|group_count|receipt_occurrence/);
  });

  it("does not schedule a fresh matching component merely because legacy direct money is absent", async () => {
    const result = await listDueNorthCarolinaReportedReceiptFinance(database([eligible(1, { last_synced_at: null })]), input());
    expect(result).toMatchObject({ eligibleCount: 1, totalDueRows: 0, rows: [] });
  });

  it.each([{ source_clock: null }, { source_clock: "invalid" }, { source_clock: OLD },
    { source_clock: "2028-10-22T12:00:00.000Z" }, { source_receiver: otherReceiverId }, { source_manifest: null }])
  ("selects absent, invalid, stale, future, or repointed own source: %j", async (change) => {
    expect((await listDueNorthCarolinaReportedReceiptFinance(database([eligible()], [metadata(1, change)]), input())).rows).toHaveLength(1);
  });

  it("uses retrieved time for freshness, independent of completion or direct sync clocks", async () => {
    revision.mockResolvedValue({ ...hint(), sourceRetrievedAt: OLD, sourceCompletedAt: NOW.toISOString() });
    expect((await listDueNorthCarolinaReportedReceiptFinance(database([eligible()], [metadata(1, { source_clock: OLD })]), input())).rows).toHaveLength(1);
  });

  it("notices a changed cache manifest inside the stored source freshness window", async () => {
    revision.mockResolvedValue(hint("b".repeat(64)));
    const result = await listDueNorthCarolinaReportedReceiptFinance(database(), input());
    expect(result.rows).toHaveLength(1);
    expect(revision).toHaveBeenCalledWith({ cacheDir: "/synthetic-cache", receivingCommitteeId: receiverId, electionYear: 2028 });
  });

  it("applies the unchanged-revision cooldown through exactly 24 hours", async () => {
    revision.mockResolvedValue(hint());
    for (const [last_attempted_at, count] of [["2028-10-20T12:00:00.001Z", 0], ["2028-10-20T12:00:00.000Z", 1]] as const) {
      const result = await listDueNorthCarolinaReportedReceiptFinance(database([eligible()], [metadata(1, {
        source_clock: null, last_attempted_at, attempt_receiver: receiverId, attempt_manifest: "a".repeat(64),
      })]), input());
      expect(result.rows).toHaveLength(count);
    }
  });

  it("lets a new revision or repointed receiver bypass a recent attempt", async () => {
    revision.mockResolvedValue(hint("b".repeat(64)));
    const recent = { source_clock: null, last_attempted_at: NOW.toISOString(), attempt_receiver: receiverId, attempt_manifest: "a".repeat(64) };
    expect((await listDueNorthCarolinaReportedReceiptFinance(database([eligible()], [metadata(1, recent)]), input())).rows).toHaveLength(1);
    revision.mockResolvedValue(null);
    expect((await listDueNorthCarolinaReportedReceiptFinance(database([eligible()], [metadata(1, { ...recent, attempt_receiver: otherReceiverId })]), input())).rows).toHaveLength(1);
  });

  it("treats missing revision as unknown, preserving unchanged held cooldown instead of inventing zero", async () => {
    const result = await listDueNorthCarolinaReportedReceiptFinance(database([eligible()], [metadata(1, {
      source_clock: null, last_attempted_at: NOW.toISOString(), attempt_receiver: receiverId, attempt_manifest: "a".repeat(64),
    })]), input());
    expect(result.rows).toEqual([]);
  });

  it("rotates least attempted first and preserves canonical factory order among equal attempts", async () => {
    const rows = [eligible(4, { total_due_rows: "4", candidate_name: "Z synthetic" }), eligible(2), eligible(3), eligible(1)];
    const meta = [metadata(4, { source_clock: null }), metadata(2, { source_clock: null }),
      metadata(3, { source_clock: null, last_attempted_at: "2028-10-18T00:00:00.000Z", attempt_receiver: receiverId }),
      metadata(1, { source_clock: null, last_attempted_at: "2028-10-19T00:00:00.000Z", attempt_receiver: receiverId })];
    const first = await listDueNorthCarolinaReportedReceiptFinance(database(rows, meta), input({ maxCandidates: 2 }));
    expect(first.totalDueRows).toBe(4);
    expect(first.rows.map((row) => row.linkId)).toEqual([id(4), id(2)]);
    for (const item of meta.slice(0, 2)) Object.assign(item, { last_attempted_at: NOW.toISOString(), attempt_receiver: receiverId });
    expect((await listDueNorthCarolinaReportedReceiptFinance(database(rows, meta), input({ maxCandidates: 2 }))).rows.map((row) => row.linkId)).toEqual([id(3), id(1)]);
    expect(revision).toHaveBeenCalledTimes(2); // Once per shared receiving scope per pass.
  });

  it("retains canonical order when every receiver has the same finite attempt clock", async () => {
    const rows = [eligible(3, { total_due_rows: "3" }), eligible(1), eligible(2)];
    const meta = [3, 1, 2].map((n) => metadata(n, { source_clock: null, last_attempted_at: OLD, attempt_receiver: receiverId }));
    expect((await listDueNorthCarolinaReportedReceiptFinance(database(rows, meta), input())).rows.map((row) => row.linkId)).toEqual([id(3), id(1), id(2)]);
  });

  it("honors explicit canonical year/candidate scope without adding a money predicate", async () => {
    const db = database();
    await listDueNorthCarolinaReportedReceiptFinance(db, input({ candidateId: id(101) }));
    expect(db.query.mock.calls[0]![1]).toEqual([NOW.toISOString(), 7, 100_000, 1, 730,
      [...NORTH_CAROLINA_FINANCE_ELIGIBLE_OFFICE_KEYS], id(101), 2028, true]);
  });

  it("lets deliberate refresh bypass freshness and attempt cooldown", async () => {
    const result = await listDueNorthCarolinaReportedReceiptFinance(database([eligible()], [metadata(1, {
      last_attempted_at: NOW.toISOString(), attempt_receiver: receiverId,
    })]), input({ refresh: true }));
    expect(result.rows).toHaveLength(1);
  });

  it("fails closed on incomplete enumeration or missing/duplicated scheduling metadata", async () => {
    const clipped = database([eligible(1, { total_due_rows: "100001" })]);
    await expect(listDueNorthCarolinaReportedReceiptFinance(clipped, input())).rejects.toThrow("scheduling unavailable");
    expect(clipped.query).toHaveBeenCalledTimes(1);
    await expect(listDueNorthCarolinaReportedReceiptFinance(database([eligible()], []), input())).rejects.toThrow("scheduling unavailable");
    await expect(listDueNorthCarolinaReportedReceiptFinance(database([eligible()], [metadata(), metadata()]), input())).rejects.toThrow("scheduling unavailable");
  });

  it("returns empty canonical eligibility without metadata or cache work", async () => {
    const db = database([]);
    expect(await listDueNorthCarolinaReportedReceiptFinance(db, input())).toEqual({ eligibleCount: 0, totalDueRows: 0, rows: [] });
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(revision).not.toHaveBeenCalled();
  });

  it("tolerates only typed source unavailability and exposes unexpected helper errors", async () => {
    revision.mockRejectedValue(new sourceCache.NorthCarolinaReportedReceiptSourceError());
    expect((await listDueNorthCarolinaReportedReceiptFinance(database([eligible()], [metadata(1, { source_clock: null })]), input())).rows).toHaveLength(1);
    revision.mockRejectedValue(new Error("synthetic programming failure"));
    await expect(listDueNorthCarolinaReportedReceiptFinance(database(), input())).rejects.toThrow("synthetic programming failure");
  });

  it.each([{ maxCandidates: 0 }, { maxCandidates: 100001 }, { staleAfterDays: 0 },
    { electionLookaheadDays: -1 }, { electionLookbackDays: 1.5 }, { now: new Date(NaN) }])
  ("rejects invalid scheduling bounds before querying: %j", async (change) => {
    const db = database();
    await expect(listDueNorthCarolinaReportedReceiptFinance(db, input(change))).rejects.toThrow("scheduling unavailable");
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe("protected nonfinancial North Carolina reported receipt attempts", () => {
  it("records current receiving SID and actual cache revision using eligibility-bound parameters", async () => {
    revision.mockResolvedValue(hint());
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ link_id: id(1) }], rowCount: 1 }) };
    const r = receiver();
    expect(await recordNorthCarolinaReportedReceiptFinanceAttempt({ db, receiver: r, now: NOW, cacheDir: "/synthetic-cache" })).toBe(true);
    const [sql, params] = db.query.mock.calls[0]!;
    expect(params).toEqual([r.linkId, 2028, r.candidateId, r.electionId, receiverId, "manual", "2028-11-07",
      NOW.toISOString(), "a".repeat(64), [...NORTH_CAROLINA_FINANCE_ELIGIBLE_OFFICE_KEYS], r.officeScope, r.officeName, r.district]);
    for (const clause of ["link.committee_id = $5", "link.link_source = $6", "link.link_status = 'active'",
      "candidate.deleted_at IS NULL", "candidate_election.status NOT IN ('withdrawn', 'lost')", "district.state = 'NC'",
      "election.race_type = 'office'", "election.election_date = $7::date", "office.scope = $11",
      "link.office_name = $12", "link.district IS NOT DISTINCT FROM $13::text"])
      expect(sql).toContain(clause);
    expect(sql).not.toMatch(/positive_gross|group_count|candidate_name|committee_name|UPDATE public\.nc_candidate/);
  });

  it("reports rejected or changed eligibility honestly and stores nullable unknown revision", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
    expect(await recordNorthCarolinaReportedReceiptFinanceAttempt({ db, receiver: receiver(), now: NOW })).toBe(false);
    expect(db.query.mock.calls[0]![1][8]).toBeNull();
  });

  it("finishes with the newly captured revision so held writers rotate instead of repeatedly bypassing cooldown", async () => {
    let current: sourceCache.NorthCarolinaReportedReceiptSourceRevision | null = null;
    revision.mockImplementation(async () => current);
    const meta = metadata(1, { source_clock: null });
    const db = { query: vi.fn().mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes("INSERT INTO public.nc_reported_receipt_attempts")) {
        Object.assign(meta, { last_attempted_at: params[7], attempt_receiver: params[4], attempt_manifest: params[8] });
        return { rows: [{ link_id: id(1) }], rowCount: 1 };
      }
      return { rows: sql.includes("WITH due AS") ? [eligible()] : [meta] };
    }) };
    expect((await listDueNorthCarolinaReportedReceiptFinance(db, input())).rows).toHaveLength(1);
    await recordNorthCarolinaReportedReceiptFinanceAttempt({ db, receiver: receiver(), now: NOW });
    current = hint();
    const completed = new Date(NOW.getTime() + 60_000);
    await recordNorthCarolinaReportedReceiptFinanceAttempt({ db, receiver: receiver(), now: completed });
    expect(meta.attempt_manifest).toBe("a".repeat(64));
    expect((await listDueNorthCarolinaReportedReceiptFinance(db, input({ now: completed }))).rows).toEqual([]);
    current = hint("b".repeat(64));
    expect((await listDueNorthCarolinaReportedReceiptFinance(db, input({ now: completed }))).rows).toHaveLength(1);
  });

  it("rejects invalid receiver or clock without a scheduling write", async () => {
    const db = { query: vi.fn() };
    for (const r of [{ ...receiver(), linkSource: "unknown" }, { ...receiver(), electionDate: "2028-02-31" }]) {
      await expect(recordNorthCarolinaReportedReceiptFinanceAttempt({ db, receiver: r as NorthCarolinaReportedReceiptFinanceReceiver, now: NOW })).rejects.toThrow("scheduling unavailable");
    }
    await expect(recordNorthCarolinaReportedReceiptFinanceAttempt({ db, receiver: receiver(), now: new Date(NaN) })).rejects.toThrow("scheduling unavailable");
    expect(db.query).not.toHaveBeenCalled();
  });
});
