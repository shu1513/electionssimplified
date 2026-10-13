-- DataSF COM is a recipient committee (including candidate campaigns),
-- not a legal PAC designation. Store source-qualified signed cash positions
-- and the reported IDs as evidence, never as an inferred legal identity.
-- Returns remain signed until candidate-election netting in the reader.
BEGIN;

CREATE TABLE public.sfc_candidate_finance_pac_donors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id uuid NOT NULL REFERENCES public.sfc_candidate_finance_links(id) ON DELETE CASCADE,
  election_year integer NOT NULL CHECK (election_year BETWEEN 2000 AND 2100),
  committee_id text NOT NULL CHECK (btrim(committee_id) <> ''),
  committee_name text NOT NULL CHECK (btrim(committee_name) <> ''),
  source_reported_class text NOT NULL CHECK (source_reported_class IN ('COM','SCC')),
  reported_committee_ids jsonb NOT NULL CHECK (jsonb_typeof(reported_committee_ids) = 'array'),
  amount numeric(16,2) NOT NULL,
  contribution_count integer NOT NULL CHECK (contribution_count >= 0),
  source_url text NOT NULL CHECK (btrim(source_url) <> ''),
  reported_through date NOT NULL,
  last_synced_at timestamptz NOT NULL,
  UNIQUE (link_id, election_year, committee_id)
);

CREATE INDEX sfc_finance_pac_donors_link_year
  ON public.sfc_candidate_finance_pac_donors(link_id,election_year);

COMMIT;
