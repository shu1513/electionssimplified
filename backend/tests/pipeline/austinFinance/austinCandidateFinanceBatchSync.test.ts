import { describe, expect, it, vi } from "vitest";

import { syncDueAustinCandidateFinance } from "../../../src/pipeline/austinFinance/austinCandidateFinanceBatchSync.js";

const OUTSIDE = { dceRows: [{ dceId: "x" }], purposeRows: [{ committeePurposeId: "y" }] } as never;

function dueRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    candidate_id: "c1",
    election_id: "e1",
    candidate_name: 'Zohaib "Zo" Qadri',
    election_year: 2026,
    office_scope: "place",
    office_name: "City Council Member",
    district: "District 9",
    filer_key: "QADRI ZOHAIB",
    filer_name: "Qadri, Zohaib",
    source_url: "https://data.austintexas.gov/d/b2pc-2s8n",
    last_synced_at: null,
    total_due_rows: "1",
    ...over,
  };
}

function makeDb(input: {
  dueRows: Record<string, unknown>[];
  elections?: Array<{
    id: string;
    election_date: string;
    office_name: string | null;
    official_ballot_title: string | null;
  }>;
}) {
  const sqlLog: string[] = [];
  const query = vi.fn(async (sql: string) => {
    sqlLog.push(sql);
    if (sql.includes("due AS (")) return { rows: input.dueRows };
    if (sql.includes("official_ballot_title FROM public.elections"))
      return {
        rows: input.elections ?? [
          {
            id: "e1",
            election_date: "2026-11-03",
            office_name: "City Council Member",
            official_ballot_title: "City Council Member District 9",
          },
        ],
      };
    // Auto-link selector / roster reads — none of these tests exercise them.
    return { rows: [] };
  });
  return { db: { query, connect: vi.fn() } as never, sqlLog, query };
}

describe("syncDueAustinCandidateFinance", () => {
  it("binds due candidates to the allowlisted election + office code and passes link facts through", async () => {
    const { db } = makeDb({ dueRows: [dueRow()] });
    const syncFn = vi.fn(async () => ({ written: false }) as never);
    const loadOutsideDatasetsFn = vi.fn(async () => OUTSIDE);
    const result = await syncDueAustinCandidateFinance({
      db,
      now: new Date("2026-09-15T12:00:00Z"),
      dryRun: true,
      syncFn,
      loadOutsideDatasetsFn,
    });
    expect(result.syncedCandidateCount).toBe(1);
    expect(result.dueCandidateCount).toBe(1);
    expect(loadOutsideDatasetsFn).toHaveBeenCalledTimes(1);
    expect(syncFn).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: "c1",
        electionId: "e1",
        electionYear: 2026,
        candidateDisplayName: 'Zohaib "Zo" Qadri',
        officeName: "City Council Member",
        district: "District 9",
        filerName: "Qadri, Zohaib",
        electionDate: "2026-11-03",
        officeCode: "COUNCIL_MBR_DISTRICT_09",
        outsideDatasets: OUTSIDE,
        dryRun: true,
      }),
    );
    // The shared due list is configured for the atx_ tables and TX.
    expect(db.query.mock.calls.some(([sql]: [string]) => sql.includes("public.atx_candidate_finance_links AS link") && sql.includes("district.state = 'TX'"))).toBe(true);
  });

  it("skips (never guesses) an election date outside the allowlist and an election without an office code", async () => {
    const { db } = makeDb({
      dueRows: [dueRow({ election_id: "e2" }), dueRow({ candidate_id: "c3", election_id: "e3", total_due_rows: "2" })],
      elections: [
        { id: "e2", election_date: "2028-11-07", office_name: "Mayor", official_ballot_title: "Mayor" },
        { id: "e3", election_date: "2026-11-03", office_name: "City Council Member", official_ballot_title: "City Council Member" },
      ],
    });
    const syncFn = vi.fn();
    const loadOutsideDatasetsFn = vi.fn();
    const result = await syncDueAustinCandidateFinance({
      db,
      dryRun: true,
      syncFn: syncFn as never,
      loadOutsideDatasetsFn: loadOutsideDatasetsFn as never,
    });
    expect(syncFn).not.toHaveBeenCalled();
    expect(loadOutsideDatasetsFn).not.toHaveBeenCalled();
    expect(result.skippedCandidateCount).toBe(2);
    expect(result.results).toEqual([
      expect.objectContaining({ status: "skipped", reason: "election date 2028-11-07 is not in the Austin finance allowlist" }),
      expect.objectContaining({ status: "skipped", reason: expect.stringContaining("no Austin office code") }),
    ]);
  });

  it("isolates a per-candidate sync failure and fetches the city-wide datasets once", async () => {
    const { db } = makeDb({
      dueRows: [dueRow(), dueRow({ candidate_id: "c2", filer_key: "HEYMAN RICHARD", filer_name: "Heyman, Richard", total_due_rows: "2" })],
    });
    const syncFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("itemized contributions exceed the cover totals"))
      .mockResolvedValueOnce({ written: false } as never);
    const loadOutsideDatasetsFn = vi.fn(async () => OUTSIDE);
    const result = await syncDueAustinCandidateFinance({
      db,
      dryRun: true,
      syncFn: syncFn as never,
      loadOutsideDatasetsFn,
    });
    expect(loadOutsideDatasetsFn).toHaveBeenCalledTimes(1);
    expect(result.failedCandidateCount).toBe(1);
    expect(result.syncedCandidateCount).toBe(1);
    expect(result.results[0]).toMatchObject({ status: "failed", reason: "itemized contributions exceed the cover totals" });
  });

  it("fails every candidate with the dataset error when the city-wide fetch breaks, without refetching", async () => {
    const { db } = makeDb({
      dueRows: [dueRow(), dueRow({ candidate_id: "c2", total_due_rows: "2" })],
    });
    const syncFn = vi.fn();
    const loadOutsideDatasetsFn = vi.fn(async () => {
      throw new Error("Austin Direct Campaign Expenditures dataset returned no rows");
    });
    const result = await syncDueAustinCandidateFinance({
      db,
      dryRun: true,
      syncFn: syncFn as never,
      loadOutsideDatasetsFn,
    });
    expect(syncFn).not.toHaveBeenCalled();
    expect(loadOutsideDatasetsFn).toHaveBeenCalledTimes(1);
    expect(result.failedCandidateCount).toBe(2);
    expect(result.results.map((row) => row.reason)).toEqual([
      "Austin Direct Campaign Expenditures dataset returned no rows",
      "Austin Direct Campaign Expenditures dataset returned no rows",
    ]);
  });

  it("aborts the batch on a corrupt due-list filer identity", async () => {
    const { db } = makeDb({ dueRows: [dueRow({ filer_name: " " })] });
    await expect(
      syncDueAustinCandidateFinance({ db, dryRun: true }),
    ).rejects.toThrow(/Invalid Austin due-list filer identity/);
  });

  // The missing-links selector is the only query with this NOT EXISTS guard.
  const AUTO_LINK_SELECTOR_MARKER =
    "NOT EXISTS (SELECT 1 FROM public.atx_candidate_finance_links";

  it("skips the auto-link leg on dry runs", async () => {
    const { db, sqlLog } = makeDb({ dueRows: [] });
    await syncDueAustinCandidateFinance({ db, dryRun: true });
    expect(sqlLog.some((sql) => sql.includes(AUTO_LINK_SELECTOR_MARKER))).toBe(false);
  });

  it("runs the auto-link selector on real runs", async () => {
    const { db, sqlLog } = makeDb({ dueRows: [] });
    const result = await syncDueAustinCandidateFinance({ db });
    // Auto-link failures are swallowed into autoLinkError — assert the leg
    // completed (no missing candidates → no Socrata fetch), not just that
    // its selector SQL was issued.
    expect(result.autoLinkError).toBeNull();
    expect(result.autoLinkResults).toBeNull();
    expect(sqlLog.some((sql) => sql.includes(AUTO_LINK_SELECTOR_MARKER))).toBe(true);
  });
});
