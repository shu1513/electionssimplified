-- Illinois calls its county legislature the "County Board". Its seats run as
-- "County Board Member #10", "Knox County Board District 1", "DeKalb County
-- Board Member - District 5 (2-year unexpired term)". The catalog office for
-- that job is County Supervisor, where 267 Illinois county board seats
-- already sit.
--
-- The matcher scored many of these titles into County Board of Review Member
-- instead (the property-tax appeals board): "county board member" shares
-- three of four words with it and one with County Supervisor. Runs between
-- 2026-08-15 and 2026-09-06 saved about 40 of those matches as learned
-- aliases, and every later title that hit one landed on the wrong office too.
-- The same scoring caught Virginia "Board of Supervisors" seats, New York
-- "Board of Legislators" seats, and one Kansas "County Hospital Board".
--
-- The matcher is fixed in code (a "County Board" title now folds to County
-- Supervisor, and only a title that says "review" can reach the Board of
-- Review). This migration cleans up what the old scoring left behind:
--   1. delete the wrong learned aliases, so they cannot be hit again;
--   2. move the county-legislature seats to County Supervisor;
--   3. clear office_id on anything else (the Kiowa hospital board has no
--      catalog office; manual:elections:repair-office-ids can refill it if
--      one is added).
--
-- manual:elections:repair-office-ids cannot do step 2: it only fills
-- office_id IS NULL, so a wrong-but-present office is invisible to it.
-- Every statement is scoped to the Board of Review office and to titles
-- without "review", so re-running is a no-op and a database that never
-- learned these rows is untouched.

BEGIN;

-- 1. Learned aliases pointing at the Board of Review whose text never says
-- "review". The seeded "county board of review" alias and any real
-- "... board of review ..." wording stay.
DELETE FROM public.office_title_aliases alias
USING public.offices review
WHERE review.scope = 'county'
  AND review.canonical_name = 'County Board of Review Member'
  AND alias.office_id = review.id
  AND alias.normalized_alias NOT LIKE '%review%';

-- 2. County-legislature seats. official_ballot_title_key is lowercase with
-- single spaces, so the phrase tests are exact.
UPDATE public.elections e
SET office_id = supervisor.id,
    updated_at = now()
FROM public.offices review,
     public.offices supervisor
WHERE review.scope = 'county'
  AND review.canonical_name = 'County Board of Review Member'
  AND supervisor.scope = 'county'
  AND supervisor.canonical_name = 'County Supervisor'
  AND e.office_id = review.id
  AND e.official_ballot_title_key NOT LIKE '%review%'
  AND (
    e.official_ballot_title_key ~ '\mcounty board\M'
    OR e.official_ballot_title_key ~ '\mboard of (supervisors|legislators)\M'
  )
  AND e.official_ballot_title_key !~ '\mcounty board of (education|health|elections|commissioners)\M';

-- 3. Whatever is left on the Board of Review without "review" in its title
-- is some other body the catalog does not carry. No office beats a wrong one.
UPDATE public.elections e
SET office_id = NULL,
    updated_at = now()
FROM public.offices review
WHERE review.scope = 'county'
  AND review.canonical_name = 'County Board of Review Member'
  AND e.office_id = review.id
  AND e.official_ballot_title_key NOT LIKE '%review%';

COMMIT;
