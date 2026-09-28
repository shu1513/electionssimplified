-- The Nevada Board of Regents (the board that runs the state's public
-- universities and colleges) is elected by 13 regent districts. Those
-- districts follow their own map, drawn by the Legislature in 2021, that
-- matches no county, legislative, or congressional map. The Nov 3, 2026
-- ballot carries Districts 2, 3, 5, 8 (unexpired term), and 10, so each is a
-- reviewed local_special district (migration 300) and the race needs a
-- local_special office.
--
-- Same job and bullets as the statewide and us_house State Board of Regents
-- Member offices (migration 304). The summary is byte-identical to
-- backend/src/scripts/seedOffices.ts, and the research areas match
-- db/seeds/office_research_areas_v1.sql. On a fresh migrations-only database
-- research_areas is still empty, so the research-area insert adds zero rows
-- (same pattern as migrations 303 and 305). Every statement is idempotent.

BEGIN;

INSERT INTO public.offices (scope, canonical_name, summary)
VALUES (
  'local_special',
  'State Board of Regents Member',
  'Setting tuition at state universities
Approving university budgets
Picking university presidents'
)
ON CONFLICT (scope, canonical_name) DO NOTHING;

INSERT INTO public.office_title_aliases (office_id, scope, alias_text, normalized_alias)
SELECT o.id, 'local_special', v.alias_text, v.normalized_alias
FROM public.offices o,
     (VALUES
        ('State Board of Regents Member', 'state board of regents member'),
        ('Board of Regents', 'board of regents'),
        ('Member, Board of Regents', 'member board of regents'),
        ('Regent', 'regent')
     ) AS v(alias_text, normalized_alias)
WHERE o.scope = 'local_special'
  AND o.canonical_name = 'State Board of Regents Member'
ON CONFLICT (scope, normalized_alias) DO NOTHING;

INSERT INTO public.office_research_areas (office_id, research_area_id)
SELECT o.id, ra.id
FROM public.offices o
JOIN public.research_areas ra
  ON ra.slug = ANY (ARRAY[
       'civil_rights',
       'government_efficiency',
       'government_spending_reduction',
       'public_education_quality'
     ]::text[])
WHERE o.scope = 'local_special'
  AND o.canonical_name = 'State Board of Regents Member'
ON CONFLICT (office_id, research_area_id) DO NOTHING;

COMMIT;
