-- Santa Monica CA elects its Rent Control Board citywide (three seats on the
-- Nov 3, 2026 ballot, LA County contest 10515 "Member of the Rent Control
-- Board"). Berkeley elects a Rent Stabilization Board the same way. No
-- place-scope rent board office existed, so the office matcher returned no
-- match and the contest could not be written.
--
-- The summary is byte-identical to backend/src/scripts/seedOffices.ts, and
-- the research areas match db/seeds/office_research_areas_v1.sql.

BEGIN;

INSERT INTO public.offices (scope, canonical_name, summary)
VALUES (
  'place',
  'Rent Control Board Member',
  E'Setting the yearly rent increase for rent-controlled apartments\nDeciding tenant and landlord petitions about rent and services\nApproving the rent board''s budget and the fee landlords pay'
)
ON CONFLICT (scope, canonical_name) DO NOTHING;

INSERT INTO public.office_title_aliases (office_id, scope, alias_text, normalized_alias)
SELECT o.id, 'place', v.alias_text, v.normalized_alias
FROM public.offices o
CROSS JOIN (
  VALUES
    ('Rent Control Board', 'rent control board'),
    ('Member of the Rent Control Board', 'member of the rent control board'),
    ('Rent Control Board Commissioner', 'rent control board commissioner'),
    ('Rent Stabilization Board', 'rent stabilization board'),
    ('Rent Stabilization Board Commissioner', 'rent stabilization board commissioner'),
    ('Rent Board', 'rent board')
) AS v(alias_text, normalized_alias)
WHERE o.scope = 'place'
  AND o.canonical_name = 'Rent Control Board Member'
ON CONFLICT (scope, normalized_alias) DO NOTHING;

-- Curated research areas, mirrored in db/seeds/office_research_areas_v1.sql.
-- housing_affordability and cost_of_living_reduction are the board's core
-- lever (the yearly rent adjustment). government_efficiency and
-- government_spending_reduction cover the board's own budget and the
-- registration fee it charges landlords.
--
-- On a fresh migrations-only database research_areas is still empty, so this
-- insert matches zero rows by design and the seed layer fills the links
-- afterward (same pattern as migration 220).
INSERT INTO public.office_research_areas (office_id, research_area_id)
SELECT o.id, ra.id
FROM public.offices o
JOIN public.research_areas ra
  ON ra.slug = ANY (ARRAY[
       'cost_of_living_reduction',
       'government_efficiency',
       'government_spending_reduction',
       'housing_affordability'
     ]::text[])
WHERE o.scope = 'place'
  AND o.canonical_name = 'Rent Control Board Member'
ON CONFLICT DO NOTHING;

COMMIT;
