import type { Pool, PoolClient } from "pg";

export type MissouriFinanceAttemptComponentMask = 2 | 4 | 6;
export const MISSOURI_FINANCE_ATTEMPT_RETRY_HOURS = 24;
const unavailable = (): never => { throw new Error("Missouri finance scheduling attempt unavailable"); };
const uuid = (value: unknown): value is string => typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);

/** Durable retry ordering only. Never changes a link, money or source clock. */
export async function recordMissouriCandidateFinanceAttempt(input: {
  db: Pick<Pool | PoolClient, "query">;
  linkId: string;
  electionYear: number;
  candidateId: string;
  electionId: string;
  committeeId: string;
  attemptedAt: Date;
  componentMask: MissouriFinanceAttemptComponentMask;
}): Promise<void> {
  if (![input.linkId, input.candidateId, input.electionId].every(uuid) ||
    !Number.isInteger(input.electionYear) || input.electionYear < 2024 || input.electionYear > 2100 ||
    !/^[A-Z]\d{6}$/.test(input.committeeId) || !(input.attemptedAt instanceof Date) ||
    !Number.isFinite(input.attemptedAt.getTime()) || ![2, 4, 6].includes(input.componentMask)) return unavailable();
  try {
    const result = await input.db.query<{ link_id: string }>(`
      INSERT INTO public.mo_candidate_finance_sync_attempts AS attempt
        (link_id, election_year, last_attempted_at, component_mask)
      SELECT link.id, link.election_year, $6::timestamptz, $7::smallint
      FROM public.mo_candidate_finance_links AS link
      WHERE link.id=$1::uuid AND link.election_year=$2::int
        AND link.candidate_id=$3::uuid AND link.election_id=$4::uuid
        AND link.committee_id=$5 AND link.link_status='active'
      ON CONFLICT (link_id, election_year) DO UPDATE SET
        last_attempted_at=EXCLUDED.last_attempted_at, component_mask=EXCLUDED.component_mask
      WHERE attempt.last_attempted_at < EXCLUDED.last_attempted_at
        OR (attempt.last_attempted_at=EXCLUDED.last_attempted_at AND attempt.component_mask=EXCLUDED.component_mask)
      RETURNING link_id::text`, [input.linkId, input.electionYear, input.candidateId, input.electionId,
      input.committeeId, input.attemptedAt.toISOString(), input.componentMask]);
    if (result.rows.length !== 1 || result.rows[0]?.link_id !== input.linkId) return unavailable();
  } catch { return unavailable(); }
}
