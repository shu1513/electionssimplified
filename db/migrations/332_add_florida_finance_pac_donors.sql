-- Net cash from exact registered Florida PAC/CCE committees and PTY/PAP
-- parties. Whole current processed report and registry proof is independent
-- of the existing Raised calculation. Unknown source components preserve.
BEGIN;

CREATE TABLE IF NOT EXISTS public.fl_candidate_finance_pac_donors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id uuid NOT NULL REFERENCES public.fl_candidate_finance_links(id) ON DELETE CASCADE,
  election_year integer NOT NULL CHECK (election_year BETWEEN 2000 AND 2100),
  committee_id text NOT NULL CHECK (committee_id ~ '^[1-9][0-9]*$'),
  committee_name text NOT NULL CHECK (btrim(committee_name) <> ''),
  committee_type text NOT NULL CHECK (committee_type IN ('PAC', 'CCE', 'PTY', 'PAP')),
  amount numeric(16,2) NOT NULL CHECK (amount > 0),
  gross_amount numeric(16,2) NOT NULL CHECK (gross_amount > 0),
  refund_amount numeric(16,2) NOT NULL CHECK (refund_amount >= 0),
  contribution_count integer NOT NULL CHECK (contribution_count > 0),
  refund_count integer NOT NULL CHECK (refund_count >= 0),
  source_url text NOT NULL CHECK (btrim(source_url) <> ''),
  last_synced_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (link_id, election_year, committee_id),
  CHECK (amount = gross_amount - refund_amount)
);
CREATE INDEX IF NOT EXISTS idx_fl_pac_donors_link
  ON public.fl_candidate_finance_pac_donors(link_id, election_year, amount DESC);
CREATE TRIGGER fl_pac_donors_set_updated_at BEFORE UPDATE
  ON public.fl_candidate_finance_pac_donors FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS public.fl_candidate_finance_pac_sources (
  link_id uuid NOT NULL REFERENCES public.fl_candidate_finance_links(id) ON DELETE CASCADE,
  election_year integer NOT NULL CHECK (election_year BETWEEN 2000 AND 2100),
  source_account text NOT NULL CHECK (source_account ~ '^[1-9][0-9]*$'),
  net_amount numeric(16,2) NOT NULL CHECK (net_amount >= 0),
  unclassified_cash_amount numeric(16,2) NOT NULL CHECK (unclassified_cash_amount >= 0),
  unclassified_cash_count integer NOT NULL CHECK (unclassified_cash_count >= 0),
  provenance jsonb NOT NULL CHECK (jsonb_typeof(provenance) = 'object'
    AND provenance ?& ARRAY['authority', 'version']
    AND provenance->>'authority' = 'current_processed'
    AND provenance->>'version' = '1'),
  last_synced_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (link_id, election_year)
);
CREATE TRIGGER fl_pac_sources_set_updated_at BEFORE UPDATE
  ON public.fl_candidate_finance_pac_sources FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
