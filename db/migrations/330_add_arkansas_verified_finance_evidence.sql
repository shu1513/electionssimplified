-- Typed cash PAC donor rows and scoped ordinary-report source authority.
-- Reported-name IDs identify published donor labels, not inferred legal entities.
BEGIN;

ALTER TABLE public.ar_candidate_finance_summaries
  ADD COLUMN IF NOT EXISTS pac_source_provenance jsonb,
  ADD COLUMN IF NOT EXISTS outside_report_provenance jsonb;

ALTER TABLE public.ar_candidate_finance_summaries
  ADD CONSTRAINT ar_finance_pac_provenance_check CHECK (
    pac_source_provenance IS NULL OR (
      jsonb_typeof(pac_source_provenance) = 'object'
      AND coalesce(pac_source_provenance -> 'version' = '1'::jsonb, false)
    )
  ),
  ADD CONSTRAINT ar_finance_outside_provenance_check CHECK (
    outside_report_provenance IS NULL OR (
      jsonb_typeof(outside_report_provenance) = 'object'
      AND coalesce(outside_report_provenance -> 'version' = '1'::jsonb, false)
    )
  );

CREATE TABLE public.ar_candidate_finance_pac_donors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id uuid NOT NULL,
  election_year integer NOT NULL,
  committee_id text NOT NULL,
  committee_name text NOT NULL,
  committee_type text NOT NULL CHECK (committee_type = 'Political Action Committee'),
  amount numeric(16,2) NOT NULL CHECK (amount > 0),
  contribution_count integer NOT NULL CHECK (contribution_count > 0),
  source_url text NOT NULL,
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ar_finance_pac_donors_unique
    UNIQUE (link_id, election_year, committee_id),
  CONSTRAINT ar_finance_pac_donors_link_year_fk
    FOREIGN KEY (link_id, election_year)
    REFERENCES public.ar_candidate_finance_links(id, election_year)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT ar_finance_pac_donors_year_check
    CHECK (election_year BETWEEN 2026 AND 2100),
  CONSTRAINT ar_finance_pac_donors_identity_check
    CHECK (length(btrim(committee_id)) > 0 AND length(btrim(committee_name)) > 0
      AND length(btrim(committee_type)) > 0 AND length(btrim(source_url)) > 0)
);

CREATE INDEX ar_finance_pac_donors_link_year_idx
  ON public.ar_candidate_finance_pac_donors(link_id, election_year);

COMMIT;
