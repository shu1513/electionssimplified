-- Gross itemized Monetary receipts reported in Contributor-Committee.
-- May include loans; does not subtract separately reported returns or assert legal PAC identity.
BEGIN;

CREATE TABLE public.mo_candidate_finance_committee_receipt_sources (
  link_id uuid NOT NULL,
  election_year integer NOT NULL,
  receiving_committee_id text NOT NULL,
  cycle_start date NOT NULL,
  cycle_end date NOT NULL,
  total_amount_cents bigint NOT NULL,
  group_count integer NOT NULL,
  receipt_count integer NOT NULL,
  source_row_count integer NOT NULL,
  in_cycle_row_count integer NOT NULL,
  outside_cycle_row_count integer NOT NULL,
  canonical_row_count integer NOT NULL,
  matched_committee_row_count integer NOT NULL,
  excluded_noncommittee_row_count integer NOT NULL,
  in_kind_row_count integer NOT NULL,
  zero_monetary_row_count integer NOT NULL,
  source_url text NOT NULL,
  source_retrieved_at timestamptz NOT NULL,
  source_sha256 text NOT NULL,
  source_byte_size bigint NOT NULL,
  report_inventory_sha256 text NOT NULL,
  last_synced_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mo_cm_sources_pk PRIMARY KEY (link_id, election_year),
  CONSTRAINT mo_cm_sources_link_fk FOREIGN KEY (link_id, election_year)
    REFERENCES public.mo_candidate_finance_links(id, election_year) ON DELETE CASCADE,
  CONSTRAINT mo_cm_sources_year CHECK (election_year BETWEEN 2024 AND 2100),
  CONSTRAINT mo_cm_sources_receiver CHECK (receiving_committee_id ~ '^[A-Z][0-9]{6}$'),
  CONSTRAINT mo_cm_sources_cycle CHECK
    (isfinite(cycle_start) AND isfinite(cycle_end) AND cycle_start <= cycle_end
      AND extract(year FROM cycle_end) = election_year),
  CONSTRAINT mo_cm_sources_amount CHECK (total_amount_cents BETWEEN 0 AND 9007199254740991),
  CONSTRAINT mo_cm_sources_counts CHECK
    (group_count >= 0 AND receipt_count >= 0 AND source_row_count >= 0
      AND in_cycle_row_count >= 0 AND outside_cycle_row_count >= 0
      AND canonical_row_count >= 0 AND matched_committee_row_count >= 0
      AND excluded_noncommittee_row_count >= 0 AND in_kind_row_count >= 0
      AND zero_monetary_row_count >= 0
      AND in_cycle_row_count::bigint + outside_cycle_row_count = source_row_count
      AND canonical_row_count <= in_cycle_row_count
      AND matched_committee_row_count::bigint + excluded_noncommittee_row_count = canonical_row_count
      AND in_kind_row_count::bigint + zero_monetary_row_count + receipt_count = matched_committee_row_count
      AND group_count <= receipt_count
      AND (group_count = 0) = (receipt_count = 0)
      AND (group_count = 0) = (total_amount_cents = 0)),
  CONSTRAINT mo_cm_sources_hashes CHECK
    (source_sha256 ~ '^[a-f0-9]{64}$' AND report_inventory_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT mo_cm_sources_bytes CHECK (source_byte_size BETWEEN 1 AND 9007199254740991),
  CONSTRAINT mo_cm_sources_url CHECK (btrim(source_url) <> ''),
  CONSTRAINT mo_cm_sources_times CHECK
    (isfinite(source_retrieved_at) AND isfinite(last_synced_at) AND source_retrieved_at <= last_synced_at)
);

CREATE TABLE public.mo_candidate_finance_committee_receipts (
  link_id uuid NOT NULL,
  election_year integer NOT NULL,
  reported_committee_name text NOT NULL,
  reported_name_key text NOT NULL,
  amount_cents bigint NOT NULL,
  receipt_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mo_cm_receipts_pk PRIMARY KEY (link_id, election_year, reported_name_key),
  CONSTRAINT mo_cm_receipts_source_fk FOREIGN KEY (link_id, election_year)
    REFERENCES public.mo_candidate_finance_committee_receipt_sources(link_id, election_year) ON DELETE CASCADE,
  CONSTRAINT mo_cm_receipts_names CHECK
    (btrim(reported_committee_name) <> '' AND btrim(reported_name_key) <> ''),
  CONSTRAINT mo_cm_receipts_amount CHECK (amount_cents BETWEEN 1 AND 9007199254740991),
  CONSTRAINT mo_cm_receipts_count CHECK (receipt_count > 0)
);

CREATE INDEX mo_cm_receipts_amount_idx
  ON public.mo_candidate_finance_committee_receipts(link_id, election_year, amount_cents DESC);
CREATE TRIGGER mo_cm_sources_updated BEFORE UPDATE
  ON public.mo_candidate_finance_committee_receipt_sources
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER mo_cm_receipts_updated BEFORE UPDATE
  ON public.mo_candidate_finance_committee_receipts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
