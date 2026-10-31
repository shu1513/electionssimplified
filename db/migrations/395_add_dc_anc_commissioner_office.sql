-- District of Columbia Advisory Neighborhood Commissioners. Each of the 345
-- single-member districts (SMDs) drawn after the 2020 census elects one
-- commissioner in the November general election, nonpartisan, and the
-- catalog had no office for the seat, so the contests could not be written.
--
-- The SMDs themselves are loaded as reviewed local_special boundaries by
-- `npm run manual:dc-anc-smd:import` (backend/src/scripts/importDcAncSmdBoundaries.ts),
-- geometry from the DC GIS "Single Member District - 2023" layer.
--
-- SMD lines run down street centerlines, and the address resolver refuses a
-- 25 m band on every reviewed edge. That band dropped 95 of 330 sampled DC
-- addresses (official Address Points, geocoded by the Census batch
-- geocoder): the geocoder offsets each point 5-8 m to its side of the street,
-- inside the band. edge_margin_meters lets a reviewed boundary carry a
-- smaller band of its own; with 3 m, 328 of the 330 resolved to their
-- official SMD. Every existing row keeps 25.
--
-- The summary is byte-identical to backend/src/scripts/seedOffices.ts, and
-- the research areas match db/seeds/office_research_areas_v1.sql.

BEGIN;

ALTER TABLE public.local_special_boundaries
  ADD COLUMN edge_margin_meters real NOT NULL DEFAULT 25
    CONSTRAINT chk_local_special_boundaries_edge_margin
    CHECK (edge_margin_meters >= 0 AND edge_margin_meters <= 25);

COMMENT ON COLUMN public.local_special_boundaries.edge_margin_meters IS
  'Band (meters) on each edge in which the resolver refuses a point. 25 unless review showed geocoded points fall on the correct side of this layer''s street-centerline edges.';

INSERT INTO public.offices (scope, canonical_name, summary)
VALUES (
  'local_special',
  'Advisory Neighborhood Commissioner',
  E'Advising city agencies on zoning, building permits, and liquor licenses nearby\nWeighing in on traffic, parking, sidewalks, and public safety plans\nSpeaking for about 2,000 neighbors; the city must give these views great weight'
)
ON CONFLICT (scope, canonical_name) DO NOTHING;

INSERT INTO public.office_title_aliases (office_id, scope, alias_text, normalized_alias)
SELECT o.id, 'local_special', v.alias_text, v.normalized_alias
FROM public.offices o
CROSS JOIN (
  VALUES
    ('Advisory Neighborhood Commissioner', 'advisory neighborhood commissioner'),
    ('Advisory Neighborhood Commission Member', 'advisory neighborhood commission member'),
    ('Advisory Neighborhood Commission', 'advisory neighborhood commission'),
    ('ANC Commissioner', 'anc commissioner')
) AS v(alias_text, normalized_alias)
WHERE o.scope = 'local_special'
  AND o.canonical_name = 'Advisory Neighborhood Commissioner'
ON CONFLICT (scope, normalized_alias) DO NOTHING;

-- Curated research areas, mirrored in db/seeds/office_research_areas_v1.sql.
-- A commission's formal advice covers zoning and development
-- (housing_affordability), streets and transit (public_infrastructure),
-- policing and liquor licensing (public_safety_and_crime_control), and city
-- service delivery (government_efficiency).
--
-- On a fresh migrations-only database research_areas is still empty, so this
-- insert matches zero rows by design and the seed layer fills the links
-- afterward (same pattern as migration 220).
INSERT INTO public.office_research_areas (office_id, research_area_id)
SELECT o.id, ra.id
FROM public.offices o
JOIN public.research_areas ra
  ON ra.slug = ANY (ARRAY[
       'government_efficiency',
       'housing_affordability',
       'public_infrastructure',
       'public_safety_and_crime_control'
     ]::text[])
WHERE o.scope = 'local_special'
  AND o.canonical_name = 'Advisory Neighborhood Commissioner'
ON CONFLICT DO NOTHING;

COMMIT;
