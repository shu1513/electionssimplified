-- Named PAC monetary receipts from the candidate's own NYSBOE disclosures.
-- The contributor must carry the literal reported PAC class; a source-name
-- key is not a registry/legal identity. These are gross A/B/C cash receipts,
-- not net support: refunds and in-kind contributions are excluded.
BEGIN;

CREATE TABLE IF NOT EXISTS public.ny_candidate_finance_pac_donors (
  link_id uuid NOT NULL,
  election_year integer NOT NULL CHECK (election_year BETWEEN 2000 AND 2100),
  committee_id text NOT NULL CHECK (btrim(committee_id) <> ''),
  committee_name text NOT NULL CHECK (btrim(committee_name) <> ''),
  source_reported_class text NOT NULL
    CHECK (source_reported_class = 'Political Action Committee (PAC)'),
  amount numeric(16,2) NOT NULL CHECK (amount >= 0 AND amount <> 'NaN'::numeric),
  contribution_count integer NOT NULL CHECK (contribution_count >= 0),
  source_url text CHECK (source_url IS NULL OR btrim(source_url) <> ''),
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (link_id, election_year, committee_id),
  FOREIGN KEY (link_id, election_year)
    REFERENCES public.ny_candidate_finance_links(id, election_year) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ny_finance_pac_donors_link
  ON public.ny_candidate_finance_pac_donors (link_id, election_year, amount DESC);

CREATE TRIGGER ny_finance_pac_donors_set_updated_at
BEFORE UPDATE ON public.ny_candidate_finance_pac_donors
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
