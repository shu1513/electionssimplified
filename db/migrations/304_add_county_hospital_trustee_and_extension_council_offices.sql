-- Two county offices the catalog did not have. Without them every election
-- shell for these seats was written with a NULL office_id, which blocks the
-- candidate-records stage.
--
-- 1. "County Hospital Trustee": the elected board of a county public hospital
--    (Iowa Code chapter 347). Live titles: "Keokuk County Public Hospital
--    Trustees", "Davis County Hospital Board of Trustees", "Humboldt County
--    Memorial Hospital Board of Trustees", "Palo Alto County Hospital District
--    Trustee" (all Iowa, Nov 2026), and "Kiowa County Hospital Board" (KS).
--
-- 2. "County Agricultural Extension Council Member": the elected county
--    extension council (Iowa Code chapter 176A). Live titles: "Marion County
--    Agricultural Extension Council", "Worth County Agricultural Extension
--    Council Member", "Davis County Agricultural Extension Council Member To
--    Fill a Vacancy". The matcher already drops a trailing "to fill a
--    vacancy".
--
-- The matcher keeps plurals and the leading "county" word in its key, so the
-- aliases list each form. None of these keys existed before, so no existing
-- office loses a title.
--
-- Summaries are byte-identical to backend/src/scripts/seedOffices.ts and the
-- research-area links mirror db/seeds/office_research_areas_v1.sql. On a
-- fresh migrations-only database research_areas is still empty, so the join
-- inserts zero rows and the seed layer fills them in later (same pattern as
-- migration 298).
--
-- Adding an office does not repair elections written before it existed:
-- `npm run manual:elections:repair-office-ids` re-runs the current matcher
-- over stranded NULL-office shells and backfills office_id.

BEGIN;

INSERT INTO public.offices (scope, canonical_name, summary)
VALUES
  (
    'county',
    'County Hospital Trustee',
    'Overseeing the county''s public hospital and its budget
Hiring the hospital''s chief executive
Setting how much property tax the hospital asks for'
  ),
  (
    'county',
    'County Agricultural Extension Council Member',
    'Choosing which farm, 4-H, and family classes the county extension office offers
Setting the extension office''s budget and property tax levy
Hiring the county extension staff'
  )
ON CONFLICT (scope, canonical_name) DO NOTHING;

INSERT INTO public.office_title_aliases (office_id, scope, alias_text, normalized_alias)
SELECT o.id, 'county', v.alias_text, v.normalized_alias
FROM public.offices o,
     (VALUES
        ('County Hospital Trustee', 'county hospital trustee'),
        ('County Hospital Trustees', 'county hospital trustees'),
        ('Hospital Trustee', 'hospital trustee'),
        ('Hospital Trustees', 'hospital trustees'),
        ('Public Hospital Trustee', 'public hospital trustee'),
        ('Public Hospital Trustees', 'public hospital trustees'),
        ('Memorial Hospital Trustee', 'memorial hospital trustee'),
        ('Memorial Hospital Trustees', 'memorial hospital trustees'),
        ('Hospital Board of Trustees', 'hospital board of trustees'),
        ('Memorial Hospital Board of Trustees', 'memorial hospital board of trustees'),
        ('Hospital Board', 'hospital board'),
        ('Hospital District Trustee', 'hospital district trustee'),
        ('Hospital District Trustees', 'hospital district trustees')
     ) AS v(alias_text, normalized_alias)
WHERE o.scope = 'county'
  AND o.canonical_name = 'County Hospital Trustee'
ON CONFLICT (scope, normalized_alias) DO NOTHING;

INSERT INTO public.office_title_aliases (office_id, scope, alias_text, normalized_alias)
SELECT o.id, 'county', v.alias_text, v.normalized_alias
FROM public.offices o,
     (VALUES
        ('County Agricultural Extension Council Member', 'county agricultural extension council member'),
        ('Agricultural Extension Council Member', 'agricultural extension council member'),
        ('Agricultural Extension Council Members', 'agricultural extension council members'),
        ('Agricultural Extension Council', 'agricultural extension council'),
        ('Extension Council Member', 'extension council member'),
        ('Extension Council', 'extension council')
     ) AS v(alias_text, normalized_alias)
WHERE o.scope = 'county'
  AND o.canonical_name = 'County Agricultural Extension Council Member'
ON CONFLICT (scope, normalized_alias) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.research_areas) THEN
    RAISE NOTICE 'migration 304: research_areas is empty (fresh install); hospital trustee and extension council research areas will come from the seed layer';
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
       'healthcare_affordability'
     ]::text[])
WHERE o.scope = 'county'
  AND o.canonical_name = 'County Hospital Trustee'
ON CONFLICT DO NOTHING;

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
  AND o.canonical_name = 'County Agricultural Extension Council Member'
ON CONFLICT DO NOTHING;

COMMIT;
