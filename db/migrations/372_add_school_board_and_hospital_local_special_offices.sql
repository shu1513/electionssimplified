-- Offices for two more kinds of seat that sit on reviewed local_special
-- polygons: a school board seat elected from its own trustee area or
-- district (the school-scope School Board Member stays for at-large boards
-- on the school row), and a public hospital / healthcare district board.
--
-- Summaries are byte-identical to backend/src/scripts/seedOffices.ts, and the
-- research areas match db/seeds/office_research_areas_v1.sql. On a fresh
-- migrations-only database research_areas is still empty, so the
-- research-area joins insert zero rows (same pattern as migration 313).

BEGIN;

INSERT INTO public.offices (scope, canonical_name, summary)
VALUES
  ('local_special', 'School Board Member',
   'Setting the school district''s budget and hiring the superintendent
Deciding which schools open, close, or get rebuilt
Approving curriculum, calendars, and teacher contracts'),
  ('local_special', 'Hospital District Director',
   'Overseeing the public hospital or health district''s budget and property tax
Deciding which clinics and services the district funds
Hiring and overseeing the administrator who runs the district')
ON CONFLICT (scope, canonical_name) DO NOTHING;

INSERT INTO public.office_title_aliases (office_id, scope, alias_text, normalized_alias)
SELECT o.id, 'local_special', v.alias_text, v.normalized_alias
FROM public.offices o
JOIN (VALUES
        ('School Board Member', 'School Board Member', 'school board member'),
        ('School Board Member', 'Governing Board Member', 'governing board member'),
        ('School Board Member', 'School District Governing Board Member', 'school district governing board member'),
        ('School Board Member', 'Board of Education Member', 'board of education member'),
        ('School Board Member', 'Member, Board of Education', 'member board of education'),
        ('School Board Member', 'School Board Trustee', 'school board trustee'),
        ('School Board Member', 'School District Trustee', 'school district trustee'),
        ('School Board Member', 'School Director', 'school director'),
        ('School Board Member', 'Board of Trustees Member', 'board of trustees member'),
        ('Hospital District Director', 'Hospital District Director', 'hospital district director'),
        ('Hospital District Director', 'Healthcare District Director', 'healthcare district director'),
        ('Hospital District Director', 'Health Care District Director', 'health care district director'),
        ('Hospital District Director', 'Hospital District Board Member', 'hospital district board member'),
        ('Hospital District Director', 'Public Hospital District Commissioner', 'public hospital district commissioner'),
        ('Hospital District Director', 'Hospital District Commissioner', 'hospital district commissioner'),
        ('Hospital District Director', 'Director, Hospital District', 'director hospital district')
     ) AS v(office_name, alias_text, normalized_alias)
  ON v.office_name = o.canonical_name
WHERE o.scope = 'local_special'
ON CONFLICT (scope, normalized_alias) DO NOTHING;

INSERT INTO public.office_research_areas (office_id, research_area_id)
SELECT o.id, ra.id
FROM public.offices o
JOIN (VALUES
        ('School Board Member', ARRAY['public_education_quality', 'government_efficiency', 'government_spending_reduction', 'public_safety_and_crime_control']::text[]),
        ('Hospital District Director', ARRAY['healthcare_affordability', 'government_efficiency', 'government_spending_reduction']::text[])
     ) AS v(office_name, slugs)
  ON v.office_name = o.canonical_name
JOIN public.research_areas ra
  ON ra.slug = ANY (v.slugs)
WHERE o.scope = 'local_special'
ON CONFLICT (office_id, research_area_id) DO NOTHING;

COMMIT;
