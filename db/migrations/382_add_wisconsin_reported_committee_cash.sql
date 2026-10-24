BEGIN;

-- Independent reported-cash snapshots. These tables grant no publication
-- permission; new Wisconsin reads remain separately disabled pending review.
CREATE TABLE public.wi_candidate_finance_reported_cash_sources (
  candidate_id uuid NOT NULL,
  election_id uuid NOT NULL,
  election_year smallint NOT NULL,
  candidate_name text NOT NULL,
  candidate_last_name text NOT NULL,
  office_scope text NOT NULL,
  office_name text NOT NULL,
  district text,
  election_date date NOT NULL,
  entity_id text NOT NULL,
  committee_id text NOT NULL,
  committee_name text NOT NULL,
  observed_at timestamptz NOT NULL,
  source_url text NOT NULL,
  regular_coverage_through date NOT NULL,
  report_count integer NOT NULL,
  occurrence_count integer NOT NULL,
  monetary_receipt_count integer NOT NULL,
  excluded_in_kind_count integer NOT NULL,
  excluded_loan_count integer NOT NULL,
  excluded_other_income_count integer NOT NULL,
  returned_contribution_count integer NOT NULL,
  group_count integer NOT NULL,
  cash_cents bigint NOT NULL,
  CONSTRAINT wi_cash_sources_pk PRIMARY KEY (candidate_id, election_id),
  CONSTRAINT wi_cash_sources_context_fk FOREIGN KEY (candidate_id, election_id)
    REFERENCES public.candidate_elections (candidate_id, election_id) ON DELETE CASCADE,
  CONSTRAINT wi_cash_sources_year_ck CHECK (election_year BETWEEN 2000 AND 2100
    AND extract(year FROM election_date)::integer = election_year),
  CONSTRAINT wi_cash_sources_scope_ck CHECK (office_scope IN ('statewide', 'state_upper', 'state_lower')),
  CONSTRAINT wi_cash_sources_native_ids_ck CHECK (entity_id ~ '^[1-9][0-9]*$' AND committee_id ~ '^[1-9][0-9]*$'),
  CONSTRAINT wi_cash_sources_counts_ck CHECK (report_count > 0 AND occurrence_count >= 0
    AND monetary_receipt_count BETWEEN 0 AND occurrence_count
    AND excluded_in_kind_count BETWEEN 0 AND occurrence_count
    AND excluded_loan_count BETWEEN 0 AND occurrence_count
    AND excluded_other_income_count BETWEEN 0 AND occurrence_count
    AND returned_contribution_count BETWEEN 0 AND occurrence_count
    AND group_count BETWEEN 0 AND monetary_receipt_count + returned_contribution_count),
  CONSTRAINT wi_cash_sources_money_ck CHECK (cash_cents BETWEEN -9007199254740991 AND 9007199254740991)
);
CREATE INDEX wi_cash_sources_observed_idx
  ON public.wi_candidate_finance_reported_cash_sources (observed_at);

CREATE TABLE public.wi_candidate_finance_reported_cash_donors (
  candidate_id uuid NOT NULL,
  election_id uuid NOT NULL,
  committee_id text NOT NULL,
  committee_name text NOT NULL,
  amount_cents bigint NOT NULL,
  contribution_count integer NOT NULL,
  evidence_type text NOT NULL,
  source_url text NOT NULL,
  CONSTRAINT wi_cash_donors_pk PRIMARY KEY (candidate_id, election_id, committee_id),
  CONSTRAINT wi_cash_donors_source_fk FOREIGN KEY (candidate_id, election_id)
    REFERENCES public.wi_candidate_finance_reported_cash_sources (candidate_id, election_id) ON DELETE CASCADE,
  CONSTRAINT wi_cash_donors_native_id_ck CHECK (committee_id ~ '^[1-9][0-9]*$'),
  CONSTRAINT wi_cash_donors_name_ck CHECK (length(trim(committee_name)) BETWEEN 1 AND 500),
  CONSTRAINT wi_cash_donors_money_ck CHECK (amount_cents BETWEEN -9007199254740991 AND 9007199254740991),
  CONSTRAINT wi_cash_donors_count_ck CHECK (contribution_count >= 0),
  CONSTRAINT wi_cash_donors_evidence_ck CHECK (evidence_type IN ('native_registry_class', 'reported_pac_name'))
);

-- Attempts rotate held candidates without advancing the successful source clock.
CREATE TABLE public.wi_candidate_finance_reported_cash_attempts (
  candidate_id uuid NOT NULL,
  election_id uuid NOT NULL,
  attempted_at timestamptz NOT NULL,
  hold_code text,
  CONSTRAINT wi_cash_attempts_pk PRIMARY KEY (candidate_id, election_id),
  CONSTRAINT wi_cash_attempts_context_fk FOREIGN KEY (candidate_id, election_id)
    REFERENCES public.candidate_elections (candidate_id, election_id) ON DELETE CASCADE,
  CONSTRAINT wi_cash_attempts_code_ck CHECK (hold_code IS NULL OR hold_code ~ '^[a-z_]+$')
);
CREATE INDEX wi_cash_attempts_rotation_idx
  ON public.wi_candidate_finance_reported_cash_attempts (attempted_at);

COMMIT;
