-- Store each reviewed local boundary's bounding box on its row.
--
-- The address resolver keeps a per-state index of one box per boundary and
-- fetches a full shape only when the box holds the address point. The index
-- was built by walking every coordinate of every shape in the state, in SQL,
-- on the first lookup after each 30-minute cache window. California's shapes
-- grew to about 50 MB of jsonb and that walk passed the API's 30 s statement
-- timeout in production (2026-11-13): every California street-address search
-- failed with a 500, and the browser gave up at 15 s first.
--
-- The box is now a stored generated column, computed once when a row is
-- written, so the index query reads four numbers per row. Every importer
-- keeps working unchanged: the column follows geometry by itself.
--
-- The box spans every polygon's outer ring, the same rings the resolver's
-- boundingBox() reads. NULL when the geometry has no usable point; the
-- resolver skips such a row, as it did before.
--
-- Adding the column rewrites the table and computes every existing row's box
-- (about the cost of one old index build per state, once).

BEGIN;

CREATE FUNCTION public.local_special_geometry_bbox(geometry jsonb)
RETURNS double precision[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
           WHEN count(*) = 0 THEN NULL
           ELSE ARRAY[
             min((pt->>0)::float8), min((pt->>1)::float8),
             max((pt->>0)::float8), max((pt->>1)::float8)
           ]
         END
  FROM jsonb_array_elements(
         CASE
           WHEN geometry->>'type' = 'Polygon' AND jsonb_typeof(geometry->'coordinates') = 'array'
             THEN jsonb_build_array(geometry->'coordinates')
           WHEN geometry->>'type' = 'MultiPolygon' AND jsonb_typeof(geometry->'coordinates') = 'array'
             THEN geometry->'coordinates'
           ELSE '[]'::jsonb
         END
       ) AS polygon
  CROSS JOIN LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(polygon->0) = 'array' THEN polygon->0 ELSE '[]'::jsonb END
       ) AS pt
  WHERE jsonb_typeof(pt) = 'array'
    AND jsonb_typeof(pt->0) = 'number'
    AND jsonb_typeof(pt->1) = 'number'
$$;

COMMENT ON FUNCTION public.local_special_geometry_bbox(jsonb) IS
  'Bounding box [min_lon, min_lat, max_lon, max_lat] over the outer rings of a GeoJSON Polygon or MultiPolygon; NULL when it has no usable point.';

ALTER TABLE public.local_special_boundaries
  ADD COLUMN bbox double precision[]
    GENERATED ALWAYS AS (public.local_special_geometry_bbox(geometry)) STORED;

COMMENT ON COLUMN public.local_special_boundaries.bbox IS
  'Bounding box [min_lon, min_lat, max_lon, max_lat] of geometry, kept by Postgres. The address resolver reads it to pick which shapes to load.';

COMMIT;
