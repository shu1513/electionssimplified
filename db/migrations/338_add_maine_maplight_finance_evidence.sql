-- Dated MapLight itemized source scopes; these do not replace CFIS direct summaries.
BEGIN;
CREATE TABLE public.me_candidate_finance_source_markers (
  link_id uuid NOT NULL,
  election_year integer NOT NULL,
  component text NOT NULL CHECK (component IN ('committee_donors', 'independent_expenditures')),
  source_calendar_year integer NOT NULL CHECK (source_calendar_year BETWEEN 2000 AND 2100),
  period_start date NOT NULL,
  period_end date NOT NULL,
  observed_at timestamptz NOT NULL,
  capture_digest text NOT NULL CHECK (capture_digest ~ '^[0-9a-f]{64}$'),
  source_url text NOT NULL CHECK (btrim(source_url) <> ''),
  source_filer_id text NOT NULL CHECK (source_filer_id ~ '^f_[a-z0-9]{26}$'),
  source_filer_name text NOT NULL CHECK (btrim(source_filer_name) <> ''),
  source_office text NOT NULL CHECK (source_office IN ('Senator', 'Representative', 'Governor')),
  source_district text,
  election_date date NOT NULL,
  published_source_times jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (link_id, election_year, component, source_calendar_year),
  FOREIGN KEY (link_id, election_year) REFERENCES public.me_candidate_finance_links(id, election_year)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CHECK (source_calendar_year BETWEEN election_year - 1 AND election_year),
  CHECK (period_start <= period_end AND extract(year FROM period_start) = source_calendar_year
    AND extract(year FROM period_end) = source_calendar_year),
  CHECK (extract(year FROM election_date) = election_year),
  CHECK (published_source_times IS NULL OR jsonb_typeof(published_source_times) = 'object')
);

CREATE TABLE public.me_candidate_finance_pac_donors (
  link_id uuid NOT NULL,
  election_year integer NOT NULL,
  component text NOT NULL DEFAULT 'committee_donors' CHECK (component = 'committee_donors'),
  source_calendar_year integer NOT NULL,
  committee_id text NOT NULL CHECK (committee_id LIKE 'reported:%' AND length(committee_id) > 9),
  committee_name text NOT NULL CHECK (btrim(committee_name) <> ''),
  source_reported_class text NOT NULL CHECK (source_reported_class IN ('political_action_committee', 'political_party_committee')),
  amount numeric(16,2) NOT NULL CHECK (amount <> 'NaN'::numeric
    AND amount BETWEEN -90071992547409.91 AND 90071992547409.91),
  contribution_count integer NOT NULL CHECK (contribution_count >= 0),
  gift_transaction_ids jsonb NOT NULL CHECK (jsonb_typeof(gift_transaction_ids) = 'array'),
  returned_transaction_ids jsonb NOT NULL CHECK (jsonb_typeof(returned_transaction_ids) = 'array'),
  source_url text NOT NULL CHECK (btrim(source_url) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (link_id, election_year, source_calendar_year, committee_id),
  FOREIGN KEY (link_id, election_year, component, source_calendar_year)
    REFERENCES public.me_candidate_finance_source_markers(link_id, election_year, component, source_calendar_year)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CHECK (jsonb_array_length(gift_transaction_ids) >= contribution_count),
  CHECK (jsonb_array_length(gift_transaction_ids) + jsonb_array_length(returned_transaction_ids) > 0)
);
CREATE INDEX me_maplight_donors_lookup_idx ON public.me_candidate_finance_pac_donors(link_id, election_year, source_calendar_year);

CREATE TABLE public.me_candidate_finance_maplight_allocations (
  link_id uuid NOT NULL,
  election_year integer NOT NULL,
  component text NOT NULL DEFAULT 'independent_expenditures' CHECK (component = 'independent_expenditures'),
  source_calendar_year integer NOT NULL,
  transaction_id text NOT NULL CHECK (transaction_id ~ '^a_[a-z0-9]{26}$'),
  target_filer_id text NOT NULL CHECK (target_filer_id ~ '^f_[a-z0-9]{26}$'),
  target_name text NOT NULL CHECK (btrim(target_name) <> ''),
  payer_id text NOT NULL CHECK (payer_id ~ '^f_[a-z0-9]{26}$'),
  payer_name text NOT NULL CHECK (btrim(payer_name) <> ''),
  support_oppose text NOT NULL CHECK (support_oppose IN ('support', 'oppose')),
  transaction_date date NOT NULL,
  amount numeric(16,2) NOT NULL CHECK (amount <> 'NaN'::numeric AND amount > 0 AND amount <= 90071992547409.91),
  whole_amount numeric(16,2) NOT NULL CHECK (whole_amount <> 'NaN'::numeric AND whole_amount >= amount AND whole_amount <= 90071992547409.91),
  source_url text NOT NULL CHECK (btrim(source_url) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (link_id, election_year, source_calendar_year, transaction_id, target_filer_id, support_oppose),
  FOREIGN KEY (link_id, election_year, component, source_calendar_year)
    REFERENCES public.me_candidate_finance_source_markers(link_id, election_year, component, source_calendar_year)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CHECK (extract(year FROM transaction_date) = source_calendar_year)
);
CREATE INDEX me_maplight_allocations_lookup_idx ON public.me_candidate_finance_maplight_allocations(link_id, election_year, payer_id, support_oppose);
COMMIT;
