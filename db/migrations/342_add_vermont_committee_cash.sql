BEGIN;

CREATE TABLE public.vt_candidate_finance_pac_sources (
  link_id uuid NOT NULL,
  election_year integer NOT NULL CHECK (election_year BETWEEN 2000 AND 2100),
  observed_at timestamptz NOT NULL CHECK (isfinite(observed_at)),
  period_start date NOT NULL CHECK (isfinite(period_start)),
  period_end date NOT NULL CHECK (isfinite(period_end) AND period_end >= period_start),
  receiving_context jsonb NOT NULL CHECK (jsonb_typeof(receiving_context) = 'object'),
  report_periods jsonb NOT NULL CHECK (jsonb_typeof(report_periods) = 'array' AND jsonb_array_length(report_periods) > 0),
  source_election_id integer NOT NULL CHECK (source_election_id > 0),
  capture_digest text NOT NULL CHECK (capture_digest ~ '^[0-9a-f]{64}$'),
  cash_control_total numeric(16,2) NOT NULL CHECK (cash_control_total >= 0 AND cash_control_total::text NOT IN ('NaN','Infinity','-Infinity')),
  unclassified_cash_amount numeric(16,2) NOT NULL CHECK (unclassified_cash_amount >= 0 AND unclassified_cash_amount <= cash_control_total AND unclassified_cash_amount::text NOT IN ('NaN','Infinity','-Infinity')),
  unclassified_cash_count integer NOT NULL CHECK (unclassified_cash_count >= 0),
  PRIMARY KEY (link_id,election_year),
  FOREIGN KEY (link_id,election_year) REFERENCES public.vt_candidate_finance_links(id,election_year) ON DELETE CASCADE
);

-- Generations remain available after the pointer advances; no FK to the current digest.
CREATE TABLE public.vt_candidate_finance_pac_donors (
  link_id uuid NOT NULL,
  election_year integer NOT NULL CHECK (election_year BETWEEN 2000 AND 2100),
  capture_digest text NOT NULL CHECK (capture_digest ~ '^[0-9a-f]{64}$'),
  committee_id text NOT NULL CHECK (committee_id LIKE 'reported:%' AND length(committee_id) > 9),
  committee_name text NOT NULL CHECK (btrim(committee_name) <> ''),
  reported_type text NOT NULL CHECK (reported_type = 'Political Action Committee'),
  amount numeric(16,2) NOT NULL CHECK (amount::text NOT IN ('NaN','Infinity','-Infinity')),
  contribution_count integer NOT NULL CHECK (contribution_count >= 0),
  source_url text NOT NULL CHECK (source_url = 'https://campaignfinance.vermont.gov/'),
  last_synced_at timestamptz NOT NULL CHECK (isfinite(last_synced_at)),
  PRIMARY KEY (link_id,election_year,capture_digest,committee_id),
  FOREIGN KEY (link_id,election_year) REFERENCES public.vt_candidate_finance_links(id,election_year) ON DELETE CASCADE
);

COMMIT;
