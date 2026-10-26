-- Independent native IE component: no receiving-committee link or direct
-- summary is required. Source clocks belong only to this component.
CREATE TABLE IF NOT EXISTS public.md_candidate_finance_ie_sources (
  candidate_id uuid NOT NULL REFERENCES public.candidates(id) ON DELETE CASCADE,
  election_id uuid NOT NULL REFERENCES public.elections(id) ON DELETE CASCADE,
  election_year integer NOT NULL CHECK (election_year BETWEEN 2000 AND 2100),
  canonical_context jsonb NOT NULL CHECK (jsonb_typeof(canonical_context) = 'object'),
  target_account_guids uuid[] NOT NULL CHECK (cardinality(target_account_guids) > 0),
  support_cents bigint NOT NULL CHECK (support_cents BETWEEN 0 AND 9007199254740991),
  oppose_cents bigint NOT NULL CHECK (oppose_cents BETWEEN 0 AND 9007199254740991),
  group_count integer NOT NULL CHECK (group_count >= 0),
  allocation_count integer NOT NULL CHECK (allocation_count >= 0),
  source_observed_at timestamptz NOT NULL,
  last_synced_at timestamptz NOT NULL CHECK (last_synced_at >= source_observed_at),
  generation_directory text NOT NULL CHECK (length(generation_directory) > 0),
  native_directory text NOT NULL CHECK (length(native_directory) > 0),
  financial_basis text NOT NULL CHECK (financial_basis = 'complete_native_ie_with_current_report_controls'),
  PRIMARY KEY (candidate_id, election_id)
);
CREATE TABLE IF NOT EXISTS public.md_candidate_finance_ie_groups (
  candidate_id uuid NOT NULL,
  election_id uuid NOT NULL,
  payer_guid uuid NOT NULL,
  filing_entity_id bigint NOT NULL CHECK (filing_entity_id > 0),
  committee_name text NOT NULL CHECK (length(btrim(committee_name)) > 0),
  stance text NOT NULL CHECK (stance IN ('support', 'oppose')),
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 9007199254740991),
  source_url text NOT NULL,
  PRIMARY KEY (candidate_id, election_id, payer_guid, stance),
  FOREIGN KEY (candidate_id, election_id) REFERENCES public.md_candidate_finance_ie_sources(candidate_id, election_id) ON DELETE CASCADE
);
-- Operational retry ordering is distinct from financial freshness. An
-- unqualified/failed observation never creates a financial source row.
CREATE TABLE IF NOT EXISTS public.md_candidate_finance_ie_attempts (
  candidate_id uuid NOT NULL REFERENCES public.candidates(id) ON DELETE CASCADE,
  election_id uuid NOT NULL REFERENCES public.elections(id) ON DELETE CASCADE,
  last_attempted_at timestamptz NOT NULL,
  diagnostic text NOT NULL,
  PRIMARY KEY(candidate_id,election_id)
);
