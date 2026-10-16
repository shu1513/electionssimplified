-- Reported registered-committee IE, independent of committee-cycle funders.
-- Stored once per candidate/election/year; link is protected qualification context.
BEGIN;
CREATE TABLE public.mo_candidate_finance_registered_ie_sources (
  candidate_id uuid NOT NULL REFERENCES public.candidates(id) ON DELETE CASCADE,
  election_id uuid NOT NULL REFERENCES public.elections(id) ON DELETE CASCADE,
  election_year integer NOT NULL,
  qualifying_link_id uuid NOT NULL,
  receiving_committee_id text NOT NULL,
  basis text NOT NULL DEFAULT 'reported_registered_committee_independent_expenditures',
  cycle_start date NOT NULL, cycle_end date NOT NULL,
  support_amount_cents bigint NOT NULL, oppose_amount_cents bigint NOT NULL,
  group_count integer NOT NULL, expenditure_count integer NOT NULL,
  source_year integer NOT NULL, source_row_count integer NOT NULL, source_page_count integer,
  candidate_name_row_count integer NOT NULL, candidate_office_mismatch_row_count integer NOT NULL,
  outside_cycle_row_count integer NOT NULL, matched_row_count integer NOT NULL,
  zero_amount_row_count integer NOT NULL, negative_amount_row_count integer NOT NULL,
  ambiguous_lineage_row_count integer NOT NULL, timely_overlap_row_count integer NOT NULL,
  source_url text NOT NULL, source_retrieved_at timestamptz NOT NULL,
  source_sha256 text NOT NULL, source_byte_size bigint NOT NULL,
  last_synced_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mo_rie_sources_pk PRIMARY KEY (candidate_id,election_id,election_year),
  CONSTRAINT mo_rie_sources_link_fk FOREIGN KEY (qualifying_link_id,election_year)
    REFERENCES public.mo_candidate_finance_links(id,election_year) ON DELETE CASCADE,
  CONSTRAINT mo_rie_sources_year CHECK
    (election_year BETWEEN 2024 AND 2100 AND source_year=election_year),
  CONSTRAINT mo_rie_sources_context CHECK
    (receiving_committee_id ~ '^[A-Z][0-9]{6}$'
      AND basis='reported_registered_committee_independent_expenditures'),
  CONSTRAINT mo_rie_sources_cycle CHECK
    (isfinite(cycle_start) AND isfinite(cycle_end) AND cycle_start<=cycle_end
      AND extract(year FROM cycle_end)=election_year),
  CONSTRAINT mo_rie_sources_amounts CHECK
    (support_amount_cents BETWEEN 0 AND 9007199254740991
      AND oppose_amount_cents BETWEEN 0 AND 9007199254740991
      AND support_amount_cents+oppose_amount_cents<=9007199254740991),
  CONSTRAINT mo_rie_sources_counts CHECK
    (group_count>=0 AND expenditure_count>=0 AND source_row_count>=0
      AND (source_page_count IS NULL OR (source_page_count>=0 AND (source_row_count=0 OR source_page_count>0)))
      AND candidate_name_row_count>=0 AND candidate_name_row_count<=source_row_count
      AND candidate_office_mismatch_row_count>=0 AND outside_cycle_row_count>=0
      AND matched_row_count>=0 AND zero_amount_row_count>=0
      AND negative_amount_row_count=0 AND ambiguous_lineage_row_count=0 AND timely_overlap_row_count=0
      AND candidate_office_mismatch_row_count::bigint+outside_cycle_row_count+matched_row_count=candidate_name_row_count
      AND zero_amount_row_count::bigint+expenditure_count=matched_row_count
      AND group_count<=expenditure_count
      AND (group_count=0)=(expenditure_count=0)
      AND (group_count=0)=(support_amount_cents+oppose_amount_cents=0)),
  CONSTRAINT mo_rie_sources_hash CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT mo_rie_sources_bytes CHECK (source_byte_size BETWEEN 1 AND 9007199254740991),
  CONSTRAINT mo_rie_sources_url CHECK
    (source_url ~* '^https://(www\.)?mec\.mo\.gov/MEC/Campaign_Finance/CF_SearchDirExp\.aspx$'),
  CONSTRAINT mo_rie_sources_times CHECK
    (isfinite(source_retrieved_at) AND isfinite(last_synced_at) AND source_retrieved_at<=last_synced_at)
);
CREATE TABLE public.mo_candidate_finance_registered_ie_groups (
  candidate_id uuid NOT NULL, election_id uuid NOT NULL, election_year integer NOT NULL,
  reported_committee_name text NOT NULL, reported_name_key text NOT NULL, support_oppose text NOT NULL,
  reported_committee_id text, amount_cents bigint NOT NULL, expenditure_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mo_rie_groups_pk PRIMARY KEY
    (candidate_id,election_id,election_year,reported_name_key,support_oppose),
  CONSTRAINT mo_rie_groups_source_fk FOREIGN KEY (candidate_id,election_id,election_year)
    REFERENCES public.mo_candidate_finance_registered_ie_sources(candidate_id,election_id,election_year) ON DELETE CASCADE,
  CONSTRAINT mo_rie_groups_names CHECK (btrim(reported_committee_name)<>'' AND btrim(reported_name_key)<>''),
  CONSTRAINT mo_rie_groups_stance CHECK (support_oppose IN ('support','oppose')),
  CONSTRAINT mo_rie_groups_optional_id CHECK
    (reported_committee_id IS NULL OR reported_committee_id ~ '^[A-Z][0-9]{6}$'),
  CONSTRAINT mo_rie_groups_amount CHECK (amount_cents BETWEEN 1 AND 9007199254740991),
  CONSTRAINT mo_rie_groups_count CHECK (expenditure_count>0)
);
CREATE INDEX mo_rie_groups_amount_idx ON public.mo_candidate_finance_registered_ie_groups
  (candidate_id,election_id,election_year,amount_cents DESC);
CREATE TRIGGER mo_rie_sources_updated BEFORE UPDATE ON public.mo_candidate_finance_registered_ie_sources
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER mo_rie_groups_updated BEFORE UPDATE ON public.mo_candidate_finance_registered_ie_groups
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
COMMIT;
