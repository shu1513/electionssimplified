-- Scheduling only. An attempt is never a financial observation or zero proof.
BEGIN;

CREATE TABLE IF NOT EXISTS public.fl_candidate_finance_ie_attempts (
  candidate_election_id uuid PRIMARY KEY REFERENCES public.candidate_elections(id) ON DELETE CASCADE,
  last_attempted_at timestamptz NOT NULL
);

COMMIT;
