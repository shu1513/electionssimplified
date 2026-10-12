import { describe, expect, it, vi } from "vitest";

import { listDueDelawareCandidateFinanceSyncRows } from "../../../src/pipeline/delawareFinance/delawareCandidateFinanceDueList.js";
import { DELAWARE_FINANCE_ELIGIBLE_OFFICE_KEYS } from "../../../src/pipeline/delawareFinance/delawareFinanceEligibleOffices.js";

describe("listDueDelawareCandidateFinanceSyncRows", () => {
  it("queries link-gated staleness and returns ISO election dates for the window resolver", async () => {
    const db = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            candidate_id: "c1",
            election_id: "e1",
            candidate_name: "Jane Example",
            election_year: 2026,
            election_date: "2026-11-03T00:00:00.000Z",
            office_scope: "statewide",
            office_name: "Attorney General",
            district: null,
            committee_id: "01009999",
            committee_name: "Jane Example for Delaware",
            link_source: "cfrs_portal",
            source_url: null,
            last_synced_at: null,
            total_due_rows: "4",
          },
        ],
        rowCount: 1,
      }),
    };
    const result = await listDueDelawareCandidateFinanceSyncRows(db, {
      now: new Date("2026-08-28T00:00:00.000Z"),
      staleAfterDays: 7,
      maxCandidates: 10,
      electionLookbackDays: 39,
      electionLookaheadDays: 730,
    });
    expect(result.totalDueRows).toBe(4);
    expect(result.rows[0]).toMatchObject({
      candidateId: "c1",
      electionDate: "2026-11-03",
      cfId: "01009999",
      linkSource: "cfrs_portal",
      lastSyncedAt: null,
    });
    const sql = String(db.query.mock.calls[0]?.[0]);
    // Builder wording (the bespoke query omitted AS/spaces and aliased districts
    // as district_row); same tables and predicates.
    expect(sql).toContain("FROM public.de_candidate_finance_links AS link");
    expect(sql).toContain("summary.last_synced_at IS NULL");
    expect(sql).toContain("OR summary.last_synced_at < ($1::timestamptz - make_interval(days => $2::int))");
    expect(sql).toContain("election.election_stage = 'general'");
    expect(sql).toContain("district.state = 'DE'");
    expect(db.query.mock.calls[0]?.[1]?.[5]).toEqual([...DELAWARE_FINANCE_ELIGIBLE_OFFICE_KEYS]);
  });
  it("selects a recent scoped row with January year-end lookback before LIMIT", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const now = new Date("2027-01-21T12:00:00.000Z");
    const db = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            candidate_id: id,
            election_id: "e1",
            candidate_name: "Jane Example",
            election_year: 2026,
            election_date: "2026-11-03",
            office_scope: "statewide",
            office_name: "Attorney General",
            district: null,
            committee_id: "01009999",
            committee_name: "Jane Example for Delaware",
            link_source: "manual",
            source_url: null,
            last_synced_at: now.toISOString(),
            total_due_rows: 1,
          },
        ],
      }),
    };
    const result = await listDueDelawareCandidateFinanceSyncRows(db, {
      now,
      staleAfterDays: 7,
      maxCandidates: 1,
      electionLookbackDays: 100,
      electionLookaheadDays: 730,
      candidateId: id,
      electionYear: 2026,
      refresh: true,
    });
    const [sqlValue, params] = db.query.mock.calls[0]!;
    const sql = String(sqlValue);
    expect(sql).toContain("AND link.candidate_id = $7::uuid");
    expect(sql).toContain("AND link.election_year = $8::int");
    expect(sql).toContain("AND EXTRACT(YEAR FROM election.election_date)::int = $8::int");
    expect(sql).toContain("$9::boolean");
    expect(sql.indexOf("link.candidate_id = $7")).toBeLessThan(sql.indexOf("LIMIT $3"));
    expect(sql.indexOf("link.election_year = $8")).toBeLessThan(sql.indexOf("LIMIT $3"));
    expect(params?.[3]).toBe(100);
    expect(params?.slice(6)).toEqual([id, 2026, true]);
    // Jan21 is79days after Nov3: the configured100-day SQL window includes
    // the election for the Jan20 annual report rerun; old39days would not.
    const daysAfterElection = (Date.parse("2027-01-21") - Date.parse("2026-11-03")) / 86_400_000;
    expect(daysAfterElection).toBe(79);
    expect(daysAfterElection).toBeLessThanOrEqual(Number(params?.[3]));
    expect(result.rows[0]?.lastSyncedAt).toBe(now.toISOString());
    expect(sql).toContain("election.election_stage = 'general'");
  });

  it.each([{ candidateId: "c1" }, { electionYear: 2025 }, { electionYear: 2101 }])(
    "rejects invalid Delaware scope without querying: %j",
    async (scope) => {
      const db = { query: vi.fn() };
      await expect(
        listDueDelawareCandidateFinanceSyncRows(db, {
          now: new Date(),
          staleAfterDays: 7,
          maxCandidates: 1,
          electionLookbackDays: 100,
          electionLookaheadDays: 730,
          ...scope,
        })
      ).rejects.toThrow("Invalid Delaware finance");
      expect(db.query).not.toHaveBeenCalled();
    }
  );
});
