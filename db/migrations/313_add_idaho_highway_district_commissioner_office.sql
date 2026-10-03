-- Office for the elected board of a countywide highway district. Idaho's Ada
-- County Highway District (ACHD) builds and maintains every public road in
-- Ada County, and all Ada County voters elect its commissioners on
-- November 3, 2026 (Idaho Code 40-1404A as amended by SB 1356). The catalog
-- had no office at local_special scope for a highway district board, so the
-- contest could not be written.
--
-- The same migration adds aliases so College of Western Idaho trustee titles
-- ("College of Western Idaho Trustee, Zone 2") reach the existing
-- local_special Community College Trustee office.
--
-- The summary is byte-identical to backend/src/scripts/seedOffices.ts, and
-- the research areas match db/seeds/office_research_areas_v1.sql. On a fresh
-- migrations-only database research_areas is still empty, so the
-- research-area join inserts zero rows (same pattern as migration 305).

BEGIN;

INSERT INTO public.offices (scope, canonical_name, summary)
VALUES (
  'local_special',
  'Highway District Commissioner',
  'Setting the budget and property tax rate for county roads
Deciding which roads, bridges, and sidewalks get built or repaired
Hiring and overseeing the director who runs the highway district'
)
ON CONFLICT (scope, canonical_name) DO NOTHING;

INSERT INTO public.office_title_aliases (office_id, scope, alias_text, normalized_alias)
SELECT o.id, 'local_special', v.alias_text, v.normalized_alias
FROM public.offices o,
     (VALUES
        ('Highway District Commissioner', 'highway district commissioner'),
        ('County Highway District Commissioner', 'county highway district commissioner'),
        ('Ada County Highway District Commissioner', 'ada county highway district commissioner'),
        ('Highway Commissioner', 'highway commissioner'),
        ('Highway District Commission Member', 'highway district commission member')
     ) AS v(alias_text, normalized_alias)
WHERE o.scope = 'local_special'
  AND o.canonical_name = 'Highway District Commissioner'
ON CONFLICT (scope, normalized_alias) DO NOTHING;

INSERT INTO public.office_title_aliases (office_id, scope, alias_text, normalized_alias)
SELECT o.id, 'local_special', v.alias_text, v.normalized_alias
FROM public.offices o,
     (VALUES
        ('College of Western Idaho Trustee', 'college of western idaho trustee'),
        ('College Trustee', 'college trustee'),
        ('Community College Trustee Zone', 'community college trustee zone')
     ) AS v(alias_text, normalized_alias)
WHERE o.scope = 'local_special'
  AND o.canonical_name = 'Community College Trustee'
ON CONFLICT (scope, normalized_alias) DO NOTHING;

INSERT INTO public.office_research_areas (office_id, research_area_id)
SELECT o.id, ra.id
FROM public.offices o
JOIN public.research_areas ra
  ON ra.slug = ANY (ARRAY[
       'government_efficiency',
       'government_spending_reduction',
       'public_infrastructure'
     ]::text[])
WHERE o.scope = 'local_special'
  AND o.canonical_name = 'Highway District Commissioner'
ON CONFLICT (office_id, research_area_id) DO NOTHING;

COMMIT;
