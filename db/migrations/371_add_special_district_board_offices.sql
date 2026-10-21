-- local_special offices for special-district boards the 2026-10 county
-- inventories found on the November 3, 2026 ballot: community services
-- districts and fire protection districts (California), sanitary and
-- sanitation districts (California, Illinois), county boards of education
-- elected by trustee area (California), emergency services districts (Texas),
-- the Metropolitan Water Reclamation District and the Board of Review (Cook
-- County, Illinois).
--
-- Summaries are byte-identical to backend/src/scripts/seedOffices.ts, and the
-- research areas match db/seeds/office_research_areas_v1.sql. On a fresh
-- migrations-only database research_areas is still empty, so the
-- research-area joins insert zero rows (same pattern as migration 313).

BEGIN;

INSERT INTO public.offices (scope, canonical_name, summary)
VALUES
  ('local_special', 'Community Services District Director',
   'Setting the district''s budget and the rates or assessments it charges
Deciding which services the district provides, such as water, sewer, parks, or fire
Hiring and overseeing the general manager'),
  ('local_special', 'Fire Protection District Director',
   'Setting fire district taxes and assessments
Funding fire stations, trucks, and emergency medical service
Picking the fire chief'),
  ('local_special', 'Sanitary District Director',
   'Setting sewer rates and the district''s budget
Deciding which sewer lines and treatment plants get built or fixed
Hiring and overseeing the district''s general manager'),
  ('local_special', 'County Board of Education Member',
   'Overseeing the county office of education''s budget and programs
Hearing student expulsion and transfer appeals from local districts
Approving charter schools the local districts turned down'),
  ('local_special', 'Emergency Services District Commissioner',
   'Setting the district''s sales or property tax for fire and ambulance service
Deciding which stations, trucks, and ambulances the district funds
Contracting with or overseeing the fire and EMS providers'),
  ('local_special', 'Water Reclamation District Commissioner',
   'Setting the district''s property tax and budget for sewage treatment and flood control
Deciding which treatment plants, tunnels, and reservoirs get built
Hiring and overseeing the district''s executive director'),
  ('local_special', 'Board of Review Commissioner',
   'Hearing property owners'' appeals of their assessed values
Deciding whether to lower an assessment
Overseeing the board''s staff and hearing process')
ON CONFLICT (scope, canonical_name) DO NOTHING;

INSERT INTO public.office_title_aliases (office_id, scope, alias_text, normalized_alias)
SELECT o.id, 'local_special', v.alias_text, v.normalized_alias
FROM public.offices o
JOIN (VALUES
        ('Community Services District Director', 'Community Services District Director', 'community services district director'),
        ('Community Services District Director', 'Community Services District Board Member', 'community services district board member'),
        ('Community Services District Director', 'Director, Community Services District', 'director community services district'),
        ('Community Services District Director', 'CSD Director', 'csd director'),
        ('Fire Protection District Director', 'Fire Protection District Director', 'fire protection district director'),
        ('Fire Protection District Director', 'Fire District Director', 'fire district director'),
        ('Fire Protection District Director', 'Fire District Commissioner', 'fire district commissioner'),
        ('Fire Protection District Director', 'Fire Protection District Board Member', 'fire protection district board member'),
        ('Fire Protection District Director', 'Independent Fire District Director', 'independent fire district director'),
        ('Sanitary District Director', 'Sanitary District Director', 'sanitary district director'),
        ('Sanitary District Director', 'Sanitation District Director', 'sanitation district director'),
        ('Sanitary District Director', 'Sanitary District Trustee', 'sanitary district trustee'),
        ('Sanitary District Director', 'Sanitary District Board Member', 'sanitary district board member'),
        ('Sanitary District Director', 'Wastewater District Director', 'wastewater district director'),
        ('Sanitary District Director', 'Director, Sanitary District', 'director sanitary district'),
        ('County Board of Education Member', 'County Board of Education Member', 'county board of education member'),
        ('County Board of Education Member', 'County Board of Education Trustee', 'county board of education trustee'),
        ('County Board of Education Member', 'Member, County Board of Education', 'member county board of education'),
        ('County Board of Education Member', 'County Board of Education, Trustee Area', 'county board of education trustee area'),
        ('Emergency Services District Commissioner', 'Emergency Services District Commissioner', 'emergency services district commissioner'),
        ('Emergency Services District Commissioner', 'Emergency Services District Board Member', 'emergency services district board member'),
        ('Emergency Services District Commissioner', 'ESD Commissioner', 'esd commissioner'),
        ('Emergency Services District Commissioner', 'Commissioner, Emergency Services District', 'commissioner emergency services district'),
        ('Water Reclamation District Commissioner', 'Water Reclamation District Commissioner', 'water reclamation district commissioner'),
        ('Water Reclamation District Commissioner', 'Metropolitan Water Reclamation District Commissioner', 'metropolitan water reclamation district commissioner'),
        ('Water Reclamation District Commissioner', 'Commissioner, Water Reclamation District', 'commissioner water reclamation district'),
        ('Board of Review Commissioner', 'Board of Review Commissioner', 'board of review commissioner'),
        ('Board of Review Commissioner', 'Commissioner, Board of Review', 'commissioner board of review'),
        ('Board of Review Commissioner', 'Member, Board of Review', 'member board of review'),
        ('Board of Review Commissioner', 'Board of Review Member', 'board of review member')
     ) AS v(office_name, alias_text, normalized_alias)
  ON v.office_name = o.canonical_name
WHERE o.scope = 'local_special'
ON CONFLICT (scope, normalized_alias) DO NOTHING;

INSERT INTO public.office_research_areas (office_id, research_area_id)
SELECT o.id, ra.id
FROM public.offices o
JOIN (VALUES
        ('Community Services District Director', ARRAY['government_efficiency', 'government_spending_reduction', 'public_infrastructure']::text[]),
        ('Fire Protection District Director', ARRAY['public_safety_and_crime_control', 'government_efficiency', 'government_spending_reduction']::text[]),
        ('Sanitary District Director', ARRAY['environment_and_public_health', 'government_efficiency', 'government_spending_reduction', 'public_infrastructure']::text[]),
        ('County Board of Education Member', ARRAY['public_education_quality', 'government_efficiency', 'government_spending_reduction']::text[]),
        ('Emergency Services District Commissioner', ARRAY['public_safety_and_crime_control', 'government_efficiency', 'government_spending_reduction']::text[]),
        ('Water Reclamation District Commissioner', ARRAY['environment_and_public_health', 'government_efficiency', 'government_spending_reduction', 'public_infrastructure']::text[]),
        ('Board of Review Commissioner', ARRAY['government_efficiency', 'personal_income_tax_reduction', 'anti_corruption']::text[])
     ) AS v(office_name, slugs)
  ON v.office_name = o.canonical_name
JOIN public.research_areas ra
  ON ra.slug = ANY (v.slugs)
WHERE o.scope = 'local_special'
ON CONFLICT (office_id, research_area_id) DO NOTHING;

COMMIT;
