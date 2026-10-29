-- Independently acquired, operator-reviewed single-target CF-8 IE reports.
-- Receiving finance is neither a prerequisite nor mutated by this component.
BEGIN;
CREATE TABLE public.ri_reported_ie_families (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL,
  election_id uuid NOT NULL,
  election_year integer NOT NULL CHECK (election_year BETWEEN 2000 AND 2100 AND election_year % 2 = 0),
  spender_key text NOT NULL CHECK (spender_key ~ '^[a-f0-9]{64}$'),
  spender_name text NOT NULL CHECK (length(btrim(spender_name)) BETWEEN 1 AND 500),
  candidate_name text NOT NULL CHECK (length(btrim(candidate_name)) BETWEEN 1 AND 500),
  office_scope text NOT NULL CHECK (office_scope IN ('statewide','state_upper','state_lower')),
  office_name text NOT NULL CHECK (length(btrim(office_name)) BETWEEN 1 AND 500),
  district text,
  observed_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  source_digest text NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  source_url text NOT NULL CHECK (source_url ~ '^https://(www[.]|secure[.])?ricampaignfinance[.]com/ReportsScanned/'),
  source_report_count integer NOT NULL CHECK (source_report_count BETWEEN 1 AND 100),
  ie_report_count integer NOT NULL CHECK (ie_report_count BETWEEN 1 AND 100),
  occurrence_count integer NOT NULL CHECK (occurrence_count BETWEEN 1 AND 100000),
  support_cents bigint NOT NULL CHECK (support_cents BETWEEN 0 AND 9007199254740991),
  oppose_cents bigint NOT NULL CHECK (oppose_cents BETWEEN 0 AND 9007199254740991),
  CONSTRAINT ri_ie_family_ce_fk FOREIGN KEY (candidate_id,election_id)
    REFERENCES public.candidate_elections(candidate_id,election_id) ON DELETE CASCADE,
  CONSTRAINT ri_ie_family_owner_uq UNIQUE (candidate_id,election_id,election_year,spender_key),
  CONSTRAINT ri_ie_family_controls_ck CHECK (ie_report_count <= source_report_count AND ie_report_count <= occurrence_count
    AND support_cents + oppose_cents BETWEEN 1 AND 9007199254740991 AND completed_at >= observed_at)
);
CREATE TABLE public.ri_reported_ie_reports (
  filing_guid uuid PRIMARY KEY,
  family_id uuid NOT NULL REFERENCES public.ri_reported_ie_families(id) ON DELETE CASCADE,
  filed_date date NOT NULL,
  source_url text NOT NULL CHECK (source_url ~ '^https://(www[.]|secure[.])?ricampaignfinance[.]com/ReportsScanned/'),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  reported_spender_name text NOT NULL CHECK (length(btrim(reported_spender_name)) BETWEEN 1 AND 500),
  reported_candidate_name text NOT NULL CHECK (length(btrim(reported_candidate_name)) BETWEEN 1 AND 500),
  stance text NOT NULL CHECK (stance IN ('support','oppose')),
  reported_ytd_cents bigint NOT NULL CHECK (reported_ytd_cents BETWEEN 1 AND 9007199254740991),
  occurrence_count integer NOT NULL CHECK (occurrence_count BETWEEN 1 AND 1000),
  report_cents bigint NOT NULL CHECK (report_cents BETWEEN 1 AND 9007199254740991)
);
CREATE INDEX ri_ie_report_family_idx ON public.ri_reported_ie_reports(family_id);
CREATE TABLE public.ri_reported_ie_lines (
  filing_guid uuid NOT NULL REFERENCES public.ri_reported_ie_reports(filing_guid) ON DELETE CASCADE,
  line_number integer NOT NULL CHECK (line_number BETWEEN 1 AND 10000),
  disbursement_date date NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (filing_guid,line_number)
);
COMMIT;
