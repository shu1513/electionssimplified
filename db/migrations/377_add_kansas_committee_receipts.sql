-- Named Kansas committee receipts stay unpublished behind a separate default-off flag.
BEGIN;
CREATE TABLE public.ks_candidate_finance_committee_sources (
 link_id uuid NOT NULL, election_year integer NOT NULL CHECK(election_year BETWEEN 2024 AND 2100),
 intent_sha256 text NOT NULL CHECK(intent_sha256 ~ '^[a-f0-9]{64}$'),
 source_url text NOT NULL CHECK(source_url = 'https://sos.ks.gov/elections/cfr_viewer/cfr_examiner_entry.aspx'),
 last_synced_at timestamptz NOT NULL, written_at timestamptz NOT NULL CHECK(written_at >= last_synced_at),
 total_cents bigint NOT NULL CHECK(total_cents BETWEEN 0 AND 9007199254740991),
 group_count integer NOT NULL CHECK(group_count >= 0), receipt_count integer NOT NULL CHECK(receipt_count >= group_count),
 controls jsonb NOT NULL CHECK(jsonb_typeof(controls) = 'object'),
 provenance jsonb NOT NULL CHECK(jsonb_typeof(provenance) = 'array' AND jsonb_array_length(provenance) > 0),
 PRIMARY KEY(link_id,election_year), FOREIGN KEY(link_id,election_year)
 REFERENCES public.ks_candidate_finance_links(id,election_year) ON DELETE CASCADE,
 CHECK((group_count = 0) = (total_cents = 0)), CHECK((group_count = 0) = (receipt_count = 0))
);
CREATE TABLE public.ks_candidate_finance_committee_receipts (
 link_id uuid NOT NULL, election_year integer NOT NULL,
 reported_name text NOT NULL CHECK(btrim(reported_name) <> ''), name_key text NOT NULL CHECK(btrim(name_key) <> ''),
 amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 1 AND 9007199254740991),
 receipt_count integer NOT NULL CHECK(receipt_count > 0),
 PRIMARY KEY(link_id,election_year,name_key), FOREIGN KEY(link_id,election_year)
 REFERENCES public.ks_candidate_finance_committee_sources(link_id,election_year) ON DELETE CASCADE
);
COMMIT;
