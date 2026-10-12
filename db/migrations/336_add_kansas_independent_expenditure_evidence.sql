-- Acquired, reviewed literal IE document rows. No receiving-filer identity,
-- direct snapshot, or candidate-wide outside total/zero authority.
BEGIN;

CREATE TABLE public.ks_independent_expenditure_evidence (
  source_url text NOT NULL CHECK (source_url ~ '^https://sos[.]ks[.]gov/srvimages/campaignfinance/filings/cy[0-9]{4}/cm(0[1-9]|1[0-2])/[0-9]+[.]pdf$'),
  row_index integer NOT NULL CHECK (row_index > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  observed_at timestamptz NOT NULL CHECK (isfinite(observed_at)),
  election_year integer NOT NULL CHECK (election_year BETWEEN 2024 AND 2100),
  payer_name text NOT NULL CHECK (btrim(payer_name) <> ''),
  filing_date date NOT NULL CHECK (isfinite(filing_date)),
  period_due_key text NOT NULL CHECK (period_due_key ~ '^[0-9]{4}(0[1-9]|1[0-2])$'),
  statement_total_cents bigint NOT NULL CHECK (statement_total_cents BETWEEN 0 AND 9007199254740991),
  row_date date NOT NULL CHECK (isfinite(row_date)),
  target_as_filed text NOT NULL,
  candidate_name text CHECK (candidate_name IS NULL OR btrim(candidate_name) <> ''),
  house_district integer CHECK (house_district BETWEEN 1 AND 125),
  support_oppose text CHECK (support_oppose IN ('support', 'oppose')),
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN -9007199254740991 AND 9007199254740991),
  candidate_id uuid,
  election_id uuid,
  PRIMARY KEY (source_url, row_index),
  CHECK ((candidate_id IS NULL) = (election_id IS NULL)),
  CHECK (candidate_id IS NULL OR (candidate_name IS NOT NULL AND house_district IS NOT NULL AND support_oppose IS NOT NULL)),
  FOREIGN KEY (candidate_id, election_id) REFERENCES public.candidate_elections(candidate_id, election_id) ON DELETE SET NULL
);

CREATE INDEX ks_independent_expenditure_evidence_candidate_idx
  ON public.ks_independent_expenditure_evidence(candidate_id, election_id, election_year);

COMMIT;
