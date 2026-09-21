-- When the bulk-file donor and conduit lists were last loaded for a
-- candidate-cycle. Kept apart from candidate_finance_summaries so the mark
-- does not depend on which sync ran first: the bulk step covers every
-- candidate in the window, including ones whose totals are not synced yet.
-- Replaces candidate_finance_summaries.contributors_synced_at (migration 291).

BEGIN;

CREATE TABLE IF NOT EXISTS public.candidate_finance_contributor_syncs (
  fec_candidate_id text NOT NULL,
  election_year integer NOT NULL,
  synced_at timestamptz NOT NULL,
  PRIMARY KEY (fec_candidate_id, election_year),
  CONSTRAINT chk_candidate_finance_contributor_syncs_fec_candidate_id
    CHECK (btrim(fec_candidate_id) <> ''),
  CONSTRAINT chk_candidate_finance_contributor_syncs_election_year
    CHECK (election_year BETWEEN 1970 AND 2100)
);

INSERT INTO public.candidate_finance_contributor_syncs (fec_candidate_id, election_year, synced_at)
SELECT fec_candidate_id, election_year, contributors_synced_at
FROM public.candidate_finance_summaries
WHERE contributors_synced_at IS NOT NULL
ON CONFLICT (fec_candidate_id, election_year) DO NOTHING;

ALTER TABLE public.candidate_finance_summaries
  DROP COLUMN IF EXISTS contributors_synced_at;

COMMIT;
