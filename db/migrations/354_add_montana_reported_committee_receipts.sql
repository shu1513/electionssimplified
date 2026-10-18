-- Independent committee receipts; legacy fundraising and outside clocks stay separate.
BEGIN;
CREATE TABLE public.mt_reported_committee_sources (
  link_id uuid NOT NULL,
  election_year integer NOT NULL CHECK(election_year BETWEEN 2020 AND 2100),
  candidate_id uuid NOT NULL REFERENCES public.candidates(id),
  election_id uuid NOT NULL REFERENCES public.elections(id),
  receiving_committee_id text NOT NULL CHECK(receiving_committee_id ~ '^[1-9][0-9]*$'),
  total_cents bigint NOT NULL CHECK(total_cents BETWEEN 0 AND 9007199254740991),
  group_count integer NOT NULL CHECK(group_count>=0),
  source_row_count integer NOT NULL CHECK(source_row_count>=group_count),
  source_retrieved_at timestamptz NOT NULL,
  source_completed_at timestamptz NOT NULL,
  source_manifest_sha256 text NOT NULL CHECK(source_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  source_byte_size bigint NOT NULL CHECK(source_byte_size BETWEEN 1 AND 268435456),
  source_facts jsonb NOT NULL CHECK(jsonb_typeof(source_facts)='object'),
  aggregation_controls jsonb NOT NULL CHECK(jsonb_typeof(aggregation_controls)='object'),
  last_synced_at timestamptz NOT NULL,
  PRIMARY KEY(link_id,election_year),
  FOREIGN KEY(link_id,election_year) REFERENCES public.mt_candidate_finance_links(id,election_year) ON DELETE CASCADE,
  CHECK(source_retrieved_at<=source_completed_at AND source_completed_at<=last_synced_at),
  CHECK((group_count=0)=(total_cents=0))
);
CREATE TABLE public.mt_reported_committee_groups (
  link_id uuid NOT NULL,
  election_year integer NOT NULL,
  source_entity_id bigint NOT NULL CHECK(source_entity_id BETWEEN 1 AND 9007199254740991),
  reported_name text NOT NULL CHECK(length(trim(reported_name))>0),
  amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 1 AND 9007199254740991),
  source_row_count integer NOT NULL CHECK(source_row_count>0),
  committee_types jsonb NOT NULL CHECK(jsonb_typeof(committee_types)='array' AND jsonb_array_length(committee_types)>0),
  PRIMARY KEY(link_id,election_year,source_entity_id),
  FOREIGN KEY(link_id,election_year) REFERENCES public.mt_reported_committee_sources(link_id,election_year) ON DELETE CASCADE
);
CREATE TABLE public.mt_reported_committee_attempts (
  link_id uuid NOT NULL,
  election_year integer NOT NULL,
  candidate_id uuid NOT NULL,
  election_id uuid NOT NULL,
  receiving_committee_id text NOT NULL,
  last_attempted_at timestamptz NOT NULL,
  PRIMARY KEY(link_id,election_year),
  FOREIGN KEY(link_id,election_year) REFERENCES public.mt_candidate_finance_links(id,election_year) ON DELETE CASCADE
);
CREATE INDEX mt_reported_committee_attempt_clock ON public.mt_reported_committee_attempts(last_attempted_at);
COMMENT ON TABLE public.mt_reported_committee_sources IS 'Complete reported source-entity committee receipts, cash plus in-kind, before separate expenditure-side returns; legal committee registrations are not inferred.';
COMMIT;
