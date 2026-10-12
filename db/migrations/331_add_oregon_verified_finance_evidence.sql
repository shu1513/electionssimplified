-- Named registered PAC gifts and scoped positive outside allocation authority.
-- Complete outside headline coverage is not inferred from these payer proofs.
BEGIN;

ALTER TABLE public.or_candidate_finance_summaries
  ADD COLUMN pac_source_provenance jsonb;

ALTER TABLE public.or_candidate_finance_summaries
  ADD CONSTRAINT or_finance_pac_provenance_check CHECK (
    pac_source_provenance IS NULL OR (
      jsonb_typeof(pac_source_provenance) = 'object'
      AND coalesce(pac_source_provenance -> 'version' = '1'::jsonb, false)
      AND coalesce(pac_source_provenance ->> 'scope' = 'current_named_registered_pac_cash', false)
    )
  );

CREATE TABLE public.or_candidate_finance_pac_donors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id uuid NOT NULL,
  election_year integer NOT NULL,
  committee_id text NOT NULL,
  committee_name text NOT NULL,
  committee_type text NOT NULL,
  amount numeric(16,2) NOT NULL,
  contribution_count integer NOT NULL,
  source_url text NOT NULL,
  last_synced_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT or_finance_pac_donors_unique
    UNIQUE (link_id, election_year, committee_id),
  CONSTRAINT or_finance_pac_donors_link_year_fk
    FOREIGN KEY (link_id, election_year)
    REFERENCES public.or_candidate_finance_links(id, election_year)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT or_finance_pac_donors_year_check
    CHECK (election_year BETWEEN 2000 AND 2100),
  CONSTRAINT or_finance_pac_donors_id_check CHECK (
    CASE WHEN committee_id ~ '^[1-9][0-9]{0,15}$'
      THEN committee_id::numeric <= 9007199254740991 ELSE false END
  ),
  CONSTRAINT or_finance_pac_donors_name_check CHECK (btrim(committee_name) <> ''),
  CONSTRAINT or_finance_pac_donors_type_check CHECK (committee_type = 'Political Action Committee'),
  CONSTRAINT or_finance_pac_donors_amount_check CHECK (amount > 0 AND amount < 'Infinity'::numeric),
  CONSTRAINT or_finance_pac_donors_count_check CHECK (contribution_count > 0),
  CONSTRAINT or_finance_pac_donors_source_url_check CHECK (btrim(source_url) <> '')
);

CREATE INDEX or_finance_pac_donors_lookup_idx
  ON public.or_candidate_finance_pac_donors (link_id, election_year, amount DESC);

CREATE TRIGGER or_finance_pac_donors_set_updated_at
BEFORE UPDATE ON public.or_candidate_finance_pac_donors
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE public.or_candidate_finance_outside_source_proofs (
  link_id uuid NOT NULL,
  election_year integer NOT NULL,
  payer_committee_id text NOT NULL,
  source_provenance jsonb NOT NULL,
  last_synced_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT or_finance_outside_proofs_pk
    PRIMARY KEY (link_id, election_year, payer_committee_id),
  CONSTRAINT or_finance_outside_proofs_link_year_fk
    FOREIGN KEY (link_id, election_year)
    REFERENCES public.or_candidate_finance_links(id, election_year)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT or_finance_outside_proofs_year_check CHECK (election_year BETWEEN 2000 AND 2100),
  CONSTRAINT or_finance_outside_proofs_payer_check CHECK (
    CASE WHEN payer_committee_id ~ '^[1-9][0-9]{0,15}$'
      THEN payer_committee_id::numeric <= 9007199254740991 ELSE false END
  ),
  CONSTRAINT or_finance_outside_proofs_provenance_check CHECK (
    jsonb_typeof(source_provenance) = 'object'
    AND coalesce(source_provenance -> 'version' = '1'::jsonb, false)
    AND coalesce(source_provenance ->> 'scope' = 'current_original_cash_ie_allocations', false)
    AND coalesce(source_provenance #>> '{payer,committeeId}' = payer_committee_id, false)
  )
);

CREATE TRIGGER or_finance_outside_proofs_set_updated_at
BEFORE UPDATE ON public.or_candidate_finance_outside_source_proofs
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
