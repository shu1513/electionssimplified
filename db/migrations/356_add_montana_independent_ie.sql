-- Outside spending owns its source clock; direct-finance holds cannot hide it.
BEGIN;
CREATE TABLE public.mt_reported_ie_sources (
  link_id uuid NOT NULL,
  election_year integer NOT NULL CHECK(election_year BETWEEN 2024 AND 2100),
  candidate_id uuid NOT NULL REFERENCES public.candidates(id),
  election_id uuid NOT NULL REFERENCES public.elections(id),
  receiving_candidate_id text NOT NULL CHECK(receiving_candidate_id ~ '^[1-9][0-9]*$'),
  support_cents bigint CHECK(support_cents BETWEEN 1 AND 9007199254740991),
  oppose_cents bigint CHECK(oppose_cents BETWEEN 1 AND 9007199254740991),
  total_cents bigint NOT NULL CHECK(total_cents BETWEEN 0 AND 9007199254740991),
  group_count integer NOT NULL CHECK(group_count>=0),
  attributed_row_count integer NOT NULL CHECK(attributed_row_count>=group_count),
  source_retrieved_at timestamptz NOT NULL,
  source_completed_at timestamptz NOT NULL,
  source_manifest_sha256 text NOT NULL CHECK(source_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  source_byte_size bigint NOT NULL CHECK(source_byte_size BETWEEN 1 AND 134217728),
  source_original_count integer NOT NULL CHECK(source_original_count BETWEEN 3 AND 2000),
  source_facts jsonb NOT NULL CHECK(jsonb_typeof(source_facts)='object'),
  last_synced_at timestamptz NOT NULL,
  PRIMARY KEY(link_id,election_year),
  FOREIGN KEY(link_id,election_year) REFERENCES public.mt_candidate_finance_links(id,election_year) ON DELETE CASCADE,
  CHECK(source_retrieved_at<=source_completed_at AND source_completed_at<=last_synced_at),
  CHECK(total_cents=COALESCE(support_cents,0)+COALESCE(oppose_cents,0)),
  CHECK((group_count=0)=(support_cents IS NULL AND oppose_cents IS NULL)),
  CHECK((attributed_row_count=0)=(group_count=0))
);
CREATE TABLE public.mt_reported_ie_groups (
  link_id uuid NOT NULL,
  election_year integer NOT NULL,
  committee_id text NOT NULL CHECK(committee_id ~ '^[1-9][0-9]*$'),
  committee_name text NOT NULL CHECK(length(trim(committee_name))>0),
  support_oppose text NOT NULL CHECK(support_oppose IN ('support','oppose')),
  amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY(link_id,election_year,committee_id,support_oppose),
  FOREIGN KEY(link_id,election_year) REFERENCES public.mt_reported_ie_sources(link_id,election_year) ON DELETE CASCADE
);
CREATE TABLE public.mt_reported_ie_attempts (
  link_id uuid NOT NULL,
  election_year integer NOT NULL,
  receiving_candidate_id text NOT NULL,
  candidate_id uuid NOT NULL,
  election_id uuid NOT NULL,
  source_revision text NOT NULL,
  last_attempted_at timestamptz NOT NULL,
  PRIMARY KEY(link_id,election_year),
  FOREIGN KEY(link_id,election_year) REFERENCES public.mt_candidate_finance_links(id,election_year) ON DELETE CASCADE
);
CREATE INDEX mt_reported_ie_attempt_clock ON public.mt_reported_ie_attempts(last_attempted_at);
COMMENT ON TABLE public.mt_reported_ie_sources IS 'Complete CERS committee IE originals and verified target/stance groups, independently scheduled and published from direct candidate finance.';
COMMIT;
