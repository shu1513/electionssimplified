-- Independent monetary committee component. Preserve signed period outflows;
-- these rows do not replace Raised, direct breakdowns or outside spending.
BEGIN;

CREATE TABLE public.md_candidate_finance_pac_donors (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT md_pac_donors_pk PRIMARY KEY,
  link_id uuid NOT NULL,
  election_year integer NOT NULL,
  donor_name text NOT NULL,
  donor_name_normalized text NOT NULL,
  reported_class_code text NOT NULL,
  amount numeric(16,2) NOT NULL,
  gross_amount numeric(16,2) NOT NULL,
  refund_amount numeric(16,2) NOT NULL,
  gift_count integer NOT NULL,
  refund_count integer NOT NULL,
  original_gift_kinds text[] NOT NULL,
  document_bound_cash_outflow_refund_count integer NOT NULL,
  source_url text NOT NULL,
  source_observed_at timestamptz NOT NULL,
  last_synced_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT md_pac_donors_link_fk FOREIGN KEY (link_id, election_year)
    REFERENCES public.md_candidate_finance_links(id, election_year) ON DELETE CASCADE,
  CONSTRAINT md_pac_donor_identity UNIQUE
    (link_id, election_year, reported_class_code, donor_name_normalized),
  CONSTRAINT md_pac_donor_year CHECK (election_year BETWEEN 2000 AND 2100),
  CONSTRAINT md_pac_donor_names CHECK
    (btrim(donor_name) <> '' AND btrim(donor_name_normalized) <> ''),
  CONSTRAINT md_pac_donor_class CHECK (reported_class_code IN
    ('TCC', 'TFED', 'TPAC', 'TPCC', 'TPCLB', 'TPOC', 'TRNFC', 'TUNFC', 'TSLATE')),
  CONSTRAINT md_pac_donor_amounts CHECK
    (gross_amount >= 0 AND refund_amount >= 0 AND amount = gross_amount - refund_amount),
  CONSTRAINT md_pac_donor_counts CHECK
    (gift_count >= 0 AND refund_count >= 0 AND gift_count::bigint + refund_count::bigint > 0
      AND (gift_count > 0) = (gross_amount > 0)
      AND (refund_count > 0) = (refund_amount > 0)),
  CONSTRAINT md_pac_donor_kinds CHECK
    (cardinality(original_gift_kinds) > 0 AND array_position(original_gift_kinds, NULL) IS NULL
      AND original_gift_kinds <@ ARRAY['CMONT', 'TRFR', 'CINKIND', 'OTHRINCM', 'ANYMS']::text[]),
  CONSTRAINT md_pac_donor_bound_refunds CHECK
    (document_bound_cash_outflow_refund_count >= 0
      AND document_bound_cash_outflow_refund_count <= refund_count),
  CONSTRAINT md_pac_donor_source CHECK (btrim(source_url) <> ''),
  CONSTRAINT md_pac_donor_times CHECK (source_observed_at <= last_synced_at)
);

CREATE INDEX md_pac_donors_link_amount
  ON public.md_candidate_finance_pac_donors (link_id, election_year, amount DESC);
CREATE TRIGGER md_pac_donors_updated_at BEFORE UPDATE
  ON public.md_candidate_finance_pac_donors FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE public.md_candidate_finance_pac_sources (
  link_id uuid NOT NULL,
  election_year integer NOT NULL,
  net_amount numeric(16,2) NOT NULL,
  gross_amount numeric(16,2) NOT NULL,
  refund_amount numeric(16,2) NOT NULL,
  position_count integer NOT NULL,
  source_observed_at timestamptz NOT NULL,
  inventory_observed_at timestamptz NOT NULL,
  provenance jsonb NOT NULL,
  last_synced_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT md_pac_sources_pk PRIMARY KEY (link_id, election_year),
  CONSTRAINT md_pac_sources_link_fk FOREIGN KEY (link_id, election_year)
    REFERENCES public.md_candidate_finance_links(id, election_year) ON DELETE CASCADE,
  CONSTRAINT md_pac_sources_year CHECK (election_year BETWEEN 2000 AND 2100),
  CONSTRAINT md_pac_sources_amounts CHECK
    (gross_amount >= 0 AND refund_amount >= 0 AND net_amount = gross_amount - refund_amount),
  CONSTRAINT md_pac_sources_positions CHECK (position_count >= 0),
  CONSTRAINT md_pac_sources_provenance CHECK
    (jsonb_typeof(provenance) = 'object'
      AND provenance ?& ARRAY['scope', 'version']
      AND provenance->>'scope' = 'reported_committee_monetary_positions'
      AND provenance->>'version' = '1'),
  CONSTRAINT md_pac_sources_times CHECK
    (source_observed_at <= inventory_observed_at AND inventory_observed_at <= last_synced_at)
);
CREATE TRIGGER md_pac_sources_updated_at BEFORE UPDATE
  ON public.md_candidate_finance_pac_sources FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
