-- Political-name identified Group=Yes organizations, not verified legal PAC IDs.
-- Signed current-source net positions are a subset of direct Raised.
BEGIN;
CREATE TABLE IF NOT EXISTS public.sc_candidate_finance_pac_donors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id uuid NOT NULL,
  election_year integer NOT NULL,
  committee_id text NOT NULL,
  committee_name text NOT NULL,
  amount numeric(16,2) NOT NULL,
  contribution_count integer NOT NULL,
  source_url text,
  recognition_method text NOT NULL,
  source_reported_class text NOT NULL,
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sc_reported_donors_unique UNIQUE (link_id, election_year, committee_id),
  CONSTRAINT sc_reported_donors_link_year_fk FOREIGN KEY (link_id, election_year)
    REFERENCES public.sc_candidate_finance_links(id, election_year) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT sc_reported_donors_year_check CHECK (election_year BETWEEN 2008 AND 2100),
  CONSTRAINT sc_reported_donors_id_check CHECK (committee_id LIKE 'reported:%' AND length(committee_id) > 9),
  CONSTRAINT sc_reported_donors_name_check CHECK (btrim(committee_name) <> ''),
  CONSTRAINT sc_reported_donors_amount_check CHECK (amount <> 'NaN'::numeric AND amount BETWEEN -90071992547409.91 AND 90071992547409.91),
  CONSTRAINT sc_reported_donors_count_check CHECK (contribution_count > 0),
  CONSTRAINT sc_reported_donors_method_check CHECK (recognition_method = 'political_name_hint'),
  CONSTRAINT sc_reported_donors_class_check CHECK (source_reported_class = 'group_yes'),
  CONSTRAINT sc_reported_donors_url_check CHECK (source_url IS NULL OR btrim(source_url) <> '')
);
CREATE INDEX IF NOT EXISTS sc_reported_donors_lookup_idx
  ON public.sc_candidate_finance_pac_donors(link_id, election_year, amount DESC);
CREATE TRIGGER sc_reported_donors_set_updated_at
  BEFORE UPDATE ON public.sc_candidate_finance_pac_donors
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
COMMIT;
