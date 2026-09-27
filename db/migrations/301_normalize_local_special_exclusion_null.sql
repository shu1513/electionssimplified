BEGIN;

-- The initial Fox import serialized a missing exclusion as JSONB null. Store
-- absence as SQL NULL so SQL predicates and future readers agree.
UPDATE public.local_special_boundaries
SET exclusion_geometry = NULL
WHERE exclusion_geometry = 'null'::jsonb;

ALTER TABLE public.local_special_boundaries
  ADD CONSTRAINT chk_local_special_exclusion_geometry_object
  CHECK (
    exclusion_geometry IS NULL OR
    (jsonb_typeof(exclusion_geometry) = 'object' AND
     exclusion_geometry->>'type' IN ('Polygon', 'MultiPolygon'))
  );

COMMIT;
