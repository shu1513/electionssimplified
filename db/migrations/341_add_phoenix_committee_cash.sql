-- Source-typed monetary PAC detail is independent of existing direct totals.
BEGIN;

CREATE TABLE public.phx_candidate_finance_pac_sources (
  link_id uuid NOT NULL,
  election_year integer NOT NULL,
  observed_at timestamptz NOT NULL CHECK (isfinite(observed_at)),
  reported_through date NOT NULL CHECK (isfinite(reported_through)),
  capture_digest text NOT NULL CHECK (capture_digest ~ '^[a-f0-9]{64}$'),
  report_periods jsonb NOT NULL CHECK (jsonb_typeof(report_periods) = 'array'),
  PRIMARY KEY (link_id, election_year),
  FOREIGN KEY (link_id, election_year)
    REFERENCES public.phx_candidate_finance_links(id, election_year) ON DELETE CASCADE
);

CREATE TABLE public.phx_candidate_finance_pac_donors (
  link_id uuid NOT NULL,
  election_year integer NOT NULL,
  capture_digest text NOT NULL CHECK (capture_digest ~ '^[a-f0-9]{64}$'),
  committee_id text NOT NULL CHECK (committee_id ~ '^reported:.+'),
  committee_name text NOT NULL CHECK (btrim(committee_name) <> ''),
  recognition_method text NOT NULL CHECK (recognition_method = 'reported_type'),
  gross_amount numeric(16,2) NOT NULL CHECK (gross_amount NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
  refund_amount numeric(16,2) NOT NULL CHECK (refund_amount NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
  amount numeric(16,2) NOT NULL CHECK (amount NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
  contribution_count integer NOT NULL CHECK (contribution_count >= 0),
  refund_count integer NOT NULL CHECK (refund_count >= 0),
  source_url text NOT NULL CHECK (source_url ~ '^https://apps-secure[.]phoenix[.]gov/CampaignFinance/Reports/PrintReport/[0-9a-f-]{36}$'),
  last_synced_at timestamptz NOT NULL CHECK (isfinite(last_synced_at)),
  PRIMARY KEY (link_id, election_year, capture_digest, committee_id),
  FOREIGN KEY (link_id, election_year)
    REFERENCES public.phx_candidate_finance_pac_sources(link_id, election_year) ON DELETE CASCADE,
  CHECK (amount = gross_amount - refund_amount)
);

CREATE INDEX phx_finance_pac_donors_amount_idx
  ON public.phx_candidate_finance_pac_donors(link_id, election_year, capture_digest, amount DESC);

COMMIT;
