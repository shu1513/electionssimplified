import type { Pool, PoolClient } from "pg";

import type { HistoricalContestMarginRecord } from "./historicalContestNormalizer.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type HistoricalContestMarginWriteResult = {
  requested: number;
  rowsWritten: number;
};

function recordValues(record: HistoricalContestMarginRecord, importedAt: Date): unknown[] {
  return [
    record.source,
    record.source_url,
    record.election_year,
    record.state,
    record.state_fips,
    record.office_type,
    record.district_type,
    record.district_key,
    record.mit_office,
    record.mit_district,
    record.winner_party,
    record.runner_up_party,
    record.winner_votes,
    record.runner_up_votes,
    record.total_votes,
    record.margin_percent,
    record.competitiveness_label,
    record.stale_after_redistricting,
    importedAt.toISOString(),
    JSON.stringify(record.candidate_lines),
  ];
}

async function upsertHistoricalContestMargin(
  db: Queryable,
  record: HistoricalContestMarginRecord,
  importedAt: Date
): Promise<number> {
  const result = await db.query(
    `
      INSERT INTO public.historical_contest_margins (
        source,
        source_url,
        election_year,
        state,
        state_fips,
        office_type,
        district_type,
        district_key,
        mit_office,
        mit_district,
        winner_party,
        runner_up_party,
        winner_votes,
        runner_up_votes,
        total_votes,
        margin_percent,
        competitiveness_label,
        stale_after_redistricting,
        imported_at,
        candidate_lines
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10,
        $11,
        $12,
        $13,
        $14,
        $15,
        $16,
        $17,
        $18,
        $19::timestamptz,
        $20::jsonb
      )
      ON CONFLICT (source, election_year, state, office_type, district_type, district_key)
      DO UPDATE SET
        source_url = EXCLUDED.source_url,
        state_fips = EXCLUDED.state_fips,
        mit_office = EXCLUDED.mit_office,
        mit_district = EXCLUDED.mit_district,
        winner_party = EXCLUDED.winner_party,
        runner_up_party = EXCLUDED.runner_up_party,
        winner_votes = EXCLUDED.winner_votes,
        runner_up_votes = EXCLUDED.runner_up_votes,
        total_votes = EXCLUDED.total_votes,
        margin_percent = EXCLUDED.margin_percent,
        competitiveness_label = EXCLUDED.competitiveness_label,
        stale_after_redistricting = EXCLUDED.stale_after_redistricting,
        imported_at = EXCLUDED.imported_at,
        candidate_lines = EXCLUDED.candidate_lines,
        updated_at = now()
    `,
    recordValues(record, importedAt)
  );
  if (result.rowCount !== 1) {
    throw new Error(
      `historical contest margin upsert expected to write exactly one row, wrote ${result.rowCount ?? 0}: ` +
        `${record.source} ${record.election_year} ${record.state} ${record.office_type} ${record.district_key}`
    );
  }
  return result.rowCount;
}

export async function upsertHistoricalContestMargins(
  db: Queryable,
  records: readonly HistoricalContestMarginRecord[],
  options: { importedAt?: Date } = {}
): Promise<HistoricalContestMarginWriteResult> {
  const importedAt = options.importedAt ?? new Date();
  let rowsWritten = 0;

  for (const record of records) {
    rowsWritten += await upsertHistoricalContestMargin(db, record, importedAt);
  }

  return {
    requested: records.length,
    rowsWritten,
  };
}
