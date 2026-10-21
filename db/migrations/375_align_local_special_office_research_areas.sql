-- Match each district-scoped office to the existing curated set for the
-- same job: school boards, the statewide BOE, and county boards of review.
-- BOE duties: https://boe.ca.gov/info/about.htm
-- Board of Review duties: https://www.cookcountyil.gov/agency/board-review
-- Keep migrations 371, 372 and 374 unchanged for databases that applied them.
-- The final curated sets also live in db/seeds/office_research_areas_v1.sql.
BEGIN;

WITH curated(office_name, slugs) AS (
  VALUES
    ('School Board Member', ARRAY['civil_rights', 'criminal_justice_and_civil_liberties', 'data_privacy', 'government_efficiency', 'government_spending_reduction', 'public_education_quality', 'public_infrastructure', 'public_safety_and_crime_control']::text[]),
    ('State Board of Equalization Member', ARRAY['corporate_accountability', 'cost_of_living_reduction', 'government_efficiency', 'housing_affordability']::text[]),
    ('Board of Review Commissioner', ARRAY['anti_corruption', 'corporate_accountability', 'government_efficiency', 'housing_affordability']::text[])
), target_offices AS (
  SELECT o.id, c.slugs
  FROM public.offices o
  JOIN curated c ON c.office_name = o.canonical_name
  WHERE o.scope = 'local_special'
), removed AS (
  DELETE FROM public.office_research_areas ora
  USING target_offices target, public.research_areas ra
  WHERE ora.office_id = target.id
    AND ora.research_area_id = ra.id
    AND NOT (ra.slug = ANY (target.slugs))
  RETURNING ora.office_id
)
INSERT INTO public.office_research_areas (office_id, research_area_id)
SELECT target.id, ra.id
FROM target_offices target
JOIN public.research_areas ra ON ra.slug = ANY (target.slugs)
ON CONFLICT (office_id, research_area_id) DO NOTHING;

COMMIT;
