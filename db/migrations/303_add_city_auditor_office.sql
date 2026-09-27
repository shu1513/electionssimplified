-- New place office "City Auditor". Some cities elect an independent auditor
-- who reviews city spending and programs (Oakland and Berkeley, CA, for
-- example). The catalog had no such office, so "City Auditor, City of
-- Oakland" matched nothing and the contest could not be written. Municipal
-- Controller is a different job (the city's chief accounting officer), and
-- County Auditor is county-scoped, so neither is reused.
--
-- The summary is byte-identical to backend/src/scripts/seedOffices.ts. On a
-- fresh migrations-only database research_areas is still empty, so the
-- research-area join inserts zero rows (same pattern as migrations 176 and
-- 298).

BEGIN;

INSERT INTO public.offices (scope, canonical_name, summary)
VALUES (
  'place',
  'City Auditor',
  'Checking whether city departments spend money the way the budget allows
Reviewing how well city programs work and reporting what should change
Taking reports of waste or fraud in city government, in some cities'
)
ON CONFLICT (scope, canonical_name) DO NOTHING;

INSERT INTO public.office_title_aliases (office_id, scope, alias_text, normalized_alias)
SELECT o.id, 'place', v.alias_text, v.normalized_alias
FROM public.offices o,
     (VALUES
        ('City Auditor', 'city auditor'),
        ('Municipal Auditor', 'municipal auditor'),
        ('Town Auditor', 'town auditor'),
        ('Village Auditor', 'village auditor'),
        ('Auditor', 'auditor')
     ) AS v(alias_text, normalized_alias)
WHERE o.scope = 'place'
  AND o.canonical_name = 'City Auditor'
ON CONFLICT (scope, normalized_alias) DO NOTHING;

-- Alias insertion does not repair elections written before the alias existed.
-- Backfill only exact place-office title keys whose office is still unresolved.
UPDATE public.elections election
SET office_id = office.id,
    updated_at = now()
FROM public.offices office,
     public.districts district
WHERE election.office_id IS NULL
  AND election.race_type = 'office'
  AND district.id = election.district_id
  AND district.district_type = 'place'
  AND office.scope = 'place'
  AND office.canonical_name = 'City Auditor'
  AND election.official_ballot_title_key IN (
    'city auditor',
    'municipal auditor',
    'town auditor',
    'village auditor',
    'auditor'
  );

INSERT INTO public.office_research_areas (office_id, research_area_id)
SELECT o.id, ra.id
FROM public.offices o
JOIN public.research_areas ra
  ON ra.slug = ANY (ARRAY[
       'anti_corruption',
       'corporate_accountability',
       'government_efficiency',
       'government_spending_reduction'
     ]::text[])
WHERE o.scope = 'place'
  AND o.canonical_name = 'City Auditor'
ON CONFLICT (office_id, research_area_id) DO NOTHING;

COMMIT;
