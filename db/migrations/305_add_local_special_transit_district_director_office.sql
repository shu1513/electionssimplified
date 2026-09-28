-- Offices for reviewed local_special districts (migration 300), starting with
-- the elected board of a regional transit district. Denver-area voters elect
-- the Regional Transportation District (RTD) board by director district, and
-- the catalog had no office at local_special scope, so the race could not be
-- written.
--
-- The two scope checks are rebuilt from their current value lists, so a
-- scope added by another migration (e.g. state_executive_council) is kept.
--
-- The summary is byte-identical to backend/src/scripts/seedOffices.ts, and
-- the research areas match db/seeds/office_research_areas_v1.sql. On a fresh
-- migrations-only database research_areas is still empty, so the
-- research-area join inserts zero rows (same pattern as migration 303).

BEGIN;

DO $$
DECLARE
  target record;
  allowed text[];
BEGIN
  FOR target IN
    SELECT *
    FROM (VALUES
      ('offices', 'chk_offices_scope', 'scope'),
      ('office_title_aliases', 'chk_office_title_aliases_scope', 'scope')
    ) AS v(table_name, constraint_name, column_name)
  LOOP
    -- The list is stored either as quoted items (IN ('a', 'b')) or, once a
    -- migration has rebuilt it, as an array literal ('{a,b}'). Read both.
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
      RAISE EXCEPTION 'migration 305: could not read the value list of %.%', target.table_name, target.constraint_name;
    END IF;

    IF NOT ('local_special' = ANY (allowed)) THEN
      allowed := allowed || 'local_special'::text;
    END IF;

    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', target.table_name, target.constraint_name);
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (%I = ANY (%L::text[]))',
      target.table_name, target.constraint_name, target.column_name, allowed
    );
  END LOOP;
END
$$;

INSERT INTO public.offices (scope, canonical_name, summary)
VALUES (
  'local_special',
  'Transit District Director',
  'Setting bus and train routes, schedules, and fares for the region
Approving the transit agency''s budget and large construction projects
Hiring and overseeing the general manager who runs daily service'
)
ON CONFLICT (scope, canonical_name) DO NOTHING;

INSERT INTO public.office_title_aliases (office_id, scope, alias_text, normalized_alias)
SELECT o.id, 'local_special', v.alias_text, v.normalized_alias
FROM public.offices o,
     (VALUES
        ('Transit District Director', 'transit district director'),
        ('Regional Transportation District Director', 'regional transportation district director'),
        ('RTD Director', 'rtd director'),
        ('Director, Regional Transportation District', 'director regional transportation district'),
        ('Transit Board Director', 'transit board director'),
        ('Transit Board Member', 'transit board member')
     ) AS v(alias_text, normalized_alias)
WHERE o.scope = 'local_special'
  AND o.canonical_name = 'Transit District Director'
ON CONFLICT (scope, normalized_alias) DO NOTHING;

INSERT INTO public.office_research_areas (office_id, research_area_id)
SELECT o.id, ra.id
FROM public.offices o
JOIN public.research_areas ra
  ON ra.slug = ANY (ARRAY[
       'environment_and_public_health',
       'government_efficiency',
       'government_spending_reduction',
       'public_infrastructure'
     ]::text[])
WHERE o.scope = 'local_special'
  AND o.canonical_name = 'Transit District Director'
ON CONFLICT (office_id, research_area_id) DO NOTHING;

COMMIT;
