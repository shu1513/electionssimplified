BEGIN;

-- Reviewed reported EFD expenditures, separate from committee cash and IE
-- totals. Publication remains gated while commercial-use clearance is held.
CREATE TABLE phx_reported_efd_families (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL REFERENCES candidates(id),
  election_id uuid NOT NULL REFERENCES elections(id),
  election_year integer NOT NULL CHECK (election_year=2026),
  spender_name text NOT NULL CHECK (length(trim(spender_name))>0),
  spender_name_key text NOT NULL CHECK (length(spender_name_key)>0),
  canonical_context jsonb NOT NULL,
  observed_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL CHECK (completed_at>=observed_at),
  source_digest text NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  source_url text NOT NULL,
  occurrence_count integer NOT NULL CHECK (occurrence_count BETWEEN 1 AND 100),
  support_cents bigint NOT NULL CHECK (support_cents BETWEEN 0 AND 9007199254740991),
  oppose_cents bigint NOT NULL CHECK (oppose_cents BETWEEN 0 AND 9007199254740991),
  CONSTRAINT phx_efd_family_owner_uq UNIQUE(candidate_id,election_id,election_year,spender_name_key)
);
CREATE TABLE phx_reported_efd_reports (
  document_id text PRIMARY KEY CHECK (document_id ~ '^[1-9][0-9]{4,9}$'),
  family_id uuid NOT NULL REFERENCES phx_reported_efd_families(id) ON DELETE CASCADE,
  source_url text NOT NULL UNIQUE,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  filed_date date NOT NULL,
  reported_spender_name text NOT NULL,
  reported_candidate_name text NOT NULL,
  reported_office text NOT NULL,
  reported_district_number integer CHECK (reported_district_number BETWEEN 1 AND 8),
  vendor_name text NOT NULL,
  expenditure_date date NOT NULL CHECK (expenditure_date<=filed_date),
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 9007199254740991),
  stance text NOT NULL CHECK (stance IN ('support','oppose')),
  reviewed_page_count integer NOT NULL CHECK (reviewed_page_count BETWEEN 1 AND 50)
);
CREATE INDEX phx_efd_reports_family_idx ON phx_reported_efd_reports(family_id);

COMMIT;
