import { describe, expect, it, vi } from "vitest";

import { listDueSouthCarolinaCandidateFinanceSyncRows } from "../../../src/pipeline/southCarolinaFinance/southCarolinaCandidateFinanceDueList.js";
import { SOUTH_CAROLINA_FINANCE_ELIGIBLE_OFFICE_KEYS } from "../../../src/pipeline/southCarolinaFinance/southCarolinaFinanceEligibleOffices.js";

describe("listDueSouthCarolinaCandidateFinanceSyncRows", () => {
  it("queries active general-election links with staleness gating and maps rows", async () => {
    const db = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            candidate_id: "candidate-1",
            election_id: "election-1",
            candidate_name: "Pamela Evette",
            election_year: 2026,
            election_date: "2026-11-03T00:00:00.000Z",
            office_scope: "statewide",
            office_name: "Governor",
            district: null,
            candidate_filer_id: "54395",
            candidate_filer_name: "Evette, Pamela S",
            link_source: "ethics_filer_search",
            source_url: "https://ethicsfiling.sc.gov/public",
            last_synced_at: null,
            total_due_rows: "3",
          },
        ],
      }),
    };

    const result = await listDueSouthCarolinaCandidateFinanceSyncRows(db, {
      now: new Date("2026-08-27T00:00:00.000Z"),
      staleAfterDays: 7,
      maxCandidates: 10,
      electionLookbackDays: 76,
      electionLookaheadDays: 730,
    });

    const [sql, params] = db.query.mock.calls[0]!;
    expect(String(sql)).toContain("sc_candidate_finance_links");
    expect(String(sql)).toContain("sc_candidate_finance_summaries");
    // Builder wording (the bespoke query wrote these without spaces and
    // aliased districts as district_row); same predicates.
    expect(String(sql)).toContain("election.election_stage = 'general'");
    expect(String(sql)).toContain("district.state = 'SC'");
    expect(String(sql)).toContain("candidate_election.status NOT IN ('withdrawn', 'lost')");
    expect(params).toEqual([
      "2026-08-27T00:00:00.000Z",
      7,
      10,
      76,
      730,
      [...SOUTH_CAROLINA_FINANCE_ELIGIBLE_OFFICE_KEYS],
      false,
      null,
      null,
    ]);

    expect(result.totalDueRows).toBe(3);
    expect(result.rows).toEqual([
      {
        candidateId: "candidate-1",
        electionId: "election-1",
        candidateName: "Pamela Evette",
        electionYear: 2026,
        electionDate: "2026-11-03",
        officeScope: "statewide",
        officeName: "Governor",
        district: null,
        candidateFilerId: 54395,
        filerName: "Evette, Pamela S",
        linkSource: "ethics_filer_search",
        sourceUrl: "https://ethicsfiling.sc.gov/public",
        lastSyncedAt: null,
      },
    ]);
  });

  it("rejects a corrupted stored filer id instead of syncing the wrong filer", async () => {
    const db = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            candidate_id: "candidate-1",
            election_id: "election-1",
            candidate_name: "X",
            election_year: 2026,
            election_date: "2026-11-03",
            office_scope: "statewide",
            office_name: "Governor",
            district: null,
            candidate_filer_id: "0",
            candidate_filer_name: "Y",
            link_source: "manual",
            source_url: null,
            last_synced_at: null,
            total_due_rows: 1,
          },
        ],
      }),
    };

    await expect(
      listDueSouthCarolinaCandidateFinanceSyncRows(db, {
        now: new Date("2026-08-27T00:00:00.000Z"),
        staleAfterDays: 7,
        maxCandidates: 10,
        electionLookbackDays: 76,
        electionLookaheadDays: 730,
      })
    ).rejects.toThrow("Invalid stored South Carolina candidate filer ID: 0");
  });

  it("returns zero totals for an empty due list", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const result = await listDueSouthCarolinaCandidateFinanceSyncRows(db, {
      now: new Date("2026-08-27T00:00:00.000Z"),
      staleAfterDays: 7,
      maxCandidates: 10,
      electionLookbackDays: 76,
      electionLookaheadDays: 730,
    });
    expect(result).toEqual({ rows: [], totalDueRows: 0 });
  });

  it("applies refresh and candidate/year scopes before LIMIT", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    await listDueSouthCarolinaCandidateFinanceSyncRows(db, {
      now: new Date("2026-10-20T00:00:00Z"), staleAfterDays: 7, maxCandidates: 1,
      electionLookbackDays: 100, electionLookaheadDays: 730, refresh: true,
      candidateId: "09f72416-21e9-4a08-b172-a6e958d2f660", electionYear: 2026,
    });
    const [sql, params] = db.query.mock.calls[0]!;
    expect(String(sql).indexOf("OR $7::boolean")).toBeLessThan(String(sql).indexOf("LIMIT $3"));
    expect(String(sql).indexOf("link.candidate_id = $8::uuid")).toBeLessThan(String(sql).indexOf("LIMIT $3"));
    expect(params.slice(-3)).toEqual([true, "09f72416-21e9-4a08-b172-a6e958d2f660", 2026]);
  });
});
