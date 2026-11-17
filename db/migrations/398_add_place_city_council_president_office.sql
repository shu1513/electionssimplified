-- A citywide council president, elected on its own line.
--
-- Some cities elect the head of their council separately from the council
-- seats: St. Louis elects a President of the Board of Aldermen citywide
-- (St. Louis City Charter, Art. IV), Atlanta and Baltimore elect a City
-- Council President, and Nashville elects a Metropolitan Vice Mayor whose job
-- is to run the Metro Council (Metro Charter 5.01). No place office fit these
-- races: the office matcher scored "President of the Board of Aldermen" 0.333
-- against every place office, so the 2027 St. Louis race could not be
-- written.
--
-- Also adds two missing names for existing place offices:
--   "Alder" (Madison, WI ballots) -> Alderman
--   "Member of Council at Large" (Hamilton County, OH ballots) -> City Council Member

BEGIN;

INSERT INTO public.offices (scope, canonical_name, summary)
VALUES (
  'place',
  'City Council President',
  'Running city council meetings and deciding which bills come up for a vote
Helping decide the city budget and city laws
Filling in for the mayor when the mayor is away'
)
ON CONFLICT (scope, canonical_name) DO NOTHING;

INSERT INTO public.office_title_aliases (office_id, scope, alias_text, normalized_alias)
SELECT o.id, 'place', v.alias_text, v.normalized_alias
FROM (VALUES
        ('City Council President', 'City Council President', 'city council president'),
        ('City Council President', 'President of the City Council', 'president of the city council'),
        ('City Council President', 'Council President', 'council president'),
        ('City Council President', 'President of the Board of Aldermen', 'president of the board of aldermen'),
        ('City Council President', 'Board of Aldermen President', 'board of aldermen president'),
        ('City Council President', 'Metropolitan Vice Mayor', 'metropolitan vice mayor'),
        ('Alderman', 'Alder', 'alder'),
        ('City Council Member', 'Member of Council at Large', 'member of council at large')
     ) AS v(canonical_name, alias_text, normalized_alias)
JOIN public.offices AS o
  ON o.scope = 'place'
 AND o.canonical_name = v.canonical_name
ON CONFLICT (scope, normalized_alias) DO NOTHING;

INSERT INTO public.office_research_areas (office_id, research_area_id)
SELECT o.id, ra.id
FROM public.offices AS o
JOIN public.research_areas AS ra
  ON ra.slug = ANY (ARRAY[
       'civil_rights',
       'criminal_justice_and_civil_liberties',
       'environment_and_public_health',
       'government_efficiency',
       'government_spending_reduction',
       'housing_affordability',
       'public_infrastructure',
       'public_safety_and_crime_control',
       'social_programs_and_welfare'
     ]::text[])
WHERE o.scope = 'place'
  AND o.canonical_name = 'City Council President'
ON CONFLICT DO NOTHING;

COMMIT;
