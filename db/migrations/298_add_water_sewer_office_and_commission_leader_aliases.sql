-- Catalog repairs for county election shells that were written with a NULL
-- office_id (which blocks the candidate-records stage):
--
-- 1. New county office "Water and Sewer Commissioner". Some counties elect
--    the board of a water and sewer utility on the county ballot. Live hit:
--    "Brunswick-Glynn County Joint Water & Sewer Commissioner, At Large
--    Post 2" (Glynn County GA, Nov 2026). The catalog had no such office, so
--    every title form scored under the confidence floor. The matcher half of
--    the fix (officeMatcher.ts) folds any "<name> water and sewer
--    commission(er)/authority/board" key onto this office's alias, and strips
--    Georgia's "Post N" seat number.
--
-- 2. Alabama county commission leadership seats elected countywide
--    ("Chairman, St. Clair County Commission", "President, DeKalb County
--    Commission"). The presiding member votes on commission business like the
--    other members, so these map to County Commissioner — the same call the
--    catalog already makes for "county commissioner chairman" and "county
--    commissioner president". The aliases are the matcher keys left after the
--    county name is stripped.
--
-- The summary is byte-identical to backend/src/scripts/seedOffices.ts and the
-- research-area links mirror db/seeds/office_research_areas_v1.sql. On a
-- fresh migrations-only database research_areas is still empty, so the join
-- inserts zero rows and the seed layer fills them in later (same pattern as
-- migrations 216, 224 and 228).
--
-- Adding an office does not repair elections written before it existed:
-- `npm run manual:elections:repair-office-ids` re-runs the current matcher
-- over stranded NULL-office shells and backfills office_id.

BEGIN;

INSERT INTO public.offices (scope, canonical_name, summary)
VALUES (
  'county',
  'Water and Sewer Commissioner',
  'Setting the water and sewer rates you pay
Deciding which pipes, pumps, and treatment plants get built or fixed
Picking the utility''s director'
)
ON CONFLICT (scope, canonical_name) DO NOTHING;

INSERT INTO public.office_title_aliases (office_id, scope, alias_text, normalized_alias)
SELECT o.id, 'county', 'Water and Sewer Commissioner', 'water and sewer commissioner'
FROM public.offices o
WHERE o.scope = 'county'
  AND o.canonical_name = 'Water and Sewer Commissioner'
ON CONFLICT (scope, normalized_alias) DO NOTHING;

INSERT INTO public.office_title_aliases (office_id, scope, alias_text, normalized_alias)
SELECT o.id, 'county', v.alias_text, v.normalized_alias
FROM public.offices o,
     (VALUES
        ('Chairman County Commission', 'chairman county commission'),
        ('Chair County Commission', 'chair county commission'),
        ('President County Commission', 'president county commission')
     ) AS v(alias_text, normalized_alias)
WHERE o.scope = 'county'
  AND o.canonical_name = 'County Commissioner'
ON CONFLICT (scope, normalized_alias) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.research_areas) THEN
    RAISE NOTICE 'migration 298: research_areas is empty (fresh install); Water and Sewer Commissioner research areas will come from the seed layer';
  END IF;
END
$$;

INSERT INTO public.office_research_areas (office_id, research_area_id)
SELECT o.id, ra.id
FROM public.offices o
JOIN public.research_areas ra
  ON ra.slug = ANY (ARRAY[
       'environment_and_public_health',
       'government_efficiency',
       'government_spending_reduction',
       'public_infrastructure'
     ]::text[])
WHERE o.scope = 'county'
  AND o.canonical_name = 'Water and Sewer Commissioner'
ON CONFLICT DO NOTHING;

COMMIT;
