-- A Texas District Clerk keeps the records of the county's district courts.
-- It is a separate elected office from the County Clerk, and most Texas
-- counties put both on the same ballot. The catalog already has the right
-- office for it: county-scope "Clerk of Court".
--
-- No alias ever said so. "<X> County District Clerk" reduces to the matcher
-- key "county district clerk", which fuzzy-scored onto County Clerk, and a run
-- on 2026-08-14 stored that as a learned alias. Every later Texas District
-- Clerk title then hit the alias exactly, so about 120 upcoming contests show
-- voters the County Clerk's duties (marriage licenses, running elections)
-- instead of the court clerk's. The bare title "District Clerk" had the
-- opposite problem: it scored 0.5 against both clerk offices, matched neither,
-- and left office_id NULL.
--
-- This migration moves the learned alias to Clerk of Court, adds the bare
-- alias, and rehomes the existing Texas shells. The alias MOVE is required:
-- seedOffices.ts now seeds both aliases under Clerk of Court and refuses to
-- remap an alias whose stored office disagrees with the seed source.
--
-- Combined offices are left alone. Small Texas counties elect one "County and
-- District Clerk" (also written "County & District Clerk", "District and
-- County Clerk", or "County Clerk/District Clerk"). That person is the county
-- clerk too, so County Clerk stays a fair home for those titles.

BEGIN;

-- Migration 087's trigger blocks moving an alias between offices, so a silent
-- re-point cannot rehome elections by accident. This move is deliberate, so
-- the guard is suspended for this one scoped statement and restored before
-- COMMIT (same pattern as migration 225).
ALTER TABLE public.office_title_aliases
  DISABLE TRIGGER trg_prevent_office_title_alias_reassignment;

-- Scoped to the mis-pointed row, so re-running is a no-op and a database that
-- never learned the alias is untouched.
UPDATE public.office_title_aliases alias
SET office_id = clerk_of_court.id,
    updated_at = now()
FROM public.offices clerk_of_court,
     public.offices county_clerk
WHERE clerk_of_court.scope = 'county'
  AND clerk_of_court.canonical_name = 'Clerk of Court'
  AND county_clerk.scope = 'county'
  AND county_clerk.canonical_name = 'County Clerk'
  AND alias.scope = 'county'
  AND alias.normalized_alias = 'county district clerk'
  AND alias.office_id = county_clerk.id;

ALTER TABLE public.office_title_aliases
  ENABLE TRIGGER trg_prevent_office_title_alias_reassignment;

-- Fail the migration rather than commit a database without the guard.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'public.office_title_aliases'::regclass
      AND tgname = 'trg_prevent_office_title_alias_reassignment'
      AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION
      'migration 285 would leave trg_prevent_office_title_alias_reassignment disabled';
  END IF;
END
$$;

-- "District Clerk" is the bare ballot title. "County District Clerk" is what
-- "<X> County District Clerk" becomes after the jurisdiction strip; it is
-- inserted here for databases that never learned it.
INSERT INTO public.office_title_aliases (office_id, scope, alias_text, normalized_alias)
SELECT o.id, 'county', v.alias_text, v.normalized_alias
FROM public.offices o,
     (VALUES
        ('District Clerk', 'district clerk'),
        ('County District Clerk', 'county district clerk')
     ) AS v(alias_text, normalized_alias)
WHERE o.scope = 'county'
  AND o.canonical_name = 'Clerk of Court'
ON CONFLICT (scope, normalized_alias) DO NOTHING;

-- Rehome the Texas county shells. manual:elections:repair-office-ids cannot do
-- this: it only fills office_id IS NULL, so a wrong-but-present office is
-- invisible to it. official_ballot_title_key is lowercase with single spaces,
-- so the phrase tests are exact. The two NOT LIKE lines keep every combined
-- County-and-District-Clerk wording on County Clerk. The key drops "&" and
-- "/", so "County & District Clerk" and "<X> County/District Clerk" look like
-- a plain District Clerk there; the raw-title test keeps those combined
-- offices on County Clerk too. The NULL branch picks up the bare "District
-- Clerk" shells that matched nothing.
UPDATE public.elections e
SET office_id = clerk_of_court.id,
    updated_at = now()
FROM public.districts d,
     public.offices clerk_of_court,
     public.offices county_clerk
WHERE d.id = e.district_id
  AND d.state = 'TX'
  AND d.district_type = 'county'
  AND clerk_of_court.scope = 'county'
  AND clerk_of_court.canonical_name = 'Clerk of Court'
  AND county_clerk.scope = 'county'
  AND county_clerk.canonical_name = 'County Clerk'
  AND (e.office_id = county_clerk.id OR e.office_id IS NULL)
  AND e.official_ballot_title_key LIKE '%district clerk%'
  AND e.official_ballot_title_key NOT LIKE '%county clerk%'
  AND e.official_ballot_title_key NOT LIKE '%and district clerk%'
  AND e.official_ballot_title !~ '[&/]';

COMMIT;
