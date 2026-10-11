-- Current Quarterly itemized cash gifts from uniquely identified legal PAC/party committees.
-- Amounts are a subset of D2 receipts, not an additional fundraising total.
BEGIN;

CREATE TABLE IF NOT EXISTS public.il_candidate_finance_pac_donors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id uuid NOT NULL REFERENCES public.il_candidate_finance_links(id) ON DELETE CASCADE,
  election_year integer NOT NULL,
  committee_id text NOT NULL,
  committee_name text NOT NULL,
  committee_type text NOT NULL,
  amount numeric(16,2) NOT NULL,
  contribution_count integer NOT NULL,
  source_url text,
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT il_candidate_finance_pac_donors_unique UNIQUE (link_id, election_year, committee_id),
  CONSTRAINT il_candidate_finance_pac_donors_year_check CHECK (election_year BETWEEN 2000 AND 2100),
  CONSTRAINT il_candidate_finance_pac_donors_id_check CHECK (committee_id ~ '^[1-9][0-9]*$'),
  CONSTRAINT il_candidate_finance_pac_donors_name_check CHECK (btrim(committee_name) <> ''),
  CONSTRAINT il_candidate_finance_pac_donors_type_check CHECK (committee_type IN ('Political Action', 'Political Party')),
  CONSTRAINT il_candidate_finance_pac_donors_amount_check CHECK (amount > 0),
  CONSTRAINT il_candidate_finance_pac_donors_count_check CHECK (contribution_count > 0),
  CONSTRAINT il_candidate_finance_pac_donors_source_check CHECK (source_url IS NULL OR btrim(source_url) <> '')
);

CREATE INDEX IF NOT EXISTS idx_il_candidate_finance_pac_donors_link
  ON public.il_candidate_finance_pac_donors (link_id, election_year, amount DESC);
DROP TRIGGER IF EXISTS il_candidate_finance_pac_donors_set_updated_at ON public.il_candidate_finance_pac_donors;
CREATE TRIGGER il_candidate_finance_pac_donors_set_updated_at
BEFORE UPDATE ON public.il_candidate_finance_pac_donors
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE public.il_candidate_finance_outside_groups ADD COLUMN IF NOT EXISTS source_reports jsonb;
ALTER TABLE public.il_candidate_finance_outside_groups
  ADD CONSTRAINT il_finance_outside_source_reports_check
  CHECK (source_reports IS NULL OR jsonb_typeof(source_reports) = 'array');

COMMIT;
