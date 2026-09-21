-- Named committee donors and conduit (earmarked) totals for federal candidates.
--
-- candidate_finance_pac_donors: committees that reported contributions to the
-- candidate in the cycle (FEC bulk "contributions from committees to
-- candidates" file, transaction types 24K and 24Z), net of negative entries.
--
-- candidate_finance_conduit_totals: itemized individual contributions that the
-- candidate's own committees reported as earmarked through a conduit committee
-- (FEC bulk individual contributions file, transaction type 15E, conduit id in
-- OTHER_ID). is_payment_platform marks conduits that forward money to a very
-- large number of committees and make no contributions of their own; the UI
-- lists those apart. The rule is computed from the data at sync time.
--
-- Both tables are keyed by (fec_candidate_id, election_year) like the other
-- candidate_finance_* tables, and a sync replaces a cycle's rows in one
-- transaction. candidate_finance_summaries.contributors_synced_at tells the
-- read side that the lists were loaded, so an empty list can be shown as
-- "none reported" instead of "not loaded yet".

BEGIN;

CREATE TABLE IF NOT EXISTS public.candidate_finance_pac_donors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fec_candidate_id text NOT NULL,
  election_year integer NOT NULL,
  committee_id text NOT NULL,
  committee_name text NOT NULL,
  connected_organization text,
  amount numeric(16,2) NOT NULL,
  contribution_count integer NOT NULL,
  source_url text,
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_candidate_finance_pac_donors_key
    UNIQUE (fec_candidate_id, election_year, committee_id),
  CONSTRAINT chk_candidate_finance_pac_donors_fec_candidate_id
    CHECK (btrim(fec_candidate_id) <> ''),
  CONSTRAINT chk_candidate_finance_pac_donors_election_year
    CHECK (election_year BETWEEN 1970 AND 2100),
  CONSTRAINT chk_candidate_finance_pac_donors_committee_id
    CHECK (btrim(committee_id) <> ''),
  CONSTRAINT chk_candidate_finance_pac_donors_committee_name
    CHECK (btrim(committee_name) <> ''),
  CONSTRAINT chk_candidate_finance_pac_donors_connected_organization
    CHECK (connected_organization IS NULL OR btrim(connected_organization) <> ''),
  CONSTRAINT chk_candidate_finance_pac_donors_amount
    CHECK (amount > 0),
  CONSTRAINT chk_candidate_finance_pac_donors_contribution_count
    CHECK (contribution_count >= 0),
  CONSTRAINT chk_candidate_finance_pac_donors_source_url
    CHECK (source_url IS NULL OR btrim(source_url) <> '')
);

CREATE INDEX IF NOT EXISTS idx_candidate_finance_pac_donors_lookup
  ON public.candidate_finance_pac_donors (fec_candidate_id, election_year DESC, amount DESC);

DROP TRIGGER IF EXISTS trg_candidate_finance_pac_donors_set_updated_at
  ON public.candidate_finance_pac_donors;
CREATE TRIGGER trg_candidate_finance_pac_donors_set_updated_at
BEFORE UPDATE ON public.candidate_finance_pac_donors
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS public.candidate_finance_conduit_totals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fec_candidate_id text NOT NULL,
  election_year integer NOT NULL,
  committee_id text NOT NULL,
  committee_name text NOT NULL,
  is_payment_platform boolean NOT NULL DEFAULT false,
  amount numeric(16,2) NOT NULL,
  contribution_count integer NOT NULL,
  source_url text,
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_candidate_finance_conduit_totals_key
    UNIQUE (fec_candidate_id, election_year, committee_id),
  CONSTRAINT chk_candidate_finance_conduit_totals_fec_candidate_id
    CHECK (btrim(fec_candidate_id) <> ''),
  CONSTRAINT chk_candidate_finance_conduit_totals_election_year
    CHECK (election_year BETWEEN 1970 AND 2100),
  CONSTRAINT chk_candidate_finance_conduit_totals_committee_id
    CHECK (btrim(committee_id) <> ''),
  CONSTRAINT chk_candidate_finance_conduit_totals_committee_name
    CHECK (btrim(committee_name) <> ''),
  CONSTRAINT chk_candidate_finance_conduit_totals_amount
    CHECK (amount > 0),
  CONSTRAINT chk_candidate_finance_conduit_totals_contribution_count
    CHECK (contribution_count >= 0),
  CONSTRAINT chk_candidate_finance_conduit_totals_source_url
    CHECK (source_url IS NULL OR btrim(source_url) <> '')
);

CREATE INDEX IF NOT EXISTS idx_candidate_finance_conduit_totals_lookup
  ON public.candidate_finance_conduit_totals (fec_candidate_id, election_year DESC, amount DESC);

DROP TRIGGER IF EXISTS trg_candidate_finance_conduit_totals_set_updated_at
  ON public.candidate_finance_conduit_totals;
CREATE TRIGGER trg_candidate_finance_conduit_totals_set_updated_at
BEFORE UPDATE ON public.candidate_finance_conduit_totals
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

ALTER TABLE public.candidate_finance_summaries
  ADD COLUMN IF NOT EXISTS contributors_synced_at timestamptz;

COMMIT;
