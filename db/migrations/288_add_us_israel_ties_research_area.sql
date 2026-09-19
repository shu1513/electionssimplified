-- Add the us_israel_ties research area ("U.S.-Israel Ties") and link it to the
-- four federal offices that set foreign policy: President, Vice President,
-- U.S. Senator and U.S. Representative, following migration 277's shape.
-- Why the area exists: federal votes on aid and weapons sales to Israel, laws
-- about boycotts of Israel, and privately sponsored trips to Israel had no
-- area that could carry an honest direction, so they were tagged `general`.
-- A record is "for" when the action keeps or makes the two countries closer
-- (a yes vote on aid or a weapons sale, accepting a sponsored trip) and
-- "against" when it loosens them (a vote to block a sale or cut aid). The tag
-- describes the action, not the person's view of Israel.
-- Deliberately NOT linked: state and local offices. State anti-boycott laws
-- can be linked later if those votes are imported.
--
-- The seed layer (db/seeds/research_areas_v1.sql +
-- db/seeds/office_research_areas_v1.sql) is updated in the same change and
-- remains authoritative for links; this migration applies the identical state
-- to already-seeded databases.

BEGIN;

INSERT INTO public.research_areas (slug, name, description)
VALUES (
  'us_israel_ties',
  'U.S.-Israel Ties',
  'Keep the United States closely tied to Israel through military and financial aid, weapons sales, laws that protect the relationship, and official and sponsored exchanges.'
)
ON CONFLICT (slug)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  updated_at = now();

-- Best-effort link copy for already-seeded databases; unresolved pairs are
-- expected on a fresh migrations-only database and must not raise (see 276).
DO $$
DECLARE
  expected_pair_count integer;
  inserted_or_existing_count integer;
BEGIN
  CREATE TEMP TABLE desired_us_israel_ties_offices (scope text, canonical_name text)
  ON COMMIT DROP;

  INSERT INTO desired_us_israel_ties_offices (scope, canonical_name) VALUES
    ('presidential', 'President of the United States'),
    ('presidential', 'Vice President of the United States'),
    ('statewide', 'United States Senator'),
    ('us_house', 'United States Representative');

  SELECT COUNT(*) INTO expected_pair_count FROM desired_us_israel_ties_offices;

  INSERT INTO public.office_research_areas (office_id, research_area_id)
  SELECT office.id, area.id
  FROM desired_us_israel_ties_offices desired
  JOIN public.offices office
    ON office.scope = desired.scope
   AND office.canonical_name = desired.canonical_name
  JOIN public.research_areas area
    ON area.slug = 'us_israel_ties'
  ON CONFLICT (office_id, research_area_id) DO NOTHING;

  SELECT COUNT(*)
  INTO inserted_or_existing_count
  FROM desired_us_israel_ties_offices desired
  JOIN public.offices office
    ON office.scope = desired.scope
   AND office.canonical_name = desired.canonical_name;

  IF inserted_or_existing_count <> expected_pair_count THEN
    RAISE NOTICE
      'migration 288: % of % us_israel_ties office links resolved; the rest are created by the seed layer (fresh install path)',
      inserted_or_existing_count,
      expected_pair_count;
  END IF;
END
$$;

COMMIT;
