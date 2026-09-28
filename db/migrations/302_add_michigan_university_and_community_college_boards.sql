-- Catalog repairs for Michigan contests on the November 3, 2026 ballot that
-- had no office to match (official 2026 state and county candidate lists):
--
-- 1. The three statewide university boards: Regent of the University of
--    Michigan, Trustee of Michigan State University, and Governor of Wayne
--    State University. Each board sets tuition, approves the budget, and
--    picks the president, the same job as State Board of Regents Member, so
--    the official titles become aliases of that office.
--
-- 2. New county office "Community College Trustee". Michigan community
--    college boards (Washtenaw, Grand Rapids, and others) are elected on the
--    county ballot. "community college board of trustees member" is the
--    matcher key left after the county name is stripped; Grand Rapids
--    Community College does not share Kent County's name, so it gets its own
--    key.
--
-- The summary is byte-identical to backend/src/scripts/seedOffices.ts and the
-- research-area links mirror db/seeds/office_research_areas_v1.sql. On a
-- fresh migrations-only database research_areas is still empty, so the join
-- inserts zero rows and the seed layer fills them in later (same pattern as
-- migration 298).

BEGIN;

INSERT INTO public.office_title_aliases (office_id, scope, alias_text, normalized_alias)
SELECT o.id, 'statewide', v.alias_text, v.normalized_alias
FROM public.offices o,
     (VALUES
        ('Regent of the University of Michigan', 'regent of the university of michigan'),
        ('Trustee of Michigan State University', 'trustee of michigan state university'),
        ('Governor of Wayne State University', 'governor of wayne state university')
     ) AS v(alias_text, normalized_alias)
WHERE o.scope = 'statewide'
  AND o.canonical_name = 'State Board of Regents Member'
ON CONFLICT (scope, normalized_alias) DO NOTHING;

INSERT INTO public.offices (scope, canonical_name, summary)
VALUES (
  'county',
  'Community College Trustee',
  'Setting the college''s property tax and tuition
Approving the college budget and building plans
Picking the college president'
)
ON CONFLICT (scope, canonical_name) DO NOTHING;

INSERT INTO public.office_title_aliases (office_id, scope, alias_text, normalized_alias)
SELECT o.id, 'county', v.alias_text, v.normalized_alias
FROM public.offices o,
     (VALUES
        ('Community College Trustee', 'community college trustee'),
        ('Community College Board of Trustees Member', 'community college board of trustees member'),
        ('Grand Rapids Community College Board of Trustees Member', 'grand rapids community college board of trustees member')
     ) AS v(alias_text, normalized_alias)
WHERE o.scope = 'county'
  AND o.canonical_name = 'Community College Trustee'
ON CONFLICT (scope, normalized_alias) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.research_areas) THEN
    RAISE NOTICE 'migration 302: research_areas is empty (fresh install); Community College Trustee research areas will come from the seed layer';
  END IF;
END
$$;

INSERT INTO public.office_research_areas (office_id, research_area_id)
SELECT o.id, ra.id
FROM public.offices o
JOIN public.research_areas ra
  ON ra.slug = ANY (ARRAY[
       'government_efficiency',
       'government_spending_reduction',
       'public_education_quality'
     ]::text[])
WHERE o.scope = 'county'
  AND o.canonical_name = 'Community College Trustee'
ON CONFLICT DO NOTHING;

COMMIT;
