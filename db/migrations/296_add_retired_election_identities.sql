-- Ledger of retired election identities.
--
-- manual:elections:retire-spurious and manual:elections:supersede DELETE the
-- elections row (2026-07-16 decision: no soft-delete marker on elections).
-- Until now nothing remembered that a contest had been retired, so any later
-- discovery for the district (a manual inject or the AI search rollover)
-- could write the same contest again under the writer's upsert identity
-- (district_id, official_ballot_title_key, election_date). About 200 rows
-- were retired or superseded on 2026-09-21 alone.
--
-- This table is not a soft delete: the election row stays deleted. It keeps
-- the identity, why it was retired, and (for a supersession) which contests
-- replaced it. The elections writer skips any payload entry whose identity
-- matches an open row here and records the reason on the staging row. A
-- verified reinstatement (manual inject with --reinstate-retired) writes the
-- contest and closes the ledger row by setting reinstated_at, so the history
-- of both decisions survives.

BEGIN;

CREATE TABLE public.retired_election_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES public.districts(id) ON DELETE CASCADE,
  election_date date NOT NULL,
  -- Same normalization the writer applies (normalizeElectionTitleKey).
  official_ballot_title_key text NOT NULL,
  official_ballot_title text NOT NULL,
  race_type text,
  -- The deleted election's id, kept for cross-reference with logs. Only a
  -- backfilled row may lack it (the id survived only as a log prefix).
  election_id uuid,
  action text NOT NULL,
  reason text NOT NULL,
  source_url text,
  superseded_by_election_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  -- The staging_items row whose payload produced the contest, when known.
  staging_ingest_key text,
  retired_at timestamptz NOT NULL DEFAULT now(),
  reinstated_at timestamptz,
  reinstated_election_id uuid,
  reinstate_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_retired_election_identities_action
    CHECK (action IN ('retired_spurious', 'superseded', 'backfilled')),
  CONSTRAINT chk_retired_election_identities_reason CHECK (btrim(reason) <> ''),
  CONSTRAINT chk_retired_election_identities_title_key CHECK (btrim(official_ballot_title_key) <> ''),
  CONSTRAINT chk_retired_election_identities_election_id
    CHECK (election_id IS NOT NULL OR action = 'backfilled'),
  CONSTRAINT chk_retired_election_identities_superseded_by
    CHECK (action <> 'superseded' OR cardinality(superseded_by_election_ids) > 0),
  CONSTRAINT chk_retired_election_identities_reinstated
    CHECK ((reinstated_at IS NULL) = (reinstated_election_id IS NULL))
);

-- One open tombstone per identity. A reinstated row leaves the index, so the
-- same identity can be retired again later.
CREATE UNIQUE INDEX retired_election_identities_open_identity_uidx
  ON public.retired_election_identities (district_id, election_date, official_ballot_title_key)
  WHERE reinstated_at IS NULL;

CREATE INDEX idx_retired_election_identities_election_id
  ON public.retired_election_identities (election_id);

CREATE TRIGGER trg_retired_election_identities_set_updated_at
  BEFORE UPDATE ON public.retired_election_identities
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
