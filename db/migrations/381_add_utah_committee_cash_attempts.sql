-- Last committee-cash attempt per link, so held candidates rotate instead of
-- blocking the due queue. Successful syncs are still tracked by pac_sources.
BEGIN;
CREATE TABLE IF NOT EXISTS public.ut_candidate_finance_pac_attempts (
  link_id uuid NOT NULL, election_year integer NOT NULL,
  attempted_at timestamptz NOT NULL,
  hold_code text CHECK (hold_code ~ '^[a-z_]+$'),
  PRIMARY KEY (link_id, election_year),
  FOREIGN KEY (link_id, election_year) REFERENCES public.ut_candidate_finance_links(id, election_year) ON DELETE CASCADE
);
COMMIT;
