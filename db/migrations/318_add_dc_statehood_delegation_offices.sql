-- The District of Columbia elects two "United States Senators" and one
-- "United States Representative" under D.C. Code § 1-123(d). They are the
-- statehood, or "shadow", delegation: DC public officials (§ 1-123(e)) whose
-- duties are to press Congress for DC statehood, report on its progress, and
-- advise the District on it (§ 1-123(f)). They hold no seat or vote in
-- Congress and file no FEC reports. On November 3, 2026 the DC ballot carries
-- one Senator seat and the Representative seat.
--
-- The catalog had no home for them. At statewide scope every such title fell
-- onto the real United States Senator office, which would have told DC voters
-- they elect a voting senator and sent candidate research down the FEC path.
-- This migration adds one statewide office for each and aliases the "shadow"
-- and "statehood" forms onto it. Stored titles carry "(Shadow)" after the
-- printed words, and the code treats any shadow or statehood title as a DC
-- office rather than a seat in Congress.
--
-- It also repoints any shadow alias a matcher run learned onto the wrong
-- office, repoints any DC statewide election already written on the real
-- Senate office, and removes one alias a matcher run learned on a local database:
-- "united states representative" pointing at the statewide United States
-- Senator office. That alias is wrong in every state (a House seat is never a
-- Senate seat) and no seed or migration created it.
--
-- Summaries are byte-identical to backend/src/scripts/seedOffices.ts, and the
-- research areas match db/seeds/office_research_areas_v1.sql. On a fresh
-- migrations-only database research_areas is still empty, so the
-- research-area join inserts zero rows (same pattern as migration 313).

BEGIN;

INSERT INTO public.offices (scope, canonical_name, summary)
VALUES
  (
    'statewide',
    'Shadow United States Senator',
    'Pressing Congress to make the District of Columbia a state
Reporting to DC residents on how the push for statehood is going
Advising the DC government on policies that affect statehood'
  ),
  (
    'statewide',
    'Shadow United States Representative',
    'Pressing Congress to make the District of Columbia a state
Reporting to DC residents on how the push for statehood is going
Advising the DC government on policies that affect statehood'
  )
ON CONFLICT (scope, canonical_name) DO NOTHING;

DELETE FROM public.office_title_aliases a
USING public.offices o
WHERE a.office_id = o.id
  AND a.scope = 'statewide'
  AND a.normalized_alias = 'united states representative'
  AND o.scope = 'statewide'
  AND o.canonical_name = 'United States Senator';

-- A database whose matcher ran before this migration may have LEARNED one of
-- the shadow titles below as an alias of the real United States Senator
-- office (the matcher persists confident matches, and an exact alias hit
-- outranks the scorer). The inserts below use ON CONFLICT DO NOTHING, which
-- would keep that wrong mapping and make seedOffices refuse the remap as a
-- collision. Repoint any such alias at the shadow office first.
UPDATE public.office_title_aliases a
SET office_id = shadow.id,
    updated_at = now()
FROM public.offices shadow
WHERE a.scope = 'statewide'
  AND shadow.scope = 'statewide'
  AND shadow.canonical_name = 'Shadow United States Senator'
  AND a.office_id <> shadow.id
  AND a.normalized_alias IN (
    'united states senator shadow', 'shadow united states senator', 'united states shadow senator',
    'u s shadow senator', 'shadow senator', 'statehood senator'
  );

UPDATE public.office_title_aliases a
SET office_id = shadow.id,
    updated_at = now()
FROM public.offices shadow
WHERE a.scope = 'statewide'
  AND shadow.scope = 'statewide'
  AND shadow.canonical_name = 'Shadow United States Representative'
  AND a.office_id <> shadow.id
  AND a.normalized_alias IN (
    'united states representative shadow', 'shadow united states representative',
    'united states shadow representative', 'u s shadow representative',
    'shadow representative', 'statehood representative'
  );

INSERT INTO public.office_title_aliases (office_id, scope, alias_text, normalized_alias)
SELECT o.id, 'statewide', v.alias_text, v.normalized_alias
FROM public.offices o,
     (VALUES
        ('United States Senator (Shadow)', 'united states senator shadow'),
        ('Shadow United States Senator', 'shadow united states senator'),
        ('United States Shadow Senator', 'united states shadow senator'),
        ('U.S. Shadow Senator', 'u s shadow senator'),
        ('Shadow Senator', 'shadow senator'),
        ('Statehood Senator', 'statehood senator')
     ) AS v(alias_text, normalized_alias)
WHERE o.scope = 'statewide'
  AND o.canonical_name = 'Shadow United States Senator'
ON CONFLICT (scope, normalized_alias) DO NOTHING;

INSERT INTO public.office_title_aliases (office_id, scope, alias_text, normalized_alias)
SELECT o.id, 'statewide', v.alias_text, v.normalized_alias
FROM public.offices o,
     (VALUES
        ('United States Representative (Shadow)', 'united states representative shadow'),
        ('Shadow United States Representative', 'shadow united states representative'),
        ('United States Shadow Representative', 'united states shadow representative'),
        ('U.S. Shadow Representative', 'u s shadow representative'),
        ('Shadow Representative', 'shadow representative'),
        ('Statehood Representative', 'statehood representative')
     ) AS v(alias_text, normalized_alias)
WHERE o.scope = 'statewide'
  AND o.canonical_name = 'Shadow United States Representative'
ON CONFLICT (scope, normalized_alias) DO NOTHING;

-- An election already written for a shadow contest before this migration
-- would carry the real United States Senator office (the only statewide
-- federal office the catalog had). The District of Columbia has no seat in
-- the Senate and its House delegate sits on the us_house row, so on DC's
-- statewide row every election on that office is a shadow contest. Repoint
-- those rows by the chamber noun in their title. Nothing else runs this
-- repair: manual:elections:repair-office-ids fixes NULL office_id only.
UPDATE public.elections e
SET office_id = shadow.id
FROM public.districts d,
     public.offices senate,
     public.offices shadow
WHERE d.id = e.district_id
  AND d.state = 'DC'
  AND d.district_type = 'statewide'
  AND senate.scope = 'statewide'
  AND senate.canonical_name = 'United States Senator'
  AND e.office_id = senate.id
  AND shadow.scope = 'statewide'
  AND shadow.canonical_name = CASE
    WHEN e.official_ballot_title ~* '\mrepresentative\M' THEN 'Shadow United States Representative'
    ELSE 'Shadow United States Senator'
  END;

INSERT INTO public.office_research_areas (office_id, research_area_id)
SELECT o.id, ra.id
FROM public.offices o
JOIN public.research_areas ra
  ON ra.slug = ANY (ARRAY['anti_corruption', 'civil_rights']::text[])
WHERE o.scope = 'statewide'
  AND o.canonical_name IN ('Shadow United States Senator', 'Shadow United States Representative')
ON CONFLICT (office_id, research_area_id) DO NOTHING;

COMMIT;
