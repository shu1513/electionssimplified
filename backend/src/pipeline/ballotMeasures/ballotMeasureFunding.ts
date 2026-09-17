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
  // True when a committee these donors gave to also backs or fights other
  // measures, so their money cannot be assigned to this measure alone.
  shared_with_other_measures: boolean;
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
  committees: BallotMeasureFundingCommittee[];
  top_donors: BallotMeasureFundingDonor[];
  as_of: string;
};

const EMPTY_SIDE: BallotMeasureFundingSideView = {
  shared_with_other_measures: false,
  top_donors: [],
  source_urls: [],
};

function toSideView(row: BallotMeasureFundingRow): BallotMeasureFundingSideView {
  return {
    shared_with_other_measures: row.committees.some((committee) => committee.also_covers_other_measures),
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
// donors reported"), and a refresh must be able to replace a side that had
// donors with an empty one. Run inside the caller's transaction
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
          committees,
          top_donors,
          as_of
        )
        VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::date)
        ON CONFLICT (ballot_measure_id, side)
        DO UPDATE SET
          committees = EXCLUDED.committees,
          top_donors = EXCLUDED.top_donors,
          as_of = EXCLUDED.as_of
      `,
      [
        ballotMeasureId,
        side,
        JSON.stringify(record.committees),
        JSON.stringify(record.top_donors),
        payload.as_of,
      ]
    );
  }
  return { sidesWritten: BALLOT_MEASURE_FUNDING_SIDES.length };
}
