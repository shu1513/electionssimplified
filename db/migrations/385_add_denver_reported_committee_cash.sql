-- Gross monetary receipts identified by native Committee contact type or explicit
-- political Organization naming. Reported labels are not registry identities.
BEGIN;
CREATE TABLE public.denver_candidate_finance_pac_sources (
  link_id uuid NOT NULL REFERENCES public.denver_candidate_finance_links(id) ON DELETE CASCADE,
  election_year integer NOT NULL CHECK (election_year BETWEEN 2000 AND 2100),
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 0 AND 9007199254740991),
  contribution_count integer NOT NULL CHECK (contribution_count >= 0),
  group_count integer NOT NULL CHECK (group_count >= 0),
  transaction_through date,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (link_id, election_year)
);
CREATE TABLE public.denver_candidate_finance_pac_donors (
  link_id uuid NOT NULL,
  election_year integer NOT NULL,
  committee_key text NOT NULL CHECK (btrim(committee_key) <> ''),
  committee_name text NOT NULL CHECK (btrim(committee_name) <> ''),
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 9007199254740991),
  contribution_count integer NOT NULL CHECK (contribution_count > 0),
  PRIMARY KEY (link_id, election_year, committee_key),
  CONSTRAINT denver_pac_donors_source_fk FOREIGN KEY (link_id, election_year)
    REFERENCES public.denver_candidate_finance_pac_sources(link_id, election_year) ON DELETE CASCADE
);
COMMIT;
