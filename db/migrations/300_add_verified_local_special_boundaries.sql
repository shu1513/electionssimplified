-- Narrow local electorates cannot be inferred from county/place membership.
-- Only reviewed official voting-area polygons may enter address resolution.
BEGIN;

ALTER TABLE public.districts DROP CONSTRAINT chk_district_type;
ALTER TABLE public.districts ADD CONSTRAINT chk_district_type CHECK (
  district_type IN (
    'statewide', 'us_house', 'state_upper', 'state_lower', 'county', 'place',
    'school_elementary', 'school_secondary', 'school_unified', 'local_special'
  )
);

ALTER TABLE public.user_districts DROP CONSTRAINT chk_user_districts_type;
ALTER TABLE public.user_districts ADD CONSTRAINT chk_user_districts_type CHECK (
  district_type IN (
    'statewide', 'us_house', 'state_upper', 'state_lower', 'county', 'place',
    'school_elementary', 'school_secondary', 'school_unified', 'local_special'
  )
);

-- Many small tax/service districts publish voter counts but no resident
-- population. Unknown must stay NULL, never be represented as zero.
ALTER TABLE public.districts ALTER COLUMN population DROP NOT NULL;
ALTER TABLE public.districts ADD CONSTRAINT chk_district_population_required_except_local_special
  CHECK (district_type = 'local_special' OR population IS NOT NULL);

CREATE TABLE public.local_special_boundaries (
  district_id uuid PRIMARY KEY,
  district_type text NOT NULL DEFAULT 'local_special' CHECK (district_type = 'local_special'),
  geometry jsonb NOT NULL CHECK (geometry->>'type' IN ('Polygon', 'MultiPolygon')),
  exclusion_geometry jsonb CHECK (exclusion_geometry IS NULL OR exclusion_geometry->>'type' IN ('Polygon', 'MultiPolygon')),
  boundary_source_url text NOT NULL CHECK (boundary_source_url ~ '^https://[^ ]+$'),
  boundary_source_sha256 text NOT NULL CHECK (boundary_source_sha256 ~ '^[a-f0-9]{64}$'),
  boundary_vintage text NOT NULL CHECK (btrim(boundary_vintage) <> ''),
  eligibility_source_url text NOT NULL CHECK (eligibility_source_url ~ '^https://[^ ]+$'),
  review_status text NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'verified')),
  reviewed_at timestamptz,
  review_note text,
  CONSTRAINT fk_local_special_boundaries_district FOREIGN KEY (district_id, district_type)
    REFERENCES public.districts (id, district_type) ON DELETE CASCADE,
  CONSTRAINT chk_local_special_boundaries_verified CHECK (
    review_status <> 'verified' OR (reviewed_at IS NOT NULL AND
      review_note IS NOT NULL AND btrim(review_note) <> '')
  )
);

COMMENT ON TABLE public.local_special_boundaries IS
  'Reviewed official electorate geometry only. Never infer a local_special ballot from a parent county/place or an unreviewed polygon. The resolver excludes points near all edges.';

COMMIT;
