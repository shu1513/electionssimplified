-- Independent observations and retry clocks; existing Hawaii money is unchanged.
BEGIN;
CREATE TABLE public.hi_reported_finance_components (
  candidate_id uuid NOT NULL REFERENCES public.candidates(id) ON DELETE CASCADE,
  election_id uuid NOT NULL REFERENCES public.elections(id) ON DELETE CASCADE,
  election_year integer NOT NULL CHECK (election_year=2026),
  component text NOT NULL CHECK (component IN ('committee','ie')),
  receiver_context jsonb NOT NULL CHECK (jsonb_typeof(receiver_context)='object'),
  source_facts jsonb NOT NULL CHECK (jsonb_typeof(source_facts)='object'),
  aggregation_controls jsonb NOT NULL CHECK (jsonb_typeof(aggregation_controls)='object'),
  source_observed_at timestamptz NOT NULL,
  last_synced_at timestamptz NOT NULL CHECK (last_synced_at>=source_observed_at),
  PRIMARY KEY(candidate_id,election_id,election_year,component),
  FOREIGN KEY(candidate_id,election_id) REFERENCES public.candidate_elections(candidate_id,election_id) ON DELETE CASCADE
);
CREATE TABLE public.hi_reported_finance_groups (
  candidate_id uuid NOT NULL,
  election_id uuid NOT NULL,
  election_year integer NOT NULL,
  component text NOT NULL,
  group_key text NOT NULL CHECK (btrim(group_key)<>''),
  reported_name text NOT NULL CHECK (btrim(reported_name)<>''),
  source_class text NOT NULL CHECK (btrim(source_class)<>''),
  evidence text NOT NULL CHECK (btrim(evidence)<>''),
  stance text NOT NULL CHECK ((component='committee' AND stance='direct') OR (component='ie' AND stance IN ('support','oppose'))),
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 9007199254740991),
  occurrence_count integer NOT NULL CHECK (occurrence_count BETWEEN 1 AND 2000000),
  PRIMARY KEY(candidate_id,election_id,election_year,component,group_key),
  FOREIGN KEY(candidate_id,election_id,election_year,component) REFERENCES public.hi_reported_finance_components(candidate_id,election_id,election_year,component) ON DELETE CASCADE
);
CREATE TABLE public.hi_reported_finance_attempts (
  candidate_id uuid NOT NULL REFERENCES public.candidates(id) ON DELETE CASCADE,
  election_id uuid NOT NULL REFERENCES public.elections(id) ON DELETE CASCADE,
  election_year integer NOT NULL CHECK (election_year=2026),
  component text NOT NULL CHECK (component IN ('committee','ie')),
  receiver_context jsonb NOT NULL CHECK (jsonb_typeof(receiver_context)='object'),
  source_revision text NOT NULL CHECK (source_revision='none' OR source_revision ~ '^[a-f0-9]{64}$'),
  last_attempted_at timestamptz NOT NULL,
  PRIMARY KEY(candidate_id,election_id,election_year,component),
  FOREIGN KEY(candidate_id,election_id) REFERENCES public.candidate_elections(candidate_id,election_id) ON DELETE CASCADE
);
COMMIT;
