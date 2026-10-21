-- Independently qualified native PAC gifts never replace legacy direct snapshots.
CREATE TABLE public.in_native_pac_sources (
  link_id uuid NOT NULL REFERENCES public.in_candidate_finance_links(id) ON DELETE CASCADE,
  election_year integer NOT NULL CHECK (election_year BETWEEN 2026 AND 2100),
  candidate_id uuid NOT NULL REFERENCES public.candidates(id) ON DELETE CASCADE,
  election_id uuid NOT NULL REFERENCES public.elections(id) ON DELETE CASCADE,
  receiver_context jsonb NOT NULL CHECK (jsonb_typeof(receiver_context)='object'),
  source_facts jsonb NOT NULL CHECK (jsonb_typeof(source_facts)='object'),
  aggregation_controls jsonb NOT NULL CHECK (jsonb_typeof(aggregation_controls)='object'),
  source_observed_at timestamptz NOT NULL,
  source_completed_at timestamptz NOT NULL CHECK (source_completed_at>=source_observed_at),
  last_synced_at timestamptz NOT NULL CHECK (last_synced_at>=source_completed_at),
  PRIMARY KEY(link_id,election_year)
);
CREATE INDEX in_native_pac_candidate_idx ON public.in_native_pac_sources(candidate_id,election_id);
CREATE TABLE public.in_native_pac_donors (
  link_id uuid NOT NULL,
  election_year integer NOT NULL,
  donor_key text NOT NULL CHECK (length(donor_key) BETWEEN 1 AND 4000),
  reported_name text NOT NULL CHECK (length(reported_name) BETWEEN 1 AND 4000),
  cash_cents bigint NOT NULL CHECK (cash_cents BETWEEN -9007199254740991 AND 9007199254740991),
  in_kind_cents bigint NOT NULL CHECK (in_kind_cents BETWEEN -9007199254740991 AND 9007199254740991),
  occurrence_count integer NOT NULL CHECK (occurrence_count>0),
  PRIMARY KEY(link_id,election_year,donor_key),
  FOREIGN KEY(link_id,election_year) REFERENCES public.in_native_pac_sources(link_id,election_year) ON DELETE CASCADE
);
CREATE TABLE public.in_native_pac_attempts (
  link_id uuid NOT NULL REFERENCES public.in_candidate_finance_links(id) ON DELETE CASCADE,
  election_year integer NOT NULL,
  receiver_context jsonb NOT NULL CHECK (jsonb_typeof(receiver_context)='object'),
  source_revision text NOT NULL,
  last_attempted_at timestamptz NOT NULL,
  PRIMARY KEY(link_id,election_year)
);
