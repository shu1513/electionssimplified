-- Add the criminal_justice_and_civil_liberties research area and link it to
-- every office that carries civil_rights, following migration 276's shape.
--
-- Why: the catalog had no area for policing, sentencing, incarceration, or
-- civil liberties, so those records were filed under Civil Rights (a random
-- sample of 30 Civil Rights records was mostly criminal-justice items:
-- pretrial DNA collection, sentencing reform, record sealing, police
-- discipline, book bans). A reader who opened a DC councilmember's Civil
-- Rights group found DNA-collection and police-discipline amendment votes
-- and asked why none were "strictly civil rights" (user report,
-- 2026-09-30). Civil Rights keeps equal-rights and anti-discrimination
-- records; its description is sharpened here so labelers route the rest.
--
-- Stance: "for" advances the area's goal (reform that reduces incarceration
-- or protects liberties: due process, privacy from searches and
-- surveillance, free expression); "against" cuts against it (pretrial DNA
-- collection, longer mandatory sentences, expanded surveillance). Same
-- polarity as civil_rights, so a tag moved from Civil Rights keeps its
-- stance (migration 311 does that move).
--
-- The seed layer (db/seeds/research_areas_v1.sql +
-- db/seeds/office_research_areas_v1.sql) is updated in the same change and
-- remains authoritative for links; this migration applies the identical
-- state to already-seeded databases so the area is usable without re-running
-- seeds. The office set is copied from civil_rights at run time rather than
-- listed by name, so it stays identical on any database.

BEGIN;

INSERT INTO public.research_areas (slug, name, description)
VALUES (
  'criminal_justice_and_civil_liberties',
  'Criminal Justice and Civil Liberties',
  'Reform policing, sentencing, and incarceration, and protect civil liberties such as due process, privacy from searches and surveillance, and free expression.'
)
ON CONFLICT (slug)
DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  updated_at = now();

UPDATE public.research_areas
SET description = 'Protect equal rights and anti-discrimination enforcement for race, sex, disability, religion, sexual orientation and gender identity, and equal access to voting and public life.',
    updated_at = now()
WHERE slug = 'civil_rights'
  AND description IS DISTINCT FROM 'Protect equal rights and anti-discrimination enforcement for race, sex, disability, religion, sexual orientation and gender identity, and equal access to voting and public life.';

-- Link the new area to every office that carries civil_rights. On a fresh
-- migrations-only database no office links exist yet (offices and their
-- areas come from the seeds, which DB_DEPLOYMENT.md runs AFTER db:migrate),
-- so zero copied rows is expected there and must not raise.
INSERT INTO public.office_research_areas (office_id, research_area_id)
SELECT link.office_id, new_area.id
FROM public.office_research_areas link
JOIN public.research_areas old_area ON old_area.id = link.research_area_id AND old_area.slug = 'civil_rights'
JOIN public.research_areas new_area ON new_area.slug = 'criminal_justice_and_civil_liberties'
ON CONFLICT (office_id, research_area_id) DO NOTHING;

COMMIT;
