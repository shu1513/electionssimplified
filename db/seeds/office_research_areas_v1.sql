DO $$
DECLARE
  desired_slugs text[] := ARRAY[
    'civil_rights',
    'election_integrity',
    'womens_reproductive_rights',
    'public_safety_and_crime_control',
    'corporate_accountability',
    'data_privacy',
    'environment_and_public_health',
    'healthcare_affordability',
    'social_programs_and_welfare',
    'housing_affordability',
    'public_education_quality',
    'anti_corruption',
    'government_efficiency',
    'immigration',
    'legal_competence',
    'impartiality'
  ]::text[];
  expected_area_count integer;
  office_count integer;
  area_count integer;
BEGIN
  expected_area_count := COALESCE(array_length(desired_slugs, 1), 0);

  SELECT COUNT(*)
  INTO office_count
  FROM public.offices
  WHERE scope = 'statewide'
    AND canonical_name = 'State Level Judge';

  IF office_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly 1 office row for scope=statewide canonical_name=State Level Judge, found %',
      office_count;
  END IF;

  SELECT COUNT(*)
  INTO area_count
  FROM public.research_areas
  WHERE slug = ANY (desired_slugs);

  IF area_count <> expected_area_count THEN
    RAISE EXCEPTION
      'Expected % research areas for state-level judge mapping, found %',
      expected_area_count,
      area_count;
  END IF;

  INSERT INTO public.office_research_areas (office_id, research_area_id)
  SELECT office.id, area.id
  FROM public.offices office
  JOIN public.research_areas area
    ON area.slug = ANY (desired_slugs)
  WHERE office.scope = 'statewide'
    AND office.canonical_name = 'State Level Judge'
  ON CONFLICT (office_id, research_area_id) DO NOTHING;
END
$$;

DO $$
DECLARE
  expected_pair_count integer;
  resolved_pair_count integer;
BEGIN
  WITH desired(scope, canonical_name, slug) AS (
    VALUES
      ('presidential', 'President of the United States', 'national_defense'),
      ('presidential', 'President of the United States', 'peaceful_foreign_policy'),
      ('presidential', 'President of the United States', 'us_israel_ties'),
      ('presidential', 'President of the United States', 'foreign_trade'),
      ('presidential', 'President of the United States', 'immigration'),
      ('presidential', 'President of the United States', 'government_spending_reduction'),
      ('presidential', 'President of the United States', 'personal_income_tax_reduction'),
      ('presidential', 'President of the United States', 'cost_of_living_reduction'),
      ('presidential', 'President of the United States', 'healthcare_affordability'),
      ('presidential', 'President of the United States', 'social_programs_and_welfare'),
      ('presidential', 'President of the United States', 'environment_and_public_health'),
      ('presidential', 'President of the United States', 'public_infrastructure'),
      ('presidential', 'President of the United States', 'public_safety_and_crime_control'),
      ('presidential', 'President of the United States', 'civil_rights'),
      ('presidential', 'President of the United States', 'womens_reproductive_rights'),
      ('presidential', 'President of the United States', 'gun_control'),
      ('presidential', 'President of the United States', 'ai_regulation'),
      ('presidential', 'President of the United States', 'labor_rights'),
      ('presidential', 'President of the United States', 'corporate_accountability'),
      ('presidential', 'President of the United States', 'data_privacy'),
      ('presidential', 'President of the United States', 'anti_corruption'),
      ('presidential', 'President of the United States', 'government_efficiency'),
      ('presidential', 'President of the United States', 'housing_affordability'),
      ('presidential', 'President of the United States', 'public_education_quality'),
      ('presidential', 'President of the United States', 'election_integrity'),
      ('presidential', 'Vice President of the United States', 'government_spending_reduction'),
      ('presidential', 'Vice President of the United States', 'government_efficiency'),
      ('presidential', 'Vice President of the United States', 'anti_corruption'),
      ('presidential', 'Vice President of the United States', 'election_integrity'),
      ('presidential', 'Vice President of the United States', 'civil_rights'),
      ('presidential', 'Vice President of the United States', 'national_defense'),
      ('presidential', 'Vice President of the United States', 'peaceful_foreign_policy'),
      ('presidential', 'Vice President of the United States', 'us_israel_ties'),
      ('presidential', 'Vice President of the United States', 'foreign_trade'),
      ('presidential', 'Vice President of the United States', 'immigration'),
      ('presidential', 'Vice President of the United States', 'public_safety_and_crime_control'),
      ('presidential', 'Vice President of the United States', 'healthcare_affordability'),
      ('presidential', 'Vice President of the United States', 'social_programs_and_welfare'),
      ('presidential', 'Vice President of the United States', 'environment_and_public_health'),
      ('presidential', 'Vice President of the United States', 'public_infrastructure'),
      ('presidential', 'Vice President of the United States', 'personal_income_tax_reduction'),
      ('presidential', 'Vice President of the United States', 'cost_of_living_reduction'),
      ('presidential', 'Vice President of the United States', 'corporate_accountability'),
      ('presidential', 'Vice President of the United States', 'data_privacy'),
      ('presidential', 'Vice President of the United States', 'womens_reproductive_rights'),
      ('presidential', 'Vice President of the United States', 'gun_control'),
      ('presidential', 'Vice President of the United States', 'ai_regulation'),
      ('presidential', 'Vice President of the United States', 'labor_rights'),
      ('presidential', 'Vice President of the United States', 'housing_affordability'),
      ('presidential', 'Vice President of the United States', 'public_education_quality')
  )
  SELECT COUNT(*)
  INTO expected_pair_count
  FROM desired;

  WITH desired(scope, canonical_name, slug) AS (
    VALUES
      ('presidential', 'President of the United States', 'national_defense'),
      ('presidential', 'President of the United States', 'peaceful_foreign_policy'),
      ('presidential', 'President of the United States', 'us_israel_ties'),
      ('presidential', 'President of the United States', 'foreign_trade'),
      ('presidential', 'President of the United States', 'immigration'),
      ('presidential', 'President of the United States', 'government_spending_reduction'),
      ('presidential', 'President of the United States', 'personal_income_tax_reduction'),
      ('presidential', 'President of the United States', 'cost_of_living_reduction'),
      ('presidential', 'President of the United States', 'healthcare_affordability'),
      ('presidential', 'President of the United States', 'social_programs_and_welfare'),
      ('presidential', 'President of the United States', 'environment_and_public_health'),
      ('presidential', 'President of the United States', 'public_infrastructure'),
      ('presidential', 'President of the United States', 'public_safety_and_crime_control'),
      ('presidential', 'President of the United States', 'civil_rights'),
      ('presidential', 'President of the United States', 'womens_reproductive_rights'),
      ('presidential', 'President of the United States', 'gun_control'),
      ('presidential', 'President of the United States', 'ai_regulation'),
      ('presidential', 'President of the United States', 'labor_rights'),
      ('presidential', 'President of the United States', 'corporate_accountability'),
      ('presidential', 'President of the United States', 'data_privacy'),
      ('presidential', 'President of the United States', 'anti_corruption'),
      ('presidential', 'President of the United States', 'government_efficiency'),
      ('presidential', 'President of the United States', 'housing_affordability'),
      ('presidential', 'President of the United States', 'public_education_quality'),
      ('presidential', 'President of the United States', 'election_integrity'),
      ('presidential', 'Vice President of the United States', 'government_spending_reduction'),
      ('presidential', 'Vice President of the United States', 'government_efficiency'),
      ('presidential', 'Vice President of the United States', 'anti_corruption'),
      ('presidential', 'Vice President of the United States', 'election_integrity'),
      ('presidential', 'Vice President of the United States', 'civil_rights'),
      ('presidential', 'Vice President of the United States', 'national_defense'),
      ('presidential', 'Vice President of the United States', 'peaceful_foreign_policy'),
      ('presidential', 'Vice President of the United States', 'us_israel_ties'),
      ('presidential', 'Vice President of the United States', 'foreign_trade'),
      ('presidential', 'Vice President of the United States', 'immigration'),
      ('presidential', 'Vice President of the United States', 'public_safety_and_crime_control'),
      ('presidential', 'Vice President of the United States', 'healthcare_affordability'),
      ('presidential', 'Vice President of the United States', 'social_programs_and_welfare'),
      ('presidential', 'Vice President of the United States', 'environment_and_public_health'),
      ('presidential', 'Vice President of the United States', 'public_infrastructure'),
      ('presidential', 'Vice President of the United States', 'personal_income_tax_reduction'),
      ('presidential', 'Vice President of the United States', 'cost_of_living_reduction'),
      ('presidential', 'Vice President of the United States', 'corporate_accountability'),
      ('presidential', 'Vice President of the United States', 'data_privacy'),
      ('presidential', 'Vice President of the United States', 'womens_reproductive_rights'),
      ('presidential', 'Vice President of the United States', 'gun_control'),
      ('presidential', 'Vice President of the United States', 'ai_regulation'),
      ('presidential', 'Vice President of the United States', 'labor_rights'),
      ('presidential', 'Vice President of the United States', 'housing_affordability'),
      ('presidential', 'Vice President of the United States', 'public_education_quality')
  )
  SELECT COUNT(*)
  INTO resolved_pair_count
  FROM desired
  JOIN public.offices AS office
    ON office.scope = desired.scope
   AND office.canonical_name = desired.canonical_name
  JOIN public.research_areas AS area
    ON area.slug = desired.slug;

  IF resolved_pair_count <> expected_pair_count THEN
    RAISE EXCEPTION
      'Expected % presidential office research-area pairs to resolve, found %',
      expected_pair_count,
      resolved_pair_count;
  END IF;

  WITH desired(scope, canonical_name, slug) AS (
    VALUES
      ('presidential', 'President of the United States', 'national_defense'),
      ('presidential', 'President of the United States', 'peaceful_foreign_policy'),
      ('presidential', 'President of the United States', 'us_israel_ties'),
      ('presidential', 'President of the United States', 'foreign_trade'),
      ('presidential', 'President of the United States', 'immigration'),
      ('presidential', 'President of the United States', 'government_spending_reduction'),
      ('presidential', 'President of the United States', 'personal_income_tax_reduction'),
      ('presidential', 'President of the United States', 'cost_of_living_reduction'),
      ('presidential', 'President of the United States', 'healthcare_affordability'),
      ('presidential', 'President of the United States', 'social_programs_and_welfare'),
      ('presidential', 'President of the United States', 'environment_and_public_health'),
      ('presidential', 'President of the United States', 'public_infrastructure'),
      ('presidential', 'President of the United States', 'public_safety_and_crime_control'),
      ('presidential', 'President of the United States', 'civil_rights'),
      ('presidential', 'President of the United States', 'womens_reproductive_rights'),
      ('presidential', 'President of the United States', 'gun_control'),
      ('presidential', 'President of the United States', 'ai_regulation'),
      ('presidential', 'President of the United States', 'labor_rights'),
      ('presidential', 'President of the United States', 'corporate_accountability'),
      ('presidential', 'President of the United States', 'data_privacy'),
      ('presidential', 'President of the United States', 'anti_corruption'),
      ('presidential', 'President of the United States', 'government_efficiency'),
      ('presidential', 'President of the United States', 'housing_affordability'),
      ('presidential', 'President of the United States', 'public_education_quality'),
      ('presidential', 'President of the United States', 'election_integrity'),
      ('presidential', 'Vice President of the United States', 'government_spending_reduction'),
      ('presidential', 'Vice President of the United States', 'government_efficiency'),
      ('presidential', 'Vice President of the United States', 'anti_corruption'),
      ('presidential', 'Vice President of the United States', 'election_integrity'),
      ('presidential', 'Vice President of the United States', 'civil_rights'),
      ('presidential', 'Vice President of the United States', 'national_defense'),
      ('presidential', 'Vice President of the United States', 'peaceful_foreign_policy'),
      ('presidential', 'Vice President of the United States', 'us_israel_ties'),
      ('presidential', 'Vice President of the United States', 'foreign_trade'),
      ('presidential', 'Vice President of the United States', 'immigration'),
      ('presidential', 'Vice President of the United States', 'public_safety_and_crime_control'),
      ('presidential', 'Vice President of the United States', 'healthcare_affordability'),
      ('presidential', 'Vice President of the United States', 'social_programs_and_welfare'),
      ('presidential', 'Vice President of the United States', 'environment_and_public_health'),
      ('presidential', 'Vice President of the United States', 'public_infrastructure'),
      ('presidential', 'Vice President of the United States', 'personal_income_tax_reduction'),
      ('presidential', 'Vice President of the United States', 'cost_of_living_reduction'),
      ('presidential', 'Vice President of the United States', 'corporate_accountability'),
      ('presidential', 'Vice President of the United States', 'data_privacy'),
      ('presidential', 'Vice President of the United States', 'womens_reproductive_rights'),
      ('presidential', 'Vice President of the United States', 'gun_control'),
      ('presidential', 'Vice President of the United States', 'ai_regulation'),
      ('presidential', 'Vice President of the United States', 'labor_rights'),
      ('presidential', 'Vice President of the United States', 'housing_affordability'),
      ('presidential', 'Vice President of the United States', 'public_education_quality')
  )
  INSERT INTO public.office_research_areas (office_id, research_area_id)
  SELECT office.id, area.id
  FROM desired
  JOIN public.offices AS office
    ON office.scope = desired.scope
   AND office.canonical_name = desired.canonical_name
  JOIN public.research_areas AS area
    ON area.slug = desired.slug
  ON CONFLICT (office_id, research_area_id) DO NOTHING;
END
$$;

DO $$
DECLARE
  expected_office_count integer := 5;
  expected_pair_count integer;
  office_count integer;
  pair_count integer;
BEGIN
  WITH desired(scope, canonical_name, slug) AS (
    VALUES
      ('statewide', 'Labor Commissioner', 'civil_rights'),
      ('statewide', 'Labor Commissioner', 'corporate_accountability'),
      ('statewide', 'Labor Commissioner', 'cost_of_living_reduction'),
      ('statewide', 'Labor Commissioner', 'healthcare_affordability'),
      ('statewide', 'Labor Commissioner', 'social_programs_and_welfare'),
      ('statewide', 'Labor Commissioner', 'government_efficiency'),
      ('statewide', 'Labor Commissioner', 'anti_corruption'),
      ('statewide', 'Labor Commissioner', 'data_privacy'),
      ('statewide', 'Land Commissioner', 'environment_and_public_health'),
      ('statewide', 'Land Commissioner', 'public_infrastructure'),
      ('statewide', 'Land Commissioner', 'housing_affordability'),
      ('statewide', 'Land Commissioner', 'cost_of_living_reduction'),
      ('statewide', 'Land Commissioner', 'government_efficiency'),
      ('statewide', 'Land Commissioner', 'government_spending_reduction'),
      ('statewide', 'Land Commissioner', 'anti_corruption'),
      ('statewide', 'Land Commissioner', 'corporate_accountability'),
      ('statewide', 'Land Commissioner', 'data_privacy'),
      ('statewide', 'Railroad Commissioner', 'cost_of_living_reduction'),
      ('statewide', 'Railroad Commissioner', 'public_infrastructure'),
      ('statewide', 'Railroad Commissioner', 'environment_and_public_health'),
      ('statewide', 'Railroad Commissioner', 'corporate_accountability'),
      ('statewide', 'Railroad Commissioner', 'government_efficiency'),
      ('statewide', 'Railroad Commissioner', 'anti_corruption'),
      ('statewide', 'Railroad Commissioner', 'data_privacy'),
      ('statewide', 'Railroad Commissioner', 'public_safety_and_crime_control'),
      ('county', 'County Auditor', 'government_spending_reduction'),
      ('county', 'County Auditor', 'government_efficiency'),
      ('county', 'County Auditor', 'anti_corruption'),
      ('county', 'County Auditor', 'data_privacy'),
      ('county', 'County Auditor', 'corporate_accountability'),
      ('county', 'County Auditor', 'civil_rights'),
      ('county', 'County Auditor', 'election_integrity'),
      ('county', 'Clerk of Court', 'civil_rights'),
      ('county', 'Clerk of Court', 'public_safety_and_crime_control'),
      ('county', 'Clerk of Court', 'government_efficiency'),
      ('county', 'Clerk of Court', 'data_privacy'),
      ('county', 'Clerk of Court', 'anti_corruption'),
      ('county', 'Clerk of Court', 'social_programs_and_welfare')
  )
  SELECT COUNT(DISTINCT scope || ':' || canonical_name), COUNT(*)
  INTO office_count, expected_pair_count
  FROM desired;

  IF office_count <> expected_office_count THEN
    RAISE EXCEPTION
      'Expected % new elected office mappings, found %',
      expected_office_count,
      office_count;
  END IF;

  WITH desired(scope, canonical_name, slug) AS (
    VALUES
      ('statewide', 'Labor Commissioner', 'civil_rights'),
      ('statewide', 'Labor Commissioner', 'corporate_accountability'),
      ('statewide', 'Labor Commissioner', 'cost_of_living_reduction'),
      ('statewide', 'Labor Commissioner', 'healthcare_affordability'),
      ('statewide', 'Labor Commissioner', 'social_programs_and_welfare'),
      ('statewide', 'Labor Commissioner', 'government_efficiency'),
      ('statewide', 'Labor Commissioner', 'anti_corruption'),
      ('statewide', 'Labor Commissioner', 'data_privacy'),
      ('statewide', 'Land Commissioner', 'environment_and_public_health'),
      ('statewide', 'Land Commissioner', 'public_infrastructure'),
      ('statewide', 'Land Commissioner', 'housing_affordability'),
      ('statewide', 'Land Commissioner', 'cost_of_living_reduction'),
      ('statewide', 'Land Commissioner', 'government_efficiency'),
      ('statewide', 'Land Commissioner', 'government_spending_reduction'),
      ('statewide', 'Land Commissioner', 'anti_corruption'),
      ('statewide', 'Land Commissioner', 'corporate_accountability'),
      ('statewide', 'Land Commissioner', 'data_privacy'),
      ('statewide', 'Railroad Commissioner', 'cost_of_living_reduction'),
      ('statewide', 'Railroad Commissioner', 'public_infrastructure'),
      ('statewide', 'Railroad Commissioner', 'environment_and_public_health'),
      ('statewide', 'Railroad Commissioner', 'corporate_accountability'),
      ('statewide', 'Railroad Commissioner', 'government_efficiency'),
      ('statewide', 'Railroad Commissioner', 'anti_corruption'),
      ('statewide', 'Railroad Commissioner', 'data_privacy'),
      ('statewide', 'Railroad Commissioner', 'public_safety_and_crime_control'),
      ('county', 'County Auditor', 'government_spending_reduction'),
      ('county', 'County Auditor', 'government_efficiency'),
      ('county', 'County Auditor', 'anti_corruption'),
      ('county', 'County Auditor', 'data_privacy'),
      ('county', 'County Auditor', 'corporate_accountability'),
      ('county', 'County Auditor', 'civil_rights'),
      ('county', 'County Auditor', 'election_integrity'),
      ('county', 'Clerk of Court', 'civil_rights'),
      ('county', 'Clerk of Court', 'public_safety_and_crime_control'),
      ('county', 'Clerk of Court', 'government_efficiency'),
      ('county', 'Clerk of Court', 'data_privacy'),
      ('county', 'Clerk of Court', 'anti_corruption'),
      ('county', 'Clerk of Court', 'social_programs_and_welfare')
  ),
  resolved AS (
    SELECT office.id AS office_id, area.id AS research_area_id
    FROM desired
    JOIN public.offices office
      ON office.scope = desired.scope
     AND office.canonical_name = desired.canonical_name
    JOIN public.research_areas area
      ON area.slug = desired.slug
  )
  SELECT COUNT(*)
  INTO pair_count
  FROM resolved;

  IF pair_count <> expected_pair_count THEN
    RAISE EXCEPTION
      'Expected % new elected office research area pairs, found %',
      expected_pair_count,
      pair_count;
  END IF;

  WITH desired(scope, canonical_name, slug) AS (
    VALUES
      ('statewide', 'Labor Commissioner', 'civil_rights'),
      ('statewide', 'Labor Commissioner', 'corporate_accountability'),
      ('statewide', 'Labor Commissioner', 'cost_of_living_reduction'),
      ('statewide', 'Labor Commissioner', 'healthcare_affordability'),
      ('statewide', 'Labor Commissioner', 'social_programs_and_welfare'),
      ('statewide', 'Labor Commissioner', 'government_efficiency'),
      ('statewide', 'Labor Commissioner', 'anti_corruption'),
      ('statewide', 'Labor Commissioner', 'data_privacy'),
      ('statewide', 'Land Commissioner', 'environment_and_public_health'),
      ('statewide', 'Land Commissioner', 'public_infrastructure'),
      ('statewide', 'Land Commissioner', 'housing_affordability'),
      ('statewide', 'Land Commissioner', 'cost_of_living_reduction'),
      ('statewide', 'Land Commissioner', 'government_efficiency'),
      ('statewide', 'Land Commissioner', 'government_spending_reduction'),
      ('statewide', 'Land Commissioner', 'anti_corruption'),
      ('statewide', 'Land Commissioner', 'corporate_accountability'),
      ('statewide', 'Land Commissioner', 'data_privacy'),
      ('statewide', 'Railroad Commissioner', 'cost_of_living_reduction'),
      ('statewide', 'Railroad Commissioner', 'public_infrastructure'),
      ('statewide', 'Railroad Commissioner', 'environment_and_public_health'),
      ('statewide', 'Railroad Commissioner', 'corporate_accountability'),
      ('statewide', 'Railroad Commissioner', 'government_efficiency'),
      ('statewide', 'Railroad Commissioner', 'anti_corruption'),
      ('statewide', 'Railroad Commissioner', 'data_privacy'),
      ('statewide', 'Railroad Commissioner', 'public_safety_and_crime_control'),
      ('county', 'County Auditor', 'government_spending_reduction'),
      ('county', 'County Auditor', 'government_efficiency'),
      ('county', 'County Auditor', 'anti_corruption'),
      ('county', 'County Auditor', 'data_privacy'),
      ('county', 'County Auditor', 'corporate_accountability'),
      ('county', 'County Auditor', 'civil_rights'),
      ('county', 'County Auditor', 'election_integrity'),
      ('county', 'Clerk of Court', 'civil_rights'),
      ('county', 'Clerk of Court', 'public_safety_and_crime_control'),
      ('county', 'Clerk of Court', 'government_efficiency'),
      ('county', 'Clerk of Court', 'data_privacy'),
      ('county', 'Clerk of Court', 'anti_corruption'),
      ('county', 'Clerk of Court', 'social_programs_and_welfare')
  )
  INSERT INTO public.office_research_areas (office_id, research_area_id)
  SELECT office.id, area.id
  FROM desired
  JOIN public.offices office
    ON office.scope = desired.scope
   AND office.canonical_name = desired.canonical_name
  JOIN public.research_areas area
    ON area.slug = desired.slug
  ON CONFLICT (office_id, research_area_id) DO NOTHING;
END
$$;

DO $$
DECLARE
  expected_office_count integer := 9;
  expected_pair_count integer;
  office_count integer;
  pair_count integer;
BEGIN
  WITH desired(canonical_name, slug) AS (
    VALUES
      ('Alderman', 'government_spending_reduction'),
      ('Alderman', 'government_efficiency'),
      ('Alderman', 'public_infrastructure'),
      ('Alderman', 'housing_affordability'),
      ('Alderman', 'environment_and_public_health'),
      ('Alderman', 'public_safety_and_crime_control'),
      ('Alderman', 'social_programs_and_welfare'),
      ('Alderman', 'civil_rights'),
      ('Alderman', 'anti_corruption'),
      ('Alderman', 'corporate_accountability'),
      ('Alderman', 'data_privacy'),
      ('City Clerk', 'election_integrity'),
      ('City Clerk', 'government_efficiency'),
      ('City Clerk', 'data_privacy'),
      ('City Clerk', 'anti_corruption'),
      ('City Clerk', 'civil_rights'),
      ('City Clerk', 'corporate_accountability'),
      ('City Council Member', 'government_spending_reduction'),
      ('City Council Member', 'government_efficiency'),
      ('City Council Member', 'public_infrastructure'),
      ('City Council Member', 'housing_affordability'),
      ('City Council Member', 'environment_and_public_health'),
      ('City Council Member', 'public_safety_and_crime_control'),
      ('City Council Member', 'social_programs_and_welfare'),
      ('City Council Member', 'civil_rights'),
      ('City Council Member', 'anti_corruption'),
      ('City Council Member', 'corporate_accountability'),
      ('City Council Member', 'data_privacy'),
      ('City Treasurer', 'government_spending_reduction'),
      ('City Treasurer', 'government_efficiency'),
      ('City Treasurer', 'anti_corruption'),
      ('City Treasurer', 'data_privacy'),
      ('City Treasurer', 'corporate_accountability'),
      ('City Treasurer', 'public_infrastructure'),
      ('Municipal Assessor', 'housing_affordability'),
      ('Municipal Assessor', 'government_efficiency'),
      ('Municipal Assessor', 'anti_corruption'),
      ('Municipal Assessor', 'data_privacy'),
      ('Municipal Assessor', 'corporate_accountability'),
      ('Municipal Assessor', 'civil_rights'),
      ('Municipal Attorney', 'government_efficiency'),
      ('Municipal Attorney', 'civil_rights'),
      ('Municipal Attorney', 'anti_corruption'),
      ('Municipal Attorney', 'public_safety_and_crime_control'),
      ('Municipal Attorney', 'corporate_accountability'),
      ('Municipal Attorney', 'data_privacy'),
      ('Municipal Attorney', 'housing_affordability'),
      ('Municipal Attorney', 'environment_and_public_health'),
      ('Municipal Attorney', 'public_infrastructure'),
      ('Municipal Constable', 'public_safety_and_crime_control'),
      ('Municipal Constable', 'civil_rights'),
      ('Municipal Constable', 'housing_affordability'),
      ('Municipal Constable', 'government_efficiency'),
      ('Municipal Constable', 'data_privacy'),
      ('Municipal Constable', 'anti_corruption'),
      ('Town Council Member', 'government_spending_reduction'),
      ('Town Council Member', 'government_efficiency'),
      ('Town Council Member', 'public_infrastructure'),
      ('Town Council Member', 'housing_affordability'),
      ('Town Council Member', 'environment_and_public_health'),
      ('Town Council Member', 'public_safety_and_crime_control'),
      ('Town Council Member', 'social_programs_and_welfare'),
      ('Town Council Member', 'civil_rights'),
      ('Town Council Member', 'anti_corruption'),
      ('Town Council Member', 'corporate_accountability'),
      ('Town Council Member', 'data_privacy'),
      ('Town Moderator', 'government_efficiency'),
      ('Town Moderator', 'civil_rights'),
      ('Town Moderator', 'election_integrity'),
      ('Town Moderator', 'anti_corruption')
  )
  SELECT COUNT(DISTINCT canonical_name), COUNT(*)
  INTO office_count, expected_pair_count
  FROM desired;

  IF office_count <> expected_office_count THEN
    RAISE EXCEPTION
      'Expected % place offices in requested mapping, found %',
      expected_office_count,
      office_count;
  END IF;

  WITH desired(canonical_name, slug) AS (
    VALUES
      ('Alderman', 'government_spending_reduction'),
      ('Alderman', 'government_efficiency'),
      ('Alderman', 'public_infrastructure'),
      ('Alderman', 'housing_affordability'),
      ('Alderman', 'environment_and_public_health'),
      ('Alderman', 'public_safety_and_crime_control'),
      ('Alderman', 'social_programs_and_welfare'),
      ('Alderman', 'civil_rights'),
      ('Alderman', 'anti_corruption'),
      ('Alderman', 'corporate_accountability'),
      ('Alderman', 'data_privacy'),
      ('City Clerk', 'election_integrity'),
      ('City Clerk', 'government_efficiency'),
      ('City Clerk', 'data_privacy'),
      ('City Clerk', 'anti_corruption'),
      ('City Clerk', 'civil_rights'),
      ('City Clerk', 'corporate_accountability'),
      ('City Council Member', 'government_spending_reduction'),
      ('City Council Member', 'government_efficiency'),
      ('City Council Member', 'public_infrastructure'),
      ('City Council Member', 'housing_affordability'),
      ('City Council Member', 'environment_and_public_health'),
      ('City Council Member', 'public_safety_and_crime_control'),
      ('City Council Member', 'social_programs_and_welfare'),
      ('City Council Member', 'civil_rights'),
      ('City Council Member', 'anti_corruption'),
      ('City Council Member', 'corporate_accountability'),
      ('City Council Member', 'data_privacy'),
      ('City Treasurer', 'government_spending_reduction'),
      ('City Treasurer', 'government_efficiency'),
      ('City Treasurer', 'anti_corruption'),
      ('City Treasurer', 'data_privacy'),
      ('City Treasurer', 'corporate_accountability'),
      ('City Treasurer', 'public_infrastructure'),
      ('Municipal Assessor', 'housing_affordability'),
      ('Municipal Assessor', 'government_efficiency'),
      ('Municipal Assessor', 'anti_corruption'),
      ('Municipal Assessor', 'data_privacy'),
      ('Municipal Assessor', 'corporate_accountability'),
      ('Municipal Assessor', 'civil_rights'),
      ('Municipal Attorney', 'government_efficiency'),
      ('Municipal Attorney', 'civil_rights'),
      ('Municipal Attorney', 'anti_corruption'),
      ('Municipal Attorney', 'public_safety_and_crime_control'),
      ('Municipal Attorney', 'corporate_accountability'),
      ('Municipal Attorney', 'data_privacy'),
      ('Municipal Attorney', 'housing_affordability'),
      ('Municipal Attorney', 'environment_and_public_health'),
      ('Municipal Attorney', 'public_infrastructure'),
      ('Municipal Constable', 'public_safety_and_crime_control'),
      ('Municipal Constable', 'civil_rights'),
      ('Municipal Constable', 'housing_affordability'),
      ('Municipal Constable', 'government_efficiency'),
      ('Municipal Constable', 'data_privacy'),
      ('Municipal Constable', 'anti_corruption'),
      ('Town Council Member', 'government_spending_reduction'),
      ('Town Council Member', 'government_efficiency'),
      ('Town Council Member', 'public_infrastructure'),
      ('Town Council Member', 'housing_affordability'),
      ('Town Council Member', 'environment_and_public_health'),
      ('Town Council Member', 'public_safety_and_crime_control'),
      ('Town Council Member', 'social_programs_and_welfare'),
      ('Town Council Member', 'civil_rights'),
      ('Town Council Member', 'anti_corruption'),
      ('Town Council Member', 'corporate_accountability'),
      ('Town Council Member', 'data_privacy'),
      ('Town Moderator', 'government_efficiency'),
      ('Town Moderator', 'civil_rights'),
      ('Town Moderator', 'election_integrity'),
      ('Town Moderator', 'anti_corruption')
  ),
  resolved AS (
    SELECT office.id AS office_id, area.id AS research_area_id
    FROM desired
    JOIN public.offices office
      ON office.scope = 'place'
     AND office.canonical_name = desired.canonical_name
    JOIN public.research_areas area
      ON area.slug = desired.slug
  )
  SELECT COUNT(*)
  INTO pair_count
  FROM resolved;

  IF pair_count <> expected_pair_count THEN
    RAISE EXCEPTION
      'Expected % place office research area pairs, found %',
      expected_pair_count,
      pair_count;
  END IF;

  WITH desired(canonical_name, slug) AS (
    VALUES
      ('Alderman', 'government_spending_reduction'),
      ('Alderman', 'government_efficiency'),
      ('Alderman', 'public_infrastructure'),
      ('Alderman', 'housing_affordability'),
      ('Alderman', 'environment_and_public_health'),
      ('Alderman', 'public_safety_and_crime_control'),
      ('Alderman', 'social_programs_and_welfare'),
      ('Alderman', 'civil_rights'),
      ('Alderman', 'anti_corruption'),
      ('Alderman', 'corporate_accountability'),
      ('Alderman', 'data_privacy'),
      ('City Clerk', 'election_integrity'),
      ('City Clerk', 'government_efficiency'),
      ('City Clerk', 'data_privacy'),
      ('City Clerk', 'anti_corruption'),
      ('City Clerk', 'civil_rights'),
      ('City Clerk', 'corporate_accountability'),
      ('City Council Member', 'government_spending_reduction'),
      ('City Council Member', 'government_efficiency'),
      ('City Council Member', 'public_infrastructure'),
      ('City Council Member', 'housing_affordability'),
      ('City Council Member', 'environment_and_public_health'),
      ('City Council Member', 'public_safety_and_crime_control'),
      ('City Council Member', 'social_programs_and_welfare'),
      ('City Council Member', 'civil_rights'),
      ('City Council Member', 'anti_corruption'),
      ('City Council Member', 'corporate_accountability'),
      ('City Council Member', 'data_privacy'),
      ('City Treasurer', 'government_spending_reduction'),
      ('City Treasurer', 'government_efficiency'),
      ('City Treasurer', 'anti_corruption'),
      ('City Treasurer', 'data_privacy'),
      ('City Treasurer', 'corporate_accountability'),
      ('City Treasurer', 'public_infrastructure'),
      ('Municipal Assessor', 'housing_affordability'),
      ('Municipal Assessor', 'government_efficiency'),
      ('Municipal Assessor', 'anti_corruption'),
      ('Municipal Assessor', 'data_privacy'),
      ('Municipal Assessor', 'corporate_accountability'),
      ('Municipal Assessor', 'civil_rights'),
      ('Municipal Attorney', 'government_efficiency'),
      ('Municipal Attorney', 'civil_rights'),
      ('Municipal Attorney', 'anti_corruption'),
      ('Municipal Attorney', 'public_safety_and_crime_control'),
      ('Municipal Attorney', 'corporate_accountability'),
      ('Municipal Attorney', 'data_privacy'),
      ('Municipal Attorney', 'housing_affordability'),
      ('Municipal Attorney', 'environment_and_public_health'),
      ('Municipal Attorney', 'public_infrastructure'),
      ('Municipal Constable', 'public_safety_and_crime_control'),
      ('Municipal Constable', 'civil_rights'),
      ('Municipal Constable', 'housing_affordability'),
      ('Municipal Constable', 'government_efficiency'),
      ('Municipal Constable', 'data_privacy'),
      ('Municipal Constable', 'anti_corruption'),
      ('Town Council Member', 'government_spending_reduction'),
      ('Town Council Member', 'government_efficiency'),
      ('Town Council Member', 'public_infrastructure'),
      ('Town Council Member', 'housing_affordability'),
      ('Town Council Member', 'environment_and_public_health'),
      ('Town Council Member', 'public_safety_and_crime_control'),
      ('Town Council Member', 'social_programs_and_welfare'),
      ('Town Council Member', 'civil_rights'),
      ('Town Council Member', 'anti_corruption'),
      ('Town Council Member', 'corporate_accountability'),
      ('Town Council Member', 'data_privacy'),
      ('Town Moderator', 'government_efficiency'),
      ('Town Moderator', 'civil_rights'),
      ('Town Moderator', 'election_integrity'),
      ('Town Moderator', 'anti_corruption')
  ),
  target_offices AS (
    SELECT id
    FROM public.offices
    WHERE scope = 'place'
      AND canonical_name IN (SELECT DISTINCT canonical_name FROM desired)
  ),
  resolved AS (
    SELECT office.id AS office_id, area.id AS research_area_id
    FROM desired
    JOIN public.offices office
      ON office.scope = 'place'
     AND office.canonical_name = desired.canonical_name
    JOIN public.research_areas area
      ON area.slug = desired.slug
  )
  DELETE FROM public.office_research_areas existing
  WHERE existing.office_id IN (SELECT id FROM target_offices)
    AND NOT EXISTS (
      SELECT 1
      FROM resolved
      WHERE resolved.office_id = existing.office_id
        AND resolved.research_area_id = existing.research_area_id
    );

  WITH desired(canonical_name, slug) AS (
    VALUES
      ('Alderman', 'government_spending_reduction'),
      ('Alderman', 'government_efficiency'),
      ('Alderman', 'public_infrastructure'),
      ('Alderman', 'housing_affordability'),
      ('Alderman', 'environment_and_public_health'),
      ('Alderman', 'public_safety_and_crime_control'),
      ('Alderman', 'social_programs_and_welfare'),
      ('Alderman', 'civil_rights'),
      ('Alderman', 'anti_corruption'),
      ('Alderman', 'corporate_accountability'),
      ('Alderman', 'data_privacy'),
      ('City Clerk', 'election_integrity'),
      ('City Clerk', 'government_efficiency'),
      ('City Clerk', 'data_privacy'),
      ('City Clerk', 'anti_corruption'),
      ('City Clerk', 'civil_rights'),
      ('City Clerk', 'corporate_accountability'),
      ('City Council Member', 'government_spending_reduction'),
      ('City Council Member', 'government_efficiency'),
      ('City Council Member', 'public_infrastructure'),
      ('City Council Member', 'housing_affordability'),
      ('City Council Member', 'environment_and_public_health'),
      ('City Council Member', 'public_safety_and_crime_control'),
      ('City Council Member', 'social_programs_and_welfare'),
      ('City Council Member', 'civil_rights'),
      ('City Council Member', 'anti_corruption'),
      ('City Council Member', 'corporate_accountability'),
      ('City Council Member', 'data_privacy'),
      ('City Treasurer', 'government_spending_reduction'),
      ('City Treasurer', 'government_efficiency'),
      ('City Treasurer', 'anti_corruption'),
      ('City Treasurer', 'data_privacy'),
      ('City Treasurer', 'corporate_accountability'),
      ('City Treasurer', 'public_infrastructure'),
      ('Municipal Assessor', 'housing_affordability'),
      ('Municipal Assessor', 'government_efficiency'),
      ('Municipal Assessor', 'anti_corruption'),
      ('Municipal Assessor', 'data_privacy'),
      ('Municipal Assessor', 'corporate_accountability'),
      ('Municipal Assessor', 'civil_rights'),
      ('Municipal Attorney', 'government_efficiency'),
      ('Municipal Attorney', 'civil_rights'),
      ('Municipal Attorney', 'anti_corruption'),
      ('Municipal Attorney', 'public_safety_and_crime_control'),
      ('Municipal Attorney', 'corporate_accountability'),
      ('Municipal Attorney', 'data_privacy'),
      ('Municipal Attorney', 'housing_affordability'),
      ('Municipal Attorney', 'environment_and_public_health'),
      ('Municipal Attorney', 'public_infrastructure'),
      ('Municipal Constable', 'public_safety_and_crime_control'),
      ('Municipal Constable', 'civil_rights'),
      ('Municipal Constable', 'housing_affordability'),
      ('Municipal Constable', 'government_efficiency'),
      ('Municipal Constable', 'data_privacy'),
      ('Municipal Constable', 'anti_corruption'),
      ('Town Council Member', 'government_spending_reduction'),
      ('Town Council Member', 'government_efficiency'),
      ('Town Council Member', 'public_infrastructure'),
      ('Town Council Member', 'housing_affordability'),
      ('Town Council Member', 'environment_and_public_health'),
      ('Town Council Member', 'public_safety_and_crime_control'),
      ('Town Council Member', 'social_programs_and_welfare'),
      ('Town Council Member', 'civil_rights'),
      ('Town Council Member', 'anti_corruption'),
      ('Town Council Member', 'corporate_accountability'),
      ('Town Council Member', 'data_privacy'),
      ('Town Moderator', 'government_efficiency'),
      ('Town Moderator', 'civil_rights'),
      ('Town Moderator', 'election_integrity'),
      ('Town Moderator', 'anti_corruption')
  )
  INSERT INTO public.office_research_areas (office_id, research_area_id)
  SELECT office.id, area.id
  FROM desired
  JOIN public.offices office
    ON office.scope = 'place'
   AND office.canonical_name = desired.canonical_name
  JOIN public.research_areas area
    ON area.slug = desired.slug
  ON CONFLICT (office_id, research_area_id) DO NOTHING;
END
$$;

DO $$
DECLARE
  desired_slugs text[] := ARRAY[
    'election_integrity',
    'government_efficiency',
    'civil_rights',
    'anti_corruption'
  ]::text[];
  expected_area_count integer;
  office_count integer;
  area_count integer;
BEGIN
  expected_area_count := COALESCE(array_length(desired_slugs, 1), 0);

  SELECT COUNT(*)
  INTO office_count
  FROM public.offices
  WHERE scope = 'place'
    AND canonical_name = 'Town Moderator';

  IF office_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly 1 office row for scope=place canonical_name=Town Moderator, found %',
      office_count;
  END IF;

  SELECT COUNT(*)
  INTO area_count
  FROM public.research_areas
  WHERE slug = ANY (desired_slugs);

  IF area_count <> expected_area_count THEN
    RAISE EXCEPTION
      'Expected % research areas for town moderator mapping, found %',
      expected_area_count,
      area_count;
  END IF;

  INSERT INTO public.office_research_areas (office_id, research_area_id)
  SELECT office.id, area.id
  FROM public.offices office
  JOIN public.research_areas area
    ON area.slug = ANY (desired_slugs)
  WHERE office.scope = 'place'
    AND office.canonical_name = 'Town Moderator'
  ON CONFLICT (office_id, research_area_id) DO NOTHING;
END
$$;

DO $$
DECLARE
  desired_slugs text[] := ARRAY[
    'housing_affordability',
    'government_efficiency',
    'anti_corruption',
    'data_privacy',
    'corporate_accountability',
    'civil_rights'
  ]::text[];
  expected_area_count integer;
  office_count integer;
  area_count integer;
BEGIN
  expected_area_count := COALESCE(array_length(desired_slugs, 1), 0);

  SELECT COUNT(*)
  INTO office_count
  FROM public.offices
  WHERE scope = 'place'
    AND canonical_name = 'Municipal Assessor';

  IF office_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly 1 office row for scope=place canonical_name=Municipal Assessor, found %',
      office_count;
  END IF;

  SELECT COUNT(*)
  INTO area_count
  FROM public.research_areas
  WHERE slug = ANY (desired_slugs);

  IF area_count <> expected_area_count THEN
    RAISE EXCEPTION
      'Expected % research areas for municipal assessor mapping, found %',
      expected_area_count,
      area_count;
  END IF;

  INSERT INTO public.office_research_areas (office_id, research_area_id)
  SELECT office.id, area.id
  FROM public.offices office
  JOIN public.research_areas area
    ON area.slug = ANY (desired_slugs)
  WHERE office.scope = 'place'
    AND office.canonical_name = 'Municipal Assessor'
  ON CONFLICT (office_id, research_area_id) DO NOTHING;
END
$$;

DO $$
DECLARE
  desired_slugs text[] := ARRAY[
    'government_efficiency',
    'civil_rights',
    'anti_corruption',
    'public_safety_and_crime_control',
    'corporate_accountability',
    'data_privacy',
    'housing_affordability',
    'environment_and_public_health',
    'public_infrastructure'
  ]::text[];
  expected_area_count integer;
  office_count integer;
  area_count integer;
BEGIN
  expected_area_count := COALESCE(array_length(desired_slugs, 1), 0);

  SELECT COUNT(*)
  INTO office_count
  FROM public.offices
  WHERE scope = 'place'
    AND canonical_name = 'Municipal Attorney';

  IF office_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly 1 office row for scope=place canonical_name=Municipal Attorney, found %',
      office_count;
  END IF;

  SELECT COUNT(*)
  INTO area_count
  FROM public.research_areas
  WHERE slug = ANY (desired_slugs);

  IF area_count <> expected_area_count THEN
    RAISE EXCEPTION
      'Expected % research areas for municipal attorney mapping, found %',
      expected_area_count,
      area_count;
  END IF;

  INSERT INTO public.office_research_areas (office_id, research_area_id)
  SELECT office.id, area.id
  FROM public.offices office
  JOIN public.research_areas area
    ON area.slug = ANY (desired_slugs)
  WHERE office.scope = 'place'
    AND office.canonical_name = 'Municipal Attorney'
  ON CONFLICT (office_id, research_area_id) DO NOTHING;
END
$$;

DO $$
DECLARE
  desired_slugs text[] := ARRAY[
    'public_safety_and_crime_control',
    'civil_rights',
    'housing_affordability',
    'government_efficiency',
    'data_privacy',
    'anti_corruption'
  ]::text[];
  expected_area_count integer;
  office_count integer;
  area_count integer;
BEGIN
  expected_area_count := COALESCE(array_length(desired_slugs, 1), 0);

  SELECT COUNT(*)
  INTO office_count
  FROM public.offices
  WHERE scope = 'place'
    AND canonical_name = 'Municipal Constable';

  IF office_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly 1 office row for scope=place canonical_name=Municipal Constable, found %',
      office_count;
  END IF;

  SELECT COUNT(*)
  INTO area_count
  FROM public.research_areas
  WHERE slug = ANY (desired_slugs);

  IF area_count <> expected_area_count THEN
    RAISE EXCEPTION
      'Expected % research areas for municipal constable mapping, found %',
      expected_area_count,
      area_count;
  END IF;

  INSERT INTO public.office_research_areas (office_id, research_area_id)
  SELECT office.id, area.id
  FROM public.offices office
  JOIN public.research_areas area
    ON area.slug = ANY (desired_slugs)
  WHERE office.scope = 'place'
    AND office.canonical_name = 'Municipal Constable'
  ON CONFLICT (office_id, research_area_id) DO NOTHING;
END
$$;

DO $$
DECLARE
  desired_slugs text[] := ARRAY[
    'environment_and_public_health',
    'corporate_accountability',
    'government_efficiency',
    'social_programs_and_welfare',
    'cost_of_living_reduction',
    'public_infrastructure',
    'foreign_trade',
    'anti_corruption'
  ]::text[];
  expected_area_count integer;
  office_count integer;
  area_count integer;
BEGIN
  expected_area_count := COALESCE(array_length(desired_slugs, 1), 0);

  SELECT COUNT(*)
  INTO office_count
  FROM public.offices
  WHERE scope = 'statewide'
    AND canonical_name = 'Commissioner of Agriculture';

  IF office_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly 1 office row for scope=statewide canonical_name=Commissioner of Agriculture, found %',
      office_count;
  END IF;

  SELECT COUNT(*)
  INTO area_count
  FROM public.research_areas
  WHERE slug = ANY (desired_slugs);

  IF area_count <> expected_area_count THEN
    RAISE EXCEPTION
      'Expected % research areas for commissioner of agriculture mapping, found %',
      expected_area_count,
      area_count;
  END IF;

  INSERT INTO public.office_research_areas (office_id, research_area_id)
  SELECT office.id, area.id
  FROM public.offices office
  JOIN public.research_areas area
    ON area.slug = ANY (desired_slugs)
  WHERE office.scope = 'statewide'
    AND office.canonical_name = 'Commissioner of Agriculture'
  ON CONFLICT (office_id, research_area_id) DO NOTHING;
END
$$;

DO $$
DECLARE
  desired_slugs text[] := ARRAY[
    'healthcare_affordability',
    'cost_of_living_reduction',
    'corporate_accountability',
    'civil_rights',
    'data_privacy',
    'government_efficiency',
    'anti_corruption',
    'housing_affordability'
  ]::text[];
  expected_area_count integer;
  office_count integer;
  area_count integer;
BEGIN
  expected_area_count := COALESCE(array_length(desired_slugs, 1), 0);

  SELECT COUNT(*)
  INTO office_count
  FROM public.offices
  WHERE scope = 'statewide'
    AND canonical_name = 'Commissioner of Insurance';

  IF office_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly 1 office row for scope=statewide canonical_name=Commissioner of Insurance, found %',
      office_count;
  END IF;

  SELECT COUNT(*)
  INTO area_count
  FROM public.research_areas
  WHERE slug = ANY (desired_slugs);

  IF area_count <> expected_area_count THEN
    RAISE EXCEPTION
      'Expected % research areas for commissioner of insurance mapping, found %',
      expected_area_count,
      area_count;
  END IF;

  INSERT INTO public.office_research_areas (office_id, research_area_id)
  SELECT office.id, area.id
  FROM public.offices office
  JOIN public.research_areas area
    ON area.slug = ANY (desired_slugs)
  WHERE office.scope = 'statewide'
    AND office.canonical_name = 'Commissioner of Insurance'
  ON CONFLICT (office_id, research_area_id) DO NOTHING;
END
$$;

DO $$
DECLARE
  desired_slugs text[] := ARRAY[
    'cost_of_living_reduction',
    'public_infrastructure',
    'environment_and_public_health',
    'corporate_accountability',
    'government_efficiency',
    'anti_corruption',
    'data_privacy',
    'civil_rights'
  ]::text[];
  expected_area_count integer;
  office_count integer;
  area_count integer;
BEGIN
  expected_area_count := COALESCE(array_length(desired_slugs, 1), 0);

  SELECT COUNT(*)
  INTO office_count
  FROM public.offices
  WHERE scope = 'statewide'
    AND canonical_name = 'Corporation Commissioner';

  IF office_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly 1 office row for scope=statewide canonical_name=Corporation Commissioner, found %',
      office_count;
  END IF;

  SELECT COUNT(*)
  INTO area_count
  FROM public.research_areas
  WHERE slug = ANY (desired_slugs);

  IF area_count <> expected_area_count THEN
    RAISE EXCEPTION
      'Expected % research areas for corporation commissioner mapping, found %',
      expected_area_count,
      area_count;
  END IF;

  INSERT INTO public.office_research_areas (office_id, research_area_id)
  SELECT office.id, area.id
  FROM public.offices office
  JOIN public.research_areas area
    ON area.slug = ANY (desired_slugs)
  WHERE office.scope = 'statewide'
    AND office.canonical_name = 'Corporation Commissioner'
  ON CONFLICT (office_id, research_area_id) DO NOTHING;
END
$$;

DO $$
DECLARE
  desired_slugs text[] := ARRAY[
    'cost_of_living_reduction',
    'public_infrastructure',
    'environment_and_public_health',
    'corporate_accountability',
    'government_efficiency',
    'anti_corruption',
    'data_privacy',
    'civil_rights'
  ]::text[];
  expected_area_count integer;
  office_count integer;
  area_count integer;
BEGIN
  expected_area_count := COALESCE(array_length(desired_slugs, 1), 0);

  SELECT COUNT(*)
  INTO office_count
  FROM public.offices
  WHERE scope = 'statewide'
    AND canonical_name = 'Public Service Commissioner';

  IF office_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly 1 office row for scope=statewide canonical_name=Public Service Commissioner, found %',
      office_count;
  END IF;

  SELECT COUNT(*)
  INTO area_count
  FROM public.research_areas
  WHERE slug = ANY (desired_slugs);

  IF area_count <> expected_area_count THEN
    RAISE EXCEPTION
      'Expected % research areas for public service commissioner mapping, found %',
      expected_area_count,
      area_count;
  END IF;

  INSERT INTO public.office_research_areas (office_id, research_area_id)
  SELECT office.id, area.id
  FROM public.offices office
  JOIN public.research_areas area
    ON area.slug = ANY (desired_slugs)
  WHERE office.scope = 'statewide'
    AND office.canonical_name = 'Public Service Commissioner'
  ON CONFLICT (office_id, research_area_id) DO NOTHING;
END
$$;

DO $$
DECLARE
  desired_slugs text[] := ARRAY[
    'public_education_quality',
    'civil_rights',
    'government_efficiency',
    'government_spending_reduction',
    'data_privacy',
    'social_programs_and_welfare',
    'public_safety_and_crime_control',
    'healthcare_affordability',
    'anti_corruption',
    'environment_and_public_health',
    'public_infrastructure'
  ]::text[];
  expected_area_count integer;
  office_count integer;
  area_count integer;
BEGIN
  expected_area_count := COALESCE(array_length(desired_slugs, 1), 0);

  SELECT COUNT(*)
  INTO office_count
  FROM public.offices
  WHERE scope = 'statewide'
    AND canonical_name = 'State Board of Education Member';

  IF office_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly 1 office row for scope=statewide canonical_name=State Board of Education Member, found %',
      office_count;
  END IF;

  SELECT COUNT(*)
  INTO area_count
  FROM public.research_areas
  WHERE slug = ANY (desired_slugs);

  IF area_count <> expected_area_count THEN
    RAISE EXCEPTION
      'Expected % research areas for state board of education member mapping, found %',
      expected_area_count,
      area_count;
  END IF;

  INSERT INTO public.office_research_areas (office_id, research_area_id)
  SELECT office.id, area.id
  FROM public.offices office
  JOIN public.research_areas area
    ON area.slug = ANY (desired_slugs)
  WHERE office.scope = 'statewide'
    AND office.canonical_name = 'State Board of Education Member'
  ON CONFLICT (office_id, research_area_id) DO NOTHING;
END
$$;

DO $$
DECLARE
  desired_slugs text[] := ARRAY[
    'public_education_quality',
    'government_efficiency',
    'government_spending_reduction',
    'civil_rights',
    'social_programs_and_welfare',
    'data_privacy',
    'public_safety_and_crime_control',
    'healthcare_affordability',
    'anti_corruption',
    'environment_and_public_health',
    'public_infrastructure'
  ]::text[];
  expected_area_count integer;
  office_count integer;
  area_count integer;
BEGIN
  expected_area_count := COALESCE(array_length(desired_slugs, 1), 0);

  SELECT COUNT(*)
  INTO office_count
  FROM public.offices
  WHERE scope = 'statewide'
    AND canonical_name = 'Superintendent of Public Instruction';

  IF office_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly 1 office row for scope=statewide canonical_name=Superintendent of Public Instruction, found %',
      office_count;
  END IF;

  SELECT COUNT(*)
  INTO area_count
  FROM public.research_areas
  WHERE slug = ANY (desired_slugs);

  IF area_count <> expected_area_count THEN
    RAISE EXCEPTION
      'Expected % research areas for superintendent of public instruction mapping, found %',
      expected_area_count,
      area_count;
  END IF;

  INSERT INTO public.office_research_areas (office_id, research_area_id)
  SELECT office.id, area.id
  FROM public.offices office
  JOIN public.research_areas area
    ON area.slug = ANY (desired_slugs)
  WHERE office.scope = 'statewide'
    AND office.canonical_name = 'Superintendent of Public Instruction'
  ON CONFLICT (office_id, research_area_id) DO NOTHING;
END
$$;

DO $$
DECLARE
  desired_slugs text[] := ARRAY[
    'government_efficiency',
    'government_spending_reduction',
    'anti_corruption',
    'public_safety_and_crime_control',
    'civil_rights',
    'public_infrastructure',
    'corporate_accountability'
  ]::text[];
  expected_area_count integer;
  office_count integer;
  area_count integer;
BEGIN
  expected_area_count := COALESCE(array_length(desired_slugs, 1), 0);

  SELECT COUNT(*)
  INTO office_count
  FROM public.offices
  WHERE scope = 'statewide'
    AND canonical_name = 'Lieutenant Governor';

  IF office_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly 1 office row for scope=statewide canonical_name=Lieutenant Governor, found %',
      office_count;
  END IF;

  SELECT COUNT(*)
  INTO area_count
  FROM public.research_areas
  WHERE slug = ANY (desired_slugs);

  IF area_count <> expected_area_count THEN
    RAISE EXCEPTION
      'Expected % research areas for lieutenant governor mapping, found %',
      expected_area_count,
      area_count;
  END IF;

  INSERT INTO public.office_research_areas (office_id, research_area_id)
  SELECT office.id, area.id
  FROM public.offices office
  JOIN public.research_areas area
    ON area.slug = ANY (desired_slugs)
  WHERE office.scope = 'statewide'
    AND office.canonical_name = 'Lieutenant Governor'
  ON CONFLICT (office_id, research_area_id) DO NOTHING;
END
$$;

DO $$
DECLARE
  desired_slugs text[] := ARRAY[
    'election_integrity',
    'government_efficiency',
    'anti_corruption',
    'data_privacy',
    'civil_rights',
    'corporate_accountability'
  ]::text[];
  expected_area_count integer;
  office_count integer;
  area_count integer;
BEGIN
  expected_area_count := COALESCE(array_length(desired_slugs, 1), 0);

  SELECT COUNT(*)
  INTO office_count
  FROM public.offices
  WHERE scope = 'statewide'
    AND canonical_name = 'Secretary of State';

  IF office_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly 1 office row for scope=statewide canonical_name=Secretary of State, found %',
      office_count;
  END IF;

  SELECT COUNT(*)
  INTO area_count
  FROM public.research_areas
  WHERE slug = ANY (desired_slugs);

  IF area_count <> expected_area_count THEN
    RAISE EXCEPTION
      'Expected % research areas for secretary of state mapping, found %',
      expected_area_count,
      area_count;
  END IF;

  INSERT INTO public.office_research_areas (office_id, research_area_id)
  SELECT office.id, area.id
  FROM public.offices office
  JOIN public.research_areas area
    ON area.slug = ANY (desired_slugs)
  WHERE office.scope = 'statewide'
    AND office.canonical_name = 'Secretary of State'
  ON CONFLICT (office_id, research_area_id) DO NOTHING;
END
$$;

DO $$
DECLARE
  desired_slugs text[] := ARRAY[
    'government_efficiency',
    'anti_corruption',
    'government_spending_reduction',
    'data_privacy',
    'corporate_accountability',
    'civil_rights'
  ]::text[];
  expected_area_count integer;
  office_count integer;
  area_count integer;
BEGIN
  expected_area_count := COALESCE(array_length(desired_slugs, 1), 0);

  SELECT COUNT(*)
  INTO office_count
  FROM public.offices
  WHERE scope = 'statewide'
    AND canonical_name = 'State Auditor';

  IF office_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly 1 office row for scope=statewide canonical_name=State Auditor, found %',
      office_count;
  END IF;

  SELECT COUNT(*)
  INTO area_count
  FROM public.research_areas
  WHERE slug = ANY (desired_slugs);

  IF area_count <> expected_area_count THEN
    RAISE EXCEPTION
      'Expected % research areas for state auditor mapping, found %',
      expected_area_count,
      area_count;
  END IF;

  INSERT INTO public.office_research_areas (office_id, research_area_id)
  SELECT office.id, area.id
  FROM public.offices office
  JOIN public.research_areas area
    ON area.slug = ANY (desired_slugs)
  WHERE office.scope = 'statewide'
    AND office.canonical_name = 'State Auditor'
  ON CONFLICT (office_id, research_area_id) DO NOTHING;
END
$$;

DO $$
DECLARE
  desired_slugs text[] := ARRAY[
    'government_spending_reduction',
    'government_efficiency',
    'anti_corruption',
    'corporate_accountability',
    'data_privacy',
    'public_infrastructure'
  ]::text[];
  expected_area_count integer;
  office_count integer;
  area_count integer;
BEGIN
  expected_area_count := COALESCE(array_length(desired_slugs, 1), 0);

  SELECT COUNT(*)
  INTO office_count
  FROM public.offices
  WHERE scope = 'statewide'
    AND canonical_name = 'State Treasurer';

  IF office_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly 1 office row for scope=statewide canonical_name=State Treasurer, found %',
      office_count;
  END IF;

  SELECT COUNT(*)
  INTO area_count
  FROM public.research_areas
  WHERE slug = ANY (desired_slugs);

  IF area_count <> expected_area_count THEN
    RAISE EXCEPTION
      'Expected % research areas for state treasurer mapping, found %',
      expected_area_count,
      area_count;
  END IF;

  INSERT INTO public.office_research_areas (office_id, research_area_id)
  SELECT office.id, area.id
  FROM public.offices office
  JOIN public.research_areas area
    ON area.slug = ANY (desired_slugs)
  WHERE office.scope = 'statewide'
    AND office.canonical_name = 'State Treasurer'
  ON CONFLICT (office_id, research_area_id) DO NOTHING;
END
$$;

DO $$
DECLARE
  desired_slugs text[] := ARRAY[
    'government_spending_reduction',
    'government_efficiency',
    'anti_corruption',
    'corporate_accountability',
    'data_privacy'
  ]::text[];
  expected_area_count integer;
  office_count integer;
  area_count integer;
BEGIN
  expected_area_count := COALESCE(array_length(desired_slugs, 1), 0);

  SELECT COUNT(*)
  INTO office_count
  FROM public.offices
  WHERE scope = 'statewide'
    AND canonical_name = 'Comptroller';

  IF office_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly 1 office row for scope=statewide canonical_name=Comptroller, found %',
      office_count;
  END IF;

  SELECT COUNT(*)
  INTO area_count
  FROM public.research_areas
  WHERE slug = ANY (desired_slugs);

  IF area_count <> expected_area_count THEN
    RAISE EXCEPTION
      'Expected % research areas for comptroller mapping, found %',
      expected_area_count,
      area_count;
  END IF;

  INSERT INTO public.office_research_areas (office_id, research_area_id)
  SELECT office.id, area.id
  FROM public.offices office
  JOIN public.research_areas area
    ON area.slug = ANY (desired_slugs)
  WHERE office.scope = 'statewide'
    AND office.canonical_name = 'Comptroller'
  ON CONFLICT (office_id, research_area_id) DO NOTHING;
END
$$;

DO $$
DECLARE
  desired_slugs text[] := ARRAY[
    'public_safety_and_crime_control',
    'civil_rights',
    'corporate_accountability',
    'anti_corruption',
    'data_privacy',
    'environment_and_public_health',
    'healthcare_affordability',
    'social_programs_and_welfare',
    'government_efficiency',
    'election_integrity',
    'womens_reproductive_rights',
    'immigration',
    'housing_affordability'
  ]::text[];
  expected_area_count integer;
  office_count integer;
  area_count integer;
BEGIN
  expected_area_count := COALESCE(array_length(desired_slugs, 1), 0);

  SELECT COUNT(*)
  INTO office_count
  FROM public.offices
  WHERE scope = 'statewide'
    AND canonical_name = 'Attorney General';

  IF office_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly 1 office row for scope=statewide canonical_name=Attorney General, found %',
      office_count;
  END IF;

  SELECT COUNT(*)
  INTO area_count
  FROM public.research_areas
  WHERE slug = ANY (desired_slugs);

  IF area_count <> expected_area_count THEN
    RAISE EXCEPTION
      'Expected % research areas for attorney general mapping, found %',
      expected_area_count,
      area_count;
  END IF;

  INSERT INTO public.office_research_areas (office_id, research_area_id)
  SELECT office.id, area.id
  FROM public.offices office
  JOIN public.research_areas area
    ON area.slug = ANY (desired_slugs)
  WHERE office.scope = 'statewide'
    AND office.canonical_name = 'Attorney General'
  ON CONFLICT (office_id, research_area_id) DO NOTHING;
END
$$;

DO $$
DECLARE
  desired_slugs text[] := ARRAY[
    'government_efficiency',
    'government_spending_reduction',
    'public_safety_and_crime_control',
    'public_infrastructure',
    'housing_affordability',
    'environment_and_public_health',
    'social_programs_and_welfare',
    'civil_rights',
    'anti_corruption',
    'corporate_accountability',
    'data_privacy'
  ]::text[];
  expected_area_count integer;
  office_count integer;
  area_count integer;
BEGIN
  expected_area_count := COALESCE(array_length(desired_slugs, 1), 0);

  SELECT COUNT(*)
  INTO office_count
  FROM public.offices
  WHERE scope = 'place'
    AND canonical_name = 'Mayor';

  IF office_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly 1 office row for scope=place canonical_name=Mayor, found %',
      office_count;
  END IF;

  SELECT COUNT(*)
  INTO area_count
  FROM public.research_areas
  WHERE slug = ANY (desired_slugs);

  IF area_count <> expected_area_count THEN
    RAISE EXCEPTION
      'Expected % research areas for mayor mapping, found %',
      expected_area_count,
      area_count;
  END IF;

  INSERT INTO public.office_research_areas (office_id, research_area_id)
  SELECT office.id, area.id
  FROM public.offices office
  JOIN public.research_areas area
    ON area.slug = ANY (desired_slugs)
  WHERE office.scope = 'place'
    AND office.canonical_name = 'Mayor'
  ON CONFLICT (office_id, research_area_id) DO NOTHING;
END
$$;

DO $$
DECLARE
  desired_slugs text[] := ARRAY[
    'public_education_quality',
    'government_spending_reduction',
    'government_efficiency',
    'civil_rights',
    'data_privacy',
    'anti_corruption',
    'corporate_accountability'
  ]::text[];
  expected_area_count integer;
  office_count integer;
  area_count integer;
BEGIN
  expected_area_count := COALESCE(array_length(desired_slugs, 1), 0);

  SELECT COUNT(*)
  INTO office_count
  FROM public.offices
  WHERE scope = 'statewide'
    AND canonical_name = 'State Board of Regents Member';

  IF office_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly 1 office row for scope=statewide canonical_name=State Board of Regents Member, found %',
      office_count;
  END IF;

  SELECT COUNT(*)
  INTO area_count
  FROM public.research_areas
  WHERE slug = ANY (desired_slugs);

  IF area_count <> expected_area_count THEN
    RAISE EXCEPTION
      'Expected % research areas for state board of regents mapping, found %',
      expected_area_count,
      area_count;
  END IF;

  INSERT INTO public.office_research_areas (office_id, research_area_id)
  SELECT office.id, area.id
  FROM public.offices office
  JOIN public.research_areas area
    ON area.slug = ANY (desired_slugs)
  WHERE office.scope = 'statewide'
    AND office.canonical_name = 'State Board of Regents Member'
  ON CONFLICT (office_id, research_area_id) DO NOTHING;
END
$$;

DO $$
DECLARE
  desired_slugs text[] := ARRAY[
    'housing_affordability',
    'cost_of_living_reduction',
    'government_efficiency',
    'government_spending_reduction',
    'anti_corruption',
    'corporate_accountability',
    'civil_rights',
    'data_privacy'
  ]::text[];
  expected_area_count integer;
  office_count integer;
  area_count integer;
BEGIN
  expected_area_count := COALESCE(array_length(desired_slugs, 1), 0);

  SELECT COUNT(*)
  INTO office_count
  FROM public.offices
  WHERE scope = 'statewide'
    AND canonical_name = 'State Board of Equalization Member';

  IF office_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly 1 office row for scope=statewide canonical_name=State Board of Equalization Member, found %',
      office_count;
  END IF;

  SELECT COUNT(*)
  INTO area_count
  FROM public.research_areas
  WHERE slug = ANY (desired_slugs);

  IF area_count <> expected_area_count THEN
    RAISE EXCEPTION
      'Expected % research areas for state board of equalization mapping, found %',
      expected_area_count,
      area_count;
  END IF;

  INSERT INTO public.office_research_areas (office_id, research_area_id)
  SELECT office.id, area.id
  FROM public.offices office
  JOIN public.research_areas area
    ON area.slug = ANY (desired_slugs)
  WHERE office.scope = 'statewide'
    AND office.canonical_name = 'State Board of Equalization Member'
  ON CONFLICT (office_id, research_area_id) DO NOTHING;
END
$$;

DO $$
DECLARE
  desired_slugs text[] := ARRAY[
    'public_safety_and_crime_control',
    'civil_rights',
    'government_efficiency',
    'anti_corruption',
    'data_privacy',
    'social_programs_and_welfare'
  ]::text[];
  expected_area_count integer;
  office_count integer;
  area_count integer;
BEGIN
  expected_area_count := COALESCE(array_length(desired_slugs, 1), 0);

  SELECT COUNT(*)
  INTO office_count
  FROM public.offices
  WHERE scope = 'county'
    AND canonical_name = 'Sheriff';

  IF office_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly 1 office row for scope=county canonical_name=Sheriff, found %',
      office_count;
  END IF;

  SELECT COUNT(*)
  INTO area_count
  FROM public.research_areas
  WHERE slug = ANY (desired_slugs);

  IF area_count <> expected_area_count THEN
    RAISE EXCEPTION
      'Expected % research areas for sheriff mapping, found %',
      expected_area_count,
      area_count;
  END IF;

  INSERT INTO public.office_research_areas (office_id, research_area_id)
  SELECT office.id, area.id
  FROM public.offices office
  JOIN public.research_areas area
    ON area.slug = ANY (desired_slugs)
  WHERE office.scope = 'county'
    AND office.canonical_name = 'Sheriff'
  ON CONFLICT (office_id, research_area_id) DO NOTHING;
END
$$;

DO $$
DECLARE
  desired_slugs text[] := ARRAY[
    'housing_affordability',
    'government_efficiency',
    'anti_corruption',
    'data_privacy',
    'corporate_accountability',
    'civil_rights'
  ]::text[];
  expected_area_count integer;
  office_count integer;
  area_count integer;
BEGIN
  expected_area_count := COALESCE(array_length(desired_slugs, 1), 0);

  SELECT COUNT(*)
  INTO office_count
  FROM public.offices
  WHERE scope = 'county'
    AND canonical_name = 'County Assessor';

  IF office_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly 1 office row for scope=county canonical_name=County Assessor, found %',
      office_count;
  END IF;

  SELECT COUNT(*)
  INTO area_count
  FROM public.research_areas
  WHERE slug = ANY (desired_slugs);

  IF area_count <> expected_area_count THEN
    RAISE EXCEPTION
      'Expected % research areas for county assessor mapping, found %',
      expected_area_count,
      area_count;
  END IF;

  INSERT INTO public.office_research_areas (office_id, research_area_id)
  SELECT office.id, area.id
  FROM public.offices office
  JOIN public.research_areas area
    ON area.slug = ANY (desired_slugs)
  WHERE office.scope = 'county'
    AND office.canonical_name = 'County Assessor'
  ON CONFLICT (office_id, research_area_id) DO NOTHING;
END
$$;

DO $$
DECLARE
  desired_slugs text[] := ARRAY[
    'government_spending_reduction',
    'government_efficiency',
    'public_infrastructure',
    'housing_affordability',
    'environment_and_public_health',
    'healthcare_affordability',
    'social_programs_and_welfare',
    'public_safety_and_crime_control',
    'anti_corruption',
    'corporate_accountability',
    'civil_rights',
    'data_privacy',
    'election_integrity'
  ]::text[];
  expected_area_count integer;
  office_count integer;
  area_count integer;
BEGIN
  expected_area_count := COALESCE(array_length(desired_slugs, 1), 0);

  SELECT COUNT(*)
  INTO office_count
  FROM public.offices
  WHERE scope = 'county'
    AND canonical_name = 'County Supervisor';

  IF office_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly 1 office row for scope=county canonical_name=County Supervisor, found %',
      office_count;
  END IF;

  SELECT COUNT(*)
  INTO area_count
  FROM public.research_areas
  WHERE slug = ANY (desired_slugs);

  IF area_count <> expected_area_count THEN
    RAISE EXCEPTION
      'Expected % research areas for county supervisor mapping, found %',
      expected_area_count,
      area_count;
  END IF;

  INSERT INTO public.office_research_areas (office_id, research_area_id)
  SELECT office.id, area.id
  FROM public.offices office
  JOIN public.research_areas area
    ON area.slug = ANY (desired_slugs)
  WHERE office.scope = 'county'
    AND office.canonical_name = 'County Supervisor'
  ON CONFLICT (office_id, research_area_id) DO NOTHING;
END
$$;

DO $$
DECLARE
  desired_slugs text[] := ARRAY[
    'government_spending_reduction',
    'government_efficiency',
    'public_infrastructure',
    'housing_affordability',
    'environment_and_public_health',
    'healthcare_affordability',
    'social_programs_and_welfare',
    'public_safety_and_crime_control',
    'anti_corruption',
    'corporate_accountability',
    'civil_rights',
    'data_privacy',
    'election_integrity',
    'reduce_wealth_gap'
  ]::text[];
  expected_area_count integer;
  office_count integer;
  area_count integer;
BEGIN
  expected_area_count := COALESCE(array_length(desired_slugs, 1), 0);

  SELECT COUNT(*)
  INTO office_count
  FROM public.offices
  WHERE scope = 'county'
    AND canonical_name = 'County Executive';

  IF office_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly 1 office row for scope=county canonical_name=County Executive, found %',
      office_count;
  END IF;

  SELECT COUNT(*)
  INTO area_count
  FROM public.research_areas
  WHERE slug = ANY (desired_slugs);

  IF area_count <> expected_area_count THEN
    RAISE EXCEPTION
      'Expected % research areas for county executive mapping, found %',
      expected_area_count,
      area_count;
  END IF;

  INSERT INTO public.office_research_areas (office_id, research_area_id)
  SELECT office.id, area.id
  FROM public.offices office
  JOIN public.research_areas area
    ON area.slug = ANY (desired_slugs)
  WHERE office.scope = 'county'
    AND office.canonical_name = 'County Executive'
  ON CONFLICT (office_id, research_area_id) DO NOTHING;
END
$$;

DO $$
DECLARE
  desired_slugs text[] := ARRAY[
    'election_integrity',
    'government_efficiency',
    'data_privacy',
    'anti_corruption',
    'civil_rights',
    'corporate_accountability'
  ]::text[];
  expected_area_count integer;
  office_count integer;
  area_count integer;
BEGIN
  expected_area_count := COALESCE(array_length(desired_slugs, 1), 0);

  SELECT COUNT(*)
  INTO office_count
  FROM public.offices
  WHERE scope = 'county'
    AND canonical_name = 'County Clerk';

  IF office_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly 1 office row for scope=county canonical_name=County Clerk, found %',
      office_count;
  END IF;

  SELECT COUNT(*)
  INTO area_count
  FROM public.research_areas
  WHERE slug = ANY (desired_slugs);

  IF area_count <> expected_area_count THEN
    RAISE EXCEPTION
      'Expected % research areas for county clerk mapping, found %',
      expected_area_count,
      area_count;
  END IF;

  INSERT INTO public.office_research_areas (office_id, research_area_id)
  SELECT office.id, area.id
  FROM public.offices office
  JOIN public.research_areas area
    ON area.slug = ANY (desired_slugs)
  WHERE office.scope = 'county'
    AND office.canonical_name = 'County Clerk'
  ON CONFLICT (office_id, research_area_id) DO NOTHING;
END
$$;

DO $$
DECLARE
  desired_slugs text[] := ARRAY[
    'government_spending_reduction',
    'government_efficiency',
    'public_infrastructure',
    'housing_affordability',
    'environment_and_public_health',
    'healthcare_affordability',
    'social_programs_and_welfare',
    'public_safety_and_crime_control',
    'anti_corruption',
    'corporate_accountability',
    'civil_rights',
    'data_privacy',
    'election_integrity'
  ]::text[];
  expected_area_count integer;
  office_count integer;
  area_count integer;
BEGIN
  expected_area_count := COALESCE(array_length(desired_slugs, 1), 0);

  SELECT COUNT(*)
  INTO office_count
  FROM public.offices
  WHERE scope = 'county'
    AND canonical_name = 'County Commissioner';

  IF office_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly 1 office row for scope=county canonical_name=County Commissioner, found %',
      office_count;
  END IF;

  SELECT COUNT(*)
  INTO area_count
  FROM public.research_areas
  WHERE slug = ANY (desired_slugs);

  IF area_count <> expected_area_count THEN
    RAISE EXCEPTION
      'Expected % research areas for county commissioner mapping, found %',
      expected_area_count,
      area_count;
  END IF;

  INSERT INTO public.office_research_areas (office_id, research_area_id)
  SELECT office.id, area.id
  FROM public.offices office
  JOIN public.research_areas area
    ON area.slug = ANY (desired_slugs)
  WHERE office.scope = 'county'
    AND office.canonical_name = 'County Commissioner'
  ON CONFLICT (office_id, research_area_id) DO NOTHING;
END
$$;

DO $$
DECLARE
  desired_slugs text[] := ARRAY[
    'public_safety_and_crime_control',
    'environment_and_public_health',
    'civil_rights',
    'data_privacy',
    'anti_corruption',
    'government_efficiency',
    'social_programs_and_welfare'
  ]::text[];
  expected_area_count integer;
  office_count integer;
  area_count integer;
BEGIN
  expected_area_count := COALESCE(array_length(desired_slugs, 1), 0);

  SELECT COUNT(*)
  INTO office_count
  FROM public.offices
  WHERE scope = 'county'
    AND canonical_name = 'County Coroner';

  IF office_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly 1 office row for scope=county canonical_name=County Coroner, found %',
      office_count;
  END IF;

  SELECT COUNT(*)
  INTO area_count
  FROM public.research_areas
  WHERE slug = ANY (desired_slugs);

  IF area_count <> expected_area_count THEN
    RAISE EXCEPTION
      'Expected % research areas for county coroner mapping, found %',
      expected_area_count,
      area_count;
  END IF;

  INSERT INTO public.office_research_areas (office_id, research_area_id)
  SELECT office.id, area.id
  FROM public.offices office
  JOIN public.research_areas area
    ON area.slug = ANY (desired_slugs)
  WHERE office.scope = 'county'
    AND office.canonical_name = 'County Coroner'
  ON CONFLICT (office_id, research_area_id) DO NOTHING;
END
$$;

DO $$
DECLARE
  desired_slugs text[] := ARRAY[
    'housing_affordability',
    'data_privacy',
    'government_efficiency',
    'anti_corruption',
    'civil_rights',
    'corporate_accountability'
  ]::text[];
  expected_area_count integer;
  office_count integer;
  area_count integer;
BEGIN
  expected_area_count := COALESCE(array_length(desired_slugs, 1), 0);

  SELECT COUNT(*)
  INTO office_count
  FROM public.offices
  WHERE scope = 'county'
    AND canonical_name = 'County Recorder';

  IF office_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly 1 office row for scope=county canonical_name=County Recorder, found %',
      office_count;
  END IF;

  SELECT COUNT(*)
  INTO area_count
  FROM public.research_areas
  WHERE slug = ANY (desired_slugs);

  IF area_count <> expected_area_count THEN
    RAISE EXCEPTION
      'Expected % research areas for county recorder mapping, found %',
      expected_area_count,
      area_count;
  END IF;

  INSERT INTO public.office_research_areas (office_id, research_area_id)
  SELECT office.id, area.id
  FROM public.offices office
  JOIN public.research_areas area
    ON area.slug = ANY (desired_slugs)
  WHERE office.scope = 'county'
    AND office.canonical_name = 'County Recorder'
  ON CONFLICT (office_id, research_area_id) DO NOTHING;
END
$$;

DO $$
DECLARE
  desired_slugs text[] := ARRAY[
    'public_education_quality',
    'government_efficiency',
    'government_spending_reduction',
    'civil_rights',
    'social_programs_and_welfare',
    'data_privacy',
    'public_safety_and_crime_control',
    'healthcare_affordability',
    'anti_corruption',
    'environment_and_public_health',
    'public_infrastructure'
  ]::text[];
  expected_area_count integer;
  office_count integer;
  area_count integer;
BEGIN
  expected_area_count := COALESCE(array_length(desired_slugs, 1), 0);

  SELECT COUNT(*)
  INTO office_count
  FROM public.offices
  WHERE scope = 'county'
    AND canonical_name = 'County Superintendent of Schools';

  IF office_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly 1 office row for scope=county canonical_name=County Superintendent of Schools, found %',
      office_count;
  END IF;

  SELECT COUNT(*)
  INTO area_count
  FROM public.research_areas
  WHERE slug = ANY (desired_slugs);

  IF area_count <> expected_area_count THEN
    RAISE EXCEPTION
      'Expected % research areas for county superintendent of schools mapping, found %',
      expected_area_count,
      area_count;
  END IF;

  INSERT INTO public.office_research_areas (office_id, research_area_id)
  SELECT office.id, area.id
  FROM public.offices office
  JOIN public.research_areas area
    ON area.slug = ANY (desired_slugs)
  WHERE office.scope = 'county'
    AND office.canonical_name = 'County Superintendent of Schools'
  ON CONFLICT (office_id, research_area_id) DO NOTHING;
END
$$;

DO $$
DECLARE
  desired_slugs text[] := ARRAY[
    'government_spending_reduction',
    'government_efficiency',
    'anti_corruption',
    'data_privacy',
    'housing_affordability',
    'corporate_accountability',
    'civil_rights'
  ]::text[];
  expected_area_count integer;
  office_count integer;
  area_count integer;
BEGIN
  expected_area_count := COALESCE(array_length(desired_slugs, 1), 0);

  SELECT COUNT(*)
  INTO office_count
  FROM public.offices
  WHERE scope = 'county'
    AND canonical_name = 'County Treasurer';

  IF office_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly 1 office row for scope=county canonical_name=County Treasurer, found %',
      office_count;
  END IF;

  SELECT COUNT(*)
  INTO area_count
  FROM public.research_areas
  WHERE slug = ANY (desired_slugs);

  IF area_count <> expected_area_count THEN
    RAISE EXCEPTION
      'Expected % research areas for county treasurer mapping, found %',
      expected_area_count,
      area_count;
  END IF;

  INSERT INTO public.office_research_areas (office_id, research_area_id)
  SELECT office.id, area.id
  FROM public.offices office
  JOIN public.research_areas area
    ON area.slug = ANY (desired_slugs)
  WHERE office.scope = 'county'
    AND office.canonical_name = 'County Treasurer'
  ON CONFLICT (office_id, research_area_id) DO NOTHING;
END
$$;

DO $$
DECLARE
  desired_slugs text[] := ARRAY[
    'government_spending_reduction',
    'government_efficiency',
    'anti_corruption',
    'data_privacy',
    'housing_affordability',
    'corporate_accountability',
    'civil_rights'
  ]::text[];
  expected_area_count integer;
  office_count integer;
  area_count integer;
BEGIN
  expected_area_count := COALESCE(array_length(desired_slugs, 1), 0);

  SELECT COUNT(*)
  INTO office_count
  FROM public.offices
  WHERE scope = 'county'
    AND canonical_name = 'Public Administrator';

  IF office_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly 1 office row for scope=county canonical_name=Public Administrator, found %',
      office_count;
  END IF;

  SELECT COUNT(*)
  INTO area_count
  FROM public.research_areas
  WHERE slug = ANY (desired_slugs);

  IF area_count <> expected_area_count THEN
    RAISE EXCEPTION
      'Expected % research areas for public administrator mapping, found %',
      expected_area_count,
      area_count;
  END IF;

  INSERT INTO public.office_research_areas (office_id, research_area_id)
  SELECT office.id, area.id
  FROM public.offices office
  JOIN public.research_areas area
    ON area.slug = ANY (desired_slugs)
  WHERE office.scope = 'county'
    AND office.canonical_name = 'Public Administrator'
  ON CONFLICT (office_id, research_area_id) DO NOTHING;
END
$$;

DO $$
DECLARE
  desired_scopes text[] := ARRAY[
    'school_elementary',
    'school_secondary',
    'school_unified'
  ]::text[];
  desired_slugs text[] := ARRAY[
    'public_education_quality',
    'government_spending_reduction',
    'government_efficiency',
    'civil_rights',
    'public_safety_and_crime_control',
    'social_programs_and_welfare',
    'data_privacy',
    'anti_corruption',
    'environment_and_public_health',
    'public_infrastructure'
  ]::text[];
  expected_scope_count integer;
  expected_area_count integer;
  office_count integer;
  area_count integer;
BEGIN
  expected_scope_count := COALESCE(array_length(desired_scopes, 1), 0);
  expected_area_count := COALESCE(array_length(desired_slugs, 1), 0);

  SELECT COUNT(*)
  INTO office_count
  FROM public.offices
  WHERE scope = ANY (desired_scopes)
    AND canonical_name = 'School Board Member';

  IF office_count <> expected_scope_count THEN
    RAISE EXCEPTION
      'Expected exactly % School Board Member office rows across school scopes, found %',
      expected_scope_count,
      office_count;
  END IF;

  SELECT COUNT(*)
  INTO area_count
  FROM public.research_areas
  WHERE slug = ANY (desired_slugs);

  IF area_count <> expected_area_count THEN
    RAISE EXCEPTION
      'Expected % research areas for school board mapping, found %',
      expected_area_count,
      area_count;
  END IF;

  INSERT INTO public.office_research_areas (office_id, research_area_id)
  SELECT office.id, area.id
  FROM public.offices office
  JOIN public.research_areas area
    ON area.slug = ANY (desired_slugs)
  WHERE office.scope = ANY (desired_scopes)
    AND office.canonical_name = 'School Board Member'
  ON CONFLICT (office_id, research_area_id) DO NOTHING;
END
$$;

DO $$
DECLARE
  desired_slugs text[] := ARRAY[
    'public_safety_and_crime_control',
    'civil_rights',
    'anti_corruption',
    'government_efficiency',
    'corporate_accountability',
    'data_privacy',
    'social_programs_and_welfare'
  ]::text[];
  expected_area_count integer;
  office_count integer;
  area_count integer;
BEGIN
  expected_area_count := COALESCE(array_length(desired_slugs, 1), 0);

  SELECT COUNT(*)
  INTO office_count
  FROM public.offices
  WHERE scope = 'county'
    AND canonical_name = 'District Attorney';

  IF office_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly 1 office row for scope=county canonical_name=District Attorney, found %',
      office_count;
  END IF;

  SELECT COUNT(*)
  INTO area_count
  FROM public.research_areas
  WHERE slug = ANY (desired_slugs);

  IF area_count <> expected_area_count THEN
    RAISE EXCEPTION
      'Expected % research areas for district attorney mapping, found %',
      expected_area_count,
      area_count;
  END IF;

  INSERT INTO public.office_research_areas (office_id, research_area_id)
  SELECT office.id, area.id
  FROM public.offices office
  JOIN public.research_areas area
    ON area.slug = ANY (desired_slugs)
  WHERE office.scope = 'county'
    AND office.canonical_name = 'District Attorney'
  ON CONFLICT (office_id, research_area_id) DO NOTHING;
END
$$;

DO $$
DECLARE
  desired_slugs text[] := ARRAY[
    'public_safety_and_crime_control',
    'civil_rights',
    'housing_affordability',
    'corporate_accountability',
    'data_privacy',
    'anti_corruption',
    'government_efficiency',
    'election_integrity',
    'environment_and_public_health',
    'healthcare_affordability',
    'social_programs_and_welfare',
    'womens_reproductive_rights',
    'public_education_quality',
    'immigration',
    'legal_competence',
    'impartiality'
  ]::text[];
  expected_area_count integer;
  office_count integer;
  area_count integer;
BEGIN
  expected_area_count := COALESCE(array_length(desired_slugs, 1), 0);

  SELECT COUNT(*)
  INTO office_count
  FROM public.offices
  WHERE scope = 'county'
    AND canonical_name = 'County Level Judge';

  IF office_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly 1 office row for scope=county canonical_name=County Level Judge, found %',
      office_count;
  END IF;

  SELECT COUNT(*)
  INTO area_count
  FROM public.research_areas
  WHERE slug = ANY (desired_slugs);

  IF area_count <> expected_area_count THEN
    RAISE EXCEPTION
      'Expected % research areas for county-level judge mapping, found %',
      expected_area_count,
      area_count;
  END IF;

  INSERT INTO public.office_research_areas (office_id, research_area_id)
  SELECT office.id, area.id
  FROM public.offices office
  JOIN public.research_areas area
    ON area.slug = ANY (desired_slugs)
  WHERE office.scope = 'county'
    AND office.canonical_name = 'County Level Judge'
  ON CONFLICT (office_id, research_area_id) DO NOTHING;
END
$$;

DO $$
DECLARE
  desired_slugs text[] := ARRAY[
    'public_safety_and_crime_control',
    'civil_rights',
    'government_efficiency',
    'housing_affordability',
    'data_privacy',
    'corporate_accountability',
    'anti_corruption',
    'legal_competence',
    'impartiality'
  ]::text[];
  expected_area_count integer;
  office_count integer;
  area_count integer;
BEGIN
  expected_area_count := COALESCE(array_length(desired_slugs, 1), 0);

  SELECT COUNT(*)
  INTO office_count
  FROM public.offices
  WHERE scope = 'place'
    AND canonical_name = 'Place Level Judge';

  IF office_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly 1 office row for scope=place canonical_name=Place Level Judge, found %',
      office_count;
  END IF;

  SELECT COUNT(*)
  INTO area_count
  FROM public.research_areas
  WHERE slug = ANY (desired_slugs);

  IF area_count <> expected_area_count THEN
    RAISE EXCEPTION
      'Expected % research areas for place-level judge mapping, found %',
      expected_area_count,
      area_count;
  END IF;

  INSERT INTO public.office_research_areas (office_id, research_area_id)
  SELECT office.id, area.id
  FROM public.offices office
  JOIN public.research_areas area
    ON area.slug = ANY (desired_slugs)
  WHERE office.scope = 'place'
    AND office.canonical_name = 'Place Level Judge'
  ON CONFLICT (office_id, research_area_id) DO NOTHING;
END
$$;

DO $$
DECLARE
  desired_slugs text[] := ARRAY[
    'gun_control',
    'ai_regulation',
    'labor_rights',
    'national_defense',
    'peaceful_foreign_policy',
    'us_israel_ties',
    'foreign_trade',
    'government_spending_reduction',
    'personal_income_tax_reduction',
    'healthcare_affordability',
    'social_programs_and_welfare',
    'immigration',
    'civil_rights',
    'womens_reproductive_rights',
    'environment_and_public_health',
    'public_infrastructure',
    'corporate_accountability',
    'data_privacy',
    'anti_corruption',
    'government_efficiency'
  ]::text[];
  expected_area_count integer;
  office_count integer;
  area_count integer;
BEGIN
  expected_area_count := COALESCE(array_length(desired_slugs, 1), 0);

  SELECT COUNT(*)
  INTO office_count
  FROM public.offices
  WHERE scope = 'statewide'
    AND canonical_name = 'United States Senator';

  IF office_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly 1 office row for scope=statewide canonical_name=United States Senator, found %',
      office_count;
  END IF;

  SELECT COUNT(*)
  INTO area_count
  FROM public.research_areas
  WHERE slug = ANY (desired_slugs);

  IF area_count <> expected_area_count THEN
    RAISE EXCEPTION
      'Expected % research areas for senate mapping, found %',
      expected_area_count,
      area_count;
  END IF;
  INSERT INTO public.office_research_areas (office_id, research_area_id)
  SELECT office.id, area.id
  FROM (
    SELECT id
    FROM public.offices
    WHERE scope = 'statewide'
      AND canonical_name = 'United States Senator'
    LIMIT 1
  ) office
  JOIN (
    SELECT id
    FROM public.research_areas
    WHERE slug = ANY (desired_slugs)
  ) area
    ON true
  ON CONFLICT (office_id, research_area_id) DO NOTHING;
END
$$;

DO $$
DECLARE
  desired_slugs text[] := ARRAY[
    'gun_control',
    'ai_regulation',
    'labor_rights',
    'government_spending_reduction',
    'personal_income_tax_reduction',
    'public_education_quality',
    'public_safety_and_crime_control',
    'healthcare_affordability',
    'social_programs_and_welfare',
    'public_infrastructure',
    'housing_affordability',
    'environment_and_public_health',
    'womens_reproductive_rights',
    'election_integrity',
    'civil_rights',
    'data_privacy',
    'corporate_accountability',
    'anti_corruption',
    'government_efficiency',
    'immigration'
  ]::text[];
  expected_area_count integer;
  office_count integer;
  area_count integer;
BEGIN
  expected_area_count := COALESCE(array_length(desired_slugs, 1), 0);

  SELECT COUNT(*)
  INTO office_count
  FROM public.offices
  WHERE scope = 'state_upper'
    AND canonical_name = 'State Senator';

  IF office_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly 1 office row for scope=state_upper canonical_name=State Senator, found %',
      office_count;
  END IF;

  SELECT COUNT(*)
  INTO area_count
  FROM public.research_areas
  WHERE slug = ANY (desired_slugs);

  IF area_count <> expected_area_count THEN
    RAISE EXCEPTION
      'Expected % research areas for state_upper mapping, found %',
      expected_area_count,
      area_count;
  END IF;

  INSERT INTO public.office_research_areas (office_id, research_area_id)
  SELECT office.id, area.id
  FROM (
    SELECT id
    FROM public.offices
    WHERE scope = 'state_upper'
      AND canonical_name = 'State Senator'
    LIMIT 1
  ) office
  JOIN (
    SELECT id
    FROM public.research_areas
    WHERE slug = ANY (desired_slugs)
  ) area
    ON true
  ON CONFLICT (office_id, research_area_id) DO NOTHING;
END
$$;

DO $$
DECLARE
  desired_slugs text[] := ARRAY[
    'gun_control',
    'ai_regulation',
    'labor_rights',
    'government_spending_reduction',
    'personal_income_tax_reduction',
    'public_education_quality',
    'public_safety_and_crime_control',
    'healthcare_affordability',
    'social_programs_and_welfare',
    'public_infrastructure',
    'housing_affordability',
    'environment_and_public_health',
    'womens_reproductive_rights',
    'election_integrity',
    'civil_rights',
    'data_privacy',
    'corporate_accountability',
    'anti_corruption',
    'government_efficiency',
    'immigration'
  ]::text[];
  expected_area_count integer;
  office_count integer;
  area_count integer;
BEGIN
  expected_area_count := COALESCE(array_length(desired_slugs, 1), 0);

  SELECT COUNT(*)
  INTO office_count
  FROM public.offices
  WHERE scope = 'state_lower'
    AND canonical_name = 'State Lower Chamber Legislator';

  IF office_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly 1 office row for scope=state_lower canonical_name=State Lower Chamber Legislator, found %',
      office_count;
  END IF;

  SELECT COUNT(*)
  INTO area_count
  FROM public.research_areas
  WHERE slug = ANY (desired_slugs);

  IF area_count <> expected_area_count THEN
    RAISE EXCEPTION
      'Expected % research areas for state_lower mapping, found %',
      expected_area_count,
      area_count;
  END IF;

  INSERT INTO public.office_research_areas (office_id, research_area_id)
  SELECT office.id, area.id
  FROM (
    SELECT id
    FROM public.offices
    WHERE scope = 'state_lower'
      AND canonical_name = 'State Lower Chamber Legislator'
    LIMIT 1
  ) office
  JOIN (
    SELECT id
    FROM public.research_areas
    WHERE slug = ANY (desired_slugs)
  ) area
    ON true
  ON CONFLICT (office_id, research_area_id) DO NOTHING;
END
$$;

DO $$
DECLARE
  desired_slugs text[] := ARRAY[
    'gun_control',
    'ai_regulation',
    'labor_rights',
    'public_education_quality',
    'public_safety_and_crime_control',
    'healthcare_affordability',
    'social_programs_and_welfare',
    'government_spending_reduction',
    'government_efficiency',
    'public_infrastructure',
    'environment_and_public_health',
    'housing_affordability',
    'personal_income_tax_reduction',
    'womens_reproductive_rights',
    'civil_rights',
    'data_privacy',
    'corporate_accountability',
    'anti_corruption',
    'immigration'
  ]::text[];
  expected_area_count integer;
  office_count integer;
  area_count integer;
BEGIN
  expected_area_count := COALESCE(array_length(desired_slugs, 1), 0);

  SELECT COUNT(*)
  INTO office_count
  FROM public.offices
  WHERE scope = 'statewide'
    AND canonical_name = 'Governor';

  IF office_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly 1 office row for scope=statewide canonical_name=Governor, found %',
      office_count;
  END IF;

  SELECT COUNT(*)
  INTO area_count
  FROM public.research_areas
  WHERE slug = ANY (desired_slugs);

  IF area_count <> expected_area_count THEN
    RAISE EXCEPTION
      'Expected % research areas for governor mapping, found %',
      expected_area_count,
      area_count;
  END IF;
  INSERT INTO public.office_research_areas (office_id, research_area_id)
  SELECT office.id, area.id
  FROM (
    SELECT id
    FROM public.offices
    WHERE scope = 'statewide'
      AND canonical_name = 'Governor'
    LIMIT 1
  ) office
  JOIN (
    SELECT id
    FROM public.research_areas
    WHERE slug = ANY (desired_slugs)
  ) area
    ON true
  ON CONFLICT (office_id, research_area_id) DO NOTHING;
END
$$;

DELETE FROM public.office_research_areas ora
USING public.offices office, public.research_areas area
WHERE ora.office_id = office.id
  AND ora.research_area_id = area.id
  AND office.scope = 'statewide'
  AND office.canonical_name = 'Governor'
  AND area.slug IN ('legal_competence', 'impartiality');

DO $$
DECLARE
  desired_slugs text[] := ARRAY[
    'gun_control',
    'ai_regulation',
    'labor_rights',
    'government_spending_reduction',
    'personal_income_tax_reduction',
    'healthcare_affordability',
    'social_programs_and_welfare',
    'public_infrastructure',
    'national_defense',
    'foreign_trade',
    'immigration',
    'environment_and_public_health',
    'corporate_accountability',
    'data_privacy',
    'anti_corruption',
    'government_efficiency',
    'civil_rights',
    'womens_reproductive_rights',
    'peaceful_foreign_policy',
    'us_israel_ties'
  ]::text[];
  expected_area_count integer;
  office_count integer;
  area_count integer;
BEGIN
  expected_area_count := COALESCE(array_length(desired_slugs, 1), 0);

  SELECT COUNT(*)
  INTO office_count
  FROM public.offices
  WHERE scope = 'us_house'
    AND canonical_name = 'United States Representative';

  IF office_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly 1 office row for scope=us_house canonical_name=United States Representative, found %',
      office_count;
  END IF;

  SELECT COUNT(*)
  INTO area_count
  FROM public.research_areas
  WHERE slug = ANY (desired_slugs);

  IF area_count <> expected_area_count THEN
    RAISE EXCEPTION
      'Expected % research areas for us_house mapping, found %',
      expected_area_count,
      area_count;
  END IF;
  INSERT INTO public.office_research_areas (office_id, research_area_id)
  SELECT office.id, area.id
  FROM (
    SELECT id
    FROM public.offices
    WHERE scope = 'us_house'
      AND canonical_name = 'United States Representative'
    LIMIT 1
  ) office
  JOIN (
    SELECT id
    FROM public.research_areas
    WHERE slug = ANY (desired_slugs)
  ) area
    ON true
  ON CONFLICT (office_id, research_area_id) DO NOTHING;
END
$$;

DO $$
DECLARE
  source_slugs text[] := ARRAY[
    'cost_of_living_reduction',
    'housing_affordability',
    'personal_income_tax_reduction',
    'social_programs_and_welfare'
  ]::text[];
  target_area_count integer;
  source_area_count integer;
  target_office_count integer;
  missing_mapping_count integer;
BEGIN
  SELECT COUNT(*)
  INTO target_area_count
  FROM public.research_areas
  WHERE slug = 'reduce_wealth_gap';

  IF target_area_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly 1 research area for slug=reduce_wealth_gap, found %',
      target_area_count;
  END IF;

  SELECT COUNT(*)
  INTO source_area_count
  FROM public.research_areas
  WHERE slug = ANY (source_slugs);

  IF source_area_count <> COALESCE(array_length(source_slugs, 1), 0) THEN
    RAISE EXCEPTION
      'Expected % source research areas for reduce_wealth_gap backfill, found %',
      COALESCE(array_length(source_slugs, 1), 0),
      source_area_count;
  END IF;

  WITH source_areas AS (
    SELECT id
    FROM public.research_areas
    WHERE slug = ANY (source_slugs)
  )
  SELECT COUNT(DISTINCT link.office_id)
  INTO target_office_count
  FROM public.office_research_areas link
  JOIN source_areas source_area
    ON source_area.id = link.research_area_id
  JOIN public.offices office
    ON office.id = link.office_id
  WHERE office.canonical_name NOT ILIKE '%judge%'
    AND office.canonical_name NOT ILIKE '%justice%';

  IF target_office_count = 0 THEN
    RAISE EXCEPTION
      'Expected at least 1 office for reduce_wealth_gap backfill, found 0';
  END IF;

  WITH target_area AS (
    SELECT id
    FROM public.research_areas
    WHERE slug = 'reduce_wealth_gap'
  ),
  source_areas AS (
    SELECT id
    FROM public.research_areas
    WHERE slug = ANY (source_slugs)
  ),
  target_offices AS (
    SELECT DISTINCT link.office_id
    FROM public.office_research_areas link
    JOIN source_areas source_area
      ON source_area.id = link.research_area_id
    JOIN public.offices office
      ON office.id = link.office_id
    WHERE office.canonical_name NOT ILIKE '%judge%'
      AND office.canonical_name NOT ILIKE '%justice%'
  )
  INSERT INTO public.office_research_areas (office_id, research_area_id)
  SELECT target_office.office_id, target_area.id
  FROM target_offices target_office
  CROSS JOIN target_area
  ON CONFLICT (office_id, research_area_id) DO NOTHING;

  WITH target_area AS (
    SELECT id
    FROM public.research_areas
    WHERE slug = 'reduce_wealth_gap'
  ),
  source_areas AS (
    SELECT id
    FROM public.research_areas
    WHERE slug = ANY (source_slugs)
  ),
  target_offices AS (
    SELECT DISTINCT link.office_id
    FROM public.office_research_areas link
    JOIN source_areas source_area
      ON source_area.id = link.research_area_id
    JOIN public.offices office
      ON office.id = link.office_id
    WHERE office.canonical_name NOT ILIKE '%judge%'
      AND office.canonical_name NOT ILIKE '%justice%'
  )
  SELECT COUNT(*)
  INTO missing_mapping_count
  FROM target_offices target_office
  CROSS JOIN target_area
  LEFT JOIN public.office_research_areas link
    ON link.office_id = target_office.office_id
   AND link.research_area_id = target_area.id
  WHERE link.office_id IS NULL;

  IF missing_mapping_count <> 0 THEN
    RAISE EXCEPTION
      'Expected reduce_wealth_gap mappings for all derived offices, missing %',
      missing_mapping_count;
  END IF;
END
$$;

-- ============================================================================
-- FINAL CURATION PASS (authoritative core sets)
-- The generous per-office blocks above are kept for provenance, but this final
-- pass is the source of truth for every office it lists: it deletes links
-- outside the curated core set and inserts any missing ones, so re-seeding
-- always converges to the curated state. Offices not listed (President/VP,
-- Governor, U.S. Senator/Representative, state legislators) keep their earlier
-- broad sets deliberately, and Lieutenant Governor is curated TO the broad
-- state-legislator set because its powers vary by state more than any other
-- office (TX/GA senate control; UT/AK chief election officer). Rationale, and
-- the ADDed Sheriff/immigration and District Attorney/womens_reproductive_rights
-- links: see db/migrations/159_curate_office_research_area_core_sets.sql.
--
-- No BEGIN/COMMIT here, matching every other block in this file: the seed
-- runner (backend/src/scripts/seedOfficeResearchAreas.ts) already wraps the
-- whole file in one transaction and rolls back on error. A nested BEGIN would
-- warn, and the nested COMMIT would end the runner's transaction early --
-- removing the very atomicity it appears to add.
-- ============================================================================

-- The curated data lives in exactly ONE place per file: this temp table.
-- Both the guard and the reconcile statement below read from it, so a future
-- single-office edit cannot leave a DELETE copy and an INSERT copy out of sync
-- (a slug present only in a DELETE copy would be pruned and never restored).
-- No ON COMMIT DROP: the table is dropped explicitly so the file behaves the
-- same whether the caller wraps it in a transaction (the migration and seed
-- runners both do) or runs it statement-at-a-time.
DROP TABLE IF EXISTS curated_office_core_areas;

CREATE TEMP TABLE curated_office_core_areas (
    scope text NOT NULL,
    canonical_name text NOT NULL,
    slugs text[] NOT NULL
);

INSERT INTO curated_office_core_areas (scope, canonical_name, slugs) VALUES
    ('county', 'Clerk of Court', ARRAY['anti_corruption', 'data_privacy', 'government_efficiency']::text[]),
    -- Missouri-style property-tax collection: County Treasurer's curated set
    -- (housing_affordability because property-tax administration prices
    -- people in or out of homes).
    ('county', 'Collector of Revenue', ARRAY['anti_corruption', 'government_efficiency', 'government_spending_reduction', 'housing_affordability']::text[]),
    -- Same civil-process set as Municipal Constable (housing_affordability
    -- because constables serve evictions).
    -- Virginia's constitutional tax assessor: the County Assessor set, since
    -- it is the assessing job without the collection half (the elected
    -- Treasurer collects), and corporate_accountability carries extra weight
    -- because it also runs the local business-license tax.
    ('county', 'Commissioner of the Revenue', ARRAY['anti_corruption', 'corporate_accountability', 'government_efficiency', 'housing_affordability']::text[]),
    ('county', 'Constable', ARRAY['civil_rights', 'housing_affordability', 'public_safety_and_crime_control']::text[]),
    ('county', 'County Assessor', ARRAY['anti_corruption', 'corporate_accountability', 'government_efficiency', 'housing_affordability']::text[]),
    -- Combined office (e.g. San Francisco): union of the County Assessor and
    -- County Recorder curated sets, since the officeholder does both jobs.
    ('county', 'County Assessor-Recorder', ARRAY['anti_corruption', 'corporate_accountability', 'data_privacy', 'government_efficiency', 'housing_affordability']::text[]),
    ('county', 'County Auditor', ARRAY['anti_corruption', 'corporate_accountability', 'election_integrity', 'government_efficiency', 'government_spending_reduction']::text[]),
    -- Property-tax assessment appeals: the County Assessor's curated set,
    -- since the board reviews the assessor's valuations.
    ('county', 'County Board of Review Member', ARRAY['anti_corruption', 'corporate_accountability', 'government_efficiency', 'housing_affordability']::text[]),
    ('county', 'County Clerk', ARRAY['anti_corruption', 'data_privacy', 'election_integrity', 'government_efficiency']::text[]),
    -- Combined office (e.g. Colorado): union of the County Clerk and County
    -- Recorder curated sets, since the officeholder does both jobs.
    ('county', 'County Clerk and Recorder', ARRAY['anti_corruption', 'data_privacy', 'election_integrity', 'government_efficiency']::text[]),
    ('county', 'County Commissioner', ARRAY['environment_and_public_health', 'government_efficiency', 'government_spending_reduction', 'healthcare_affordability', 'housing_affordability', 'public_infrastructure', 'public_safety_and_crime_control', 'social_programs_and_welfare']::text[]),
    ('county', 'County Coroner', ARRAY['civil_rights', 'environment_and_public_health', 'government_efficiency', 'public_safety_and_crime_control']::text[]),
    -- Roads and capital projects: County Surveyor's infrastructure set with
    -- government_spending_reduction in place of the surveyor's land-records
    -- housing slug — the engineer's public exposure is the capital budget.
    ('county', 'County Engineer', ARRAY['government_efficiency', 'government_spending_reduction', 'public_infrastructure']::text[]),
    -- Independent fire district board: the emergency-response slugs the office
    -- actually controls (fire and EMS coverage, stations and apparatus), plus
    -- the two spending slugs every self-taxing special district owns — the
    -- board sets its own levy or assessment. No housing_affordability: unlike
    -- the assessor-class offices, the district's charge lands on the tax bill
    -- but the board does not value or administer property.
    ('county', 'Community Development District Supervisor', ARRAY['environment_and_public_health', 'government_efficiency', 'government_spending_reduction', 'housing_affordability', 'public_infrastructure']::text[]),
    ('county', 'Fire Control District Commissioner', ARRAY['environment_and_public_health', 'government_efficiency', 'government_spending_reduction', 'public_infrastructure', 'public_safety_and_crime_control']::text[]),
    ('county', 'County Executive', ARRAY['environment_and_public_health', 'government_efficiency', 'government_spending_reduction', 'healthcare_affordability', 'housing_affordability', 'public_infrastructure', 'public_safety_and_crime_control', 'social_programs_and_welfare']::text[]),
    ('county', 'Borough President', ARRAY['environment_and_public_health', 'government_efficiency', 'government_spending_reduction', 'healthcare_affordability', 'housing_affordability', 'public_infrastructure', 'public_safety_and_crime_control', 'social_programs_and_welfare']::text[]),
    ('county', 'County Level Judge', ARRAY['civil_rights', 'housing_affordability', 'impartiality', 'legal_competence', 'public_safety_and_crime_control']::text[]),
    -- The limited-jurisdiction tier of the same judiciary, so the County Level
    -- Judge set applies unchanged: JP courts are the eviction and small-claims
    -- forum (housing_affordability, civil_rights) and, in states such as Texas,
    -- the Class C misdemeanor and traffic court (public_safety_and_crime_control).
    ('county', 'Justice of the Peace', ARRAY['civil_rights', 'housing_affordability', 'impartiality', 'legal_competence', 'public_safety_and_crime_control']::text[]),
    ('county', 'County Recorder', ARRAY['anti_corruption', 'data_privacy', 'government_efficiency']::text[]),
    -- Business licensing and fee collection (St. Louis): recorder-class
    -- records set with corporate_accountability for the licensing power.
    ('county', 'License Collector', ARRAY['anti_corruption', 'corporate_accountability', 'government_efficiency']::text[]),
    -- Alabama's county tag office. License Collector's set (it issues business
    -- licenses too) plus data_privacy, because this office holds the county's
    -- vehicle-ownership and driver-licence records.
    ('county', 'License Commissioner', ARRAY['anti_corruption', 'corporate_accountability', 'data_privacy', 'government_efficiency']::text[]),
    ('county', 'County Superintendent of Schools', ARRAY['civil_rights', 'government_efficiency', 'government_spending_reduction', 'public_education_quality']::text[]),
    ('county', 'County Supervisor', ARRAY['environment_and_public_health', 'government_efficiency', 'government_spending_reduction', 'healthcare_affordability', 'housing_affordability', 'public_infrastructure', 'public_safety_and_crime_control', 'social_programs_and_welfare']::text[]),
    -- Boundary records and plats: recorder-adjacent land administration.
    ('county', 'County Surveyor', ARRAY['government_efficiency', 'housing_affordability', 'public_infrastructure']::text[]),
    ('county', 'County Treasurer', ARRAY['anti_corruption', 'government_efficiency', 'government_spending_reduction', 'housing_affordability']::text[]),
    ('county', 'District Attorney', ARRAY['anti_corruption', 'civil_rights', 'corporate_accountability', 'gun_control', 'public_safety_and_crime_control', 'womens_reproductive_rights']::text[]),
    ('county', 'Public Administrator', ARRAY['anti_corruption', 'data_privacy', 'government_efficiency']::text[]),
    -- Defense-side justice set, NOT a District Attorney mirror: the DA slugs
    -- that track prosecutorial charging discretion (gun_control,
    -- womens_reproductive_rights, corporate_accountability, anti_corruption)
    -- don't apply to an office whose job is representing the accused.
    -- legal_competence mirrors the judge sets (quality of representation);
    -- immigration covers crimmigration consequences of pleas (Padilla).
    ('county', 'Public Defender', ARRAY['civil_rights', 'immigration', 'legal_competence', 'public_safety_and_crime_control']::text[]),
    -- Same job as County Recorder under its Missouri/Pennsylvania name.
    ('county', 'Recorder of Deeds', ARRAY['anti_corruption', 'data_privacy', 'government_efficiency']::text[]),
    -- Alabama's merged property-tax office: union of the County Assessor and
    -- Collector of Revenue curated sets, since the officeholder does both jobs.
    ('county', 'Revenue Commissioner', ARRAY['anti_corruption', 'corporate_accountability', 'government_efficiency', 'government_spending_reduction', 'housing_affordability']::text[]),
    -- Georgia's county misdemeanor prosecutor (State Court), a separate
    -- elected office from the District Attorney: the DA set MINUS the two
    -- slugs that track felony-only charging discretion, since in Georgia
    -- abortion-law violations (womens_reproductive_rights) and white-collar
    -- fraud (corporate_accountability) are felonies this office cannot bring.
    -- gun_control stays: Georgia's weapons misdemeanors — carrying in a
    -- prohibited location, possession by a minor, pointing a firearm at
    -- another — are State Court cases. See db/migrations/225.
    ('county', 'Solicitor General', ARRAY['anti_corruption', 'civil_rights', 'gun_control', 'public_safety_and_crime_control']::text[]),
    -- Kentucky's elected jail administrator: the custody slice of the Sheriff
    -- set (no patrol, so no gun_control/immigration) plus government_efficiency
    -- for jail operations and spending.
    ('county', 'County Jailer', ARRAY['civil_rights', 'government_efficiency', 'public_safety_and_crime_control']::text[]),
    -- Kentucky fiscal-court district member: a county legislator, so the
    -- County Commissioner set.
    ('county', 'Magistrate', ARRAY['environment_and_public_health', 'government_efficiency', 'government_spending_reduction', 'healthcare_affordability', 'housing_affordability', 'public_infrastructure', 'public_safety_and_crime_control', 'social_programs_and_welfare']::text[]),
    ('county', 'Sheriff', ARRAY['civil_rights', 'data_privacy', 'gun_control', 'immigration', 'public_safety_and_crime_control']::text[]),
    ('county', 'Soil and Water Conservation District Supervisor', ARRAY['environment_and_public_health', 'government_efficiency', 'public_infrastructure']::text[]),
    ('place', 'Alderman', ARRAY['civil_rights', 'environment_and_public_health', 'government_efficiency', 'government_spending_reduction', 'housing_affordability', 'public_infrastructure', 'public_safety_and_crime_control', 'social_programs_and_welfare']::text[]),
    ('place', 'City Clerk', ARRAY['anti_corruption', 'data_privacy', 'election_integrity', 'government_efficiency']::text[]),
    ('place', 'City Council Member', ARRAY['civil_rights', 'environment_and_public_health', 'government_efficiency', 'government_spending_reduction', 'housing_affordability', 'public_infrastructure', 'public_safety_and_crime_control', 'social_programs_and_welfare']::text[]),
    -- Elected public-library board. civil_rights is the board's most contested
    -- lever (challenges to materials, who may access them); data_privacy is
    -- the library-specific one, since patron borrowing records are
    -- confidential by statute in most states. The two spending slugs are the
    -- operating and levy decisions — Michigan library boards administer their
    -- own millage — and public_infrastructure is branches and capital
    -- projects. public_education_quality is shared with School Board Member
    -- rather than exclusive to it: the literacy, homework-help, and adult-
    -- education programming a library board sets belongs somewhere, and
    -- omitting it would push those records into neighboring areas. No
    -- public_safety_and_crime_control — branch security is the director's
    -- administrative problem, not a lever the board is elected on.
    ('place', 'Library Board Member', ARRAY['civil_rights', 'data_privacy', 'government_efficiency', 'government_spending_reduction', 'public_education_quality', 'public_infrastructure']::text[]),
    ('place', 'Comptroller', ARRAY['anti_corruption', 'corporate_accountability', 'government_efficiency', 'government_spending_reduction']::text[]),
    ('place', 'City Treasurer', ARRAY['anti_corruption', 'government_efficiency', 'government_spending_reduction']::text[]),
    ('place', 'Mayor', ARRAY['civil_rights', 'environment_and_public_health', 'government_efficiency', 'government_spending_reduction', 'housing_affordability', 'public_infrastructure', 'public_safety_and_crime_control', 'social_programs_and_welfare']::text[]),
    ('place', 'Public Advocate', ARRAY['anti_corruption', 'civil_rights', 'environment_and_public_health', 'government_efficiency', 'government_spending_reduction', 'housing_affordability', 'public_infrastructure', 'public_safety_and_crime_control', 'social_programs_and_welfare']::text[]),
    ('place', 'Municipal Assessor', ARRAY['anti_corruption', 'corporate_accountability', 'government_efficiency', 'housing_affordability']::text[]),
    ('place', 'Municipal Attorney', ARRAY['civil_rights', 'government_efficiency', 'housing_affordability', 'public_safety_and_crime_control']::text[]),
    ('place', 'Municipal Controller', ARRAY['anti_corruption', 'corporate_accountability', 'government_efficiency', 'government_spending_reduction']::text[]),
    ('place', 'Municipal Constable', ARRAY['civil_rights', 'housing_affordability', 'public_safety_and_crime_control']::text[]),
    -- Officer of the city court (Louisiana): the same civil-process job as
    -- Municipal Constable, housing_affordability included because the marshal
    -- executes evictions.
    ('place', 'City Marshal', ARRAY['civil_rights', 'housing_affordability', 'public_safety_and_crime_control']::text[]),
    ('place', 'Municipal Trustee', ARRAY['civil_rights', 'environment_and_public_health', 'government_efficiency', 'government_spending_reduction', 'housing_affordability', 'public_infrastructure', 'public_safety_and_crime_control', 'social_programs_and_welfare']::text[]),
    ('place', 'Place Level Judge', ARRAY['civil_rights', 'housing_affordability', 'impartiality', 'legal_competence', 'public_safety_and_crime_control']::text[]),
    ('place', 'Town Council Member', ARRAY['civil_rights', 'environment_and_public_health', 'government_efficiency', 'government_spending_reduction', 'housing_affordability', 'public_infrastructure', 'public_safety_and_crime_control', 'social_programs_and_welfare']::text[]),
    ('place', 'Town Moderator', ARRAY['election_integrity', 'government_efficiency']::text[]),
    ('school_elementary', 'School Board Member', ARRAY['civil_rights', 'data_privacy', 'government_efficiency', 'government_spending_reduction', 'public_education_quality', 'public_infrastructure', 'public_safety_and_crime_control']::text[]),
    ('school_secondary', 'School Board Member', ARRAY['civil_rights', 'data_privacy', 'government_efficiency', 'government_spending_reduction', 'public_education_quality', 'public_infrastructure', 'public_safety_and_crime_control']::text[]),
    ('school_unified', 'School Board Member', ARRAY['civil_rights', 'data_privacy', 'government_efficiency', 'government_spending_reduction', 'public_education_quality', 'public_infrastructure', 'public_safety_and_crime_control']::text[]),
    -- DC's ward-elected State Board of Education seat (migration 280): the
    -- statewide board's set, since it is the same policy job at ward scope.
    ('state_upper', 'State Board of Education Member', ARRAY['civil_rights', 'data_privacy', 'government_efficiency', 'government_spending_reduction', 'public_education_quality']::text[]),
    ('statewide', 'Attorney General', ARRAY['ai_regulation', 'anti_corruption', 'civil_rights', 'corporate_accountability', 'data_privacy', 'election_integrity', 'environment_and_public_health', 'gun_control', 'healthcare_affordability', 'immigration', 'labor_rights', 'public_safety_and_crime_control', 'womens_reproductive_rights']::text[]),
    ('statewide', 'Commissioner of Agriculture', ARRAY['corporate_accountability', 'cost_of_living_reduction', 'environment_and_public_health', 'foreign_trade', 'social_programs_and_welfare']::text[]),
    ('statewide', 'Commissioner of Insurance', ARRAY['corporate_accountability', 'cost_of_living_reduction', 'healthcare_affordability', 'housing_affordability']::text[]),
    ('statewide', 'Comptroller', ARRAY['anti_corruption', 'corporate_accountability', 'government_efficiency', 'government_spending_reduction']::text[]),
    ('statewide', 'Corporation Commissioner', ARRAY['corporate_accountability', 'cost_of_living_reduction', 'environment_and_public_health', 'public_infrastructure']::text[]),
    ('statewide', 'Labor Commissioner', ARRAY['civil_rights', 'corporate_accountability', 'labor_rights', 'reduce_wealth_gap', 'social_programs_and_welfare']::text[]),
    ('statewide', 'Land Commissioner', ARRAY['corporate_accountability', 'environment_and_public_health', 'government_spending_reduction', 'housing_affordability']::text[]),
    ('statewide', 'Lieutenant Governor', ARRAY['ai_regulation', 'anti_corruption', 'civil_rights', 'corporate_accountability', 'data_privacy', 'election_integrity', 'environment_and_public_health', 'government_efficiency', 'government_spending_reduction', 'gun_control', 'healthcare_affordability', 'housing_affordability', 'immigration', 'labor_rights', 'personal_income_tax_reduction', 'public_education_quality', 'public_infrastructure', 'public_safety_and_crime_control', 'reduce_wealth_gap', 'social_programs_and_welfare', 'womens_reproductive_rights']::text[]),
    ('statewide', 'Public Service Commissioner', ARRAY['corporate_accountability', 'cost_of_living_reduction', 'environment_and_public_health', 'public_infrastructure']::text[]),
    ('statewide', 'Railroad Commissioner', ARRAY['corporate_accountability', 'cost_of_living_reduction', 'environment_and_public_health', 'public_infrastructure']::text[]),
    ('statewide', 'Secretary of State', ARRAY['anti_corruption', 'civil_rights', 'data_privacy', 'election_integrity', 'government_efficiency']::text[]),
    ('statewide', 'State Auditor', ARRAY['anti_corruption', 'corporate_accountability', 'government_efficiency', 'government_spending_reduction']::text[]),
    ('statewide', 'State Board of Education Member', ARRAY['civil_rights', 'data_privacy', 'government_efficiency', 'government_spending_reduction', 'public_education_quality']::text[]),
    ('statewide', 'State Board of Equalization Member', ARRAY['corporate_accountability', 'cost_of_living_reduction', 'government_efficiency', 'housing_affordability']::text[]),
    ('statewide', 'State Board of Regents Member', ARRAY['civil_rights', 'government_efficiency', 'government_spending_reduction', 'public_education_quality']::text[]),
    ('statewide', 'State Level Judge', ARRAY['civil_rights', 'election_integrity', 'gun_control', 'impartiality', 'legal_competence', 'public_safety_and_crime_control', 'womens_reproductive_rights']::text[]),
    ('statewide', 'State Treasurer', ARRAY['anti_corruption', 'government_efficiency', 'government_spending_reduction']::text[]),
    ('statewide', 'Superintendent of Public Instruction', ARRAY['civil_rights', 'data_privacy', 'government_efficiency', 'government_spending_reduction', 'public_education_quality']::text[]);

-- Fail fast rather than silently mis-shaping an office. The reconcile below
-- deletes every link outside the curated set and re-inserts the curated ones by
-- joining research_areas on slug; a curated slug that resolves to no research
-- area would therefore be deleted-and-not-restored (linked offices) or produce
-- a silently incomplete set (offices being linked for the first time), with no
-- error either way.
--
-- Bootstrap is detected globally, not per office: only when NO curated office
-- has any link yet (a fresh migrations-only database, where db:migrate runs
-- before db:seed:research-areas per DB_DEPLOYMENT.md and research_areas is
-- legitimately still incomplete) is the check skipped — the reconcile's insert
-- is then healed by the seed layer moments later. If even one curated office
-- has links, this is a live database and EVERY curated slug must resolve, so a
-- partially-installed database cannot hand an unlinked office an incomplete
-- area set.
DO $$
DECLARE
    curated_link_count bigint;
    missing_slugs text;
BEGIN
    SELECT COUNT(*)
    INTO curated_link_count
    FROM public.office_research_areas ora
    JOIN public.offices o ON o.id = ora.office_id
    JOIN curated_office_core_areas c
      ON c.scope = o.scope AND c.canonical_name = o.canonical_name;

    IF curated_link_count = 0 THEN
        RETURN; -- bootstrap: nothing the reconcile can damage or half-fill persistently
    END IF;

    SELECT string_agg(DISTINCT s.slug, ', ' ORDER BY s.slug)
    INTO missing_slugs
    FROM (
        SELECT DISTINCT unnest(slugs) AS slug FROM curated_office_core_areas
    ) s
    WHERE NOT EXISTS (
        SELECT 1 FROM public.research_areas ra WHERE ra.slug = s.slug
    );

    IF missing_slugs IS NOT NULL THEN
        RAISE EXCEPTION
            'Curated research-area slugs not found in public.research_areas: %. Refusing to reconcile: linked offices would lose these links and unlinked offices would receive incomplete sets.',
            missing_slugs;
    END IF;
END
$$;

-- One statement, one snapshot: the DELETE removes links outside each office's
-- curated set and the INSERT adds any missing curated links. The two operate on
-- disjoint rows (non-curated vs curated), so combining them in a single
-- data-modifying CTE is safe and keeps both driven by the same `targets`.
WITH targets AS (
    SELECT o.id AS office_id, c.slugs
    FROM public.offices o
    JOIN curated_office_core_areas c
      ON c.scope = o.scope AND c.canonical_name = o.canonical_name
),
deleted AS (
    DELETE FROM public.office_research_areas ora
    USING targets t, public.research_areas ra
    WHERE ora.office_id = t.office_id
      AND ra.id = ora.research_area_id
      AND NOT (ra.slug = ANY (t.slugs))
    RETURNING 1
)
INSERT INTO public.office_research_areas (office_id, research_area_id)
SELECT t.office_id, ra.id
FROM targets t
JOIN public.research_areas ra
  ON ra.slug = ANY (t.slugs)
ON CONFLICT (office_id, research_area_id) DO NOTHING;

DROP TABLE curated_office_core_areas;
