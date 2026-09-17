import type { Pool, PoolClient } from "pg";

import {
  BALLOT_MEASURE_FUNDING_SIDES,
  type BallotMeasureFundingCommittee,
  type BallotMeasureFundingDonor,
  type BallotMeasureFundingPayload,
  type BallotMeasureFundingSide,
} from "../../contracts/ballotMeasureFundingPayloadContract.js";

type Queryable = Pick<Pool | PoolClient, "query">;

// What the election page gets. Committee names stay out on purpose: the page
// shows who paid, and a committee name can hide that. The committees' filing
// pages come through as source_urls so a reader can still check the numbers.
export type BallotMeasureFundingSideView = {
  total_raised: number;
  // The part of total_raised held by committees that also back or fight other
  // measures. That money cannot be assigned to this measure alone, so the
  // page says how much of the total it is.
  shared_with_other_measures_raised: number;
  top_donors: BallotMeasureFundingDonor[];
  source_urls: string[];
};

export type BallotMeasureFundingView = {
  as_of: string;
  support: BallotMeasureFundingSideView;
  oppose: BallotMeasureFundingSideView;
};

type BallotMeasureFundingRow = {
  ballot_measure_id: string;
  side: BallotMeasureFundingSide;
  total_raised: string;
  committees: BallotMeasureFundingCommittee[];
  top_donors: BallotMeasureFundingDonor[];
  as_of: string;
};

const EMPTY_SIDE: BallotMeasureFundingSideView = {
  total_raised: 0,
  shared_with_other_measures_raised: 0,
  top_donors: [],
  source_urls: [],
};

function toSideView(row: BallotMeasureFundingRow): BallotMeasureFundingSideView {
  // Same netting as the side total: money a committee got from another listed
  // committee on its side is not counted again. Summed in cents.
  const sharedCents = row.committees
    .filter((committee) => committee.also_covers_other_measures)
    .reduce(
      (sum, committee) =>
        sum + Math.round(committee.total_raised * 100) - Math.round(committee.from_same_side_committees * 100),
      0
    );
  return {
    total_raised: Number(row.total_raised),
    shared_with_other_measures_raised: sharedCents / 100,
    top_donors: row.top_donors,
    source_urls: [...new Set(row.committees.map((committee) => committee.source_url))],
  };
}

// Measures with no funding rows are absent from the map ("not researched").
export async function loadBallotMeasureFundingByMeasure(
  db: Queryable,
  ballotMeasureIds: readonly string[]
): Promise<Map<string, BallotMeasureFundingView>> {
  const result = await db.query<BallotMeasureFundingRow>(
    `
      SELECT
        f.ballot_measure_id,
        f.side,
        f.total_raised::text AS total_raised,
        f.committees,
        f.top_donors,
        f.as_of::text AS as_of
      FROM public.ballot_measure_funding AS f
      WHERE f.ballot_measure_id = ANY($1::uuid[])
      ORDER BY f.ballot_measure_id, f.side
    `,
    [ballotMeasureIds]
  );

  const fundingByMeasure = new Map<string, BallotMeasureFundingView>();
  for (const row of result.rows) {
    // The writer stamps both sides with one as_of in one transaction.
    const view = fundingByMeasure.get(row.ballot_measure_id) ?? {
      as_of: row.as_of,
      support: EMPTY_SIDE,
      oppose: EMPTY_SIDE,
    };
    view[row.side] = toSideView(row);
    fundingByMeasure.set(row.ballot_measure_id, view);
  }
  return fundingByMeasure;
}

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
