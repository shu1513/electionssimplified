-- Political committees that gave to a Pennsylvania candidate's committee in
-- the cycle, from the candidate's own contribution rows in the DOS bulk
-- export. A contributor counts as a committee when its name matches a
-- FILERTYPE 2 (committee) row of the filer registry, or when it reports no
-- occupation and is named like a committee (PAC, committee, union, ...).
--
-- committee_id is the registry filer id when the name matched exactly one
-- registered committee, otherwise the normalized contributor name. (The
-- registry's OFFICE column is not carried: committee rows fill it
-- inconsistently, so it cannot tell a candidate's own committee apart.)
--
-- Keyed by link like the other pa_candidate_finance_* tables; a sync
-- replaces the link's rows for the cycle in one transaction. The read side
-- feeds these into the "PAC money by interest" list that federal candidates
-- already have (candidate_finance_pac_donors, migration 291).

BEGIN;

CREATE TABLE IF NOT EXISTS public.pa_candidate_finance_pac_donors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id uuid NOT NULL REFERENCES public.pa_candidate_finance_links(id) ON DELETE CASCADE,
  election_year integer NOT NULL,
  committee_id text NOT NULL,
  committee_name text NOT NULL,
  amount numeric(16,2) NOT NULL,
  contribution_count integer NOT NULL,
  source_url text,
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pa_candidate_finance_pac_donors_unique
    UNIQUE (link_id, election_year, committee_id),
  CONSTRAINT pa_candidate_finance_pac_donors_year_check
    CHECK (election_year >= 2000 AND election_year <= 2100),
  CONSTRAINT pa_candidate_finance_pac_donors_committee_id_check
    CHECK (btrim(committee_id) <> ''),
  CONSTRAINT pa_candidate_finance_pac_donors_committee_name_check
    CHECK (btrim(committee_name) <> ''),
  CONSTRAINT pa_candidate_finance_pac_donors_amount_check
    CHECK (amount > 0),
  CONSTRAINT pa_candidate_finance_pac_donors_count_check
    CHECK (contribution_count >= 0),
  CONSTRAINT pa_candidate_finance_pac_donors_source_url_check
    CHECK (source_url IS NULL OR btrim(source_url) <> '')
);

CREATE INDEX IF NOT EXISTS idx_pa_candidate_finance_pac_donors_link
  ON public.pa_candidate_finance_pac_donors (link_id, election_year, amount DESC);

DROP TRIGGER IF EXISTS pa_candidate_finance_pac_donors_set_updated_at
  ON public.pa_candidate_finance_pac_donors;
CREATE TRIGGER pa_candidate_finance_pac_donors_set_updated_at
BEFORE UPDATE ON public.pa_candidate_finance_pac_donors
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
