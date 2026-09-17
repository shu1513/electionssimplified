import { describe, expect, it, vi } from "vitest";

import type { BallotMeasureFundingPayload } from "../../src/contracts/ballotMeasureFundingPayloadContract.js";
import {
  loadBallotMeasureFundingByMeasure,
  upsertBallotMeasureFunding,
} from "../../src/pipeline/ballotMeasures/ballotMeasureFunding.js";

const MEASURE_ID = "11111111-1111-4111-8111-111111111111";

const PAYLOAD: BallotMeasureFundingPayload = {
  as_of: "2026-09-17",
  sides: {
    support: { committees: [], top_donors: [] },
    oppose: {
      committees: [
        {
          name: "No on 645",
          also_covers_other_measures: false,
          source_url: "https://www.pdc.wa.gov/committees/co-2026-42211",
        },
      ],
      top_donors: [
        {
          name: "Washington Education Association",
          amount: 3014260.91,
          type: "organization",
          about: "Washington's teachers union",
        },
      ],
    },
  },
};

describe("loadBallotMeasureFundingByMeasure", () => {
  it("returns an empty map for measures with no funding rows", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] });

    const result = await loadBallotMeasureFundingByMeasure({ query }, [MEASURE_ID]);

    expect(result.size).toBe(0);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("FROM public.ballot_measure_funding"), [[MEASURE_ID]]);
  });

  it("builds one view per measure and hides committee names", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [
        {
          ballot_measure_id: MEASURE_ID,
          side: "oppose",
          committees: [
            ...PAYLOAD.sides.oppose.committees,
            {
              name: "Permanent Defense PAC",
              also_covers_other_measures: true,
              source_url: "https://www.pdc.wa.gov/committees/co-2026-42211",
            },
          ],
          top_donors: PAYLOAD.sides.oppose.top_donors,
          as_of: "2026-09-17",
        },
      ],
    });

    const result = await loadBallotMeasureFundingByMeasure({ query }, [MEASURE_ID]);

    expect(result.get(MEASURE_ID)).toEqual({
      as_of: "2026-09-17",
      // A side with no row reads as empty rather than missing.
      support: { shared_with_other_measures: false, top_donors: [], source_urls: [] },
      oppose: {
        shared_with_other_measures: true,
        top_donors: PAYLOAD.sides.oppose.top_donors,
        // Two committees filed on one page: the link is listed once.
        source_urls: ["https://www.pdc.wa.gov/committees/co-2026-42211"],
      },
    });
    expect(JSON.stringify(result.get(MEASURE_ID))).not.toContain("No on 645");
  });
});

describe("upsertBallotMeasureFunding", () => {
  it("upserts both sides, including an empty side, keyed by measure and side", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });

    const result = await upsertBallotMeasureFunding({ query }, MEASURE_ID, PAYLOAD);

    expect(result).toEqual({ sidesWritten: 2 });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining("ON CONFLICT (ballot_measure_id, side)"), [
      MEASURE_ID,
      "support",
      "[]",
      "[]",
      "2026-09-17",
    ]);
    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining("INSERT INTO public.ballot_measure_funding"), [
      MEASURE_ID,
      "oppose",
      JSON.stringify(PAYLOAD.sides.oppose.committees),
      JSON.stringify(PAYLOAD.sides.oppose.top_donors),
      "2026-09-17",
    ]);
    expect(String(query.mock.calls[0]?.[0])).not.toContain("total_raised");
  });
});
