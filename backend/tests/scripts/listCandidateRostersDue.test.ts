import { describe, expect, it, vi } from "vitest";

import {
  listCandidateRosterFanoutDebt,
  listCandidateRostersInitialPending,
  listCandidateRostersDue,
} from "../../src/scripts/listCandidateRostersDue.js";

function createMockQueryable(rows: unknown[] = []) {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  };
}

describe("listCandidateRostersInitialPending", () => {
  it("lists untouched pending roster rows while excluding existing candidate work and deferrals", async () => {
    const row = {
      election_id: "e-initial",
      district_name: "Legislative District 35, Washington",
      district_type: "state_lower",
      state: "WA",
      official_ballot_title: "State Representative Pos. 1",
      election_date: "2026-08-04",
      election_stage: "primary",
      roster_status: "pending",
      roster_updated_at: "2026-07-20 12:00:00+00",
    };
    const db = createMockQueryable([row]);

    const result = await listCandidateRostersInitialPending(db, {
      asOfDate: "2026-07-16",
      withinDays: 90,
    });

    expect(result).toEqual([row]);
    const [sql, params] = db.query.mock.calls[0]!;
    expect(params).toEqual(["2026-07-16", 90, "candidate_roster"]);
    expect(sql).toContain("s.status = 'pending'");
    expect(sql).toContain("COALESCE(btrim(s.reason), '') = ''");
    expect(sql).toContain("jsonb_array_length(s.payload->'candidates'), 0) = 0");
    expect(sql).toContain("FROM public.candidate_elections AS ce");
    expect(sql).toContain("ce.election_id = e.id");
    expect(sql).toContain("NOT EXISTS");
    expect(sql).toContain("mrd.status = 'deferred'");
    expect(sql).toContain("mrd.stage = 'candidate_roster'");
    expect(sql).toContain("e.election_date >= $1::date");
    expect(sql).toContain("<= $2::int");
    expect(sql).toContain("ORDER BY e.election_date ASC, s.updated_at ASC, e.id ASC");
  });
});

describe("listCandidateRostersDue", () => {
  it("passes the as-of date, cooldown, window, and item type as parameters and returns the rows", async () => {
    // Federal row: only federal rosters can carry a non-null no-FEC skip
    // list — non-federal rosters project null for roster_skipped_no_fec_id.
    const row = {
      election_id: "e-1",
      district_name: "Congressional District 4, Michigan",
      district_type: "us_house",
      state: "MI",
      official_ballot_title: "Representative in Congress District 4",
      election_date: "2026-08-11",
      election_stage: "primary",
      roster_status: "written",
      roster_written_at: "2026-05-01 12:00:00+00",
      staged_candidate_count: 3,
      linked_candidate_count: 3,
      roster_skipped_no_fec_id: ["Tanis, Philip"],
      roster_no_fec_id_exceptions: [
        {
          display_name: "Ivy Independent",
          reason: "Certified for the ballot; no FEC candidate ID issued.",
          official_roster_url: "https://elections.example.gov/certified",
        },
      ],
      reason: "stale",
    };
    const db = createMockQueryable([row]);

    const result = await listCandidateRostersDue(db, {
      asOfDate: "2026-07-16",
      cooldownDays: 30,
      withinDays: 90,
    });

    expect(result).toEqual([row]);
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0]!;
    expect(params).toEqual(["2026-07-16", 30, 90, "candidate_roster"]);
    // The refresh loop covers only rosters a research pass already resolved;
    // pending/failed rosters belong to the initial research flow.
    expect(sql).toContain("s.status IN ('written', 'no_results')");
    expect(sql).toContain("race_type = 'office'");
    // Upcoming elections only, capped to the lookahead window — rosters for
    // far-future elections change too rarely to be worth refreshing.
    expect(sql).toContain("e.election_date >= $1::date");
    expect(sql).toContain("<= $3::int");
    // Cooldown cutoff pinned to UTC so the boundary does not drift with the
    // session TimeZone (written_at is timestamptz).
    expect(sql).toContain("AT TIME ZONE 'UTC'");
    // Emptiness is judged on the staged payload, never on candidate_elections
    // links: zero links with staged candidates is fanout debt (the profile
    // pipeline stalled), and re-researching the roster targets the wrong
    // stage — those rows are excluded here and owned by the fanout-debt list.
    expect(sql).toContain("jsonb_array_length(s.payload->'candidates'), 0) = 0");
    expect(sql).toContain("AND NOT (");
    expect(sql).toContain("linked.linked_candidate_count = 0");
    expect(sql).toContain("s.status = 'no_results'");
    // Linked-candidate count must ignore deleted candidates.
    expect(sql).toContain("c.deleted_at IS NULL");
    // The federal no-FEC skip list rides along so the refresh pass re-checks
    // those names for late FEC registrations.
    expect(sql).toContain("s.ai_raw_debug->'roster_skipped_no_fec_id'");
    // Manual no-FEC-ID exceptions ride along the same way, so the refresh
    // pass re-checks OpenFEC for them too.
    expect(sql).toContain("s.ai_raw_debug->'roster_no_fec_id_exceptions'");
  });

  it("orders soonest election first, oldest roster first within a date", async () => {
    const db = createMockQueryable();
    await listCandidateRostersDue(db, { asOfDate: "2026-07-16", cooldownDays: 30, withinDays: 90 });
    const [sql] = db.query.mock.calls[0]!;
    expect(sql).toContain("ORDER BY e.election_date ASC, s.written_at ASC NULLS FIRST, e.id ASC");
  });
});

describe("listCandidateRosterFanoutDebt", () => {
  it("lists written rosters whose staged candidates never became links", async () => {
    const row = {
      election_id: "e-2",
      district_name: "Congressional District 1 (119th Congress), Connecticut",
      district_type: "us_house",
      state: "CT",
      official_ballot_title: "United States Representative",
      election_date: "2026-08-11",
      election_stage: "primary",
      roster_written_at: "2026-07-06 18:50:10+00",
      staged_candidate_count: 4,
    };
    const db = createMockQueryable([row]);

    const result = await listCandidateRosterFanoutDebt(db, {
      asOfDate: "2026-07-16",
      withinDays: 90,
    });

    expect(result).toEqual([row]);
    const [sql, params] = db.query.mock.calls[0]!;
    expect(params).toEqual(["2026-07-16", 90, "candidate_roster"]);
    // Fanout debt is only meaningful for completed rosters: staged
    // candidates exist but no candidate_elections links do.
    expect(sql).toContain("s.status = 'written'");
    expect(sql).toContain("jsonb_array_length(s.payload->'candidates'), 0) > 0");
    expect(sql).toContain("linked.linked_candidate_count = 0");
    expect(sql).toContain("c.deleted_at IS NULL");
    expect(sql).toContain("ORDER BY e.election_date ASC, s.written_at ASC NULLS FIRST, e.id ASC");
  });
});
