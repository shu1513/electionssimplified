-- local_special offices for Florida districts whose seats reach only part of
-- a county: soil and water conservation supervisors elected by numbered
-- district (Orange County), water control / drainage / improvement districts
-- elected by zone or seat (Broward County), and community development
-- districts (one development each; Broward, Orange, Miami-Dade). The
-- county-scope rows for the first and third stay for countywide seats.
--
-- Summaries are byte-identical to backend/src/scripts/seedOffices.ts, and the
-- research areas match db/seeds/office_research_areas_v1.sql. On a fresh
-- migrations-only database research_areas is still empty, so the
-- research-area joins insert zero rows (same pattern as migration 313).

BEGIN;

INSERT INTO public.offices (scope, canonical_name, summary)
VALUES
  ('local_special', 'Community Development District Supervisor',
   'Setting assessments on property in the district
Maintaining roads, drainage, and water and sewer lines
Running parks, ponds, pools, and clubhouses'),
  ('local_special', 'Soil and Water Conservation District Supervisor',
   'Running drainage, erosion, and watershed projects
Helping landowners with conservation
Deciding how conservation money is spent in the district'),
  ('local_special', 'Water Control District Supervisor',
   'Setting the district''s drainage assessments and budget
Deciding which canals, pumps, and flood-control works get built or repaired
Hiring and overseeing the district''s manager and engineer')
ON CONFLICT (scope, canonical_name) DO NOTHING;

INSERT INTO public.office_title_aliases (office_id, scope, alias_text, normalized_alias)
SELECT o.id, 'local_special', v.alias_text, v.normalized_alias
FROM public.offices o
JOIN (VALUES
        ('Community Development District Supervisor', 'Community Development District Supervisor', 'community development district supervisor'),
        ('Community Development District Supervisor', 'CDD Supervisor', 'cdd supervisor'),
        ('Community Development District Supervisor', 'Supervisor, Community Development District', 'supervisor community development district'),
        ('Community Development District Supervisor', 'Community Development District Board of Supervisors', 'community development district board of supervisors'),
        ('Soil and Water Conservation District Supervisor', 'Soil and Water Conservation District Supervisor', 'soil and water conservation district supervisor'),
        ('Soil and Water Conservation District Supervisor', 'Soil and Water Conservation Supervisor', 'soil and water conservation supervisor'),
        ('Soil and Water Conservation District Supervisor', 'Soil & Water Conservation District Supervisor', 'soil water conservation district supervisor'),
        ('Soil and Water Conservation District Supervisor', 'Supervisor, Soil and Water Conservation District', 'supervisor soil and water conservation district'),
        ('Water Control District Supervisor', 'Water Control District Supervisor', 'water control district supervisor'),
        ('Water Control District Supervisor', 'Water Control District Board Member', 'water control district board member'),
        ('Water Control District Supervisor', 'Drainage District Supervisor', 'drainage district supervisor'),
        ('Water Control District Supervisor', 'Drainage District Commissioner', 'drainage district commissioner'),
        ('Water Control District Supervisor', 'Improvement District Supervisor', 'improvement district supervisor'),
        ('Water Control District Supervisor', 'Improvement District Board Member', 'improvement district board member'),
        ('Water Control District Supervisor', 'Supervisor, Water Control District', 'supervisor water control district')
     ) AS v(office_name, alias_text, normalized_alias)
  ON v.office_name = o.canonical_name
WHERE o.scope = 'local_special'
ON CONFLICT (scope, normalized_alias) DO NOTHING;

INSERT INTO public.office_research_areas (office_id, research_area_id)
SELECT o.id, ra.id
FROM public.offices o
JOIN (VALUES
        ('Community Development District Supervisor', ARRAY['environment_and_public_health', 'government_efficiency', 'government_spending_reduction', 'housing_affordability', 'public_infrastructure']::text[]),
        ('Soil and Water Conservation District Supervisor', ARRAY['environment_and_public_health', 'government_efficiency', 'public_infrastructure']::text[]),
        ('Water Control District Supervisor', ARRAY['environment_and_public_health', 'government_efficiency', 'government_spending_reduction', 'public_infrastructure']::text[])
     ) AS v(office_name, slugs)
  ON v.office_name = o.canonical_name
JOIN public.research_areas ra
  ON ra.slug = ANY (v.slugs)
WHERE o.scope = 'local_special'
ON CONFLICT (office_id, research_area_id) DO NOTHING;

COMMIT;
