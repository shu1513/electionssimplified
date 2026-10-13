import { describe, expect, it, vi } from "vitest";
import { syncDuePhoenixCandidateFinance } from "../../../src/pipeline/phoenixFinance/phoenixCandidateFinanceBatchSync.js";
import type { PhoenixFinanceRunContext } from "../../../src/pipeline/phoenixFinance/phoenixCandidateFinanceSync.js";
import type { PhoenixRegistrationRow } from "../../../src/pipeline/phoenixFinance/phoenixEfilingClient.js";

const registration: PhoenixRegistrationRow = {
  copId: "CAN-25-4",
  committeeName: "Ed Hermes for Phoenix",
  committeeType: "Candidate Committee",
  candidateName: "Ed Hermes",
  electionCycle: "2025 Election Cycle",
  officeSoughtElectionCycle: "2026",
  terminated: false,
  approved: true,
  approvedTimestamp: 1,
  isStandingCommittee: false,
};

function runContext(): PhoenixFinanceRunContext {
  return {
    registrations: [registration],
    registrationsByCopId: new Map([[registration.copId, registration]]),
    outsidePool: [],
    diagnostics: { ieRegistrations: 0, cityFilingIePacs: 0, standingIePacs: 0, b6Packages: 0 },
  };
}

const dueRow = {
  candidate_id: "c1",
  election_id: "e1",
  election_year: 2026,
  candidate_name: "Ed Hermes",
  office_name: "City Council Member",
  official_ballot_title: "Phoenix City Council, District 4",
  election_date: "2026-11-03",
  cop_id: "CAN-25-4",
  portal_cycle_start: "2025-04-01",
  portal_cycle_end: "2027-03-31",
  last_synced_at: null,
  total_due_rows: 1,
};

// The due query starts "WITH due AS (SELECT link.candidate_id"; the
// missing-links selector starts "SELECT candidate.id::text candidate_id".
function makeDb(input: {
  due?: Record<string, unknown>[];
  missing?: Record<string, unknown>[];
  roster?: Record<string, unknown>[];
}) {
  const query = vi.fn().mockImplementation((sql: unknown) => {
    const s = String(sql);
    if (s.startsWith("WITH due AS (SELECT link.candidate_id"))
      return Promise.resolve({ rows: input.due ?? [] });
    if (s.startsWith("SELECT candidate.id::text candidate_id,election.id::text"))
      return Promise.resolve({ rows: input.missing ?? [] });
    if (s.startsWith("SELECT candidate.id::text candidate_id,COALESCE"))
      return Promise.resolve({ rows: input.roster ?? [] });
    if (s.startsWith("INSERT INTO public.phx_candidate_finance_links"))
      return Promise.resolve({ rows: [{ id: "link-1" }] });
    return Promise.resolve({ rows: [] });
  });
  return { db: { query, connect: vi.fn() }, query };
}

describe("syncDuePhoenixCandidateFinance", () => {
  it("retains candidate diagnostics in a real-shaped dry-run result", async () => {
    const { db, query } = makeDb({ due: [dueRow] });
    const candidateResult = {
      linkWritten: false,
      totalRaisedCents: 31613910,
      totalSpentCents: 8504359,
      loansReceivedCents: 0,
      cashOnHandCents: 23109551,
      outsideSupportCents: 0,
      outsideOpposeCents: 0,
      directBreakdownCount: 5,
      outsideGroupCount: 0,
      reportedThrough: "2026-06-30",
      directCoverageNote: "Published reports through June 30",
      outsideCoverageNote: "Standing PAC coverage incomplete",
      violations: [],
      canonicalReportCount: 2,
    };
    const result = await syncDuePhoenixCandidateFinance({
      db: db as never,
      dryRun: true,
      loadRunContext: async () => runContext(),
      syncCandidateFn: vi.fn().mockResolvedValue(candidateResult),
    });
    expect(result.results).toEqual([
      { candidateId: "c1", electionId: "e1", ok: true, result: candidateResult },
    ]);
    expect(result.autoLinkAttemptedCount).toBe(0);
    expect(query.mock.calls.every(([sql]) => !String(sql).startsWith("INSERT"))).toBe(true);
  });

  it("selects due links Phoenix-scoped and syncs with a parsed district", async () => {
    const { db, query } = makeDb({ due: [dueRow] });
    const syncCandidateFn = vi.fn().mockResolvedValue({});
    const result = await syncDuePhoenixCandidateFinance({
      db: db as never,
      now: new Date("2026-08-12T00:00:00Z"),
      autoLinkMissingLinks: false,
      loadRunContext: async () => runContext(),
      syncCandidateFn: syncCandidateFn as never,
    });
    const dueSql = String(
      query.mock.calls.find((call) => String(call[0]).startsWith("WITH due AS"))?.[0],
    );
    expect(dueSql).toContain("geoid_compact='0455000'");
    expect(dueSql).toContain("district.state='AZ'");
    expect(dueSql).toContain("phx_candidate_finance_links");
    expect(dueSql).toContain("NOT IN ('withdrawn','lost')");
    expect(syncCandidateFn).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: "c1",
        copId: "CAN-25-4",
        districtNumber: 4,
        electionDate: "2026-11-03",
        portalCycleStart: "2025-04-01",
        portalCycleEnd: "2027-03-31",
      }),
    );
    expect(result).toMatchObject({
      dueCandidateCount: 1,
      syncedCandidateCount: 1,
      failedCandidateCount: 0,
    });
  });

  it("fails every selected candidate when the run context cannot load", async () => {
    const { db } = makeDb({ due: [dueRow] });
    const result = await syncDuePhoenixCandidateFinance({
      db: db as never,
      now: new Date("2026-08-12T00:00:00Z"),
      autoLinkMissingLinks: false,
      loadRunContext: async () => {
        throw new Error("portal unreachable");
      },
      syncCandidateFn: vi.fn() as never,
    });
    expect(result.syncedCandidateCount).toBe(0);
    expect(result.results).toEqual([
      expect.objectContaining({
        ok: false,
        error: expect.stringContaining("run context load failed: portal unreachable"),
      }),
    ]);
  });

  it("skips the portal entirely when nothing is due and nothing is missing", async () => {
    const { db } = makeDb({});
    const loadRunContext = vi.fn();
    const result = await syncDuePhoenixCandidateFinance({
      db: db as never,
      now: new Date("2026-08-12T00:00:00Z"),
      loadRunContext: loadRunContext as never,
      syncCandidateFn: vi.fn() as never,
    });
    expect(loadRunContext).not.toHaveBeenCalled();
    expect(result.selectedCandidateCount).toBe(0);
  });

  it("builds covers only for name-tier candidates before auto-linking", async () => {
    // One missing candidate WITHOUT a COP-shaped stored id whose name
    // matches the registration: its cop id gets a cover parse. The writer
    // never fires (resolver name tier corroborates or fails on the cover).
    const { db } = makeDb({
      missing: [
        {
          candidate_id: "c2",
          election_id: "e1",
          candidate_name: "Ed Hermes",
          election_date: "2026-11-03",
          state: "AZ",
          district_type: "place",
          geoid_compact: "0455000",
          office_scope: "place",
          office_name: "City Council Member",
          official_ballot_title: "Phoenix City Council, District 4",
          state_filing_ids: null,
        },
      ],
      roster: [
        {
          candidate_id: "c2",
          candidate_name: "Ed Hermes",
          state_filing_ids: null,
        },
      ],
    });
    const buildCoverIndex = vi
      .fn()
      .mockResolvedValue(new Map([["CAN-25-4", ["Council Member District 4"]]]));
    const result = await syncDuePhoenixCandidateFinance({
      db: db as never,
      now: new Date("2026-08-12T00:00:00Z"),
      loadRunContext: async () => runContext(),
      buildCoverIndex: buildCoverIndex as never,
      syncCandidateFn: vi.fn() as never,
    });
    expect(buildCoverIndex).toHaveBeenCalledWith(
      expect.objectContaining({ copIds: ["CAN-25-4"] }),
    );
    expect(result.autoLinkAttemptedCount).toBe(1);
    // The name tier corroborated via the parsed cover and the link wrote.
    expect(result.autoLinkLinkedCount).toBe(1);
  });

  it("election targeting validates the UUID and skips auto-link", async () => {
    const { db, query } = makeDb({ due: [] });
    await expect(
      syncDuePhoenixCandidateFinance({
        db: db as never,
        electionId: "nope",
        loadRunContext: (async () => runContext()) as never,
        syncCandidateFn: vi.fn() as never,
      }),
    ).rejects.toThrow(/Invalid Phoenix finance electionId/);
    await syncDuePhoenixCandidateFinance({
      db: db as never,
      electionId: "11111111-2222-3333-4444-555555555555",
      loadRunContext: (async () => runContext()) as never,
      syncCandidateFn: vi.fn() as never,
    });
    expect(
      query.mock.calls.some((call) =>
        String(call[0]).startsWith("SELECT candidate.id::text candidate_id,election.id::text"),
      ),
    ).toBe(false);
    const dueSql = String(
      query.mock.calls.find((call) => String(call[0]).startsWith("WITH due AS"))?.[0],
    );
    expect(dueSql).toContain("election.id=$1::uuid");
  });
});
