-- Independent current reported PAC receipts, including signed C.1 adjustments.
BEGIN;
CREATE TABLE public.wa_reported_pac_sources (
  link_id uuid NOT NULL,
  election_year integer NOT NULL,
  candidate_id uuid NOT NULL REFERENCES public.candidates(id) ON DELETE CASCADE,
  election_id uuid NOT NULL REFERENCES public.elections(id) ON DELETE CASCADE,
  receiving_filer_id text NOT NULL,
  receiving_committee_id text NOT NULL,
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
  PRIMARY KEY (link_id, election_year),
  FOREIGN KEY (link_id, election_year) REFERENCES public.wa_candidate_finance_links(id, election_year) ON DELETE CASCADE,
  CHECK (election_year BETWEEN 2000 AND 2100),
  CHECK (btrim(receiving_filer_id) <> '' AND receiving_committee_id ~ '^[1-9][0-9]*$'),
  CHECK (group_count <= source_row_count AND (group_count = 0) = (total_cents = 0)),
  CHECK (source_retrieved_at <= source_completed_at AND source_completed_at <= last_synced_at)
);
CREATE TABLE public.wa_reported_pac_groups (
  link_id uuid NOT NULL,
  election_year integer NOT NULL,
  reported_name_key text NOT NULL CHECK (btrim(reported_name_key) <> ''),
  reported_name text NOT NULL CHECK (btrim(reported_name) <> ''),
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 9007199254740991),
  source_row_count integer NOT NULL CHECK (source_row_count BETWEEN 1 AND 10000),
  PRIMARY KEY (link_id, election_year, reported_name_key),
  FOREIGN KEY (link_id, election_year) REFERENCES public.wa_reported_pac_sources(link_id, election_year) ON DELETE CASCADE
);
CREATE TABLE public.wa_reported_pac_attempts (
  link_id uuid NOT NULL,
  election_year integer NOT NULL,
  receiving_filer_id text NOT NULL,
  receiving_committee_id text NOT NULL,
  candidate_id uuid NOT NULL REFERENCES public.candidates(id) ON DELETE CASCADE,
  election_id uuid NOT NULL REFERENCES public.elections(id) ON DELETE CASCADE,
  source_manifest_sha256 text CHECK (source_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  last_attempted_at timestamptz NOT NULL,
  PRIMARY KEY (link_id, election_year),
  FOREIGN KEY (link_id, election_year) REFERENCES public.wa_candidate_finance_links(id, election_year) ON DELETE CASCADE
);
COMMIT;
