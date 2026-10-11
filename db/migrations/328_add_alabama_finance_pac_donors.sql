-- Accepted typed PAC cash contributions; a subset of direct Raised.
-- Donor committee_id is a public FCPA number or reported:<canonical name> group.
-- Reported groups are source labels, not legal committee identities; the writer
-- enforces exact NFKC/Unicode name consistency independently of database locale.
BEGIN;

CREATE TABLE IF NOT EXISTS public.al_candidate_finance_pac_donors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id uuid NOT NULL,
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
  CONSTRAINT al_finance_pac_donors_unique
    UNIQUE (link_id, election_year, committee_id),
  CONSTRAINT al_finance_pac_donors_link_year_fk
    FOREIGN KEY (link_id, election_year)
    REFERENCES public.al_candidate_finance_links(id, election_year)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT al_finance_pac_donors_year_check
    CHECK (election_year BETWEEN 2024 AND 2100),
  CONSTRAINT al_finance_pac_donors_id_check
    CHECK (
      CASE WHEN committee_id ~ '^[1-9][0-9]{0,15}$'
        THEN committee_id::numeric <= 9007199254740991
        ELSE committee_id ~ '^reported:[[:alnum:]]+( [[:alnum:]]+)*$'
      END
    ),
  CONSTRAINT al_finance_pac_donors_name_check
    CHECK (btrim(committee_name) <> ''),
  CONSTRAINT al_finance_pac_donors_type_check
    CHECK (committee_type = 'Political Action Committee'),
  CONSTRAINT al_finance_pac_donors_amount_check
    CHECK (amount > 0),
  CONSTRAINT al_finance_pac_donors_count_check
    CHECK (contribution_count > 0),
  CONSTRAINT al_finance_pac_donors_source_url_check
    CHECK (
      (source_url IS NULL OR btrim(source_url) <> '')
      AND (committee_id NOT LIKE 'reported:%' OR source_url IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS al_finance_pac_donors_lookup_idx
  ON public.al_candidate_finance_pac_donors (link_id, election_year, amount DESC);

DROP TRIGGER IF EXISTS al_finance_pac_donors_set_updated_at
  ON public.al_candidate_finance_pac_donors;
CREATE TRIGGER al_finance_pac_donors_set_updated_at
BEFORE UPDATE ON public.al_candidate_finance_pac_donors
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
