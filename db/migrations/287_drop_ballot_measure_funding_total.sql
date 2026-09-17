BEGIN;

-- The page shows who the largest donors are, not how much a side raised.
-- States do not publish a total on the same date as their donor lists
-- (California's totals run weeks behind its top-10 lists), so a total next to
-- the donors mixed two dates. Dropping the column also drops its check
-- constraint (chk_ballot_measure_funding_total_raised).
--
-- A side with empty top_donors now means "researched, no donors reported".
ALTER TABLE public.ballot_measure_funding
    DROP COLUMN total_raised;

COMMIT;
