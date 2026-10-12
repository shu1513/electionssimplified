-- Published committee gifts and safe accepted-source provenance.
-- Reported-name identities are not inferred registered legal CF_IDs.
BEGIN;

ALTER TABLE public.de_candidate_finance_summaries
  ADD COLUMN pac_source_provenance jsonb,
  ADD COLUMN outside_report_provenance jsonb,
  ADD CONSTRAINT de_finance_pac_provenance_check CHECK (
    pac_source_provenance IS NULL OR (
      jsonb_typeof(pac_source_provenance) = 'object'
      AND coalesce(pac_source_provenance -> 'version' = '1'::jsonb, false)
    )
  ),
  ADD CONSTRAINT de_finance_outside_provenance_check CHECK (
    outside_report_provenance IS NULL OR (
      jsonb_typeof(outside_report_provenance) = 'object'
      AND coalesce(outside_report_provenance -> 'version' = '1'::jsonb, false)
    )
  );

CREATE TABLE public.de_candidate_finance_pac_donors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id uuid NOT NULL,
  election_year integer NOT NULL CHECK (election_year BETWEEN 2026 AND 2100),
  committee_id text NOT NULL CHECK (btrim(committee_id) <> ''),
  committee_name text NOT NULL CHECK (btrim(committee_name) <> ''),
  reported_contributor_type text NOT NULL CHECK (btrim(reported_contributor_type) <> ''),
  committee_type text NOT NULL CHECK (committee_type IN (
    'Political Action Committee', 'Political Committee', 'PAC', 'Candidate Committee',
    'Out-of-State or Federal Committee', 'Dem or Rep National Sub-Committees'
  )),
  registered_committee_id text CHECK (registered_committee_id ~ '^[0-9]{8}$'),
  cash_amount numeric(16,2) NOT NULL,
  in_kind_amount numeric(16,2) NOT NULL,
  amount numeric(16,2) GENERATED ALWAYS AS (cash_amount + in_kind_amount) STORED,
  contribution_count integer NOT NULL CHECK (contribution_count >= 0),
  source_url text NOT NULL CHECK (btrim(source_url) <> ''),
  last_synced_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT de_finance_pac_donors_net_check CHECK (
    -- Signed and zero receiver positions must survive candidate-wide netting.
    cash_amount <> 'NaN'::numeric AND in_kind_amount <> 'NaN'::numeric
  ),
  CONSTRAINT de_finance_pac_donors_unique
    UNIQUE (link_id, election_year, committee_id),
  CONSTRAINT de_finance_pac_donors_link_year_fk
    FOREIGN KEY (link_id, election_year)
    REFERENCES public.de_candidate_finance_links(id, election_year)
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX de_finance_pac_donors_link_year_idx
  ON public.de_candidate_finance_pac_donors(link_id, election_year);

CREATE TRIGGER de_finance_pac_donors_set_updated_at
BEFORE UPDATE ON public.de_candidate_finance_pac_donors
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
