import type { PoolClient } from "pg";

import {
  BALLOT_MEASURE_FUNDING_SIDES,
  type BallotMeasureFundingPayload,
} from "../../contracts/ballotMeasureFundingPayloadContract.js";

type Queryable = Pick<PoolClient, "query">;

// Writes both sides every time. An empty side is a finding ("researched, no
// committee reported money"), and a refresh must be able to replace a side
// that had committees with an empty one. Run inside the caller's transaction
// so a measure never shows one fresh side next to one stale side.
export async function upsertBallotMeasureFunding(
  client: Queryable,
  ballotMeasureId: string,
  payload: BallotMeasureFundingPayload
): Promise<{ sidesWritten: number }> {
  for (const side of BALLOT_MEASURE_FUNDING_SIDES) {
    const record = payload.sides[side];
    await client.query(
      `
        INSERT INTO public.ballot_measure_funding (
          ballot_measure_id,
          side,
          total_raised,
          committees,
          top_donors,
          as_of
        )
        VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::date)
        ON CONFLICT (ballot_measure_id, side)
        DO UPDATE SET
          total_raised = EXCLUDED.total_raised,
          committees = EXCLUDED.committees,
          top_donors = EXCLUDED.top_donors,
          as_of = EXCLUDED.as_of
      `,
      [
        ballotMeasureId,
        side,
        // numeric(14,2): pass as a fixed-point string so no float digits leak in.
        record.total_raised.toFixed(2),
        JSON.stringify(record.committees),
        JSON.stringify(record.top_donors),
        payload.as_of,
      ]
    );
  }
  return { sidesWritten: BALLOT_MEASURE_FUNDING_SIDES.length };
}
