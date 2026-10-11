-- Typed political committee contributions to a West Virginia candidate committee.
-- Keyed by receiving link and year; snapshot replacement is transactional.
-- Official 102 PAC and 103 party/caucus identities remain distinct.
-- Unknown interests remain visible.

BEGIN;

CREATE TABLE IF NOT EXISTS public.wv_candidate_finance_pac_donors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id uuid NOT NULL REFERENCES public.wv_candidate_finance_links(id) ON DELETE CASCADE,
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
  CONSTRAINT wv_candidate_finance_pac_donors_unique
    UNIQUE (link_id, election_year, committee_id),
  CONSTRAINT wv_candidate_finance_pac_donors_year_check
    CHECK (election_year >= 2026 AND election_year <= 2100),
  CONSTRAINT wv_candidate_finance_pac_donors_committee_id_check
    CHECK (committee_id ~ '^10[23][0-9]{7}$'),
  CONSTRAINT wv_candidate_finance_pac_donors_committee_name_check
    CHECK (btrim(committee_name) <> ''),
  CONSTRAINT wv_candidate_finance_pac_donors_type_check
    CHECK (committee_type IN ('102', '103')),
  CONSTRAINT wv_candidate_finance_pac_donors_amount_check
    CHECK (amount > 0),
  CONSTRAINT wv_candidate_finance_pac_donors_count_check
    CHECK (contribution_count > 0),
  CONSTRAINT wv_candidate_finance_pac_donors_source_url_check
    CHECK (source_url IS NULL OR btrim(source_url) <> '')
);

CREATE INDEX IF NOT EXISTS idx_wv_candidate_finance_pac_donors_link
  ON public.wv_candidate_finance_pac_donors (link_id, election_year, amount DESC);

DROP TRIGGER IF EXISTS wv_candidate_finance_pac_donors_set_updated_at
  ON public.wv_candidate_finance_pac_donors;
CREATE TRIGGER wv_candidate_finance_pac_donors_set_updated_at
BEFORE UPDATE ON public.wv_candidate_finance_pac_donors
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Source transaction/version evidence protects accepted electronic IE rows
-- from disappearing when the public transaction view is incomplete.
ALTER TABLE public.wv_candidate_finance_outside_groups
  ADD COLUMN IF NOT EXISTS source_transactions jsonb;
ALTER TABLE public.wv_candidate_finance_outside_groups
  ADD CONSTRAINT wv_finance_outside_source_transactions_check
  CHECK (source_transactions IS NULL OR jsonb_typeof(source_transactions) = 'array');

COMMIT;
