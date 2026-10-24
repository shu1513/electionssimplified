-- Gross, positive, non-memo canonical Schedule A COM/PTY/SCC receipts.
-- Native contributor labels and IDs are reported evidence, not registry verification.
BEGIN;
CREATE TABLE public.sdcity_candidate_finance_pac_sources (
  link_id uuid NOT NULL REFERENCES public.sdcity_candidate_finance_links(id) ON DELETE CASCADE,
  election_year integer NOT NULL CHECK (election_year BETWEEN 2000 AND 2100),
  receiving_fppc_id text NOT NULL CHECK (receiving_fppc_id ~ '^[0-9]{4,12}$'),
  office_name text NOT NULL CHECK (office_name IN ('Mayor','City Council Member')),
  seat_number smallint,
  CONSTRAINT sdcity_cash_office_seat_check CHECK ((office_name='Mayor' AND seat_number IS NULL) OR
    (office_name='City Council Member' AND seat_number IS NOT NULL AND seat_number BETWEEN 1 AND 9)),
  canonical_filing_count integer NOT NULL CHECK (canonical_filing_count >= 0),
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 0 AND 9007199254740991),
  contribution_count integer NOT NULL CHECK (contribution_count >= 0),
  group_count integer NOT NULL CHECK (group_count >= 0),
  reported_through date,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (link_id,election_year)
);
CREATE TABLE public.sdcity_candidate_finance_pac_donors (
  link_id uuid NOT NULL,
  election_year integer NOT NULL,
  committee_key text NOT NULL CHECK (btrim(committee_key) <> ''),
  committee_id text CHECK (committee_id ~ '^[0-9]{4,12}$'),
  committee_name text NOT NULL CHECK (btrim(committee_name) <> ''),
  contributor_type text NOT NULL CHECK (contributor_type IN ('COM','PTY','SCC')),
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 9007199254740991),
  contribution_count integer NOT NULL CHECK (contribution_count > 0),
  PRIMARY KEY (link_id,election_year,committee_key),
  CONSTRAINT sdcity_pac_donors_source_fk FOREIGN KEY (link_id,election_year)
    REFERENCES public.sdcity_candidate_finance_pac_sources(link_id,election_year) ON DELETE CASCADE
);
COMMIT;
