-- Native reported components remain independent of legacy scheduled-report summaries.
CREATE TABLE public.va_reported_finance_components (
  link_id uuid NOT NULL REFERENCES public.va_candidate_finance_links(id) ON DELETE CASCADE,
  election_year integer NOT NULL CHECK (election_year BETWEEN 2026 AND 2100),
  component text NOT NULL CHECK (component IN ('committee','ie')),
  candidate_id uuid NOT NULL REFERENCES public.candidates(id) ON DELETE CASCADE,
  election_id uuid NOT NULL REFERENCES public.elections(id) ON DELETE CASCADE,
  receiver_context jsonb NOT NULL CHECK (jsonb_typeof(receiver_context)='object'),
  receiving_context jsonb NOT NULL CHECK (jsonb_typeof(receiving_context)='object'),
  source_facts jsonb NOT NULL CHECK (jsonb_typeof(source_facts)='object'),
  aggregation_controls jsonb NOT NULL CHECK (jsonb_typeof(aggregation_controls)='object'),
  source_observed_at timestamptz NOT NULL,
  source_completed_at timestamptz NOT NULL CHECK (source_completed_at>=source_observed_at),
  last_synced_at timestamptz NOT NULL CHECK (last_synced_at>=source_completed_at),
  PRIMARY KEY(link_id,election_year,component)
);
CREATE INDEX va_reported_finance_candidate_idx ON public.va_reported_finance_components(candidate_id,election_id);
CREATE TABLE public.va_reported_finance_groups (
  link_id uuid NOT NULL,
  election_year integer NOT NULL,
  component text NOT NULL,
  group_key text NOT NULL CHECK (length(group_key) BETWEEN 1 AND 4000),
  reported_name text NOT NULL CHECK (length(reported_name) BETWEEN 1 AND 4000),
  stance text NOT NULL CHECK (stance IN ('committee','support','oppose')),
  amount_cents bigint NOT NULL CHECK (amount_cents>=-9007199254740991 AND amount_cents<=9007199254740991),
  occurrence_count integer NOT NULL CHECK (occurrence_count>0),
  PRIMARY KEY(link_id,election_year,component,stance,group_key),
  FOREIGN KEY(link_id,election_year,component) REFERENCES public.va_reported_finance_components(link_id,election_year,component) ON DELETE CASCADE,
  CHECK ((component='committee' AND stance='committee') OR (component='ie' AND stance IN ('support','oppose')))
);
CREATE TABLE public.va_reported_finance_attempts (
  link_id uuid NOT NULL REFERENCES public.va_candidate_finance_links(id) ON DELETE CASCADE,
  election_year integer NOT NULL,
  component text NOT NULL CHECK (component IN ('committee','ie')),
  receiver_context jsonb NOT NULL,
  source_revision text NOT NULL,
  last_attempted_at timestamptz NOT NULL,
  PRIMARY KEY(link_id,election_year,component)
);
