-- Current report-year cash/in-kind committee receipts, before separate returns.
BEGIN;
CREATE TABLE public.oh_reported_committee_sources (
  link_id uuid NOT NULL,
  election_year integer NOT NULL CHECK (election_year BETWEEN 2000 AND 2100),
  candidate_id uuid NOT NULL REFERENCES public.candidates(id) ON DELETE CASCADE,
  election_id uuid NOT NULL REFERENCES public.elections(id) ON DELETE CASCADE,
  receiving_committee_id text NOT NULL CHECK (receiving_committee_id ~ '^[1-9][0-9]*$'),
  total_cents bigint NOT NULL CHECK (total_cents BETWEEN 0 AND 9007199254740991),
  group_count integer NOT NULL CHECK (group_count >= 0),
  source_row_count integer NOT NULL CHECK (source_row_count BETWEEN 0 AND 5000000),
  source_retrieved_at timestamptz NOT NULL,
  source_completed_at timestamptz NOT NULL,
  source_manifest_sha256 text NOT NULL CHECK (source_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  source_byte_size bigint NOT NULL CHECK (source_byte_size BETWEEN 1 AND 536870912),
  source_facts jsonb NOT NULL CHECK (jsonb_typeof(source_facts) = 'object'),
  aggregation_controls jsonb NOT NULL CHECK (jsonb_typeof(aggregation_controls) = 'object'),
  last_synced_at timestamptz NOT NULL,
  PRIMARY KEY (link_id,election_year),
  FOREIGN KEY (link_id,election_year) REFERENCES public.oh_candidate_finance_links(id,election_year) ON DELETE CASCADE,
  CHECK (group_count <= source_row_count AND (group_count = 0) = (total_cents = 0)),
  CHECK (source_retrieved_at <= source_completed_at AND source_completed_at <= last_synced_at)
);
CREATE TABLE public.oh_reported_committee_groups (
  link_id uuid NOT NULL,
  election_year integer NOT NULL,
  reported_source_key text NOT NULL CHECK (reported_source_key ~ '^(committee:[1-9][0-9]*|reported:.+)$'),
  reported_name text NOT NULL CHECK (btrim(reported_name) <> ''),
  native_committee_id text CHECK (native_committee_id ~ '^[1-9][0-9]*$'),
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 9007199254740991),
  source_row_count integer NOT NULL CHECK (source_row_count BETWEEN 1 AND 5000000),
  PRIMARY KEY (link_id,election_year,reported_source_key),
  FOREIGN KEY (link_id,election_year) REFERENCES public.oh_reported_committee_sources(link_id,election_year) ON DELETE CASCADE
);
CREATE TABLE public.oh_reported_committee_attempts (
  link_id uuid NOT NULL,
  election_year integer NOT NULL,
  receiving_committee_id text NOT NULL CHECK (receiving_committee_id ~ '^[1-9][0-9]*$'),
  candidate_id uuid NOT NULL REFERENCES public.candidates(id) ON DELETE CASCADE,
  election_id uuid NOT NULL REFERENCES public.elections(id) ON DELETE CASCADE,
  source_revision text NOT NULL CHECK (source_revision ~ '^(none|[a-f0-9]{64}):(none|[a-f0-9]{64})$'),
  last_attempted_at timestamptz NOT NULL,
  PRIMARY KEY (link_id,election_year),
  FOREIGN KEY (link_id,election_year) REFERENCES public.oh_candidate_finance_links(id,election_year) ON DELETE CASCADE
);
COMMIT;
