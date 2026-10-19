BEGIN;
CREATE TABLE public.ca_reported_committee_sources (
  link_id uuid NOT NULL REFERENCES public.ca_candidate_finance_links(id) ON DELETE CASCADE,
  election_year integer NOT NULL CHECK(election_year BETWEEN 2001 AND 2100),
  candidate_id uuid NOT NULL REFERENCES public.candidates(id),
  election_id uuid NOT NULL REFERENCES public.elections(id),
  receiving_committee_id text NOT NULL CHECK(receiving_committee_id ~ '^[1-9][0-9]*$'),
  total_cents bigint NOT NULL CHECK(total_cents BETWEEN 0 AND 9007199254740991),
  group_count integer NOT NULL CHECK(group_count>=0),
  selected_row_count integer NOT NULL CHECK(selected_row_count>=group_count),
  source_retrieved_at timestamptz NOT NULL,
  source_completed_at timestamptz NOT NULL,
  source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[a-f0-9]{64}$'),
  source_byte_size bigint NOT NULL CHECK(source_byte_size BETWEEN 1 AND 3221225472),
  source_facts jsonb NOT NULL CHECK(jsonb_typeof(source_facts)='object'),
  aggregation_controls jsonb NOT NULL CHECK(jsonb_typeof(aggregation_controls)='object'),
  last_synced_at timestamptz NOT NULL,
  PRIMARY KEY(link_id,election_year),
  CHECK(source_retrieved_at=source_completed_at AND source_completed_at<=last_synced_at),
  CHECK((group_count=0)=(total_cents=0))
);
CREATE TABLE public.ca_reported_committee_groups (
  link_id uuid NOT NULL,
  election_year integer NOT NULL,
  group_key text NOT NULL CHECK(group_key ~ '^[a-f0-9]{64}$'),
  reported_name text NOT NULL CHECK(length(trim(reported_name))>0),
  entity_code text NOT NULL CHECK(entity_code IN('COM','RCP','PTY','SCC')),
  native_committee_id text,
  amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 1 AND 9007199254740991),
  positive_cents bigint NOT NULL CHECK(positive_cents BETWEEN 1 AND 9007199254740991),
  negative_cents bigint NOT NULL CHECK(negative_cents BETWEEN -9007199254740991 AND 0),
  gift_count integer NOT NULL CHECK(gift_count>0),
  correction_count integer NOT NULL CHECK(correction_count>=0),
  PRIMARY KEY(link_id,election_year,group_key),
  FOREIGN KEY(link_id,election_year) REFERENCES public.ca_reported_committee_sources(link_id,election_year) ON DELETE CASCADE,
  CHECK(amount_cents=positive_cents+negative_cents),
  CHECK((negative_cents=0)=(correction_count=0))
);
CREATE TABLE public.ca_reported_committee_attempts (
  link_id uuid NOT NULL REFERENCES public.ca_candidate_finance_links(id) ON DELETE CASCADE,
  election_year integer NOT NULL,
  candidate_id uuid NOT NULL,
  election_id uuid NOT NULL,
  receiving_committee_id text NOT NULL,
  source_revision text NOT NULL,
  last_attempted_at timestamptz NOT NULL,
  PRIMARY KEY(link_id,election_year)
);
CREATE INDEX ca_reported_committee_attempt_clock ON public.ca_reported_committee_attempts(last_attempted_at);
COMMENT ON TABLE public.ca_reported_committee_sources IS 'Current filed Schedule A/C explicit committee classes, net of signed receipt corrections, independently sourced and scheduled; legacy fundraising and IE remain separate.';
COMMIT;
