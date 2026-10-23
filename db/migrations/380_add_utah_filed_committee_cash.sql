-- Independent freshness and acceptance for current filed committee cash.
BEGIN;
CREATE TABLE public.ut_candidate_finance_pac_sources (
  link_id uuid NOT NULL, election_year integer NOT NULL CHECK (election_year BETWEEN 1998 AND 2100),
  folder_id text NOT NULL CHECK (folder_id ~ '^[0-9]+$'),
  last_synced_at timestamptz NOT NULL,
  source_url text NOT NULL CHECK (source_url ~ '^https://disclosures[.]utah[.]gov/Search/PublicSearch/FolderDetails/[0-9]+$'),
  report_count integer NOT NULL CHECK (report_count > 0),
  occurrence_count integer NOT NULL CHECK (occurrence_count > 0),
  excluded_unfiled_count integer NOT NULL CHECK (excluded_unfiled_count >= 0),
  group_count integer NOT NULL CHECK (group_count >= 0),
  cash_cents bigint NOT NULL CHECK (cash_cents BETWEEN -9007199254740991 AND 9007199254740991),
  PRIMARY KEY (link_id, election_year),
  FOREIGN KEY (link_id, election_year) REFERENCES public.ut_candidate_finance_links(id, election_year) ON DELETE CASCADE
);
CREATE TABLE public.ut_candidate_finance_pac_donors (
  link_id uuid NOT NULL, election_year integer NOT NULL,
  committee_id text NOT NULL CHECK (btrim(committee_id) <> '' AND length(committee_id) <= 600),
  committee_name text NOT NULL CHECK (btrim(committee_name) <> '' AND length(committee_name) <= 500),
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN -9007199254740991 AND 9007199254740991),
  contribution_count integer NOT NULL CHECK (contribution_count > 0),
  PRIMARY KEY (link_id, election_year, committee_id),
  FOREIGN KEY (link_id, election_year) REFERENCES public.ut_candidate_finance_pac_sources(link_id, election_year) ON DELETE CASCADE
);
COMMIT;
