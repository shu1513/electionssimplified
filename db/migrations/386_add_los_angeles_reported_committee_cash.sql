-- Gross itemized Schedule A cash under committee-shaped reported names and
-- blank occupations. These labels are not registered PAC identities.
BEGIN;
-- NULL preserves the legacy singular scope until a fresh source observation.
ALTER TABLE public.lacity_candidate_finance_links ADD COLUMN fppc_committee_ids text[];
ALTER TABLE public.lacity_candidate_finance_links ADD CONSTRAINT lacity_receiving_scope_check CHECK (
  fppc_committee_ids IS NULL OR (cardinality(fppc_committee_ids) BETWEEN 1 AND 2
    AND array_position(fppc_committee_ids,NULL) IS NULL AND fppc_committee_id=ANY(fppc_committee_ids)
    AND array_to_string(fppc_committee_ids,',') ~ '^[0-9]{4,12}(,[0-9]{4,12})?$')
);
CREATE TABLE public.lacity_candidate_finance_pac_sources (
  link_id uuid NOT NULL REFERENCES public.lacity_candidate_finance_links(id) ON DELETE CASCADE,
  election_year integer NOT NULL CHECK (election_year BETWEEN 2000 AND 2100),
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 0 AND 9007199254740991),
  contribution_count integer NOT NULL CHECK (contribution_count >= 0),
  group_count integer NOT NULL CHECK (group_count >= 0),
  reported_through date,
  observed_at timestamptz NOT NULL,
  receiving_committee_ids text[] NOT NULL CHECK (cardinality(receiving_committee_ids) BETWEEN 1 AND 2),
  PRIMARY KEY (link_id, election_year)
);
CREATE TABLE public.lacity_candidate_finance_pac_donors (
  link_id uuid NOT NULL,
  election_year integer NOT NULL,
  committee_key text NOT NULL CHECK (btrim(committee_key) <> ''),
  committee_name text NOT NULL CHECK (btrim(committee_name) <> ''),
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 9007199254740991),
  contribution_count integer NOT NULL CHECK (contribution_count > 0),
  PRIMARY KEY (link_id, election_year, committee_key),
  CONSTRAINT lacity_pac_donors_source_fk FOREIGN KEY (link_id, election_year)
    REFERENCES public.lacity_candidate_finance_pac_sources(link_id, election_year) ON DELETE CASCADE
);
COMMIT;
