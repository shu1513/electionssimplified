-- Georgia keeps its five canonical factory tables (capability matrix, Georgia
-- row). Independent reported components must not replace/freshen direct cover
-- totals or cascade-delete legacy outside funders when their source fails.
BEGIN;

CREATE TABLE public.ga_reported_committee_sources (
  link_id uuid NOT NULL,
  election_year integer NOT NULL,
  filing_year integer NOT NULL,
  receiving_committee_id text NOT NULL,
  registration_guid text NOT NULL,
  total_amount_cents bigint NOT NULL,
  contribution_count integer NOT NULL,
  group_count integer NOT NULL,
  source_row_count integer NOT NULL,
  held_receiving_count integer NOT NULL,
  source_url text NOT NULL,
  source_retrieved_at timestamptz NOT NULL,
  source_completed_at timestamptz NOT NULL,
  source_manifest_sha256 text NOT NULL,
  source_byte_size bigint NOT NULL,
  source_controls jsonb NOT NULL,
  last_synced_at timestamptz NOT NULL,
  CONSTRAINT ga_rcpt_source_pk PRIMARY KEY (link_id, election_year),
  CONSTRAINT ga_rcpt_source_link FOREIGN KEY (link_id, election_year)
    REFERENCES public.ga_candidate_finance_links(id, election_year) ON DELETE CASCADE,
  CONSTRAINT ga_rcpt_source_years CHECK
    (election_year BETWEEN 2026 AND 2100 AND filing_year BETWEEN 2026 AND 2100),
  CONSTRAINT ga_rcpt_source_identity CHECK
    (receiving_committee_id ~ '^[1-9][0-9]*$' AND btrim(registration_guid) <> ''),
  CONSTRAINT ga_rcpt_source_money CHECK
    (total_amount_cents BETWEEN 0 AND 9007199254740991),
  CONSTRAINT ga_rcpt_source_counts CHECK
    (contribution_count >= 0 AND group_count >= 0 AND group_count <= contribution_count
      AND contribution_count <= source_row_count AND source_row_count > 0 AND held_receiving_count >= 0
      AND (group_count = 0) = (contribution_count = 0)
      AND (contribution_count = 0) = (total_amount_cents = 0)),
  CONSTRAINT ga_rcpt_source_facts CHECK
    (source_url = 'https://ethics.ga.gov/records-search-all/'
      AND source_manifest_sha256 ~ '^[a-f0-9]{64}$' AND source_byte_size > 0
      AND jsonb_typeof(source_controls) = 'array' AND jsonb_array_length(source_controls) = 1),
  CONSTRAINT ga_rcpt_source_times CHECK
    (source_retrieved_at <= source_completed_at AND source_completed_at <= last_synced_at)
);

CREATE TABLE public.ga_reported_committee_groups (
  link_id uuid NOT NULL,
  election_year integer NOT NULL,
  reported_contributor_type text NOT NULL,
  reported_name text NOT NULL,
  reported_name_key text NOT NULL,
  amount_cents bigint NOT NULL,
  contribution_count integer NOT NULL,
  CONSTRAINT ga_rcpt_group_pk PRIMARY KEY
    (link_id, election_year, reported_contributor_type, reported_name_key),
  CONSTRAINT ga_rcpt_group_source FOREIGN KEY (link_id, election_year)
    REFERENCES public.ga_reported_committee_sources(link_id, election_year) ON DELETE CASCADE,
  CONSTRAINT ga_rcpt_group_role CHECK
    (reported_contributor_type IN ('Non-Candidate Committee', 'Candidate / Candidate Committee')),
  CONSTRAINT ga_rcpt_group_names CHECK (btrim(reported_name) <> '' AND btrim(reported_name_key) <> ''),
  CONSTRAINT ga_rcpt_group_money CHECK
    (amount_cents BETWEEN 1 AND 9007199254740991 AND contribution_count > 0)
);

CREATE TABLE public.ga_reported_ie_sources (
  candidate_id uuid NOT NULL REFERENCES public.candidates(id) ON DELETE CASCADE,
  election_id uuid NOT NULL REFERENCES public.elections(id) ON DELETE CASCADE,
  election_year integer NOT NULL,
  link_id uuid NOT NULL,
  filing_year integer NOT NULL,
  receiving_committee_id text NOT NULL,
  registration_guid text NOT NULL,
  support_total_cents bigint NOT NULL,
  oppose_total_cents bigint NOT NULL,
  group_count integer NOT NULL,
  expenditure_count integer NOT NULL,
  candidate_target_row_count integer NOT NULL,
  other_year_row_count integer NOT NULL,
  multi_target_row_count integer NOT NULL,
  multi_target_amount_cents bigint NOT NULL,
  source_row_count integer NOT NULL,
  source_url text NOT NULL,
  source_retrieved_at timestamptz NOT NULL,
  source_completed_at timestamptz NOT NULL,
  source_manifest_sha256 text NOT NULL,
  source_byte_size bigint NOT NULL,
  source_controls jsonb NOT NULL,
  last_synced_at timestamptz NOT NULL,
  CONSTRAINT ga_ie_source_pk PRIMARY KEY (candidate_id, election_id, election_year),
  CONSTRAINT ga_ie_source_link FOREIGN KEY (link_id, election_year)
    REFERENCES public.ga_candidate_finance_links(id, election_year) ON DELETE CASCADE,
  CONSTRAINT ga_ie_source_years CHECK
    (election_year BETWEEN 2026 AND 2100 AND filing_year BETWEEN 2026 AND 2100),
  CONSTRAINT ga_ie_source_identity CHECK
    (receiving_committee_id ~ '^[1-9][0-9]*$' AND btrim(registration_guid) <> ''),
  CONSTRAINT ga_ie_source_money CHECK
    (support_total_cents >= 0 AND oppose_total_cents >= 0
      AND support_total_cents + oppose_total_cents <= 9007199254740991
      AND multi_target_amount_cents BETWEEN 0 AND 9007199254740991),
  CONSTRAINT ga_ie_source_counts CHECK
    (group_count >= 0 AND expenditure_count >= 0 AND group_count <= expenditure_count
      AND other_year_row_count >= 0 AND multi_target_row_count >= 0 AND source_row_count > 0
      AND candidate_target_row_count >= 0 AND candidate_target_row_count <= source_row_count
      AND candidate_target_row_count::bigint = expenditure_count::bigint + other_year_row_count::bigint + multi_target_row_count::bigint
      AND (group_count = 0) = (expenditure_count = 0)
      AND (expenditure_count = 0) = (support_total_cents + oppose_total_cents = 0)
      AND (multi_target_row_count = 0) = (multi_target_amount_cents = 0)),
  CONSTRAINT ga_ie_source_facts CHECK
    (source_url = 'https://ethics.ga.gov/records-search-all/'
      AND source_manifest_sha256 ~ '^[a-f0-9]{64}$' AND source_byte_size > 0
      AND jsonb_typeof(source_controls) = 'array' AND jsonb_array_length(source_controls) BETWEEN 2 AND 64),
  CONSTRAINT ga_ie_source_times CHECK
    (source_retrieved_at <= source_completed_at AND source_completed_at <= last_synced_at)
);
CREATE INDEX ga_ie_source_link ON public.ga_reported_ie_sources (link_id, election_year);

CREATE TABLE public.ga_reported_ie_groups (
  candidate_id uuid NOT NULL,
  election_id uuid NOT NULL,
  election_year integer NOT NULL,
  reported_spender_id text NOT NULL,
  reported_spender_name text NOT NULL,
  support_oppose text NOT NULL,
  amount_cents bigint NOT NULL,
  expenditure_count integer NOT NULL,
  CONSTRAINT ga_ie_group_pk PRIMARY KEY
    (candidate_id, election_id, election_year, reported_spender_id, support_oppose),
  CONSTRAINT ga_ie_group_source FOREIGN KEY (candidate_id, election_id, election_year)
    REFERENCES public.ga_reported_ie_sources(candidate_id, election_id, election_year) ON DELETE CASCADE,
  CONSTRAINT ga_ie_group_names CHECK
    (btrim(reported_spender_id) <> '' AND btrim(reported_spender_name) <> ''),
  CONSTRAINT ga_ie_group_stance CHECK (support_oppose IN ('support', 'oppose')),
  CONSTRAINT ga_ie_group_money CHECK
    (amount_cents BETWEEN 1 AND 9007199254740991 AND expenditure_count > 0)
);

-- Attempts schedule unavailable/held components without changing money or
-- financial source clocks. No names, amounts, errors or candidate IDs.
CREATE TABLE public.ga_reported_finance_attempts (
  link_id uuid NOT NULL,
  election_year integer NOT NULL,
  last_attempted_at timestamptz NOT NULL,
  component_mask integer NOT NULL,
  CONSTRAINT ga_reported_attempt_pk PRIMARY KEY (link_id, election_year),
  CONSTRAINT ga_reported_attempt_link FOREIGN KEY (link_id, election_year)
    REFERENCES public.ga_candidate_finance_links(id, election_year) ON DELETE CASCADE,
  CONSTRAINT ga_reported_attempt_mask CHECK (component_mask IN (2, 4, 6))
);

COMMIT;
