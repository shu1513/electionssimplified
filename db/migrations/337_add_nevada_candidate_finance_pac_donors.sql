-- Committee donor subset only; separate source watermark preserves complete
-- empty observations without refreshing the receiving candidate's totals.
BEGIN;

CREATE TABLE public.nv_candidate_finance_pac_sources (
  link_id uuid NOT NULL,
  election_year integer NOT NULL CHECK (election_year BETWEEN 2004 AND 2100),
  observed_at timestamptz NOT NULL CHECK (isfinite(observed_at)),
  period_start date NOT NULL CHECK (isfinite(period_start)),
  period_end date NOT NULL CHECK (isfinite(period_end) AND period_end >= period_start),
  capture_digest text NOT NULL CHECK (capture_digest ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (link_id, election_year),
  CHECK (period_start = make_date(election_year - 1, 1, 1) AND period_end <= make_date(election_year, 12, 31)),
  FOREIGN KEY (link_id, election_year) REFERENCES public.nv_candidate_finance_links(id, election_year) ON DELETE CASCADE
);

CREATE TABLE public.nv_candidate_finance_pac_donors (
  link_id uuid NOT NULL,
  election_year integer NOT NULL,
  committee_id text NOT NULL CHECK (committee_id ~ '^reported:.+'),
  committee_name text NOT NULL CHECK (btrim(committee_name) <> ''),
  recognition_method text NOT NULL CHECK (recognition_method IN ('registry_name', 'reported_name')),
  amount numeric(16,2) NOT NULL CHECK (amount NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
  contribution_count integer NOT NULL CHECK (contribution_count >= 0),
  source_url text NOT NULL CHECK (source_url = 'https://www.nvsos.gov/SOSCandidateServices/AnonymousAccess/CEFDSearchUU/Search.aspx'),
  last_synced_at timestamptz NOT NULL CHECK (isfinite(last_synced_at)),
  PRIMARY KEY (link_id, election_year, committee_id),
  FOREIGN KEY (link_id, election_year) REFERENCES public.nv_candidate_finance_pac_sources(link_id, election_year) ON DELETE CASCADE,
  CHECK (committee_id LIKE 'reported:%')
);

CREATE INDEX nv_candidate_finance_pac_donors_lookup_idx
  ON public.nv_candidate_finance_pac_donors(link_id, election_year, amount DESC);

COMMIT;
