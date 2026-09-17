import { describe, expect, it, vi } from "vitest";

import type { BallotMeasureFundingPayload } from "../../src/contracts/ballotMeasureFundingPayloadContract.js";
import { upsertBallotMeasureFunding } from "../../src/pipeline/ballotMeasures/ballotMeasureFunding.js";

const MEASURE_ID = "11111111-1111-4111-8111-111111111111";

const PAYLOAD: BallotMeasureFundingPayload = {
  as_of: "2026-09-17",
  sides: {
    support: { total_raised: 0, committees: [], top_donors: [] },
    oppose: {
      total_raised: 7805687.5,
      committees: [
        {
          name: "No on 645",
          total_raised: 7805687.5,
          from_same_side_committees: 0,
          also_covers_other_measures: false,
          source_url: "https://www.pdc.wa.gov/committees/co-2026-42211",
        },
      ],
      top_donors: [{ name: "Washington Education Association", amount: 3014260.91, type: "organization" }],
    },
  },
};

describe("upsertBallotMeasureFunding", () => {
  it("upserts both sides, including an empty side, keyed by measure and side", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });

    const result = await upsertBallotMeasureFunding({ query }, MEASURE_ID, PAYLOAD);

    expect(result).toEqual({ sidesWritten: 2 });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining("ON CONFLICT (ballot_measure_id, side)"), [
      MEASURE_ID,
      "support",
      "0.00",
      "[]",
      "[]",
      "2026-09-17",
    ]);
    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining("INSERT INTO public.ballot_measure_funding"), [
      MEASURE_ID,
      "oppose",
      "7805687.50",
      JSON.stringify(PAYLOAD.sides.oppose.committees),
      JSON.stringify(PAYLOAD.sides.oppose.top_donors),
      "2026-09-17",
    ]);
  });
});
