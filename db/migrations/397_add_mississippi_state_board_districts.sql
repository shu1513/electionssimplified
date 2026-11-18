-- Mississippi's Public Service Commission and Transportation Commission.
--
-- Each board has three members, one elected from each of the three Supreme
-- Court districts (Miss. Code 77-1-1 and 65-1-3). The districts are lists of
-- whole counties set by Miss. Code 9-3-1 (Laws 1987, ch. 491); no county is
-- split. All six seats are elected every four years with the governor
-- (Miss. Code 23-15-193), next in 2027. Census publishes no layer for these
-- districts, so no address ever resolved to one.
--
-- They get a new district type, state_board: a district drawn only for a
-- statewide board or commission. Louisiana's Board of Elementary and
-- Secondary Education districts can reuse it. Both Mississippi boards share
-- the same three rows, since the lines are the same.
--
-- Numbering follows the Secretary of State: District 1 = Central,
-- District 2 = Southern, District 3 = Northern. Ballots print the contests as
-- "Public Service Commissioner-Northern District" and "Transportation
-- Commissioner-Northern District".
--
-- No polygons are stored. Each district lists its counties in
-- district_components with the new component type 'county' (5-digit county
-- FIPS code, the same value as districts.geoid_compact for county rows). The
-- address lookup already gets the county code from the Census geocoder for
-- every address.
--
-- Populations are the sums of the county rows' ACS totals, the source the
-- districts loader uses. The three add up to 2,946,779, the Mississippi
-- statewide total, a check that no county is missing or doubled.
--
-- Saved addresses: every county lies wholly inside one district, so every
-- user with a saved Mississippi county gets their board district.
--
-- representation_power_score starts NULL. Run
-- `npm run districts:recompute-representation` after migrating.

BEGIN;

-- The four check constraints are rebuilt from their current value lists, so
-- a type added by another migration is kept (same reader as migration 306).
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
    SELECT CASE
             WHEN def ~ '''\{[a-z_,]+\}''' THEN
               string_to_array(substring(def FROM '''\{([a-z_,]+)\}'''), ',')
             ELSE
               ARRAY(SELECT m[1] FROM regexp_matches(def, '''([a-z_]+)''', 'g') AS m)
           END
    INTO allowed
    FROM (
      SELECT pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint AS c
      WHERE c.conname = target.constraint_name
        AND c.conrelid = format('public.%I', target.table_name)::regclass
    ) AS constraint_def;

    IF allowed IS NULL OR NOT ('state_lower' = ANY (allowed)) THEN
      RAISE EXCEPTION 'migration 397: could not read the value list of %.%', target.table_name, target.constraint_name;
    END IF;

    IF NOT ('state_board' = ANY (allowed)) THEN
      allowed := allowed || 'state_board'::text;
    END IF;

    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', target.table_name, target.constraint_name);
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (%I = ANY (%L::text[]))',
      target.table_name, target.constraint_name, target.column_name, allowed
    );
  END LOOP;
END
$$;

-- district_components gains whole counties as a building block.
DO $$
DECLARE
  def text;
  allowed text[];
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO def
  FROM pg_constraint AS c
  WHERE c.conname = 'chk_district_components_type'
    AND c.conrelid = 'public.district_components'::regclass;

  allowed := ARRAY(SELECT m[1] FROM regexp_matches(def, '''([a-z_]+)''', 'g') AS m);
  IF NOT ('state_lower' = ANY (allowed)) THEN
    RAISE EXCEPTION 'migration 397: could not read the value list of district_components.chk_district_components_type';
  END IF;
  IF NOT ('county' = ANY (allowed)) THEN
    allowed := allowed || 'county'::text;
  END IF;

  ALTER TABLE public.district_components DROP CONSTRAINT chk_district_components_type;
  EXECUTE format(
    'ALTER TABLE public.district_components ADD CONSTRAINT chk_district_components_type CHECK (component_type = ANY (%L::text[]))',
    allowed
  );
END
$$;

COMMENT ON TABLE public.district_components IS
  'Districts with no Census polygon, defined as the union of Census units. An address is in the district when the geocoder returns any listed unit for it. state_lower = a base House district code (SLDL GEOID); county_subdivision = a Census town/city code (COUSUB GEOID); county = a 5-digit county FIPS code.';

-- Districts ---------------------------------------------------------------------

CREATE TEMP TABLE ms_board_districts (
  district_number integer PRIMARY KEY,
  label text NOT NULL,
  population integer NOT NULL
) ON COMMIT DROP;

INSERT INTO ms_board_districts (district_number, label, population)
VALUES
    (1, 'Central', 914732),
    (2, 'Southern', 1040978),
    (3, 'Northern', 991069);

CREATE TEMP TABLE ms_board_counties (
  district_number integer NOT NULL,
  county_geoid text PRIMARY KEY,
  county_name text NOT NULL
) ON COMMIT DROP;

INSERT INTO ms_board_counties (district_number, county_geoid, county_name)
VALUES
    (1, '28011', 'Bolivar'),
    (1, '28021', 'Claiborne'),
    (1, '28029', 'Copiah'),
    (1, '28049', 'Hinds'),
    (1, '28051', 'Holmes'),
    (1, '28053', 'Humphreys'),
    (1, '28055', 'Issaquena'),
    (1, '28063', 'Jefferson'),
    (1, '28069', 'Kemper'),
    (1, '28075', 'Lauderdale'),
    (1, '28079', 'Leake'),
    (1, '28089', 'Madison'),
    (1, '28099', 'Neshoba'),
    (1, '28101', 'Newton'),
    (1, '28103', 'Noxubee'),
    (1, '28121', 'Rankin'),
    (1, '28123', 'Scott'),
    (1, '28125', 'Sharkey'),
    (1, '28133', 'Sunflower'),
    (1, '28149', 'Warren'),
    (1, '28151', 'Washington'),
    (1, '28163', 'Yazoo'),
    (2, '28001', 'Adams'),
    (2, '28005', 'Amite'),
    (2, '28023', 'Clarke'),
    (2, '28031', 'Covington'),
    (2, '28035', 'Forrest'),
    (2, '28037', 'Franklin'),
    (2, '28039', 'George'),
    (2, '28041', 'Greene'),
    (2, '28045', 'Hancock'),
    (2, '28047', 'Harrison'),
    (2, '28059', 'Jackson'),
    (2, '28061', 'Jasper'),
    (2, '28065', 'Jefferson Davis'),
    (2, '28067', 'Jones'),
    (2, '28073', 'Lamar'),
    (2, '28077', 'Lawrence'),
    (2, '28085', 'Lincoln'),
    (2, '28091', 'Marion'),
    (2, '28109', 'Pearl River'),
    (2, '28111', 'Perry'),
    (2, '28113', 'Pike'),
    (2, '28127', 'Simpson'),
    (2, '28129', 'Smith'),
    (2, '28131', 'Stone'),
    (2, '28147', 'Walthall'),
    (2, '28153', 'Wayne'),
    (2, '28157', 'Wilkinson'),
    (3, '28003', 'Alcorn'),
    (3, '28007', 'Attala'),
    (3, '28009', 'Benton'),
    (3, '28013', 'Calhoun'),
    (3, '28015', 'Carroll'),
    (3, '28017', 'Chickasaw'),
    (3, '28019', 'Choctaw'),
    (3, '28025', 'Clay'),
    (3, '28027', 'Coahoma'),
    (3, '28033', 'DeSoto'),
    (3, '28043', 'Grenada'),
    (3, '28057', 'Itawamba'),
    (3, '28071', 'Lafayette'),
    (3, '28081', 'Lee'),
    (3, '28083', 'Leflore'),
    (3, '28087', 'Lowndes'),
    (3, '28093', 'Marshall'),
    (3, '28095', 'Monroe'),
    (3, '28097', 'Montgomery'),
    (3, '28105', 'Oktibbeha'),
    (3, '28107', 'Panola'),
    (3, '28115', 'Pontotoc'),
    (3, '28117', 'Prentiss'),
    (3, '28119', 'Quitman'),
    (3, '28135', 'Tallahatchie'),
    (3, '28137', 'Tate'),
    (3, '28139', 'Tippah'),
    (3, '28141', 'Tishomingo'),
    (3, '28143', 'Tunica'),
    (3, '28145', 'Union'),
    (3, '28155', 'Webster'),
    (3, '28159', 'Winston'),
    (3, '28161', 'Yalobusha');

DO $$
BEGIN
  IF (SELECT count(*) FROM ms_board_counties) <> 82 THEN
    RAISE EXCEPTION 'migration 397: expected all 82 Mississippi counties in the district plan';
  END IF;
END
$$;

INSERT INTO public.districts (geoid_compact, name, state, state_fips, district_type, population)
SELECT
  '28SB' || district_number,
  label || ' District (Supreme Court District ' || district_number || '); Mississippi',
  'MS',
  '28',
  'state_board',
  population
FROM ms_board_districts
ON CONFLICT (district_type, geoid_compact) DO NOTHING;

INSERT INTO public.district_components (district_id, component_type, component_geoid)
SELECT d.id, 'county', c.county_geoid
FROM ms_board_counties AS c
JOIN public.districts AS d
  ON d.district_type = 'state_board'
 AND d.geoid_compact = '28SB' || c.district_number
ON CONFLICT DO NOTHING;

-- Offices -----------------------------------------------------------------------

INSERT INTO public.offices (scope, canonical_name, summary)
VALUES
  (
    'state_board',
    'Public Service Commissioner',
    'Setting how much you pay for electricity, gas, and water
Handling your complaints about utility companies
Approving new power plants and power lines'
  ),
  (
    'state_board',
    'Transportation Commissioner',
    'Deciding which state highways and bridges get built or repaired
Approving contracts for state road and bridge work
Hiring the head of the state transportation department'
  )
ON CONFLICT (scope, canonical_name) DO NOTHING;

INSERT INTO public.office_title_aliases (office_id, scope, alias_text, normalized_alias)
SELECT o.id, 'state_board', v.alias_text, v.normalized_alias
FROM (VALUES
        ('Public Service Commissioner', 'Public Service Commissioner', 'public service commissioner'),
        ('Public Service Commissioner', 'Public Service Commission', 'public service commission'),
        ('Public Service Commissioner', 'Member, Public Service Commission', 'member public service commission'),
        ('Transportation Commissioner', 'Transportation Commissioner', 'transportation commissioner'),
        ('Transportation Commissioner', 'Transportation Commission', 'transportation commission'),
        ('Transportation Commissioner', 'Member, Transportation Commission', 'member transportation commission')
     ) AS v(canonical_name, alias_text, normalized_alias)
JOIN public.offices AS o
  ON o.scope = 'state_board'
 AND o.canonical_name = v.canonical_name
ON CONFLICT (scope, normalized_alias) DO NOTHING;

INSERT INTO public.office_research_areas (office_id, research_area_id)
SELECT o.id, ra.id
FROM (VALUES
        ('Public Service Commissioner', ARRAY['corporate_accountability', 'cost_of_living_reduction', 'environment_and_public_health', 'public_infrastructure']::text[]),
        ('Transportation Commissioner', ARRAY['anti_corruption', 'government_efficiency', 'government_spending_reduction', 'public_infrastructure']::text[])
     ) AS v(canonical_name, slugs)
JOIN public.offices AS o
  ON o.scope = 'state_board'
 AND o.canonical_name = v.canonical_name
JOIN public.research_areas AS ra
  ON ra.slug = ANY (v.slugs)
ON CONFLICT DO NOTHING;

-- Saved addresses ---------------------------------------------------------------

INSERT INTO public.user_districts (user_id, district_id, district_type)
SELECT DISTINCT ud.user_id, board.id, 'state_board'
FROM public.user_districts AS ud
JOIN public.districts AS county
  ON county.id = ud.district_id
 AND county.district_type = 'county'
 AND county.state_fips = '28'
JOIN public.district_components AS c
  ON c.component_type = 'county'
 AND c.component_geoid = county.geoid_compact
JOIN public.districts AS board
  ON board.id = c.district_id
 AND board.district_type = 'state_board'
ON CONFLICT (user_id, district_id) DO NOTHING;

COMMIT;
