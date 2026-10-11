-- The District of Columbia's ward Council races sat on the State Senator
-- office. DC's ward rows are typed state_upper (the ward stands in for a state
-- senate district), and the matcher gave every state_upper title the chamber
-- seat, so "Ward 5 Member of the Council" showed voters a state senator's job
-- summary and research areas. The DC campaign finance adapter only looks at
-- Council offices, so no ward candidate ever linked to their Office of
-- Campaign Finance committee (live: Zachary Parker, Ward 5, 612 contribution
-- rows waiting).
--
-- A ward member is a member of the Council of the District of Columbia (D.C.
-- Code § 1-204.01), the same body as the Chairman and the at-large members,
-- which already sit on City Council Member at place scope (migration 316). The
-- ward seat needs a row at the scope its district carries, like the ward State
-- Board of Education seat (migration 280). This migration adds City Council
-- Member at state_upper scope with the place office's summary and research
-- areas, drops any learned State Senator alias that names a council, and
-- repoints the DC ward elections already written on State Senator.
--
-- Code ships alongside: officeMatcher.ts routes a DC state_upper title that
-- names the Council to this office ahead of every alias, and the DC finance
-- adapter accepts it. seedOffices.ts and db/seeds/office_research_areas_v1.sql
-- carry the office for fresh installs; the summary below is byte-identical to
-- the seed's.
--
-- On a fresh migrations-only database research_areas is still empty, so the
-- research-area copy inserts zero rows and the seed layer fills the links
-- afterward (same pattern as migration 280). Every statement is idempotent:
-- after a successful run no predicate matches, so a replay is a no-op.

BEGIN;

INSERT INTO public.offices (scope, canonical_name, summary)
VALUES (
  'state_upper',
  'City Council Member',
  'Passing city laws, called ordinances
Approving the city budget
Funding city services, such as police, trash, and parks'
)
ON CONFLICT (scope, canonical_name) DO NOTHING;

-- A matcher run may have learned "member of the council" -> State Senator at
-- state_upper scope (live on a local database). No state senate title names a
-- council, so drop any such alias. A trigger forbids repointing an alias, and
-- none is needed: the matcher routes DC ward Council titles ahead of every
-- alias.
DELETE FROM public.office_title_aliases a
USING public.offices senate
WHERE a.office_id = senate.id
  AND a.scope = 'state_upper'
  AND senate.scope = 'state_upper'
  AND senate.canonical_name = 'State Senator'
  AND a.normalized_alias ~ '\mcouncil\M';

-- DC has no state senate, so every DC state_upper election on State Senator
-- whose title names the Council is a ward Council race. Nothing else runs this
-- repair: manual:elections:repair-office-ids fixes NULL office_id only.
UPDATE public.elections e
SET office_id = council.id,
    updated_at = now()
FROM public.districts d,
     public.offices senate,
     public.offices council
WHERE d.id = e.district_id
  AND d.state = 'DC'
  AND d.district_type = 'state_upper'
  AND senate.scope = 'state_upper'
  AND senate.canonical_name = 'State Senator'
  AND e.office_id = senate.id
  AND e.official_ballot_title ~* '\mcouncil\M'
  AND council.scope = 'state_upper'
  AND council.canonical_name = 'City Council Member';

INSERT INTO public.office_research_areas (office_id, research_area_id)
SELECT o.id, ra.id
FROM public.offices o
JOIN public.research_areas ra
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
WHERE o.scope = 'state_upper'
  AND o.canonical_name = 'City Council Member'
ON CONFLICT (office_id, research_area_id) DO NOTHING;

COMMIT;
