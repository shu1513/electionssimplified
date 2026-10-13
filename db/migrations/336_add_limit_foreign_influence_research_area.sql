-- Add Limit Foreign Influence to offices that write or enforce these limits.
-- Stance measures the recorded action: for advances a limit or disclosure
-- requirement; against weakens or rejects it. Existing tags are unchanged.
-- Candidate tags are reviewed and applied separately to the local database.
BEGIN;

INSERT INTO public.research_areas (slug, name, description)
VALUES (
  'limit_foreign_influence',
  'Limit Foreign Influence',
  'Limit foreign influence through political money, lobbying, land ownership, university funding, and access to sensitive data and technology. Excludes foreign aid, arms sales, sanctions, trade, war powers, and records about Israel.'
)
ON CONFLICT (slug)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  updated_at = now();

-- Best-effort link copy for already-seeded databases. On a fresh
-- migrations-only database most of these offices do not exist yet (offices
-- are created by elections:offices:seed, which DB_DEPLOYMENT.md runs AFTER
-- db:migrate), so unresolved pairs are expected there and must not raise —
-- an exception would brick every fresh install before the seeds could run.
-- The seed layer produces the complete link set either way; the NOTICE keeps
-- partial resolution visible on live databases.
DO $$
DECLARE
  expected_pair_count integer;
  inserted_or_existing_count integer;
BEGIN
  CREATE TEMP TABLE desired_limit_foreign_influence_offices (scope text, canonical_name text)
  ON COMMIT DROP;

  INSERT INTO desired_limit_foreign_influence_offices (scope, canonical_name) VALUES
    ('presidential', 'President of the United States'),
    ('presidential', 'Vice President of the United States'),
    ('statewide', 'United States Senator'),
    ('us_house', 'United States Representative'),
    ('statewide', 'Governor'),
    ('statewide', 'Lieutenant Governor'),
    ('statewide', 'Attorney General'),
    ('statewide', 'Secretary of State'),
    ('statewide', 'Commissioner of Agriculture'),
    ('statewide', 'Land Commissioner'),
    ('state_upper', 'State Senator'),
    ('state_lower', 'State Lower Chamber Legislator');

  SELECT COUNT(*) INTO expected_pair_count FROM desired_limit_foreign_influence_offices;

  INSERT INTO public.office_research_areas (office_id, research_area_id)
  SELECT office.id, area.id
  FROM desired_limit_foreign_influence_offices desired
  JOIN public.offices office
    ON office.scope = desired.scope
   AND office.canonical_name = desired.canonical_name
  JOIN public.research_areas area
    ON area.slug = 'limit_foreign_influence'
  ON CONFLICT (office_id, research_area_id) DO NOTHING;

  SELECT COUNT(*)
  INTO inserted_or_existing_count
  FROM desired_limit_foreign_influence_offices desired
  JOIN public.offices office
    ON office.scope = desired.scope
   AND office.canonical_name = desired.canonical_name;

  IF inserted_or_existing_count <> expected_pair_count THEN
    RAISE NOTICE
      'migration 336: % of % limit_foreign_influence office links resolved; the rest are created by the seed layer (fresh install path)',
      inserted_or_existing_count,
      expected_pair_count;
  END IF;
END
$$;

COMMIT;
