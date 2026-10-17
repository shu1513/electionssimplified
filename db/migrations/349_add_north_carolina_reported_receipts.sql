-- Independent NC reported committee/party receipts. The five legacy finance
-- tables retain their money and clocks when this component is held or absent.
BEGIN;

CREATE TABLE public.nc_reported_receipt_sources (
  link_id uuid NOT NULL,
  election_year integer NOT NULL,
  receiving_committee_id text NOT NULL,
  positive_gross_cents bigint NOT NULL,
  positive_occurrence_count integer NOT NULL,
  group_count integer NOT NULL,
  source_report_count integer NOT NULL,
  source_receipt_occurrence_count integer NOT NULL,
  source_generation uuid NOT NULL,
  source_retrieved_at timestamptz NOT NULL,
  source_completed_at timestamptz NOT NULL,
  source_manifest_sha256 text NOT NULL,
  source_byte_size bigint NOT NULL,
  source_facts jsonb NOT NULL,
  aggregation_controls jsonb NOT NULL,
  last_synced_at timestamptz NOT NULL,
  CONSTRAINT nc_rr_source_pk PRIMARY KEY (link_id, election_year),
  CONSTRAINT nc_rr_source_link FOREIGN KEY (link_id, election_year)
    REFERENCES public.nc_candidate_finance_links(id, election_year) ON DELETE CASCADE,
  CONSTRAINT nc_rr_source_year CHECK (election_year BETWEEN 2000 AND 2100),
  CONSTRAINT nc_rr_source_receiver CHECK
    (receiving_committee_id ~ '^([A-Z]{3}|[0-9]{3})-[A-Z0-9]{6}-C-[0-9]{3}$'),
  CONSTRAINT nc_rr_source_money CHECK
    (positive_gross_cents BETWEEN 0 AND 9007199254740991),
  CONSTRAINT nc_rr_source_counts CHECK
    (source_report_count > 0 AND source_receipt_occurrence_count >= 0
      AND positive_occurrence_count >= 0 AND group_count >= 0
      AND positive_occurrence_count <= source_receipt_occurrence_count
      AND group_count <= positive_occurrence_count
      AND (group_count = 0) = (positive_occurrence_count = 0)
      AND (positive_occurrence_count = 0) = (positive_gross_cents = 0)),
  CONSTRAINT nc_rr_source_originals CHECK
    (source_manifest_sha256 ~ '^[a-f0-9]{64}$'
      AND source_byte_size BETWEEN 1 AND 268435456
      AND jsonb_typeof(source_facts) = 'object'
      AND source_facts ? 'sourceControls'
      AND source_facts ? 'sourceUrl'
      AND jsonb_typeof(source_facts->'sourceControls') = 'array'
      AND jsonb_array_length(source_facts->'sourceControls') BETWEEN 6 AND 1000
      AND (source_facts->>'sourceUrl' = 'https://cf.ncsbe.gov/CFOrgLkup/') IS TRUE),
  CONSTRAINT nc_rr_source_scope CHECK
    (jsonb_typeof(aggregation_controls) = 'object'
      AND aggregation_controls ? 'status'
      AND aggregation_controls ? 'metric'
      AND (aggregation_controls->>'status' = 'qualified') IS TRUE
      AND (aggregation_controls->>'metric' =
        'reported_itemized_committee_monetary_receipts_before_returns') IS TRUE),
  CONSTRAINT nc_rr_source_times CHECK
    (source_retrieved_at <= source_completed_at AND source_completed_at <= last_synced_at)
);

CREATE TABLE public.nc_reported_receipt_groups (
  link_id uuid NOT NULL,
  election_year integer NOT NULL,
  reported_class text NOT NULL,
  reported_name text NOT NULL,
  reported_name_key text NOT NULL,
  positive_gross_cents bigint NOT NULL,
  positive_occurrence_count integer NOT NULL,
  CONSTRAINT nc_rr_group_pk PRIMARY KEY
    (link_id, election_year, reported_class, reported_name_key),
  CONSTRAINT nc_rr_group_source FOREIGN KEY (link_id, election_year)
    REFERENCES public.nc_reported_receipt_sources(link_id, election_year) ON DELETE CASCADE,
  CONSTRAINT nc_rr_group_role CHECK (reported_class IN ('CPCM', 'PPTY')),
  CONSTRAINT nc_rr_group_names CHECK
    (btrim(reported_name) <> '' AND btrim(reported_name_key) <> ''),
  CONSTRAINT nc_rr_group_money CHECK
    (positive_gross_cents BETWEEN 1 AND 9007199254740991
      AND positive_occurrence_count > 0)
);

-- Nonfinancial attempts rotate held sources without changing financial dates.
CREATE TABLE public.nc_reported_receipt_attempts (
  link_id uuid NOT NULL,
  election_year integer NOT NULL,
  last_attempted_at timestamptz NOT NULL,
  receiving_committee_id text NOT NULL,
  source_manifest_sha256 text,
  CONSTRAINT nc_rr_attempt_pk PRIMARY KEY (link_id, election_year),
  CONSTRAINT nc_rr_attempt_link FOREIGN KEY (link_id, election_year)
    REFERENCES public.nc_candidate_finance_links(id, election_year) ON DELETE CASCADE,
  CONSTRAINT nc_rr_attempt_receiver CHECK (btrim(receiving_committee_id) <> ''),
  CONSTRAINT nc_rr_attempt_revision CHECK
    (source_manifest_sha256 IS NULL OR source_manifest_sha256 ~ '^[a-f0-9]{64}$')
);

COMMIT;
