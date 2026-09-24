import { describe, expect, it, vi } from "vitest";

import {
  listMissingGeneralElections,
  listTerminalStagePrimaries,
} from "../../src/scripts/listMissingGeneralElections.js";

function createMockQueryable(rows: unknown[] = []) {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  };
}

describe("listMissingGeneralElections", () => {
  it("reports primaries with no later same-contest election, excluding deferrals and November primaries", async () => {
    const row = {
      election_id: "e-gap",
      state: "MI",
      district_name: "Michigan",
      district_type: "statewide",
      official_ballot_title: "Governor",
      election_date: "2026-08-04",
      office_id: "office-1",
      linked_candidate_count: 9,
      has_decisive_result: true,
    };
    const db = createMockQueryable([row]);

    const result = await listMissingGeneralElections(db, {
      asOfDate: "2026-08-09",
      lookbackDays: 180,
      lookaheadDays: 365,
      horizonDays: 365,
    });

    expect(result).toEqual([row]);
    const [sql, params] = db.query.mock.calls[0]!;
    expect(params).toEqual(["2026-08-09", 180, 365, 365, null, null]);
    expect(sql).toContain("e.race_type = 'office'");
    expect(sql).toContain("e.election_stage = 'primary'");
    // The gap probe: any later same-contest election clears the row.
    expect(sql).toContain("g.district_id = e.district_id");
    expect(sql).toContain("g.election_date > e.election_date");
    // office_id vouches only when unambiguous: sibling primaries (same
    // district+office+day, seat-per-title races like Cape Coral council
    // districts or WA Supreme Court positions) disable it, so one seat's
    // general cannot clear the other seats' gaps.
    expect(sql).toContain("g.office_id = e.office_id");
    expect(sql).toContain("sibling.district_id = e.district_id");
    expect(sql).toContain("sibling.office_id = e.office_id");
    expect(sql).toContain("sibling.election_date = e.election_date");
    expect(sql).toContain("sibling.id <> e.id");
    // Title-key identity vouches unless both rows carry offices that
    // disagree — different contests sharing a title.
    expect(sql).toContain("g.official_ballot_title_key = e.official_ballot_title_key");
    expect(sql).toContain("e.office_id IS NULL OR g.office_id IS NULL OR g.office_id = e.office_id");
    // Contest-key identity: same seat titled with/without the district's
    // name (behaviour pinned in listMissingGeneralElectionsContestKey.db.test.ts).
    expect(sql).toContain("regexp_replace(lower(coalesce(d.name, ''))");
    expect(sql).toContain("~ '\\m[0-9]+[a-z]?\\M'");
    // Only Louisiana fall jungle primaries are terminal-stage — the exact
    // complement of listTerminalStagePrimaries, so a November or December
    // primary in any other state stays gap-eligible.
    expect(sql).toContain("NOT (d.state = 'LA' AND EXTRACT(MONTH FROM e.election_date) >= 11)");
    // Deferral-covered primaries belong to manual:deferral:due.
    expect(sql).toContain("mrd.status = 'deferred'");
    expect(sql).toContain("mrd.stage = 'elections'");
    // Decisive-result signal: winners recorded as advancing to a race that
    // does not exist.
    expect(sql).toContain("er.outcome IN ('won', 'advanced', 'runoff')");
    expect(sql).toContain(
      "ORDER BY d.state ASC NULLS LAST, e.election_date ASC, d.name ASC, e.official_ballot_title ASC, e.id ASC"
    );
  });

  it("passes the state filter through", async () => {
    const db = createMockQueryable();

    await listMissingGeneralElections(db, {
      asOfDate: "2026-08-09",
      lookbackDays: 30,
      lookaheadDays: 60,
      horizonDays: 90,
      state: "MI",
    });

    const [sql, params] = db.query.mock.calls[0]!;
    expect(params).toEqual(["2026-08-09", 30, 60, 90, "MI", null]);
    expect(sql).toContain("$5::text IS NULL OR d.state = $5::text");
    expect(sql).toContain("$6::uuid[] IS NULL OR e.district_id = ANY($6::uuid[])");
  });
});

describe("listTerminalStagePrimaries", () => {
  it("lists Louisiana fall jungle primaries as visibility rows, not gaps", async () => {
    const row = {
      election_id: "e-la",
      state: "LA",
      district_name: "City of Shreveport, Louisiana",
      district_type: "place",
      official_ballot_title: "City Marshal City Court, City of Shreveport",
      election_date: "2026-11-03",
    };
    const db = createMockQueryable([row]);

    const result = await listTerminalStagePrimaries(db, {
      asOfDate: "2026-08-09",
      lookbackDays: 180,
      lookaheadDays: 365,
      horizonDays: 365,
    });

    expect(result).toEqual([row]);
    const [sql, params] = db.query.mock.calls[0]!;
    expect(params).toEqual(["2026-08-09", 180, 365, null]);
    // Louisiana-only: a November primary anywhere else is a gap candidate,
    // not a jungle primary.
    expect(sql).toContain("d.state = 'LA'");
    expect(sql).toContain("EXTRACT(MONTH FROM e.election_date) >= 11");
    expect(sql).toContain("e.election_stage = 'primary'");
  });
});
