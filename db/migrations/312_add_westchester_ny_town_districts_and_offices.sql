-- New York towns as districts, starting with Westchester County.
--
-- New York towns are county subdivisions, not Census places, so the districts
-- table had no row for them and no address ever resolved to one. Town offices
-- (supervisor, clerk, justice, highway superintendent, council) are on the
-- November ballot in even years in Westchester (county BOE 2026 general
-- candidate list), so Westchester voters were missing those contests.
--
-- Each town is a place row whose geoid_compact is its Census county
-- subdivision code (COUSUB GEOID, 10 digits) and whose single component is
-- that same code. The address lookup already gets county subdivision codes
-- from the Census geocoder for every address (migration 306 added
-- district_components for New Hampshire's Executive Council), so a town row
-- resolves through district_components with no polygon to store. Villages
-- and cities inside a town keep their own place rows: a Dobbs Ferry address
-- resolves to the village row (Places layer) and the Greenburgh town row
-- (county subdivision component), which is how the ballot works there.
--
-- Towns coextensive with a village or city are skipped because that
-- government already has a place row: Harrison (village), Mount Kisco
-- (village), Scarsdale (village), and the six cities. 16 towns are added.
-- Populations are 2020 Census counts (POP100) from the TIGERweb county
-- subdivisions layer.
--
-- Two town offices had no catalog entry at place scope: Town Supervisor and
-- Highway Superintendent. Both are added with aliases. Town Clerk already
-- aliases to City Clerk, Town Trustee/Village Trustee to Municipal Trustee,
-- Town Board Member to Town Council Member, and town/village justices match
-- Place Level Judge through the judicial family. The summaries are
-- byte-identical to backend/src/scripts/seedOffices.ts and the research
-- areas match db/seeds/office_research_areas_v1.sql. On a fresh
-- migrations-only database research_areas is empty, so the research-area
-- join inserts zero rows (same pattern as migration 305).
--
-- representation_power_score starts NULL. Run
-- `npm run districts:recompute-representation` after migrating.

BEGIN;

CREATE TEMP TABLE westchester_towns (
  cousub_geoid text NOT NULL,
  town_name text NOT NULL,
  population integer NOT NULL
) ON COMMIT DROP;

INSERT INTO westchester_towns (cousub_geoid, town_name, population)
VALUES
  ('3611905320', 'Bedford', 17309),
  ('3611918410', 'Cortlandt', 42545),
  ('3611921820', 'Eastchester', 34641),
  ('3611930367', 'Greenburgh', 95397),
  ('3611942136', 'Lewisboro', 12265),
  ('3611944842', 'Mamaroneck', 31758),
  ('3611949011', 'Mount Pleasant', 44436),
  ('3611950078', 'New Castle', 18311),
  ('3611951693', 'North Castle', 12408),
  ('3611953517', 'North Salem', 5243),
  ('3611955541', 'Ossining', 40061),
  ('3611957012', 'Pelham', 13078),
  ('3611959685', 'Pound Ridge', 5082),
  ('3611964320', 'Rye', 49613),
  ('3611968308', 'Somers', 21541),
  ('3611984077', 'Yorktown', 36569);

INSERT INTO public.districts (geoid_compact, name, state, state_fips, district_type, population)
SELECT
  cousub_geoid,
  town_name || ' town, New York',
  'NY',
  '36',
  'place',
  population
FROM westchester_towns
ON CONFLICT (district_type, geoid_compact) DO NOTHING;

INSERT INTO public.district_components (district_id, component_type, component_geoid)
SELECT d.id, 'county_subdivision', t.cousub_geoid
FROM westchester_towns AS t
JOIN public.districts AS d
  ON d.district_type = 'place'
 AND d.geoid_compact = t.cousub_geoid
ON CONFLICT DO NOTHING;

-- Town offices ---------------------------------------------------------------

INSERT INTO public.offices (scope, canonical_name, summary)
VALUES
  (
    'place',
    'Town Supervisor',
    'Proposing the town budget and your town property tax rate
Running town departments, such as police, roads, and parks
Leading the town board and signing town contracts'
  ),
  (
    'place',
    'Highway Superintendent',
    'Deciding which town roads get paved and plowed first
Spending the town''s road and snow removal budget
Hiring and overseeing the town highway crew'
  )
ON CONFLICT (scope, canonical_name) DO NOTHING;

INSERT INTO public.office_title_aliases (office_id, scope, alias_text, normalized_alias)
SELECT o.id, 'place', v.alias_text, v.normalized_alias
FROM public.offices o,
     (VALUES
        ('Town Supervisor', 'town supervisor'),
        ('Supervisor', 'supervisor'),
        ('Town Supervisor (Unexpired Term)', 'town supervisor unexpired term')
     ) AS v(alias_text, normalized_alias)
WHERE o.scope = 'place'
  AND o.canonical_name = 'Town Supervisor'
ON CONFLICT (scope, normalized_alias) DO NOTHING;

INSERT INTO public.office_title_aliases (office_id, scope, alias_text, normalized_alias)
SELECT o.id, 'place', v.alias_text, v.normalized_alias
FROM public.offices o,
     (VALUES
        ('Highway Superintendent', 'highway superintendent'),
        ('Town Highway Superintendent', 'town highway superintendent'),
        ('Superintendent of Highways', 'superintendent of highways'),
        ('Town Superintendent of Highways', 'town superintendent of highways')
     ) AS v(alias_text, normalized_alias)
WHERE o.scope = 'place'
  AND o.canonical_name = 'Highway Superintendent'
ON CONFLICT (scope, normalized_alias) DO NOTHING;

INSERT INTO public.office_research_areas (office_id, research_area_id)
SELECT o.id, ra.id
FROM public.offices o
JOIN public.research_areas ra
  ON ra.slug = ANY (ARRAY[
       'government_spending_reduction',
       'government_efficiency',
       'public_infrastructure',
       'housing_affordability',
       'environment_and_public_health',
       'public_safety_and_crime_control',
       'social_programs_and_welfare',
       'civil_rights',
       'criminal_justice_and_civil_liberties',
       'anti_corruption',
       'corporate_accountability',
       'data_privacy'
     ]::text[])
WHERE o.scope = 'place'
  AND o.canonical_name = 'Town Supervisor'
ON CONFLICT (office_id, research_area_id) DO NOTHING;

INSERT INTO public.office_research_areas (office_id, research_area_id)
SELECT o.id, ra.id
FROM public.offices o
JOIN public.research_areas ra
  ON ra.slug = ANY (ARRAY[
       'public_infrastructure',
       'government_spending_reduction',
       'government_efficiency',
       'environment_and_public_health',
       'public_safety_and_crime_control',
       'anti_corruption'
     ]::text[])
WHERE o.scope = 'place'
  AND o.canonical_name = 'Highway Superintendent'
ON CONFLICT (office_id, research_area_id) DO NOTHING;

COMMIT;
