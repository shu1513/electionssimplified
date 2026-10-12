-- Current processed expenses scoped to one registered payer and actual local
-- candidate election. No candidate-wide outside total or zero authority.
BEGIN;

CREATE TABLE IF NOT EXISTS public.fl_candidate_finance_ie_sources (
  candidate_election_id uuid NOT NULL REFERENCES public.candidate_elections(id) ON DELETE CASCADE,
  payer_account text NOT NULL CHECK (payer_account ~ '^[1-9][0-9]*$'),
  election_year integer NOT NULL CHECK (election_year BETWEEN 2000 AND 2100),
  link_id uuid NOT NULL REFERENCES public.fl_candidate_finance_links(id) ON DELETE CASCADE,
  payer_name text NOT NULL CHECK (btrim(payer_name) <> ''),
  payer_type text NOT NULL CHECK (payer_type IN ('PAC', 'IXO')),
  support_amount numeric(16,2) NOT NULL CHECK (support_amount >= 0),
  expenditure_count integer NOT NULL CHECK (expenditure_count >= 0),
  current_report_count integer NOT NULL CHECK (current_report_count > 0),
  source_url text NOT NULL CHECK (btrim(source_url) <> ''),
  provenance jsonb NOT NULL CHECK (
    jsonb_typeof(provenance) = 'object'
    AND provenance ?& ARRAY['version', 'authority', 'candidateWideZeroAuthority']
    AND provenance->>'version' = '1'
    AND provenance->>'authority' = 'current_processed_expense_ledger'
    AND provenance->'candidateWideZeroAuthority' = 'false'::jsonb
  ),
  last_synced_at timestamptz NOT NULL,
  verified_source_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (candidate_election_id, payer_account, election_year),
  CHECK ((support_amount = 0) = (expenditure_count = 0))
);
CREATE INDEX IF NOT EXISTS idx_fl_ie_sources_link
  ON public.fl_candidate_finance_ie_sources(link_id, election_year, support_amount DESC);
CREATE TRIGGER fl_ie_sources_set_updated_at BEFORE UPDATE
  ON public.fl_candidate_finance_ie_sources FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
