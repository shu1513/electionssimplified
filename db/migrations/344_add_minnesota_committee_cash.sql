BEGIN;

-- A current reported itemized cash component, separate from official headlines.
CREATE TABLE public.mn_candidate_finance_pac_sources (
  link_id uuid NOT NULL,
  election_year integer NOT NULL CHECK (election_year BETWEEN 2000 AND 2100),
  basis text NOT NULL DEFAULT 'reported_itemized_committee_cash_contributions'
    CHECK (basis = 'reported_itemized_committee_cash_contributions'),
  source_url text NOT NULL CHECK (source_url ~ '^https://([A-Za-z0-9-]+\.)*cfb\.mn\.gov/'),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  source_byte_count bigint NOT NULL CHECK (source_byte_count > 0),
  source_row_count integer NOT NULL CHECK (source_row_count > 0),
  source_observed_at timestamptz NOT NULL CHECK (isfinite(source_observed_at)),
  total_amount numeric(16,2) NOT NULL CHECK (total_amount >= 0 AND total_amount NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
  matched_contribution_row_count integer NOT NULL CHECK (matched_contribution_row_count >= 0),
  included_contribution_row_count integer NOT NULL CHECK (included_contribution_row_count >= 0),
  excluded_contribution_row_count integer NOT NULL CHECK (excluded_contribution_row_count >= 0),
  zero_contribution_row_count integer NOT NULL CHECK (zero_contribution_row_count >= 0),
  excluded_unknown_class_row_count integer NOT NULL CHECK (excluded_unknown_class_row_count >= 0),
  last_synced_at timestamptz NOT NULL CHECK (isfinite(last_synced_at)),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (link_id, election_year),
  UNIQUE (link_id, election_year, source_sha256),
  CONSTRAINT mn_pac_sources_link_year_fk FOREIGN KEY (link_id, election_year)
    REFERENCES public.mn_candidate_finance_links(id, election_year)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT mn_pac_sources_counts_check CHECK (
    source_row_count >= matched_contribution_row_count
    AND matched_contribution_row_count::bigint =
      included_contribution_row_count::bigint + excluded_contribution_row_count + zero_contribution_row_count
    AND excluded_unknown_class_row_count <= excluded_contribution_row_count
  )
);

CREATE TABLE public.mn_candidate_finance_pac_donors (
  link_id uuid NOT NULL,
  election_year integer NOT NULL,
  reported_committee_id text NOT NULL CHECK (reported_committee_id ~ '^[0-9]+$'),
  reported_committee_name text NOT NULL CHECK (btrim(reported_committee_name) <> ''),
  reported_type text NOT NULL DEFAULT 'Political Committee/Fund'
    CHECK (reported_type = 'Political Committee/Fund'),
  amount numeric(16,2) NOT NULL CHECK (amount > 0 AND amount NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
  contribution_count integer NOT NULL CHECK (contribution_count > 0),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  last_synced_at timestamptz NOT NULL CHECK (isfinite(last_synced_at)),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (link_id, election_year, reported_committee_id, reported_committee_name),
  CONSTRAINT mn_pac_donors_source_fk FOREIGN KEY (link_id, election_year, source_sha256)
    REFERENCES public.mn_candidate_finance_pac_sources(link_id, election_year, source_sha256)
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TRIGGER mn_pac_sources_set_updated_at
BEFORE UPDATE ON public.mn_candidate_finance_pac_sources
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
