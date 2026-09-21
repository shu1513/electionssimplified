-- Link the existing `immigration` research area to state legislators,
-- Governor and Lieutenant Governor, following migration 159's principle
-- (keep an area where the office's formal powers move outcomes in it):
--   * State Senator / State Lower Chamber Legislator: state legislatures
--     write the immigration statutes voters meet directly — 287(g) and
--     detainer cooperation mandates, sanctuary bans, E-Verify rules,
--     in-state tuition and driver's licenses for undocumented residents.
--   * Governor: signs or vetoes those bills and directs state cooperation
--     with federal enforcement (National Guard deployments, agency orders).
--   * Lieutenant Governor: curated TO the broad state-legislator set by
--     design (migration 159), so it follows the chambers.
--
-- The area was previously federal-plus-Sheriff only, so the state-level
-- record base already carried immigration tags the office set did not
-- allow: on 2026-09-21 the local database held ~5,000 `immigration` tags on
-- roll-call records of Nov-2026 state legislative candidates (Maryland,
-- California, Tennessee, Illinois, Oregon, ...). The ballot view hides a tag
-- whose area is outside the office's allowed set (ballotLookup.ts), so those
-- votes were invisible to voters, and the manual records writer had to file
-- ICE and immigration items under civil_rights. This link makes both right.
--
-- The seed layer (db/seeds/office_research_areas_v1.sql) is updated in the
-- same change and remains authoritative for links; this migration applies the
-- identical state to already-seeded databases. Shape follows migration 276.

BEGIN;

-- Best-effort link copy for already-seeded databases. On a fresh
-- migrations-only database these offices do not exist yet (offices are
-- created by elections:offices:seed, which DB_DEPLOYMENT.md runs AFTER
-- db:migrate), so unresolved pairs are expected there and must not raise —
-- an exception would brick every fresh install before the seeds could run.
DO $$
DECLARE
  expected_pair_count integer;
  inserted_or_existing_count integer;
BEGIN
  CREATE TEMP TABLE desired_immigration_offices (scope text, canonical_name text)
  ON COMMIT DROP;

  INSERT INTO desired_immigration_offices (scope, canonical_name) VALUES
    ('statewide', 'Governor'),
    ('statewide', 'Lieutenant Governor'),
    ('state_upper', 'State Senator'),
    ('state_lower', 'State Lower Chamber Legislator');

  SELECT COUNT(*) INTO expected_pair_count FROM desired_immigration_offices;

  INSERT INTO public.office_research_areas (office_id, research_area_id)
  SELECT office.id, area.id
  FROM desired_immigration_offices desired
  JOIN public.offices office
    ON office.scope = desired.scope
   AND office.canonical_name = desired.canonical_name
  JOIN public.research_areas area
    ON area.slug = 'immigration'
  ON CONFLICT (office_id, research_area_id) DO NOTHING;

  SELECT COUNT(*)
  INTO inserted_or_existing_count
  FROM desired_immigration_offices desired
  JOIN public.offices office
    ON office.scope = desired.scope
   AND office.canonical_name = desired.canonical_name
  JOIN public.research_areas area
    ON area.slug = 'immigration';

  IF inserted_or_existing_count <> expected_pair_count THEN
    RAISE NOTICE
      'migration 294: % of % immigration office links resolved; the rest are created by the seed layer (fresh install path)',
      inserted_or_existing_count,
      expected_pair_count;
  END IF;
END
$$;

COMMIT;
