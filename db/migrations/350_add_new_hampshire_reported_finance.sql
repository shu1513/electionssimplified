-- Independent observations must not refresh legacy campaign-receipt money.
-- Component keys keep receipt and IE acquisition, money and clocks separate.
BEGIN;

CREATE TABLE public.nh_reported_finance_components (
  link_id uuid NOT NULL,
  election_year integer NOT NULL,
  component text NOT NULL,
  candidate_id uuid NOT NULL REFERENCES public.candidates(id) ON DELETE CASCADE,
  election_id uuid NOT NULL REFERENCES public.elections(id) ON DELETE CASCADE,
  receiving_entity_id text NOT NULL,
  registration_guid uuid NOT NULL,
  total_amount_cents bigint NOT NULL,
  support_total_cents bigint NOT NULL,
  oppose_total_cents bigint NOT NULL,
  occurrence_count integer NOT NULL,
  group_count integer NOT NULL,
  source_row_count integer NOT NULL,
  current_row_count integer NOT NULL,
  historical_row_count integer NOT NULL,
  excluded_current_row_count integer NOT NULL,
  nonpositive_row_count integer NOT NULL,
  source_url text NOT NULL,
  source_base_retrieved_at timestamptz NOT NULL,
  source_retrieved_at timestamptz NOT NULL,
  source_completed_at timestamptz NOT NULL,
  source_manifest_sha256 text NOT NULL,
  source_byte_size bigint NOT NULL,
  source_controls jsonb NOT NULL,
  last_synced_at timestamptz NOT NULL,
  CONSTRAINT nh_reported_component_pk PRIMARY KEY (link_id, election_year, component),
  CONSTRAINT nh_reported_component_link FOREIGN KEY (link_id, election_year)
    REFERENCES public.nh_candidate_finance_links (id, election_year) ON DELETE CASCADE,
  CONSTRAINT nh_reported_component_scope CHECK
    (election_year BETWEEN 2016 AND 2100 AND component IN ('committee', 'ie')
      AND receiving_entity_id ~ '^[1-9][0-9]*$'
      AND registration_guid <> '00000000-0000-0000-0000-000000000000'::uuid),
  CONSTRAINT nh_reported_component_money CHECK
    (total_amount_cents BETWEEN 0 AND 9007199254740991
      AND support_total_cents >= 0 AND oppose_total_cents >= 0
      AND CASE component WHEN 'ie' THEN total_amount_cents = support_total_cents + oppose_total_cents
        ELSE support_total_cents = 0 AND oppose_total_cents = 0 END),
  CONSTRAINT nh_reported_component_counts CHECK
    (source_row_count >= 0 AND current_row_count >= 0 AND historical_row_count >= 0
      AND source_row_count::bigint = current_row_count::bigint + historical_row_count::bigint
      AND occurrence_count >= 0 AND group_count BETWEEN 0 AND occurrence_count
      AND excluded_current_row_count >= 0 AND nonpositive_row_count >= 0
      AND current_row_count::bigint = occurrence_count::bigint + excluded_current_row_count::bigint + nonpositive_row_count::bigint
      AND (group_count = 0) = (occurrence_count = 0)
      AND (occurrence_count = 0) = (total_amount_cents = 0)
      AND (component <> 'committee' OR nonpositive_row_count = 0)
      AND (component <> 'ie' OR source_row_count > 0)),
  CONSTRAINT nh_reported_component_source CHECK
    (source_url = 'https://cfs.sos.nh.gov/'
      AND source_manifest_sha256 ~ '^[a-f0-9]{64}$'
      AND source_byte_size BETWEEN 1 AND 268435456
      AND jsonb_typeof(source_controls) = 'array'
      AND jsonb_array_length(source_controls) BETWEEN 8 AND 800),
  CONSTRAINT nh_reported_component_clocks CHECK
    (source_base_retrieved_at <= source_retrieved_at
      AND source_retrieved_at <= source_completed_at AND source_completed_at <= last_synced_at)
);

CREATE TABLE public.nh_reported_finance_groups (
  link_id uuid NOT NULL,
  election_year integer NOT NULL,
  component text NOT NULL,
  reported_group_key text NOT NULL,
  reported_group_id text,
  reported_name text NOT NULL,
  support_oppose text NOT NULL,
  amount_cents bigint NOT NULL,
  occurrence_count integer NOT NULL,
  CONSTRAINT nh_reported_group_pk PRIMARY KEY
    (link_id, election_year, component, reported_group_key, support_oppose),
  CONSTRAINT nh_reported_group_component FOREIGN KEY (link_id, election_year, component)
    REFERENCES public.nh_reported_finance_components (link_id, election_year, component) ON DELETE CASCADE,
  CONSTRAINT nh_reported_group_role CHECK
    ((component = 'committee' AND support_oppose = 'direct' AND reported_group_id IS NULL)
      OR (component = 'ie' AND support_oppose IN ('support', 'oppose') AND reported_group_id IS NOT NULL
        AND reported_group_id ~ '^[1-9][0-9]*$')),
  CONSTRAINT nh_reported_group_name CHECK
    (btrim(reported_group_key) <> '' AND btrim(reported_name) <> ''),
  CONSTRAINT nh_reported_group_money CHECK
    (amount_cents BETWEEN 1 AND 9007199254740991 AND occurrence_count > 0)
);

-- Nonfinancial scheduling attempts rotate held/unavailable links without
-- recording personal data or changing any financial observation timestamp.
CREATE TABLE public.nh_reported_finance_attempts (
  link_id uuid NOT NULL,
  election_year integer NOT NULL,
  last_attempted_at timestamptz NOT NULL,
  component_mask integer NOT NULL,
  CONSTRAINT nh_reported_attempt_pk PRIMARY KEY (link_id, election_year),
  CONSTRAINT nh_reported_attempt_link FOREIGN KEY (link_id, election_year)
    REFERENCES public.nh_candidate_finance_links (id, election_year) ON DELETE CASCADE,
  CONSTRAINT nh_reported_attempt_mask CHECK (component_mask IN (2, 4, 6))
);

COMMIT;
