-- Retry held work after source qualification changes, retaining ordinary caps.
BEGIN;
ALTER TABLE public.mt_reported_committee_attempts
  ADD COLUMN source_revision text NOT NULL DEFAULT '';
COMMIT;
