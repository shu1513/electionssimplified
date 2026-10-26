import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { syncMarylandIndependentExpenditures } from "../../../src/pipeline/marylandFinance/marylandIndependentExpenditureSync.js";
import { qualifyMarylandIndependentOutside } from "../../../src/pipeline/marylandFinance/marylandIndependentOutsideQualification.js";
import { fixture, owner } from "./marylandIndependentOutsideTestFixtures.js";
afterEach(() => vi.unstubAllEnvs());
function setup() {
  vi.stubEnv("MARYLAND_CAMPAIGN_FINANCE_ENABLED", "true");
  vi.stubEnv("MARYLAND_CAMPAIGN_FINANCE_SYNC_ENABLED", "true");
  const f = fixture(),
    c = f.context,
    snapshot = {
      context: c,
      ...qualifyMarylandIndependentOutside(f),
      targetAccountGuids: [owner],
      sourceObservedAt: "2026-10-26T00:00:00.000Z",
      generationDirectory: "/private/synthetic/generation",
      nativeDirectory: "/private/synthetic/native",
    };
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes("WITH milestone")
      ? [
          {
            candidate_id: c.candidateId,
            election_id: c.electionId,
            candidate_name: c.candidateName,
            party: c.party,
            office_scope: c.officeScope,
            office_name: c.officeName,
            geoid_compact: c.districtGeoidCompact,
            election_date: c.electionDate,
            election_year: 2026,
            native_directory: null,
            target_account_guids: null,
          },
        ]
      : [],
  }));
  const db = { query, connect: vi.fn() } as unknown as Pick<
    Pool,
    "query" | "connect"
  >;
  const loadSourceFn = vi.fn(async () => ({
    snapshots: [snapshot],
    results: [{ dueIndex: 0, diagnostics: [] }],
    captures: 10,
    savedOpeningQueries: 2,
  }));
  const writeSnapshotFn = vi.fn(async () => ({
    groupsWritten: 1,
    allocationsQualified: 1,
  }));
  return {
    query,
    db,
    loadSourceFn,
    writeSnapshotFn,
    rawCacheDir: "/private/synthetic",
    now: new Date("2026-10-26T00:01:00Z"),
  };
}
describe("independent Maryland due sync", () => {
  it("selects canonical candidates independently of receiving links and records a normal write", async () => {
    const t = setup(),
      r = await syncMarylandIndependentExpenditures(t);
    expect(r).toMatchObject({
      attempted: 1,
      qualified: 1,
      written: 1,
      preserved: 0,
      groupsWritten: 1,
    });
    expect(t.query.mock.calls[0]![0]).not.toContain(
      "md_candidate_finance_links",
    );
    expect(t.writeSnapshotFn).toHaveBeenCalledOnce();
    expect(t.query.mock.calls.at(-1)![0]).toContain(
      "md_candidate_finance_ie_attempts",
    );
  });
  it("dry-run neither writes finance nor advances attempt or source clocks", async () => {
    const t = setup(),
      r = await syncMarylandIndependentExpenditures({ ...t, dryRun: true });
    expect(r.results[0]!.status).toBe("ready");
    expect(t.writeSnapshotFn).not.toHaveBeenCalled();
    expect(t.query).toHaveBeenCalledOnce();
  });
  it("force never bypasses the master source gate", async () => {
    const t = setup();
    vi.stubEnv("MARYLAND_CAMPAIGN_FINANCE_ENABLED", "false");
    const r = await syncMarylandIndependentExpenditures({ ...t, force: true });
    expect(r.attempted).toBe(0);
    expect(t.query).not.toHaveBeenCalled();
    expect(t.loadSourceFn).not.toHaveBeenCalled();
  });
  it("source failure preserves finance and records retry metadata separately", async () => {
    const t = setup();
    t.loadSourceFn.mockResolvedValue({
      snapshots: [],
      results: [{ dueIndex: 0, diagnostics: ["outside_source_unavailable"] }],
      captures: 0,
      savedOpeningQueries: 0,
    });
    const r = await syncMarylandIndependentExpenditures(t);
    expect(r).toMatchObject({ written: 0, preserved: 1 });
    expect(t.writeSnapshotFn).not.toHaveBeenCalled();
    expect(t.query.mock.calls.at(-1)![0]).toContain(
      "md_candidate_finance_ie_attempts",
    );
  });
  it("a canonical race or writer error preserves rather than reporting a successful zero", async () => {
    const t = setup();
    t.writeSnapshotFn.mockRejectedValue(Error("synthetic_race"));
    const r = await syncMarylandIndependentExpenditures(t);
    expect(r).toMatchObject({ written: 0, preserved: 1 });
    expect(r.results[0]!.status).toBe("preserve");
  });
});
