-- Legacy contribution-only syncs wrote outside zeros without outside coverage.
-- Keep nonzero totals and summaries with stored outside groups unchanged.
-- Separate from applied migration 331 so existing installations receive the fix.
BEGIN;

UPDATE public.or_candidate_finance_summaries AS summary
SET outside_support_total = CASE
      WHEN outside_support_total = 0 THEN NULL ELSE outside_support_total END,
    outside_oppose_total = CASE
      WHEN outside_oppose_total = 0 THEN NULL ELSE outside_oppose_total END
WHERE (outside_support_total = 0 OR outside_oppose_total = 0)
  AND NOT EXISTS (
    SELECT 1 FROM public.or_candidate_finance_outside_groups AS outside_group
    WHERE outside_group.link_id = summary.link_id
      AND outside_group.election_year = summary.election_year
  );

COMMIT;
