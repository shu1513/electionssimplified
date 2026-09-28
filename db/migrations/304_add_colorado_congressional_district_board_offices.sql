-- Colorado elects two state boards by congressional district, and neither had
-- a catalog home at that scope.
--
-- The University of Colorado Board of Regents has one member per
-- congressional district plus one at large (Colo. Const. art. IX § 12), and
-- the State Board of Education has one member per congressional district
-- (art. IX § 1). The Secretary of State's 2026 general election candidate
-- list (certified 2026-09-04) carries three district regent seats (CD 2, 6,
-- 7) and three district State Board seats (CD 1, 3, 7), titled "Regent of the
-- University of Colorado - Congressional District 2" and "State Board of
-- Education Member - Congressional District 1" on the county sample ballots.
-- These contests belong on the us_house district rows, but the catalog only
-- had statewide boards (plus the DC ward board from migration 280), so a
-- write produced a NULL office_id shell that blocks the records stage.
--
-- Same jobs as the statewide boards, so the summaries are byte-identical to
-- the statewide rows and to the seed layer (seedOffices.ts +
-- db/seeds/office_research_areas_v1.sql), and the research areas mirror the
-- statewide sets.
--
-- Code ships alongside: officeMatcher.ts routes a Colorado us_house title
-- that names a regent or the state board to these offices (every other
-- us_house title still takes the House seat, and the same title on another
-- state's row still fails loudly); electionsValidator.ts stops treating the
-- Colorado State Board title as a mis-scoped school race; roster research,
-- ballot order, race ratings and FEC lookups stop treating these seats as
-- House races.
--
-- On a fresh migrations-only database research_areas is still empty, so the
-- research-area join inserts zero rows by design and the seed layer fills the
-- links afterward (same pattern as migration 280). Every statement is
-- idempotent.

BEGIN;

INSERT INTO public.offices (scope, canonical_name, summary)
VALUES
  (
    'us_house',
    'State Board of Regents Member',
    'Setting tuition at state universities
Approving university budgets
Picking university presidents'
  ),
  (
    'us_house',
    'State Board of Education Member',
    'Setting what students must learn in each grade
Setting graduation requirements
Overseeing the state education department'
  )
ON CONFLICT (scope, canonical_name) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.research_areas) THEN
    RAISE NOTICE 'migration 304: research_areas is empty (fresh install); the new offices'' research areas will come from the seed layer';
  END IF;
END
$$;

-- Curated sets mirrored from db/seeds/office_research_areas_v1.sql: the
-- statewide boards' sets.
INSERT INTO public.office_research_areas (office_id, research_area_id)
SELECT o.id, ra.id
FROM public.offices o
JOIN public.research_areas ra
  ON ra.slug = ANY (ARRAY[
       'civil_rights',
       'government_efficiency',
       'government_spending_reduction',
       'public_education_quality'
     ]::text[])
WHERE o.scope = 'us_house'
  AND o.canonical_name = 'State Board of Regents Member'
ON CONFLICT DO NOTHING;

INSERT INTO public.office_research_areas (office_id, research_area_id)
SELECT o.id, ra.id
FROM public.offices o
JOIN public.research_areas ra
  ON ra.slug = ANY (ARRAY[
       'civil_rights',
       'data_privacy',
       'government_efficiency',
       'government_spending_reduction',
       'public_education_quality'
     ]::text[])
WHERE o.scope = 'us_house'
  AND o.canonical_name = 'State Board of Education Member'
ON CONFLICT DO NOTHING;

COMMIT;
