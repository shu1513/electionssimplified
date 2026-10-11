-- Typed political committee contributions to a Texas candidate committee.
-- Keyed by receiving link and year; snapshot replacement is transactional.
-- TEC committee IDs remain distinct from explicitly typed out-of-state PAC
-- FEC identities (fec:C########). Unknown interests remain visible.

BEGIN;

CREATE TABLE IF NOT EXISTS public.tx_candidate_finance_pac_donors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id uuid NOT NULL REFERENCES public.tx_candidate_finance_links(id) ON DELETE CASCADE,
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
  CONSTRAINT tx_candidate_finance_pac_donors_unique
    UNIQUE (link_id, election_year, committee_id),
  CONSTRAINT tx_candidate_finance_pac_donors_year_check
    CHECK (election_year >= 2014 AND election_year <= 2100),
  CONSTRAINT tx_candidate_finance_pac_donors_committee_id_check
    CHECK (btrim(committee_id) <> ''),
  CONSTRAINT tx_candidate_finance_pac_donors_committee_name_check
    CHECK (btrim(committee_name) <> ''),
  CONSTRAINT tx_candidate_finance_pac_donors_type_check
    CHECK (btrim(committee_type) <> ''),
  CONSTRAINT tx_candidate_finance_pac_donors_amount_check
    CHECK (amount > 0),
  CONSTRAINT tx_candidate_finance_pac_donors_count_check
    CHECK (contribution_count > 0),
  CONSTRAINT tx_candidate_finance_pac_donors_source_url_check
    CHECK (source_url IS NULL OR btrim(source_url) <> '')
);

CREATE INDEX IF NOT EXISTS idx_tx_candidate_finance_pac_donors_link
  ON public.tx_candidate_finance_pac_donors (link_id, election_year, amount DESC);

DROP TRIGGER IF EXISTS tx_candidate_finance_pac_donors_set_updated_at
  ON public.tx_candidate_finance_pac_donors;
CREATE TRIGGER tx_candidate_finance_pac_donors_set_updated_at
BEFORE UPDATE ON public.tx_candidate_finance_pac_donors
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
