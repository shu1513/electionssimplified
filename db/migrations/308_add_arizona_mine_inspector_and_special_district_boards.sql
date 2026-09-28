-- Catalog repairs for Arizona contests on the November 3, 2026 ballot that
-- could not be written because no office matched their titles:
--
-- 1. New statewide office "State Mine Inspector". Arizona elects one on the
--    statewide ballot (Ariz. Const. art. XIX). It had no catalog row, so the
--    contest could not be written without a NULL office_id.
--
-- 2. New county office "Career and Technical Education District Board
--    Member". Arizona's career and technical education districts (formerly
--    joint technical education districts, e.g. East Valley Institute of
--    Technology, EVIT) elect their boards by district on the county ballot.
--
-- 3. Arizona aliases onto two county offices that earlier migrations created:
--    "Community College Trustee" (migration 302; Maricopa County Community
--    College District board) and "County Hospital Trustee" (migration
--    305_add_county_hospital_trustee_and_extension_council_offices; Maricopa
--    County Special Health Care District board, which runs the county's
--    public hospital system).
--
-- The aliases are the matcher keys left after the county name and the
-- trailing seat ("District 3", "At-Large") are stripped. Summaries match
-- backend/src/scripts/seedOffices.ts and the research-area links mirror
-- db/seeds/office_research_areas_v1.sql. On a fresh migrations-only database
-- research_areas is still empty, so the joins insert zero rows and the seed
-- layer fills them in later (same pattern as migrations 216, 224 and 298).

BEGIN;

INSERT INTO public.offices (scope, canonical_name, summary)
VALUES
  (
    'statewide',
    'State Mine Inspector',
    'Inspecting mines and quarries to keep workers safe
Investigating mine accidents and enforcing safety rules
Making sure closed and abandoned mines are sealed off'
  ),
  (
    'county',
    'Career and Technical Education District Board Member',
    'Deciding which job-training programs students can take
Approving the district''s budget and property tax
Picking the district''s superintendent'
  )
ON CONFLICT (scope, canonical_name) DO NOTHING;

INSERT INTO public.office_title_aliases (office_id, scope, alias_text, normalized_alias)
SELECT o.id, v.scope, v.alias_text, v.normalized_alias
FROM (VALUES
        ('statewide', 'State Mine Inspector', 'State Mine Inspector', 'state mine inspector'),
        ('statewide', 'State Mine Inspector', 'Mine Inspector', 'mine inspector'),
        ('county', 'Career and Technical Education District Board Member',
         'Career and Technical Education District Board Member',
         'career and technical education district board member'),
        ('county', 'Career and Technical Education District Board Member',
         'East Valley Institute of Technology Governing Board Member',
         'east valley institute of technology governing board member'),
        ('county', 'Career and Technical Education District Board Member',
         'Technical Education District Governing Board Member',
         'technical education district governing board member'),
        ('county', 'Community College Trustee',
         'Community College District Governing Board Member',
         'community college district governing board member'),
        ('county', 'County Hospital Trustee',
         'Special Health Care District Board of Directors Member',
         'special health care district board of directors member'),
        ('county', 'County Hospital Trustee',
         'Special Health Care District Board of Directors',
         'special health care district board of directors')
     ) AS v(scope, canonical_name, alias_text, normalized_alias)
JOIN public.offices o
  ON o.scope = v.scope
 AND o.canonical_name = v.canonical_name
ON CONFLICT (scope, normalized_alias) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.research_areas) THEN
    RAISE NOTICE 'migration 308: research_areas is empty (fresh install); research areas will come from the seed layer';
  END IF;
END
$$;

INSERT INTO public.office_research_areas (office_id, research_area_id)
SELECT o.id, ra.id
FROM (VALUES
        ('statewide', 'State Mine Inspector', ARRAY[
          'environment_and_public_health', 'government_efficiency',
          'labor_rights', 'public_safety_and_crime_control']::text[]),
        ('county', 'Career and Technical Education District Board Member', ARRAY[
          'government_efficiency', 'government_spending_reduction',
          'public_education_quality']::text[])
     ) AS v(scope, canonical_name, slugs)
JOIN public.offices o
  ON o.scope = v.scope
 AND o.canonical_name = v.canonical_name
JOIN public.research_areas ra
  ON ra.slug = ANY (v.slugs)
ON CONFLICT DO NOTHING;

COMMIT;
