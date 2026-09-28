-- Offices for contests whose voters live in a reviewed local_special area
-- (migrations 300/305) rather than a county, city, or school district.
-- Austin-area voters elect all of these on November 3, 2026:
--   * State Board of Education, District 5 (a state board district that
--     matches no county or legislative map)
--   * Chief Justice of the Third Court of Appeals (24 counties)
--   * the 207th and 274th District Courts (several counties each)
--   * Austin Community College trustees (the college's taxing district)
--   * Barton Springs Edwards Aquifer Conservation District directors
--   * municipal utility district (MUD) directors
--   * library district trustees
-- Each is a local_special office. The appraisal district board is elected
-- countywide, so its office is county scope.
--
-- Research areas are copied from the closest existing office so the records
-- stage labels these races the way it labels their county or statewide
-- counterparts. On a fresh migrations-only database research_areas is still
-- empty, so those joins insert zero rows (same pattern as migrations 303 and
-- 305). Summaries are byte-identical to backend/src/scripts/seedOffices.ts.

BEGIN;

INSERT INTO public.offices (scope, canonical_name, summary)
VALUES
  ('local_special', 'State Board of Education Member',
   'Setting what students must learn in each grade and subject
Approving textbooks and instructional materials for public schools
Overseeing the state fund that helps pay for public schools'),
  ('local_special', 'Court of Appeals Justice',
   'Hearing appeals of civil and criminal cases from trial courts in the district
Deciding whether the trial court followed the law, usually in three-judge panels
Writing opinions that guide lower courts in the district'),
  ('local_special', 'District Judge',
   'Presiding over felony criminal trials and large civil lawsuits
Hearing divorce, child custody, and other family cases
Serving the voters of every county the court covers'),
  ('local_special', 'Community College Trustee',
   'Setting the college''s property tax rate and yearly budget
Approving tuition, programs, and new campuses
Hiring and overseeing the college president'),
  ('local_special', 'Groundwater Conservation District Director',
   'Setting rules and permits for pumping water from the aquifer
Deciding how much well owners may pump during a drought
Approving the district''s budget and water fees'),
  ('local_special', 'Municipal Utility District Director',
   'Overseeing water, sewer, and drainage service for the district
Setting the district''s property tax rate and water rates
Deciding when to borrow money for pipes, parks, and roads'),
  ('local_special', 'Library District Trustee',
   'Setting the library district''s budget and tax rate
Approving library hours, services, and branches
Hiring and overseeing the library director'),
  ('county', 'Appraisal District Director',
   'Overseeing the office that sets property values for tax bills
Approving the appraisal district''s budget
Hiring the chief appraiser and appointing the appeals board')
ON CONFLICT (scope, canonical_name) DO NOTHING;

INSERT INTO public.office_title_aliases (office_id, scope, alias_text, normalized_alias)
SELECT o.id, o.scope, v.alias_text, v.normalized_alias
FROM (VALUES
  ('local_special', 'State Board of Education Member', 'State Board of Education Member', 'state board of education member'),
  ('local_special', 'State Board of Education Member', 'Member, State Board of Education', 'member state board of education'),
  ('local_special', 'State Board of Education Member', 'State Board of Education', 'state board of education'),
  ('local_special', 'Court of Appeals Justice', 'Court of Appeals Justice', 'court of appeals justice'),
  ('local_special', 'Court of Appeals Justice', 'Chief Justice, Court of Appeals', 'chief justice court of appeals'),
  ('local_special', 'Court of Appeals Justice', 'Justice, Court of Appeals', 'justice court of appeals'),
  ('local_special', 'District Judge', 'District Judge', 'district judge'),
  ('local_special', 'District Judge', 'Judge, District Court', 'judge district court'),
  ('local_special', 'Community College Trustee', 'Community College Trustee', 'community college trustee'),
  ('local_special', 'Community College Trustee', 'Community College District Board of Trustees', 'community college district board of trustees'),
  ('local_special', 'Community College Trustee', 'Austin Community College District Board of Trustees', 'austin community college district board of trustees'),
  ('local_special', 'Groundwater Conservation District Director', 'Groundwater Conservation District Director', 'groundwater conservation district director'),
  ('local_special', 'Groundwater Conservation District Director', 'Aquifer Conservation District Director', 'aquifer conservation district director'),
  ('local_special', 'Groundwater Conservation District Director', 'Barton Springs Edwards Aquifer Conservation District Director', 'barton springs edwards aquifer conservation district director'),
  ('local_special', 'Municipal Utility District Director', 'Municipal Utility District Director', 'municipal utility district director'),
  ('local_special', 'Municipal Utility District Director', 'MUD Director', 'mud director'),
  ('local_special', 'Municipal Utility District Director', 'Director, Municipal Utility District', 'director municipal utility district'),
  ('local_special', 'Library District Trustee', 'Library District Trustee', 'library district trustee'),
  ('local_special', 'Library District Trustee', 'Community Library District Trustee', 'community library district trustee'),
  ('local_special', 'Library District Trustee', 'Library District Board of Trustees', 'library district board of trustees'),
  ('county', 'Appraisal District Director', 'Appraisal District Director', 'appraisal district director'),
  ('county', 'Appraisal District Director', 'Appraisal District Board of Directors', 'appraisal district board of directors'),
  ('county', 'Appraisal District Director', 'Central Appraisal District Board of Directors', 'central appraisal district board of directors'),
  ('county', 'Appraisal District Director', 'Appraisal District Board Member', 'appraisal district board member')
) AS v(scope, canonical_name, alias_text, normalized_alias)
JOIN public.offices o ON o.scope = v.scope AND o.canonical_name = v.canonical_name
ON CONFLICT (scope, normalized_alias) DO NOTHING;

-- Copy research areas from the closest existing office.
INSERT INTO public.office_research_areas (office_id, research_area_id)
SELECT target.id, ora.research_area_id
FROM (VALUES
  ('local_special', 'State Board of Education Member', 'statewide', 'State Board of Education Member'),
  ('local_special', 'Court of Appeals Justice', 'statewide', 'State Level Judge'),
  ('local_special', 'District Judge', 'county', 'County Level Judge'),
  ('local_special', 'Community College Trustee', 'county', 'Community College Trustee'),
  ('local_special', 'Groundwater Conservation District Director', 'county', 'Water and Sewer Commissioner'),
  ('local_special', 'Municipal Utility District Director', 'county', 'Water and Sewer Commissioner'),
  ('local_special', 'Library District Trustee', 'place', 'Library Board Member')
) AS v(scope, canonical_name, source_scope, source_name)
JOIN public.offices target ON target.scope = v.scope AND target.canonical_name = v.canonical_name
JOIN public.offices source ON source.scope = v.source_scope AND source.canonical_name = v.source_name
JOIN public.office_research_areas ora ON ora.office_id = source.id
ON CONFLICT (office_id, research_area_id) DO NOTHING;

-- The appraisal board sets how property is valued and runs the office's
-- budget; it does not set tax rates or run elections.
INSERT INTO public.office_research_areas (office_id, research_area_id)
SELECT o.id, ra.id
FROM public.offices o
JOIN public.research_areas ra
  ON ra.slug = ANY (ARRAY[
       'government_efficiency',
       'government_spending_reduction',
       'housing_affordability'
     ]::text[])
WHERE o.scope = 'county'
  AND o.canonical_name = 'Appraisal District Director'
ON CONFLICT (office_id, research_area_id) DO NOTHING;

COMMIT;
