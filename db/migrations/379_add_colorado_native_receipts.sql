-- Separately qualified receiving-side committee cash; legacy direct and IE
-- components retain their existing money and freshness.
BEGIN;
CREATE TABLE public.co_native_receipt_sources (
  link_id uuid NOT NULL REFERENCES public.co_candidate_finance_links(id) ON DELETE CASCADE,
  election_year integer NOT NULL CHECK (election_year BETWEEN 2026 AND 2100),
  candidate_id uuid NOT NULL,
  election_id uuid NOT NULL,
  receiver_context jsonb NOT NULL CHECK (jsonb_typeof(receiver_context) = 'object'),
  native_identity jsonb NOT NULL CHECK (jsonb_typeof(native_identity) = 'object'),
  source_facts jsonb NOT NULL CHECK (jsonb_typeof(source_facts) = 'object'),
  aggregation_controls jsonb NOT NULL CHECK (jsonb_typeof(aggregation_controls) = 'object'),
  source_observed_at timestamptz NOT NULL,
  source_completed_at timestamptz NOT NULL CHECK (source_completed_at >= source_observed_at),
  last_synced_at timestamptz NOT NULL CHECK (last_synced_at >= source_completed_at),
  PRIMARY KEY (link_id, election_year),
  FOREIGN KEY (candidate_id, election_id) REFERENCES public.candidate_elections(candidate_id, election_id) ON DELETE CASCADE
);
CREATE TABLE public.co_native_receipt_donors (
  link_id uuid NOT NULL,
  election_year integer NOT NULL,
  reported_key text NOT NULL CHECK (btrim(reported_key) <> ''),
  reported_name text NOT NULL CHECK (btrim(reported_name) <> ''),
  cash_cents bigint NOT NULL CHECK (cash_cents BETWEEN -9007199254740991 AND 9007199254740991),
  occurrence_count integer NOT NULL CHECK (occurrence_count BETWEEN 1 AND 1000000),
  PRIMARY KEY (link_id, election_year, reported_key),
  FOREIGN KEY (link_id, election_year) REFERENCES public.co_native_receipt_sources(link_id, election_year) ON DELETE CASCADE
);
CREATE TABLE public.co_native_receipt_attempts (
  link_id uuid NOT NULL REFERENCES public.co_candidate_finance_links(id) ON DELETE CASCADE,
  election_year integer NOT NULL CHECK (election_year BETWEEN 2026 AND 2100),
  receiver_context jsonb NOT NULL CHECK (jsonb_typeof(receiver_context) = 'object'),
  source_revision text NOT NULL,
  last_attempted_at timestamptz NOT NULL,
  PRIMARY KEY (link_id, election_year)
);
COMMIT;
