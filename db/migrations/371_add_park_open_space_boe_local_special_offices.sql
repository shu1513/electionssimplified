-- Offices for three more bodies that elect seats from their own reviewed
-- local_special polygons: regional park districts (East Bay Regional Park
-- District wards), open space districts (Midpeninsula Regional Open Space
-- District wards), and the California State Board of Equalization, whose
-- four districts each get a local_special row so a BOE seat reaches only the
-- voters inside it. The statewide-scope BOE office stays for any row that
-- still needs it.
--
-- Summaries are byte-identical to backend/src/scripts/seedOffices.ts, and the
-- research areas match db/seeds/office_research_areas_v1.sql. On a fresh
-- migrations-only database research_areas is still empty, so the
-- research-area joins insert zero rows (same pattern as migration 313).

BEGIN;

INSERT INTO public.offices (scope, canonical_name, summary)
VALUES
  ('local_special', 'Park District Director',
   'Setting the park district''s budget and property tax rate
Deciding which parks and trails get bought, built, or repaired
Hiring and overseeing the general manager who runs the parks'),
  ('local_special', 'Open Space District Director',
   'Setting the open space district''s budget and tax rate
Deciding which land gets bought and which trails get opened
Hiring and overseeing the general manager who runs the district'),
  ('local_special', 'State Board of Equalization Member',
   'Hearing appeals on property tax assessments and some state taxes
Overseeing county assessors so property taxes are applied evenly
Setting values for railroads and utilities that span counties')
ON CONFLICT (scope, canonical_name) DO NOTHING;

INSERT INTO public.office_title_aliases (office_id, scope, alias_text, normalized_alias)
SELECT o.id, 'local_special', v.alias_text, v.normalized_alias
FROM public.offices o
JOIN (VALUES
        ('Park District Director', 'Park District Director', 'park district director'),
        ('Park District Director', 'Regional Park District Director', 'regional park district director'),
        ('Park District Director', 'Park District Board Member', 'park district board member'),
        ('Park District Director', 'Director, Park District', 'director park district'),
        ('Open Space District Director', 'Open Space District Director', 'open space district director'),
        ('Open Space District Director', 'Regional Open Space District Director', 'regional open space district director'),
        ('Open Space District Director', 'Open Space District Board Member', 'open space district board member'),
        ('Open Space District Director', 'Director, Open Space District', 'director open space district'),
        ('State Board of Equalization Member', 'State Board of Equalization Member', 'state board of equalization member'),
        ('State Board of Equalization Member', 'Member, State Board of Equalization', 'member state board of equalization'),
        ('State Board of Equalization Member', 'Board of Equalization Member', 'board of equalization member'),
        ('State Board of Equalization Member', 'Member, Board of Equalization', 'member board of equalization'),
        ('State Board of Equalization Member', 'Member of the State Board of Equalization', 'member of the state board of equalization')
     ) AS v(office_name, alias_text, normalized_alias)
  ON v.office_name = o.canonical_name
WHERE o.scope = 'local_special'
ON CONFLICT (scope, normalized_alias) DO NOTHING;

INSERT INTO public.office_research_areas (office_id, research_area_id)
SELECT o.id, ra.id
FROM public.offices o
JOIN (VALUES
        ('Park District Director', ARRAY['environment_and_public_health', 'government_efficiency', 'government_spending_reduction', 'public_infrastructure']::text[]),
        ('Open Space District Director', ARRAY['environment_and_public_health', 'government_efficiency', 'government_spending_reduction']::text[]),
        ('State Board of Equalization Member', ARRAY['government_efficiency', 'personal_income_tax_reduction', 'anti_corruption']::text[])
     ) AS v(office_name, slugs)
  ON v.office_name = o.canonical_name
JOIN public.research_areas ra
  ON ra.slug = ANY (v.slugs)
WHERE o.scope = 'local_special'
ON CONFLICT (office_id, research_area_id) DO NOTHING;

COMMIT;
