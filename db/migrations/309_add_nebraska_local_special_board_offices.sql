-- Offices for Omaha-area (Douglas County, Nebraska) contests whose voters live
-- in a reviewed local_special area rather than a county, city, or school
-- district. Omaha voters elect all of these on November 3, 2026:
--   * Public Service Commission, District 2, and University of Nebraska
--     Board of Regents, Districts 2 and 4 (state plans that match no county)
--   * Papio-Missouri River Natural Resources District directors
--   * Omaha Public Power District directors (electric utility)
--   * Metropolitan Utilities District directors (water and gas utility)
--   * Learning Community of Douglas and Sarpy Counties coordinating council
--   * Educational Service Unit 3 board members
-- The new aliases let Nebraska's titles reach existing local_special offices:
-- Court of Appeals judges, the Metropolitan Community College Board of
-- Governors, and the Regional Metropolitan Transit Authority of Omaha board.
--
-- Research areas are copied from the closest existing office. On a fresh
-- migrations-only database research_areas is still empty, so those joins
-- insert zero rows (same pattern as migrations 303, 305, and 307). Summaries
-- are byte-identical to backend/src/scripts/seedOffices.ts.

BEGIN;

INSERT INTO public.offices (scope, canonical_name, summary)
VALUES
  ('local_special', 'Public Service Commissioner',
   'Setting rates and service rules for phone, pipeline, and other regulated companies
Approving routes for major pipelines and power lines
Hearing complaints from customers about regulated services'),
  ('local_special', 'State Board of Regents Member',
   'Setting tuition and approving the university''s yearly budget
Hiring and overseeing the university president
Approving new degree programs, campuses, and buildings'),
  ('local_special', 'Natural Resources District Director',
   'Planning flood control, soil conservation, and groundwater protection
Setting the district''s property tax rate and yearly budget
Approving dams, trails, and other district projects'),
  ('local_special', 'Public Power District Director',
   'Setting electric rates for homes and businesses
Deciding which power plants to build, run, or close
Approving the utility''s budget and borrowing'),
  ('local_special', 'Utility District Director',
   'Overseeing the district''s water and natural gas service
Setting water and gas rates
Approving the budget and borrowing for pipes and treatment plants'),
  ('local_special', 'Learning Community Council Member',
   'Running early childhood and family programs across member school districts
Setting the council''s property tax rate and yearly budget
Reviewing plans to help students from low-income families'),
  ('local_special', 'Educational Service Unit Board Member',
   'Overseeing shared services such as special education, teacher training, and technology for member schools
Setting the unit''s property tax rate and yearly budget
Hiring and overseeing the unit''s administrator')
ON CONFLICT (scope, canonical_name) DO NOTHING;

INSERT INTO public.office_title_aliases (office_id, scope, alias_text, normalized_alias)
SELECT o.id, o.scope, v.alias_text, v.normalized_alias
FROM (VALUES
  ('local_special', 'Public Service Commissioner', 'Public Service Commissioner', 'public service commissioner'),
  ('local_special', 'Public Service Commissioner', 'Public Service Commission', 'public service commission'),
  ('local_special', 'Public Service Commissioner', 'Member, Public Service Commission', 'member public service commission'),
  ('local_special', 'State Board of Regents Member', 'State Board of Regents Member', 'state board of regents member'),
  ('local_special', 'State Board of Regents Member', 'Board of Regents', 'board of regents'),
  ('local_special', 'State Board of Regents Member', 'University Regent', 'university regent'),
  ('local_special', 'State Board of Regents Member', 'Member, Board of Regents', 'member board of regents'),
  ('local_special', 'Natural Resources District Director', 'Natural Resources District Director', 'natural resources district director'),
  ('local_special', 'Natural Resources District Director', 'Natural Resources District Board of Directors', 'natural resources district board of directors'),
  ('local_special', 'Natural Resources District Director', 'Director, Natural Resources District', 'director natural resources district'),
  ('local_special', 'Public Power District Director', 'Public Power District Director', 'public power district director'),
  ('local_special', 'Public Power District Director', 'Public Power District Board of Directors', 'public power district board of directors'),
  ('local_special', 'Public Power District Director', 'Director, Public Power District', 'director public power district'),
  ('local_special', 'Utility District Director', 'Utility District Director', 'utility district director'),
  ('local_special', 'Utility District Director', 'Metropolitan Utilities District Director', 'metropolitan utilities district director'),
  ('local_special', 'Utility District Director', 'Metropolitan Utilities District Board of Directors', 'metropolitan utilities district board of directors'),
  ('local_special', 'Utility District Director', 'Director, Metropolitan Utilities District', 'director metropolitan utilities district'),
  ('local_special', 'Learning Community Council Member', 'Learning Community Council Member', 'learning community council member'),
  ('local_special', 'Learning Community Council Member', 'Learning Community Coordinating Council', 'learning community coordinating council'),
  ('local_special', 'Learning Community Council Member', 'Coordinating Council, Learning Community', 'coordinating council learning community'),
  ('local_special', 'Learning Community Council Member', 'Learning Community Coordinating Council Member', 'learning community coordinating council member'),
  ('local_special', 'Educational Service Unit Board Member', 'Educational Service Unit Board Member', 'educational service unit board member'),
  ('local_special', 'Educational Service Unit Board Member', 'Educational Service Unit Board', 'educational service unit board'),
  ('local_special', 'Educational Service Unit Board Member', 'Board Member, Educational Service Unit', 'board member educational service unit'),
  ('local_special', 'Court of Appeals Justice', 'Judge of the Court of Appeals', 'judge of the court of appeals'),
  ('local_special', 'Court of Appeals Justice', 'Court of Appeals Judge', 'court of appeals judge'),
  ('local_special', 'Community College Trustee', 'Community College Board of Governors', 'community college board of governors'),
  ('local_special', 'Community College Trustee', 'Board of Governors, Community College', 'board of governors community college'),
  ('local_special', 'Community College Trustee', 'Metropolitan Community College Board of Governors', 'metropolitan community college board of governors'),
  ('local_special', 'Transit District Director', 'Transit Authority Director', 'transit authority director'),
  ('local_special', 'Transit District Director', 'Transit Authority Board of Directors', 'transit authority board of directors')
) AS v(scope, canonical_name, alias_text, normalized_alias)
JOIN public.offices o ON o.scope = v.scope AND o.canonical_name = v.canonical_name
ON CONFLICT (scope, normalized_alias) DO NOTHING;

-- Copy research areas from the closest existing office.
INSERT INTO public.office_research_areas (office_id, research_area_id)
SELECT target.id, ora.research_area_id
FROM (VALUES
  ('local_special', 'Public Service Commissioner', 'statewide', 'Public Service Commissioner'),
  ('local_special', 'State Board of Regents Member', 'statewide', 'State Board of Regents Member'),
  ('local_special', 'Natural Resources District Director', 'local_special', 'Groundwater Conservation District Director'),
  ('local_special', 'Public Power District Director', 'statewide', 'Public Service Commissioner'),
  ('local_special', 'Utility District Director', 'statewide', 'Public Service Commissioner'),
  ('local_special', 'Learning Community Council Member', 'school_unified', 'School Board Member'),
  ('local_special', 'Educational Service Unit Board Member', 'local_special', 'Community College Trustee')
) AS v(scope, canonical_name, source_scope, source_name)
JOIN public.offices target ON target.scope = v.scope AND target.canonical_name = v.canonical_name
JOIN public.offices source ON source.scope = v.source_scope AND source.canonical_name = v.source_name
JOIN public.office_research_areas ora ON ora.office_id = source.id
ON CONFLICT (office_id, research_area_id) DO NOTHING;

COMMIT;
