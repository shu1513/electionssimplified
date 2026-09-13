import { afterEach, describe, expect, it, vi } from "vitest";

import {
  findResearchGapsForDistricts,
  listManualResearchDemand,
  MANUAL_RESEARCH_DEMAND_STAGES,
  pruneManualResearchDemand,
  recordManualResearchDemandForDistricts,
  type ManualResearchDemandRow,
  type ResearchGap,
} from "../../../src/pipeline/address/manualResearchDemand.js";

const DISTRICT_ID = "11111111-1111-4111-8111-111111111111";
const ELECTION_ID = "22222222-2222-4222-8222-222222222222";
const CANDIDATE_ID = "33333333-3333-4333-8333-333333333333";

function makeGap(overrides: Partial<ResearchGap> = {}): ResearchGap {
  return {
    stage: "candidate_roster",
    target_id: ELECTION_ID,
    district_id: DISTRICT_ID,
    election_id: ELECTION_ID,
    state: "CA",
    label: "Mayor, City of Example",
    election_date: "2026-11-03",
    ...overrides,
  };
}

function makeLedgerRow(overrides: Partial<ManualResearchDemandRow> = {}): ManualResearchDemandRow {
  return {
    ...makeGap(),
    request_count: 4,
    first_requested_at: "2026-09-01T00:00:00Z",
    last_requested_at: "2026-09-10T00:00:00Z",
    last_trigger_source: "address_resolve",
    ...overrides,
  };
}

// Gap detection issues one query per SQL-backed stage, then the
// missing-generals report. Mocks answer in that order.
const SQL_STAGE_COUNT = MANUAL_RESEARCH_DEMAND_STAGES.length - 1;

function mockGapQueries(query: ReturnType<typeof vi.fn>, rowsByStage: Partial<Record<string, unknown[]>>) {
  for (const stage of MANUAL_RESEARCH_DEMAND_STAGES) {
    if (stage === "missing_general") {
      continue;
    }
    query.mockResolvedValueOnce({ rows: rowsByStage[stage] ?? [] });
  }
  query.mockResolvedValueOnce({ rows: rowsByStage.missing_general ?? [] });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("findResearchGapsForDistricts", () => {
  it("returns nothing and issues no queries for an empty district list", async () => {
    const query = vi.fn();
    expect(await findResearchGapsForDistricts({ query }, { districtIds: [], asOfDate: "2026-09-11", horizonDays: 365 })).toEqual(
      []
    );
    expect(query).not.toHaveBeenCalled();
  });

  it("binds deduplicated district ids, the as-of date and the horizon to every stage query", async () => {
    const query = vi.fn();
    mockGapQueries(query, {
      candidate_roster: [makeGap()],
      missing_general: [
        {
          election_id: ELECTION_ID,
          district_id: DISTRICT_ID,
          state: "CA",
          official_ballot_title: "Governor",
          election_date: "2026-06-02",
        },
      ],
    });

    const gaps = await findResearchGapsForDistricts(
      { query },
      { districtIds: [DISTRICT_ID, DISTRICT_ID], asOfDate: "2026-09-11", horizonDays: 200 }
    );

    expect(query).toHaveBeenCalledTimes(SQL_STAGE_COUNT + 1);
    for (let index = 0; index < SQL_STAGE_COUNT; index += 1) {
      const [sql, params] = query.mock.calls[index]!;
      expect(params).toEqual([[DISTRICT_ID], "2026-09-11", 200]);
      expect(sql).toContain("e.district_id = ANY($1::uuid[])");
    }
    // Missing generals reuse the report's own parameter set, scoped to the ballot's districts.
    const [missingSql, missingParams] = query.mock.calls[SQL_STAGE_COUNT]!;
    expect(missingParams).toEqual(["2026-09-11", 200, 200, 200, null, [DISTRICT_ID]]);
    expect(missingSql).toContain("e.election_stage = 'primary'");

    expect(gaps).toEqual([
      makeGap(),
      makeGap({ stage: "missing_general", label: "Governor", election_date: "2026-06-02" }),
    ]);
  });

  it("pins the gap rules each stage query encodes", async () => {
    const query = vi.fn();
    mockGapQueries(query, {});
    await findResearchGapsForDistricts({ query }, { districtIds: [DISTRICT_ID], asOfDate: "2026-09-11", horizonDays: 365 });
    const sqlByStage = new Map(
      MANUAL_RESEARCH_DEMAND_STAGES.filter((stage) => stage !== "missing_general").map((stage, index) => [
        stage,
        query.mock.calls[index]![0] as string,
      ])
    );
    // Roster: no link at all, and no live roster deferral.
    expect(sqlByStage.get("candidate_roster")).toContain("NOT EXISTS (\n        SELECT 1 FROM public.candidate_elections");
    expect(sqlByStage.get("candidate_roster")).toContain("mrd.stage = 'candidate_roster'");
    expect(sqlByStage.get("candidate_roster")).toContain("mrd.blocked_until > $2::date");
    // Profile / records: live, non-withdrawn candidates only, one row per candidate.
    for (const stage of ["candidate_profile", "candidate_records"] as const) {
      expect(sqlByStage.get(stage)).toContain("DISTINCT ON (c.id)");
      expect(sqlByStage.get(stage)).toContain("ce.status <> 'withdrawn'");
      expect(sqlByStage.get(stage)).toContain("c.deleted_at IS NULL");
      expect(sqlByStage.get(stage)).toContain("c.merged_into_candidate_id IS NULL");
    }
    // Profile: a blank summary OR the fixed "no public information"
    // placeholder counts, unless a live profile deferral covers the candidate
    // (district-wide, election-wide, or keyed profile-<candidate id prefix>).
    const profileSql = sqlByStage.get("candidate_profile")!;
    expect(profileSql).toContain("COALESCE(btrim(c.summary), '') = ''");
    expect(profileSql).toContain("OR btrim(c.summary) ~ '^As of (January|February|March|April|May|June|July|August|September|October|November|December) [0-9]{4}, we found no public information about .+''s job, background, or goals\\.$'");
    expect(profileSql).toContain("mrd.stage = 'candidate_profile'");
    expect(profileSql).toContain("mrd.blocked_until > $2::date");
    expect(profileSql).toContain("(mrd.election_id = e.id OR (mrd.election_id IS NULL AND mrd.district_id = e.district_id))");
    expect(profileSql).toContain("OR mrd.blocker_key NOT LIKE 'profile-%'");
    expect(profileSql).toContain("OR mrd.blocker_key = 'profile-' || left(c.id::text, 8)");
    expect(sqlByStage.get("candidate_records")).toContain("c.last_records_searched_at IS NULL");
    // Measures: keyed by the election so a measure election with no detail
    // row yet (the writer creates it after research) still counts.
    expect(sqlByStage.get("ballot_measure")).toContain("SELECT 'ballot_measure' AS stage, e.id::text AS target_id");
    expect(sqlByStage.get("ballot_measure")).toContain("LEFT JOIN public.ballot_measures AS bm ON bm.election_id = e.id");
    expect(sqlByStage.get("ballot_measure")).toContain("e.race_type = 'ballot_measure'");
    expect(sqlByStage.get("ballot_measure")).toContain(
      "bm.id IS NULL OR bm.last_researched IS NULL OR COALESCE(btrim(bm.summary), '') = ''"
    );
    // Results: past races with a roster but no decisive outcome; measures without a result.
    expect(sqlByStage.get("election_results")).toContain("e.election_date < $2::date");
    expect(sqlByStage.get("election_results")).toContain("er.outcome IN ('won', 'advanced', 'runoff')");
    expect(sqlByStage.get("election_results")).toContain("bm.result IS NULL");
  });
});

describe("recordManualResearchDemandForDistricts", () => {
  it("returns zeros without queries for an empty district list", async () => {
    const query = vi.fn();
    const result = await recordManualResearchDemandForDistricts({ query }, { districts: [], triggerSource: "address_resolve" });
    expect(result).toEqual({ checked_districts: 0, gaps: 0, recorded: 0, bumped: 0, failed: 0 });
    expect(query).not.toHaveBeenCalled();
  });

  it("upserts one counter row per gap in a single statement and classifies new vs bumped", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const query = vi.fn();
    const rosterGap = makeGap();
    const recordsGap = makeGap({ stage: "candidate_records", target_id: CANDIDATE_ID, label: "Jane Doe" });
    mockGapQueries(query, { candidate_roster: [rosterGap], candidate_records: [recordsGap] });
    query.mockResolvedValueOnce({ rows: [{ request_count: 1 }, { request_count: 5 }] });

    const result = await recordManualResearchDemandForDistricts(
      { query },
      { districts: [{ id: DISTRICT_ID }], triggerSource: "me_address_update", asOfDate: "2026-09-11", horizonDays: 365 }
    );

    expect(result).toEqual({ checked_districts: 1, gaps: 2, recorded: 1, bumped: 1, failed: 0 });
    const [sql, params] = query.mock.calls[SQL_STAGE_COUNT + 1]!;
    expect(sql).toContain("INSERT INTO public.manual_research_demand");
    expect(sql).toContain("ON CONFLICT (stage, target_id) DO UPDATE SET");
    expect(sql).toContain("request_count = public.manual_research_demand.request_count + 1");
    expect(params).toEqual([
      ["candidate_roster", "candidate_records"],
      [ELECTION_ID, CANDIDATE_ID],
      [DISTRICT_ID, DISTRICT_ID],
      [ELECTION_ID, ELECTION_ID],
      ["CA", "CA"],
      ["Mayor, City of Example", "Jane Doe"],
      ["2026-11-03", "2026-11-03"],
      "me_address_update",
    ]);
  });

  it("skips the upsert when the ballot has no gaps", async () => {
    const query = vi.fn();
    mockGapQueries(query, {});
    const result = await recordManualResearchDemandForDistricts(
      { query },
      { districts: [{ id: DISTRICT_ID }], triggerSource: "address_resolve", asOfDate: "2026-09-11" }
    );
    expect(result).toEqual({ checked_districts: 1, gaps: 0, recorded: 0, bumped: 0, failed: 0 });
    expect(query).toHaveBeenCalledTimes(SQL_STAGE_COUNT + 1);
  });

  it("never throws: a database failure is reported as failed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const query = vi.fn().mockRejectedValue(new Error("relation does not exist"));
    const result = await recordManualResearchDemandForDistricts(
      { query },
      { districts: [{ id: DISTRICT_ID }], triggerSource: "address_resolve", asOfDate: "2026-09-11" }
    );
    expect(result).toEqual({ checked_districts: 1, gaps: 0, recorded: 0, bumped: 0, failed: 1 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("address response unaffected"), "relation does not exist");
  });
});

describe("listManualResearchDemand / pruneManualResearchDemand", () => {
  it("splits ledger rows into still-open (hottest first, limited) and closed", async () => {
    const query = vi.fn();
    const hot = makeLedgerRow({ request_count: 9 });
    const closed = makeLedgerRow({ stage: "candidate_profile", target_id: CANDIDATE_ID, request_count: 3 });
    const warm = makeLedgerRow({ stage: "candidate_records", target_id: CANDIDATE_ID, request_count: 2 });
    query.mockResolvedValueOnce({ rows: [hot, closed, warm] });
    // Live gaps: the roster and records rows are still open; the profile was researched since.
    mockGapQueries(query, {
      candidate_roster: [makeGap()],
      candidate_records: [makeGap({ stage: "candidate_records", target_id: CANDIDATE_ID })],
    });

    const result = await listManualResearchDemand({ query }, { asOfDate: "2026-09-11", horizonDays: 365, limit: 1 });

    expect(result.open).toEqual([hot]);
    expect(result.closed).toEqual([closed]);
    const [ledgerSql, ledgerParams] = query.mock.calls[0]!;
    expect(ledgerSql).toContain("ORDER BY request_count DESC, last_requested_at DESC");
    expect(ledgerParams).toEqual([null, null]);
    // Gap detection covers the districts the ledger rows point at.
    expect(query.mock.calls[1]![1]).toEqual([[DISTRICT_ID], "2026-09-11", 365]);
  });

  it("prune deletes exactly the closed rows", async () => {
    const query = vi.fn();
    const open = makeLedgerRow();
    const closed = makeLedgerRow({ stage: "candidate_profile", target_id: CANDIDATE_ID });
    query.mockResolvedValueOnce({ rows: [open, closed] });
    mockGapQueries(query, { candidate_roster: [makeGap()] });
    query.mockResolvedValueOnce({ rowCount: 1 });

    const result = await pruneManualResearchDemand({ query }, { asOfDate: "2026-09-11", horizonDays: 365 });

    expect(result).toEqual({ deleted: 1 });
    const [sql, params] = query.mock.calls[SQL_STAGE_COUNT + 2]!;
    expect(sql).toContain("DELETE FROM public.manual_research_demand");
    expect(params).toEqual([["candidate_profile"], [CANDIDATE_ID]]);
  });

  it("prune issues no delete when nothing closed", async () => {
    const query = vi.fn();
    query.mockResolvedValueOnce({ rows: [] });
    expect(await pruneManualResearchDemand({ query }, { asOfDate: "2026-09-11", horizonDays: 365 })).toEqual({ deleted: 0 });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
