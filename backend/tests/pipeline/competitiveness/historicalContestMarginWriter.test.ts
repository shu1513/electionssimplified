import { describe, expect, it, vi } from "vitest";

import {
  upsertHistoricalContestMargins,
} from "../../../src/pipeline/competitiveness/historicalContestMarginWriter.js";
import type { HistoricalContestMarginRecord } from "../../../src/pipeline/competitiveness/historicalContestNormalizer.js";

function record(overrides: Partial<HistoricalContestMarginRecord> = {}): HistoricalContestMarginRecord {
  return {
    source: "MIT_2024",
    source_url: "https://github.com/MEDSL/2024-elections-official",
    election_year: 2024,
    state: "CA",
    state_fips: "06",
    office_type: "US_HOUSE",
    district_type: "us_house",
    district_key: "0631",
    mit_office: "US HOUSE",
    mit_district: "031",
    winner_party: "DEMOCRAT",
    runner_up_party: "REPUBLICAN",
    winner_votes: 109_200,
    runner_up_votes: 90_800,
    total_votes: 200_000,
    margin_percent: 9.2,
    competitiveness_label: "competitive",
    stale_after_redistricting: false,
    candidate_lines: [
      { votes: 109_200, party: "DEMOCRAT" },
      { votes: 90_800, party: "REPUBLICAN" },
    ],
    ...overrides,
  };
}

describe("historicalContestMarginWriter", () => {
  it("does nothing for an empty record list", async () => {
    const query = vi.fn();

    await expect(upsertHistoricalContestMargins({ query } as never, [])).resolves.toEqual({
      requested: 0,
      rowsWritten: 0,
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("upserts historical contest margin records", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    const importedAt = new Date("2026-06-14T12:00:00.000Z");

    await expect(
      upsertHistoricalContestMargins({ query } as never, [record()], { importedAt })
    ).resolves.toEqual({
      requested: 1,
      rowsWritten: 1,
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain("INSERT INTO public.historical_contest_margins");
    expect(query.mock.calls[0]?.[0]).toContain(
      "ON CONFLICT (source, election_year, state, office_type, district_type, district_key)"
    );
    expect(query.mock.calls[0]?.[1]).toEqual([
      "MIT_2024",
      "https://github.com/MEDSL/2024-elections-official",
      2024,
      "CA",
      "06",
      "US_HOUSE",
      "us_house",
      "0631",
      "US HOUSE",
      "031",
      "DEMOCRAT",
      "REPUBLICAN",
      109_200,
      90_800,
      200_000,
      9.2,
      "competitive",
      false,
      "2026-06-14T12:00:00.000Z",
      '[{"votes":109200,"party":"DEMOCRAT"},{"votes":90800,"party":"REPUBLICAN"}]',
    ]);
  });

  it("upserts each record independently", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });

    await expect(
      upsertHistoricalContestMargins({ query } as never, [
        record(),
        record({
          office_type: "US_SENATE",
          district_type: "statewide",
          district_key: "06",
          mit_office: "US SENATE",
          mit_district: "STATEWIDE",
        }),
      ])
    ).resolves.toEqual({
      requested: 2,
      rowsWritten: 2,
    });

    expect(query).toHaveBeenCalledTimes(2);
  });

  it("throws when an upsert does not write exactly one row", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0 });

    await expect(upsertHistoricalContestMargins({ query } as never, [record()])).rejects.toThrow(
      "historical contest margin upsert expected to write exactly one row"
    );
  });
});
