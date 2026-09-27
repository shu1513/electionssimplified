-- New Hampshire districts the Census TIGER files do not carry.
--
-- 1. Executive Council. New Hampshire elects five Executive Councilors from
--    five districts made of whole towns and cities (RSA 662:2, as set by
--    Laws 2022, 46:1). Census publishes no layer for them, so no address ever
--    resolved to one. They get a new district type, state_executive_council,
--    and an office of the same scope ("Executive Councilor"). Massachusetts'
--    Governor's Council is the same kind of body and can reuse the type.
--
-- 2. State House floterial districts. A floterial is an extra House seat
--    elected by the voters of several base districts together (RSA 662:5,
--    as set by Laws 2022, 9:1). Census publishes only the 164 base districts,
--    so the 39 floterials (Hillsborough 37-41, 44, 45 and 32 more) were
--    missing. Every floterial is exactly the union of whole base districts,
--    which the law's town and ward lists confirm. They are state_lower rows,
--    with the next free district code in their county (Hillsborough 37 =
--    33537), the same code form Census uses for the base districts.
--
-- No polygons are stored. Each new district lists its building blocks in
-- district_components: base House district codes for a floterial, Census
-- county subdivision (town/city) codes for a council district. The address
-- lookup already gets both codes from the Census geocoder for every address,
-- so "the address is in a member" is the same test as "the address is inside
-- the union of the members", with no geometry to maintain.
--
-- Populations are ACS 2024 5-year totals (B01001_001E), the source the
-- districts loader uses: the sum of the base districts for a floterial and
-- the sum of the towns for a council district. The five council totals land
-- within 1.5% of each other, a check that no town is missing or doubled.
--
-- Saved addresses: users who saved an NH address before this migration have
-- no row for the new districts. Floterials are added from their saved base
-- district. A council district is added when their saved base district lies
-- wholly inside one council district (151 of 164). The other 13 base
-- districts straddle a council line; those users get the council race the
-- next time they save their address.
--
-- representation_power_score starts NULL. Run
-- `npm run districts:recompute-representation` after migrating.

BEGIN;

-- The four check constraints are rebuilt from their current value lists, so
-- a type added by another migration (e.g. local_special) is kept.
DO $$
DECLARE
  target record;
  allowed text[];
BEGIN
  FOR target IN
    SELECT *
    FROM (VALUES
      ('districts', 'chk_district_type', 'district_type'),
      ('user_districts', 'chk_user_districts_type', 'district_type'),
      ('offices', 'chk_offices_scope', 'scope'),
      ('office_title_aliases', 'chk_office_title_aliases_scope', 'scope')
    ) AS v(table_name, constraint_name, column_name)
  LOOP
    SELECT array_agg(match[1] ORDER BY ordinality)
    INTO allowed
    FROM pg_constraint AS c,
         regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''', 'g') WITH ORDINALITY AS m(match, ordinality)
    WHERE c.conname = target.constraint_name
      AND c.conrelid = format('public.%I', target.table_name)::regclass;

    IF allowed IS NULL OR NOT ('state_lower' = ANY (allowed)) THEN
      RAISE EXCEPTION 'migration 302: could not read the value list of %.%', target.table_name, target.constraint_name;
    END IF;

    IF NOT ('state_executive_council' = ANY (allowed)) THEN
      allowed := allowed || 'state_executive_council'::text;
    END IF;

    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', target.table_name, target.constraint_name);
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (%I = ANY (%L::text[]))',
      target.table_name, target.constraint_name, target.column_name, allowed
    );
  END LOOP;
END
$$;

CREATE TABLE public.district_components (
  district_id uuid NOT NULL REFERENCES public.districts (id) ON DELETE CASCADE,
  component_type text NOT NULL,
  component_geoid text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (district_id, component_type, component_geoid),
  CONSTRAINT chk_district_components_type
    CHECK (component_type IN ('state_lower', 'county_subdivision')),
  CONSTRAINT chk_district_components_geoid
    CHECK (component_geoid ~ '^[0-9]+$')
);

CREATE INDEX idx_district_components_component
  ON public.district_components (component_type, component_geoid);

COMMENT ON TABLE public.district_components IS
  'Districts with no Census polygon, defined as the union of Census units. An address is in the district when the geocoder returns any listed unit for it. state_lower = a base House district code (SLDL GEOID); county_subdivision = a Census town/city code (COUSUB GEOID).';

-- Executive Council districts ------------------------------------------------

CREATE TEMP TABLE nh_council_towns (
  council_district integer NOT NULL,
  cousub_geoid text NOT NULL,
  law_name text NOT NULL,
  population integer NOT NULL
) ON COMMIT DROP;

INSERT INTO nh_council_towns (council_district, cousub_geoid, law_name, population)
VALUES
    (1, '3300101060', 'Alton', 5994),
    (1, '3300104740', 'Belmont', 7392),
    (1, '3300110660', 'Center Harbor', 955),
    (1, '3300128740', 'Gilford', 7830),
    (1, '3300128980', 'Gilmanton', 4026),
    (1, '3300140180', 'Laconia', 17085),
    (1, '3300147140', 'Meredith', 6758),
    (1, '3300151540', 'New Hampton', 2509),
    (1, '3300167300', 'Sanbornton', 3053),
    (1, '3300177060', 'Tilton', 4063),
    (1, '3300300420', 'Albany', 790),
    (1, '3300303700', 'Bartlett', 3281),
    (1, '3300307940', 'Brookfield', 567),
    (1, '3300311780', 'Chatham', 430),
    (1, '3300314660', 'Conway', 10141),
    (1, '3300323380', 'Eaton', 501),
    (1, '3300323620', 'Effingham', 1912),
    (1, '3300327700', 'Freedom', 1494),
    (1, '3300332500', 'Hale''s Location', 229),
    (1, '3300334500', 'Hart''s Location', 49),
    (1, '3300338260', 'Jackson', 897),
    (1, '3300345060', 'Madison', 2680),
    (1, '3300349380', 'Moultonborough', 5126),
    (1, '3300358740', 'Ossipee', 4521),
    (1, '3300367780', 'Sandwich', 1757),
    (1, '3300376100', 'Tamworth', 2884),
    (1, '3300377620', 'Tuftonboro', 2569),
    (1, '3300378180', 'Wakefield', 5405),
    (1, '3300386420', 'Wolfeboro', 6571),
    (1, '3300702420', 'Atkinson and Gilmanton Academy Grant', 0),
    (1, '3300704100', 'Bean''s Grant', 0),
    (1, '3300704260', 'Bean''s Purchase', 0),
    (1, '3300705140', 'Berlin', 9383),
    (1, '3300708420', 'Cambridge', 22),
    (1, '3300711220', 'Chandler''s Purchase', 0),
    (1, '3300713220', 'Clarksville', 371),
    (1, '3300713780', 'Colebrook', 1988),
    (1, '3300713940', 'Columbia', 683),
    (1, '3300716100', 'Crawford''s Purchase', 0),
    (1, '3300716660', 'Cutt''s Grant', 0),
    (1, '3300716820', 'Dalton', 916),
    (1, '3300718340', 'Dix''s Grant', 0),
    (1, '3300718420', 'Dixville', 7),
    (1, '3300719300', 'Dummer', 299),
    (1, '3300725140', 'Errol', 314),
    (1, '3300725180', 'Erving''s Location', 0),
    (1, '3300730260', 'Gorham', 2682),
    (1, '3300731780', 'Green''s Grant', 26),
    (1, '3300732420', 'Hadley''s Purchase', 0),
    (1, '3300738820', 'Jefferson', 1013),
    (1, '3300739940', 'Kilkenny', 0),
    (1, '3300740420', 'Lancaster', 3216),
    (1, '3300743620', 'Low and Burbank''s Grant', 0),
    (1, '3300746020', 'Martin''s Location', 0),
    (1, '3300747860', 'Milan', 1334),
    (1, '3300748260', 'Millsfield', 5),
    (1, '3300756100', 'Northumberland', 1815),
    (1, '3300757860', 'Odell', 0),
    (1, '3300761620', 'Pinkham''s Grant', 8),
    (1, '3300761780', 'Pittsburg', 683),
    (1, '3300763860', 'Randolph', 420),
    (1, '3300767860', 'Sargent''s Purchase', 45),
    (1, '3300768500', 'Second College Grant', 0),
    (1, '3300768980', 'Shelburne', 530),
    (1, '3300773060', 'Stark', 419),
    (1, '3300773380', 'Stewartstown', 960),
    (1, '3300774180', 'Stratford', 950),
    (1, '3300774500', 'Success', 0),
    (1, '3300776580', 'Thompson & Meserve''s Purchase', 0),
    (1, '3300780740', 'Wentworth''s Location', 7),
    (1, '3300784420', 'Whitefield', 2516),
    (1, '3300900580', 'Alexandria', 1983),
    (1, '3300907540', 'Bridgewater', 1169),
    (1, '3300907700', 'Bristol', 3273),
    (1, '3300935220', 'Hebron', 883),
    (1, '3300942820', 'Livermore', 0),
    (1, '3300979380', 'Waterville Valley', 290),
    (1, '3301316980', 'Danbury', 1451),
    (1, '3301327380', 'Franklin', 8799),
    (1, '3301335860', 'Hill', 908),
    (1, '3301354260', 'Northfield', 4971),
    (1, '3301718820', 'Dover', 33364),
    (1, '3301719700', 'Durham', 15080),
    (1, '3301726020', 'Farmington', 6795),
    (1, '3301744820', 'Madbury', 2203),
    (1, '3301747700', 'Middleton', 1595),
    (1, '3301748660', 'Milton', 4538),
    (1, '3301751220', 'New Durham', 2748),
    (1, '3301765140', 'Rochester', 33144),
    (1, '3301765540', 'Rollinsford', 2626),
    (1, '3301769940', 'Somersworth', 12111),
    (2, '3300500820', 'Alstead', 1551),
    (2, '3300512260', 'Chesterfield', 3622),
    (2, '3300519140', 'Dublin', 1688),
    (2, '3300529220', 'Gilsum', 716),
    (2, '3300534420', 'Harrisville', 885),
    (2, '3300536660', 'Hinsdale', 3997),
    (2, '3300539300', 'Keene', 22939),
    (2, '3300545460', 'Marlborough', 2207),
    (2, '3300545700', 'Marlow', 855),
    (2, '3300550580', 'Nelson', 648),
    (2, '3300565700', 'Roxbury', 299),
    (2, '3300574900', 'Sullivan', 687),
    (2, '3300575300', 'Surry', 1052),
    (2, '3300578420', 'Walpole', 3690),
    (2, '3300582660', 'Westmoreland', 2237),
    (2, '3300585540', 'Winchester', 4212),
    (2, '3300710100', 'Carroll', 659),
    (2, '3300902020', 'Ashland', 2183),
    (2, '3300903940', 'Bath', 1097),
    (2, '3300905060', 'Benton', 386),
    (2, '3300905460', 'Bethlehem', 2537),
    (2, '3300908660', 'Campton', 3407),
    (2, '3300908980', 'Canaan', 3811),
    (2, '3300918740', 'Dorchester', 410),
    (2, '3300922020', 'Easton', 356),
    (2, '3300923860', 'Ellsworth', 51),
    (2, '3300924340', 'Enfield', 4475),
    (2, '3300927300', 'Franconia', 1060),
    (2, '3300930820', 'Grafton', 1354),
    (2, '3300932180', 'Groton', 507),
    (2, '3300933860', 'Hanover', 11685),
    (2, '3300934820', 'Haverhill', 4611),
    (2, '3300936900', 'Holderness', 1917),
    (2, '3300940660', 'Landaff', 420),
    (2, '3300941300', 'Lebanon', 14999),
    (2, '3300941860', 'Lincoln', 1461),
    (2, '3300942020', 'Lisbon', 1583),
    (2, '3300942580', 'Littleton', 6040),
    (2, '3300944100', 'Lyman', 464),
    (2, '3300944260', 'Lyme', 1710),
    (2, '3300948980', 'Monroe', 786),
    (2, '3300958340', 'Orange', 320),
    (2, '3300958500', 'Orford', 1295),
    (2, '3300961060', 'Piermont', 868),
    (2, '3300962660', 'Plymouth', 6601),
    (2, '3300965940', 'Rumney', 1458),
    (2, '3300974740', 'Sugar Hill', 658),
    (2, '3300976740', 'Thornton', 2799),
    (2, '3300978740', 'Warren', 942),
    (2, '3300980500', 'Wentworth', 1057),
    (2, '3300987060', 'Woodstock', 1214),
    (2, '3301133700', 'Hancock', 1791),
    (2, '3301160580', 'Peterborough', 6408),
    (2, '3301168820', 'Sharon', 442),
    (2, '3301301460', 'Andover', 2135),
    (2, '3301306260', 'Boscawen', 4044),
    (2, '3301306500', 'Bow', 8335),
    (2, '3301306980', 'Bradford', 1565),
    (2, '3301309860', 'Canterbury', 2353),
    (2, '3301314200', 'Concord', 44375),
    (2, '3301335540', 'Henniker', 6197),
    (2, '3301337540', 'Hopkinton', 6037),
    (2, '3301350900', 'Newbury', 2027),
    (2, '3301352100', 'New London', 4433),
    (2, '3301366980', 'Salisbury', 1609),
    (2, '3301375460', 'Sutton', 2239),
    (2, '3301378580', 'Warner', 2959),
    (2, '3301380020', 'Webster', 2227),
    (2, '3301384900', 'Wilmot', 1487),
    (2, '3301900260', 'Acworth', 851),
    (2, '3301911380', 'Charlestown', 4889),
    (2, '3301912900', 'Claremont', 13078),
    (2, '3301915060', 'Cornish', 1816),
    (2, '3301916340', 'Croydon', 798),
    (2, '3301931220', 'Grantham', 3465),
    (2, '3301940900', 'Langdon', 805),
    (2, '3301952580', 'Newport', 6375),
    (2, '3301962340', 'Plainfield', 2522),
    (2, '3301972740', 'Springfield', 1122),
    (2, '3301975060', 'Sunapee', 3416),
    (2, '3301977940', 'Unity', 1375),
    (3, '3301159940', 'Pelham', 14449),
    (3, '3301502340', 'Atkinson', 7267),
    (3, '3301507220', 'Brentwood', 4641),
    (3, '3301512100', 'Chester', 5300),
    (3, '3301517140', 'Danville', 4531),
    (3, '3301517940', 'Derry', 34116),
    (3, '3301521380', 'East Kingston', 2311),
    (3, '3301524660', 'Epping', 7430),
    (3, '3301525380', 'Exeter', 16151),
    (3, '3301527940', 'Fremont', 4831),
    (3, '3301531700', 'Greenland', 4106),
    (3, '3301532900', 'Hampstead', 9102),
    (3, '3301533060', 'Hampton', 16426),
    (3, '3301533460', 'Hampton Falls', 2328),
    (3, '3301539780', 'Kensington', 2009),
    (3, '3301540100', 'Kingston', 6275),
    (3, '3301550980', 'New Castle', 827),
    (3, '3301551380', 'Newfields', 2023),
    (3, '3301551620', 'Newington', 939),
    (3, '3301552340', 'Newmarket', 9463),
    (3, '3301552900', 'Newton', 4836),
    (3, '3301554580', 'North Hampton', 4543),
    (3, '3301562500', 'Plaistow', 7861),
    (3, '3301562900', 'Portsmouth', 22545),
    (3, '3301564020', 'Raymond', 10900),
    (3, '3301566180', 'Rye', 5611),
    (3, '3301566660', 'Salem', 30964),
    (3, '3301567620', 'Sandown', 6628),
    (3, '3301568260', 'Seabrook', 8427),
    (3, '3301571140', 'South Hampton', 984),
    (3, '3301574340', 'Stratham', 7754),
    (3, '3301585780', 'Windham', 16038),
    (4, '3300103220', 'Barnstead', 4994),
    (4, '3301104500', 'Bedford', 23746),
    (4, '3301129860', 'Goffstown', 18513),
    (4, '3301145140', 'Manchester', 115643),
    (4, '3301300660', 'Allenstown', 4743),
    (4, '3301312420', 'Chichester', 2745),
    (4, '3301324900', 'Epsom', 4939),
    (4, '3301337300', 'Hooksett', 15057),
    (4, '3301343380', 'Loudon', 5692),
    (4, '3301360020', 'Pembroke', 7438),
    (4, '3301361940', 'Pittsfield', 4105),
    (4, '3301502820', 'Auburn', 6119),
    (4, '3301509300', 'Candia', 4134),
    (4, '3301517460', 'Deerfield', 4932),
    (4, '3301543220', 'Londonderry', 26685),
    (4, '3301556820', 'Northwood', 4688),
    (4, '3301557460', 'Nottingham', 5357),
    (4, '3301703460', 'Barrington', 9489),
    (4, '3301741460', 'Lee', 4576),
    (4, '3301773860', 'Strafford', 4306),
    (5, '3300526500', 'Fitzwilliam', 2278),
    (5, '3300538500', 'Jaffrey', 5448),
    (5, '3300564420', 'Richmond', 1314),
    (5, '3300564580', 'Rindge', 6497),
    (5, '3300573700', 'Stoddard', 1072),
    (5, '3300575700', 'Swanzey', 7398),
    (5, '3300577380', 'Troy', 2005),
    (5, '3301101300', 'Amherst', 11861),
    (5, '3301101700', 'Antrim', 2692),
    (5, '3301104900', 'Bennington', 1588),
    (5, '3301108100', 'Brookline', 5736),
    (5, '3301117780', 'Deering', 1938),
    (5, '3301127140', 'Francestown', 1398),
    (5, '3301131540', 'Greenfield', 1730),
    (5, '3301131940', 'Greenville', 2084),
    (5, '3301136180', 'Hillsborough', 5980),
    (5, '3301137140', 'Hollis', 8603),
    (5, '3301137940', 'Hudson', 25557),
    (5, '3301142260', 'Litchfield', 8499),
    (5, '3301144580', 'Lyndeborough', 1616),
    (5, '3301146260', 'Mason', 1451),
    (5, '3301147540', 'Merrimack', 28164),
    (5, '3301148020', 'Milford', 16337),
    (5, '3301149140', 'Mont Vernon', 2636),
    (5, '3301150260', 'Nashua', 91294),
    (5, '3301150740', 'New Boston', 6165),
    (5, '3301151940', 'New Ipswich', 5310),
    (5, '3301176260', 'Temple', 1363),
    (5, '3301179780', 'Weare', 9170),
    (5, '3301185220', 'Wilton', 3960),
    (5, '3301185940', 'Windsor', 254),
    (5, '3301319460', 'Dunbarton', 3097),
    (5, '3301930500', 'Goshen', 1042),
    (5, '3301941700', 'Lempster', 953),
    (5, '3301978980', 'Washington', 1208);

DO $$
BEGIN
  IF (SELECT count(*) FROM nh_council_towns) <> 259
     OR (SELECT count(DISTINCT cousub_geoid) FROM nh_council_towns) <> 259 THEN
    RAISE EXCEPTION 'migration 302: expected 259 distinct New Hampshire towns in the council plan';
  END IF;
END
$$;

INSERT INTO public.districts (geoid_compact, name, state, state_fips, district_type, population)
SELECT
  '33EC' || council_district,
  'Executive Council District ' || council_district || '; New Hampshire',
  'NH',
  '33',
  'state_executive_council',
  sum(population)
FROM nh_council_towns
GROUP BY council_district
ON CONFLICT (district_type, geoid_compact) DO NOTHING;

INSERT INTO public.district_components (district_id, component_type, component_geoid)
SELECT d.id, 'county_subdivision', t.cousub_geoid
FROM nh_council_towns AS t
JOIN public.districts AS d
  ON d.district_type = 'state_executive_council'
 AND d.geoid_compact = '33EC' || t.council_district
ON CONFLICT DO NOTHING;

-- State House floterial districts --------------------------------------------

CREATE TEMP TABLE nh_floterials (
  geoid text NOT NULL,
  county text NOT NULL,
  district_number integer NOT NULL,
  seats integer NOT NULL,
  population integer NOT NULL,
  base_geoids text[] NOT NULL
) ON COMMIT DROP;

-- (code, county, district number, seats, population, base district codes)
INSERT INTO nh_floterials (geoid, county, district_number, seats, population, base_geoids)
VALUES
    ('33008', 'Belknap',  8, 2,  14508, ARRAY['33003', '33004']::text[]),
    ('33107', 'Carroll',  7, 1,  13661, ARRAY['33105', '33106']::text[]),
    ('33108', 'Carroll',  8, 2,  20569, ARRAY['33103', '33104']::text[]),
    ('33215', 'Cheshire', 15, 2,  32386, ARRAY['33201', '33202', '33203', '33204', '33205', '33206']::text[]),
    ('33216', 'Cheshire', 16, 1,  14071, ARRAY['33207', '33208', '33209']::text[]),
    ('33217', 'Cheshire', 17, 1,  17207, ARRAY['33210', '33211', '33212']::text[]),
    ('33218', 'Cheshire', 18, 2,  13633, ARRAY['33213', '33214']::text[]),
    ('33307', 'Coos',  7, 1,  13571, ARRAY['33304', '33305']::text[]),
    ('33417', 'Grafton', 17, 1,  14999, ARRAY['33413', '33414', '33415']::text[]),
    ('33418', 'Grafton', 18, 1,  18185, ARRAY['33409', '33410', '33411', '33416']::text[]),
    ('33537', 'Hillsborough', 37, 1,  28198, ARRAY['33534', '33543']::text[]),
    ('33538', 'Hillsborough', 38, 2,  34056, ARRAY['33513', '33514']::text[]),
    ('33539', 'Hillsborough', 39, 2,  27715, ARRAY['33515', '33516', '33520']::text[]),
    ('33540', 'Hillsborough', 40, 4,  49040, ARRAY['33518', '33519', '33521', '33522', '33523']::text[]),
    ('33541', 'Hillsborough', 41, 3,  38888, ARRAY['33517', '33524', '33525', '33526']::text[]),
    ('33544', 'Hillsborough', 44, 2,  27683, ARRAY['33528', '33529']::text[]),
    ('33545', 'Hillsborough', 45, 1,  17874, ARRAY['33535', '33536']::text[]),
    ('33625', 'Merrimack', 25, 1,  13770, ARRAY['33602', '33603']::text[]),
    ('33626', 'Merrimack', 26, 1,  20419, ARRAY['33601', '33604', '33605']::text[]),
    ('33627', 'Merrimack', 27, 2,  27836, ARRAY['33610', '33611', '33614']::text[]),
    ('33628', 'Merrimack', 28, 1,  12977, ARRAY['33615', '33616', '33617']::text[]),
    ('33629', 'Merrimack', 29, 1,  14454, ARRAY['33618', '33623', '33624']::text[]),
    ('33630', 'Merrimack', 30, 1,  16944, ARRAY['33619', '33620', '33621', '33622']::text[]),
    ('33731', 'Rockingham', 31, 2,  20485, ARRAY['33702', '33703']::text[]),
    ('33732', 'Rockingham', 32, 1,  14003, ARRAY['33706', '33707', '33708']::text[]),
    ('33733', 'Rockingham', 33, 1,  35391, ARRAY['33710', '33711', '33712']::text[]),
    ('33734', 'Rockingham', 34, 1,  17688, ARRAY['33714', '33715']::text[]),
    ('33735', 'Rockingham', 35, 1,  42723, ARRAY['33716', '33717']::text[]),
    ('33736', 'Rockingham', 36, 1,  18018, ARRAY['33719', '33720']::text[]),
    ('33737', 'Rockingham', 37, 1,  10105, ARRAY['33721', '33722']::text[]),
    ('33738', 'Rockingham', 38, 1,  14260, ARRAY['33723', '33724']::text[]),
    ('33739', 'Rockingham', 39, 1,  14206, ARRAY['33726', '33727', '33728']::text[]),
    ('33740', 'Rockingham', 40, 1,  24853, ARRAY['33729', '33730']::text[]),
    ('33818', 'Strafford', 18, 1,  18138, ARRAY['33803', '33804']::text[]),
    ('33819', 'Strafford', 19, 3,  27029, ARRAY['33805', '33806', '33807', '33808', '33809']::text[]),
    ('33820', 'Strafford', 20, 1,  27090, ARRAY['33810', '33811']::text[]),
    ('33821', 'Strafford', 21, 3,  28133, ARRAY['33813', '33814', '33815', '33816', '33817']::text[]),
    ('33907', 'Sullivan',  7, 1,  16977, ARRAY['33902', '33903']::text[]),
    ('33908', 'Sullivan',  8, 2,  23273, ARRAY['33904', '33905', '33906']::text[]);

INSERT INTO public.districts (geoid_compact, name, state, state_fips, district_type, population)
SELECT
  geoid,
  'State House District ' || county || ' ' || lpad(district_number::text, 2, '0') || ' (2024); New Hampshire',
  'NH',
  '33',
  'state_lower',
  population
FROM nh_floterials
ON CONFLICT (district_type, geoid_compact) DO NOTHING;

INSERT INTO public.district_components (district_id, component_type, component_geoid)
SELECT d.id, 'state_lower', base.geoid
FROM nh_floterials AS f
CROSS JOIN LATERAL unnest(f.base_geoids) AS base(geoid)
JOIN public.districts AS d
  ON d.district_type = 'state_lower'
 AND d.geoid_compact = f.geoid
ON CONFLICT DO NOTHING;

-- Office ----------------------------------------------------------------------

INSERT INTO public.offices (scope, canonical_name, summary)
VALUES (
  'state_executive_council',
  'Executive Councilor',
  'Approving or rejecting the judges and officials the governor picks
Approving or rejecting state contracts and spending
Approving or rejecting pardons'
)
ON CONFLICT (scope, canonical_name) DO NOTHING;

INSERT INTO public.office_title_aliases (office_id, scope, alias_text, normalized_alias)
SELECT o.id, 'state_executive_council', v.alias_text, v.normalized_alias
FROM public.offices AS o,
     (VALUES
        ('Executive Councilor', 'executive councilor'),
        ('Executive Councillor', 'executive councillor'),
        ('Governor''s Councillor', 'governor s councillor')
     ) AS v(alias_text, normalized_alias)
WHERE o.scope = 'state_executive_council'
  AND o.canonical_name = 'Executive Councilor'
ON CONFLICT (scope, normalized_alias) DO NOTHING;

INSERT INTO public.office_research_areas (office_id, research_area_id)
SELECT o.id, ra.id
FROM public.offices AS o
JOIN public.research_areas AS ra
  ON ra.slug = ANY (ARRAY[
       'anti_corruption',
       'civil_rights',
       'government_efficiency',
       'government_spending_reduction',
       'impartiality',
       'legal_competence',
       'public_safety_and_crime_control',
       'womens_reproductive_rights'
     ]::text[])
WHERE o.scope = 'state_executive_council'
  AND o.canonical_name = 'Executive Councilor'
ON CONFLICT DO NOTHING;

-- Saved addresses ---------------------------------------------------------------

-- Floterials: every user saved into a member base district.
INSERT INTO public.user_districts (user_id, district_id, district_type)
SELECT DISTINCT ud.user_id, c.district_id, 'state_lower'
FROM public.user_districts AS ud
JOIN public.districts AS base
  ON base.id = ud.district_id
 AND base.district_type = 'state_lower'
 AND base.state_fips = '33'
JOIN public.district_components AS c
  ON c.component_type = 'state_lower'
 AND c.component_geoid = base.geoid_compact
ON CONFLICT (user_id, district_id) DO NOTHING;

-- Council districts: only through base districts that sit wholly inside one
-- council district (derived from the RSA 662:5 and 662:2 town lists).
CREATE TEMP TABLE nh_base_council (
  base_geoid text PRIMARY KEY,
  council_district integer NOT NULL
) ON COMMIT DROP;

INSERT INTO nh_base_council (base_geoid, council_district)
VALUES
    ('33001', 1),
    ('33002', 1),
    ('33003', 1),
    ('33004', 1),
    ('33005', 1),
    ('33006', 1),
    ('33101', 1),
    ('33102', 1),
    ('33103', 1),
    ('33104', 1),
    ('33105', 1),
    ('33106', 1),
    ('33201', 2),
    ('33202', 2),
    ('33203', 2),
    ('33204', 2),
    ('33205', 2),
    ('33206', 2),
    ('33207', 2),
    ('33208', 2),
    ('33210', 5),
    ('33211', 2),
    ('33212', 5),
    ('33214', 5),
    ('33301', 1),
    ('33302', 1),
    ('33303', 1),
    ('33305', 1),
    ('33306', 1),
    ('33401', 2),
    ('33402', 2),
    ('33405', 2),
    ('33406', 2),
    ('33407', 2),
    ('33408', 2),
    ('33409', 2),
    ('33410', 1),
    ('33412', 2),
    ('33413', 2),
    ('33414', 2),
    ('33415', 2),
    ('33416', 2),
    ('33501', 3),
    ('33502', 4),
    ('33503', 5),
    ('33504', 5),
    ('33505', 5),
    ('33506', 5),
    ('33507', 5),
    ('33508', 5),
    ('33509', 5),
    ('33510', 5),
    ('33511', 5),
    ('33512', 5),
    ('33513', 5),
    ('33514', 5),
    ('33515', 4),
    ('33516', 4),
    ('33517', 4),
    ('33518', 4),
    ('33519', 4),
    ('33520', 4),
    ('33521', 4),
    ('33522', 4),
    ('33523', 4),
    ('33524', 4),
    ('33525', 4),
    ('33526', 4),
    ('33527', 5),
    ('33528', 5),
    ('33529', 4),
    ('33530', 5),
    ('33532', 5),
    ('33533', 2),
    ('33534', 5),
    ('33535', 5),
    ('33536', 5),
    ('33542', 5),
    ('33543', 5),
    ('33601', 2),
    ('33602', 1),
    ('33603', 1),
    ('33606', 2),
    ('33607', 2),
    ('33608', 2),
    ('33609', 2),
    ('33611', 4),
    ('33612', 4),
    ('33613', 4),
    ('33614', 4),
    ('33615', 2),
    ('33616', 2),
    ('33617', 2),
    ('33618', 2),
    ('33619', 2),
    ('33620', 2),
    ('33621', 2),
    ('33622', 2),
    ('33623', 2),
    ('33624', 2),
    ('33701', 4),
    ('33702', 4),
    ('33703', 3),
    ('33704', 3),
    ('33705', 3),
    ('33706', 3),
    ('33707', 3),
    ('33708', 3),
    ('33709', 3),
    ('33710', 3),
    ('33711', 3),
    ('33712', 3),
    ('33713', 3),
    ('33714', 3),
    ('33715', 3),
    ('33716', 4),
    ('33717', 3),
    ('33718', 3),
    ('33719', 3),
    ('33720', 3),
    ('33721', 3),
    ('33722', 3),
    ('33723', 3),
    ('33724', 3),
    ('33725', 3),
    ('33726', 3),
    ('33727', 3),
    ('33728', 3),
    ('33729', 3),
    ('33730', 3),
    ('33801', 1),
    ('33802', 1),
    ('33803', 1),
    ('33804', 4),
    ('33805', 1),
    ('33806', 1),
    ('33807', 1),
    ('33808', 1),
    ('33809', 1),
    ('33810', 1),
    ('33812', 1),
    ('33813', 1),
    ('33814', 1),
    ('33815', 1),
    ('33816', 1),
    ('33817', 1),
    ('33901', 2),
    ('33902', 2),
    ('33903', 2),
    ('33905', 2),
    ('33906', 2);

INSERT INTO public.user_districts (user_id, district_id, district_type)
SELECT DISTINCT ud.user_id, council.id, 'state_executive_council'
FROM public.user_districts AS ud
JOIN public.districts AS base
  ON base.id = ud.district_id
 AND base.district_type = 'state_lower'
 AND base.state_fips = '33'
JOIN nh_base_council AS map
  ON map.base_geoid = base.geoid_compact
JOIN public.districts AS council
  ON council.district_type = 'state_executive_council'
 AND council.geoid_compact = '33EC' || map.council_district
ON CONFLICT (user_id, district_id) DO NOTHING;

COMMIT;
