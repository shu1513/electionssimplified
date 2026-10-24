-- Gross positive itemized native PAC/Party cash, with independent source
-- acceptance. Expenditure-side returns are excluded from this stated basis.
BEGIN;
CREATE TABLE public.ri_candidate_finance_pac_sources (
  link_id uuid NOT NULL,
  election_year integer NOT NULL CHECK (election_year = 2026),
  receiving_committee_id text NOT NULL CHECK (receiving_committee_id ~ '^[0-9]+$'),
  observed_at timestamptz NOT NULL,
  source_digest text NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  period_start date NOT NULL,
  period_end date NOT NULL,
  source_url text NOT NULL CHECK (source_url ~ '^https://www[.]ricampaignfinance[.]com/RIPublic/Reporting/TransactionReport[.]aspx[?]OrgID=[0-9]+&'),
  report_count integer NOT NULL CHECK (report_count > 0),
  receiving_rows integer NOT NULL CHECK (receiving_rows >= 0),
  selected_occurrences integer NOT NULL CHECK (selected_occurrences >= 0),
  group_count integer NOT NULL CHECK (group_count >= 0),
  cash_cents bigint NOT NULL CHECK (cash_cents BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (link_id, election_year),
  CONSTRAINT ri_pac_src_link_fk FOREIGN KEY (link_id, election_year)
    REFERENCES public.ri_candidate_finance_links(id, election_year) ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT ri_pac_src_period_ck CHECK (period_start = make_date(election_year - 1, 1, 1)
    AND period_end BETWEEN period_start AND make_date(election_year, 12, 31)),
  CONSTRAINT ri_pac_src_counts_ck CHECK (group_count <= selected_occurrences AND selected_occurrences <= receiving_rows)
);
CREATE TABLE public.ri_candidate_finance_pac_donors (
  link_id uuid NOT NULL,
  election_year integer NOT NULL,
  reported_key text NOT NULL CHECK (btrim(reported_key) <> '' AND length(reported_key) <= 2100),
  committee_name text NOT NULL CHECK (btrim(committee_name) <> '' AND length(committee_name) <= 500),
  source_class text NOT NULL CHECK (source_class IN ('PAC', 'Party')),
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 9007199254740991),
  contribution_count integer NOT NULL CHECK (contribution_count > 0),
  PRIMARY KEY (link_id, election_year, reported_key),
  CONSTRAINT ri_pac_donor_src_fk FOREIGN KEY (link_id, election_year)
    REFERENCES public.ri_candidate_finance_pac_sources(link_id, election_year) ON UPDATE CASCADE ON DELETE CASCADE
);
COMMIT;
