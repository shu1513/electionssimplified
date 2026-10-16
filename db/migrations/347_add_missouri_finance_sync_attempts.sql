-- Scheduling attempts are not successful financial source observations.
BEGIN;

CREATE TABLE public.mo_candidate_finance_sync_attempts (
  link_id uuid NOT NULL,
  election_year integer NOT NULL,
  last_attempted_at timestamptz NOT NULL,
  component_mask smallint NOT NULL,
  CONSTRAINT mo_finance_attempts_pk PRIMARY KEY (link_id, election_year),
  CONSTRAINT mo_finance_attempts_link_fk FOREIGN KEY (link_id, election_year)
    REFERENCES public.mo_candidate_finance_links(id, election_year)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT mo_finance_attempts_time CHECK (isfinite(last_attempted_at)),
  CONSTRAINT mo_finance_attempts_components CHECK (component_mask IN (2, 4, 6))
);

COMMIT;
