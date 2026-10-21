-- Office for the elected board of a water district. The Santa Clara Valley
-- Water District (Valley Water) elects one director per geographic district,
-- and District 7 (Palo Alto, Mountain View, Los Altos, Los Altos Hills, Los
-- Gatos, Monte Sereno, parts of south San Jose) is on the November 3, 2026
-- ballot. The catalog had no office at local_special scope for a water
-- district board, so the contest could not be written on its reviewed
-- local_special row (CA:SCVWD:7).
--
-- The summary is byte-identical to backend/src/scripts/seedOffices.ts, and
-- the research areas match db/seeds/office_research_areas_v1.sql. On a fresh
-- migrations-only database research_areas is still empty, so the
-- research-area join inserts zero rows (same pattern as migration 313).

BEGIN;

INSERT INTO public.offices (scope, canonical_name, summary)
VALUES (
  'local_special',
  'Water District Director',
  'Setting water rates and the district''s budget
Deciding on dams, pipelines, recycling, and flood-control projects
Hiring and overseeing the general manager who runs the water district'
)
ON CONFLICT (scope, canonical_name) DO NOTHING;

INSERT INTO public.office_title_aliases (office_id, scope, alias_text, normalized_alias)
SELECT o.id, 'local_special', v.alias_text, v.normalized_alias
FROM public.offices o,
     (VALUES
        ('Water District Director', 'water district director'),
        ('Water District Board Member', 'water district board member'),
        ('Water District Board of Directors', 'water district board of directors'),
        ('Director, Water District', 'director water district'),
        ('Valley Water Director', 'valley water director')
     ) AS v(alias_text, normalized_alias)
WHERE o.scope = 'local_special'
  AND o.canonical_name = 'Water District Director'
ON CONFLICT (scope, normalized_alias) DO NOTHING;

INSERT INTO public.office_research_areas (office_id, research_area_id)
SELECT o.id, ra.id
FROM public.offices o
JOIN public.research_areas ra
  ON ra.slug = ANY (ARRAY[
       'cost_of_living_reduction',
       'environment_and_public_health',
       'government_efficiency',
       'government_spending_reduction',
       'public_infrastructure'
     ]::text[])
WHERE o.scope = 'local_special'
  AND o.canonical_name = 'Water District Director'
ON CONFLICT (office_id, research_area_id) DO NOTHING;

COMMIT;
