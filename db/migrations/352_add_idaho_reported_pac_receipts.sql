-- Independent current itemized TPAC receipts, before separate return records.
BEGIN;
CREATE TABLE public.id_reported_pac_sources (
  link_id uuid NOT NULL,
  election_year integer NOT NULL CHECK (election_year BETWEEN 2026 AND 2100),
  candidate_id uuid NOT NULL REFERENCES public.candidates(id) ON DELETE CASCADE,
  election_id uuid NOT NULL REFERENCES public.elections(id) ON DELETE CASCADE,
  receiving_registration_guid text NOT NULL CHECK (receiving_registration_guid ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
  native_entity_id bigint NOT NULL CHECK (native_entity_id BETWEEN 1 AND 9007199254740991),
  native_registration_id bigint NOT NULL CHECK (native_registration_id BETWEEN 1 AND 9007199254740991),
  total_cents bigint NOT NULL CHECK (total_cents BETWEEN 0 AND 9007199254740991),
  group_count integer NOT NULL CHECK (group_count >= 0),
  source_row_count integer NOT NULL CHECK (source_row_count BETWEEN 0 AND 10000),
  source_retrieved_at timestamptz NOT NULL,
  source_completed_at timestamptz NOT NULL,
  source_manifest_sha256 text NOT NULL CHECK (source_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  source_byte_size bigint NOT NULL CHECK (source_byte_size BETWEEN 1 AND 134217728),
  source_facts jsonb NOT NULL CHECK (jsonb_typeof(source_facts) = 'object'),
  aggregation_controls jsonb NOT NULL CHECK (jsonb_typeof(aggregation_controls) = 'object'),
  last_synced_at timestamptz NOT NULL,
  PRIMARY KEY (link_id,election_year),
  FOREIGN KEY (link_id,election_year) REFERENCES public.id_candidate_finance_links(id,election_year) ON DELETE CASCADE,
  CHECK (group_count <= source_row_count AND (group_count = 0) = (total_cents = 0)),
  CHECK (source_retrieved_at <= source_completed_at AND source_completed_at <= last_synced_at)
);
CREATE TABLE public.id_reported_pac_groups (
  link_id uuid NOT NULL,
  election_year integer NOT NULL,
  reported_source_key text NOT NULL CHECK (reported_source_key ~ '^source:[1-9][0-9]*$'),
  reported_name text NOT NULL CHECK (btrim(reported_name) <> ''),
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 9007199254740991),
  source_row_count integer NOT NULL CHECK (source_row_count BETWEEN 1 AND 10000),
  PRIMARY KEY (link_id,election_year,reported_source_key),
  FOREIGN KEY (link_id,election_year) REFERENCES public.id_reported_pac_sources(link_id,election_year) ON DELETE CASCADE
);
CREATE TABLE public.id_reported_pac_attempts (
  link_id uuid NOT NULL,
  election_year integer NOT NULL,
  receiving_registration_guid text NOT NULL,
  candidate_id uuid NOT NULL REFERENCES public.candidates(id) ON DELETE CASCADE,
  election_id uuid NOT NULL REFERENCES public.elections(id) ON DELETE CASCADE,
  source_manifest_sha256 text CHECK (source_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  last_attempted_at timestamptz NOT NULL,
  PRIMARY KEY (link_id,election_year),
  FOREIGN KEY (link_id,election_year) REFERENCES public.id_candidate_finance_links(id,election_year) ON DELETE CASCADE
);
COMMIT;
