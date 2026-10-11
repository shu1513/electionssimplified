-- Typed cash PAC donor snapshots and report-scoped ordinary outside authority.
-- Reported-name donor IDs identify source labels, not inferred legal committees.
-- The writer validates source namespaces, exact cents and provenance closure.
BEGIN;

ALTER TABLE public.tn_candidate_finance_summaries
  ADD COLUMN IF NOT EXISTS pac_source_provenance jsonb,
  ADD COLUMN IF NOT EXISTS outside_report_provenance jsonb;

ALTER TABLE public.tn_candidate_finance_summaries
  ADD CONSTRAINT tn_finance_pac_provenance_check CHECK (
    pac_source_provenance IS NULL OR (
      jsonb_typeof(pac_source_provenance) = 'object'
      AND coalesce(pac_source_provenance -> 'version' = '1'::jsonb, false)
    )
  ),
  ADD CONSTRAINT tn_finance_outside_provenance_check CHECK (
    outside_report_provenance IS NULL OR (
      jsonb_typeof(outside_report_provenance) = 'object'
      AND coalesce(outside_report_provenance -> 'version' = '1'::jsonb, false)
    )
  );

CREATE TABLE public.tn_candidate_finance_pac_donors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id uuid NOT NULL,
  election_year integer NOT NULL,
  committee_id text NOT NULL,
  committee_name text NOT NULL,
  committee_type text NOT NULL,
  amount numeric(16,2) NOT NULL,
  contribution_count integer NOT NULL,
  source_url text NOT NULL,
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tn_finance_pac_donors_unique
    UNIQUE (link_id, election_year, committee_id),
  CONSTRAINT tn_finance_pac_donors_link_year_fk
    FOREIGN KEY (link_id, election_year)
    REFERENCES public.tn_candidate_finance_links(id, election_year)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT tn_finance_pac_donors_year_check
    CHECK (election_year BETWEEN 2000 AND 2100),
  CONSTRAINT tn_finance_pac_donors_id_check CHECK (
    CASE WHEN committee_id ~ '^[1-9][0-9]{0,15}$'
      THEN committee_id::numeric <= 9007199254740991
      ELSE committee_id ~ '^reported:[[:alnum:]]+( [[:alnum:]]+)*$'
    END
  ),
  CONSTRAINT tn_finance_pac_donors_name_check
    CHECK (btrim(committee_name) <> ''),
  CONSTRAINT tn_finance_pac_donors_type_check
    CHECK (committee_type = 'Political Action Committee'),
  CONSTRAINT tn_finance_pac_donors_amount_check
    CHECK (amount > 0),
  CONSTRAINT tn_finance_pac_donors_count_check
    CHECK (contribution_count > 0),
  CONSTRAINT tn_finance_pac_donors_source_url_check
    CHECK (btrim(source_url) <> '')
);

CREATE INDEX tn_finance_pac_donors_lookup_idx
  ON public.tn_candidate_finance_pac_donors (link_id, election_year, amount DESC);

CREATE TRIGGER tn_finance_pac_donors_set_updated_at
BEFORE UPDATE ON public.tn_candidate_finance_pac_donors
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
