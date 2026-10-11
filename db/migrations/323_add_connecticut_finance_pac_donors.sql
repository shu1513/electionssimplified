-- Connecticut C1 committee-source receipts, already included in raised totals.
-- Source registry types retain candidate/exploratory transfers so the reader
-- can exclude them from PAC interests. Unknown types remain NULL.
-- The yearly snapshot is replaced atomically with the other finance tables.
BEGIN;

CREATE TABLE IF NOT EXISTS public.ct_candidate_finance_pac_donors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id uuid NOT NULL REFERENCES public.ct_candidate_finance_links(id) ON DELETE CASCADE,
  election_year integer NOT NULL,
  committee_id text NOT NULL,
  committee_name text NOT NULL,
  committee_type text,
  amount numeric(16,2) NOT NULL,
  contribution_count integer NOT NULL,
  source_url text,
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ct_candidate_finance_pac_donors_unique
    UNIQUE (link_id, election_year, committee_id),
  CONSTRAINT ct_candidate_finance_pac_donors_year_check
    CHECK (election_year >= 2008 AND election_year <= 2100),
  CONSTRAINT ct_candidate_finance_pac_donors_committee_id_check
    CHECK (btrim(committee_id) <> ''),
  CONSTRAINT ct_candidate_finance_pac_donors_committee_name_check
    CHECK (btrim(committee_name) <> ''),
  CONSTRAINT ct_candidate_finance_pac_donors_amount_check
    CHECK (amount > 0),
  CONSTRAINT ct_candidate_finance_pac_donors_count_check
    CHECK (contribution_count >= 0),
  CONSTRAINT ct_candidate_finance_pac_donors_source_url_check
    CHECK (source_url IS NULL OR btrim(source_url) <> '')
);

CREATE INDEX IF NOT EXISTS idx_ct_candidate_finance_pac_donors_link
  ON public.ct_candidate_finance_pac_donors (link_id, election_year, amount DESC);

DROP TRIGGER IF EXISTS ct_candidate_finance_pac_donors_set_updated_at
  ON public.ct_candidate_finance_pac_donors;
CREATE TRIGGER ct_candidate_finance_pac_donors_set_updated_at
BEFORE UPDATE ON public.ct_candidate_finance_pac_donors
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
