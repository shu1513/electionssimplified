-- Explicitly attributed filer-reported estimates. These are not candidate-wide
-- totals or verified cash payments, and have no dependency on direct links.
BEGIN;
CREATE TABLE public.ut_reported_ie_sources (
  candidate_id uuid NOT NULL REFERENCES public.candidates(id) ON DELETE CASCADE,
  election_id uuid NOT NULL REFERENCES public.elections(id) ON DELETE CASCADE,
  election_year integer NOT NULL CHECK (election_year BETWEEN 1998 AND 2100),
  candidate_name text NOT NULL, office_scope text NOT NULL, office_name text NOT NULL,
  district text, election_stage text NOT NULL CHECK (election_stage='general'),
  observed_at timestamptz NOT NULL,
  source_url text NOT NULL CHECK (source_url ~ '^https://disclosures[.]utah[.]gov/Search/AdvancedSearch/GetEntityReportList[?]'),
  report_count integer NOT NULL CHECK (report_count > 0),
  occurrence_count integer NOT NULL CHECK (occurrence_count > 0),
  attributed_count integer NOT NULL CHECK (attributed_count > 0 AND attributed_count <= occurrence_count),
  estimate_cents bigint NOT NULL CHECK (estimate_cents BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY(candidate_id,election_id)
);
CREATE TABLE public.ut_reported_ie_occurrences (
  candidate_id uuid NOT NULL, election_id uuid NOT NULL,
  transaction_id text NOT NULL CHECK (transaction_id ~ '^[0-9]+$'),
  folder_id text NOT NULL CHECK (folder_id ~ '^[0-9]+$'),
  report_url text NOT NULL CHECK (report_url ~ '^https://disclosures[.]utah[.]gov/Search/PublicSearch/Report/[0-9]+$'),
  payer_name text NOT NULL CHECK (length(btrim(payer_name)) BETWEEN 1 AND 500),
  expense_date date NOT NULL, amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 9007199254740991),
  stance text NOT NULL CHECK (stance IN ('support','oppose')),
  purpose text NOT NULL CHECK (length(purpose) BETWEEN 1 AND 2000),
  PRIMARY KEY(candidate_id,election_id,transaction_id),
  FOREIGN KEY(candidate_id,election_id) REFERENCES public.ut_reported_ie_sources(candidate_id,election_id) ON DELETE CASCADE
);
CREATE TABLE public.ut_reported_ie_attempts (
  candidate_id uuid NOT NULL REFERENCES public.candidates(id) ON DELETE CASCADE,
  election_id uuid NOT NULL REFERENCES public.elections(id) ON DELETE CASCADE,
  attempted_at timestamptz NOT NULL, hold_code text,
  PRIMARY KEY(candidate_id,election_id)
);
COMMIT;
