import type { Pool, PoolClient } from "pg";

import type { AddressDistrictKey } from "./addressDistrictResolver.js";
import type { CensusAddressCoordinates } from "./censusAddressGeocoder.js";

type Queryable = Pick<Pool | PoolClient, "query">;
type Point = readonly [number, number]; // longitude, latitude
type Ring = Point[];
type Polygon = Ring[];
type MultiPolygon = Polygon[];

type BoundaryRow = {
  geoid_compact: string;
  geometry: unknown;
  exclusion_geometry: unknown;
  edge_margin_meters?: number | string | null;
};

// The Census address-string geocoder places points on street centerlines.
// Those often form voting-area edges. Refuse an edge and a 25 m buffer rather
// than claiming a voter on the wrong side; rooftop coordinates also benefit.
// A boundary may carry a smaller margin of its own (edge_margin_meters,
// migration 395) when its layer is known to place geocoded points on the
// correct side of its street-centerline edges; never a larger one.
export const LOCAL_BOUNDARY_MARGIN_METERS = 25;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePoint(value: unknown): Point | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [lon, lat] = value;
  return typeof lon === "number" && typeof lat === "number" &&
    Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lon) <= 180 && Math.abs(lat) <= 90
    ? [lon, lat] : null;
}

function parseRing(value: unknown): Ring | null {
  if (!Array.isArray(value) || value.length < 4) return null;
  const ring = value.map(parsePoint);
  if (ring.some((point) => point === null)) return null;
  const points = ring as Ring;
  const first = points[0];
  const last = points[points.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) return null;
  const twiceArea = points.slice(1).reduce((sum, point, index) =>
    sum + points[index][0] * point[1] - point[0] * points[index][1], 0);
  return Math.abs(twiceArea) > 1e-12 ? points : null;
}

function parsePolygon(value: unknown): Polygon | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const rings = value.map(parseRing);
  return rings.some((ring) => ring === null) ? null : rings as Polygon;
}

function parseGeometry(value: unknown): MultiPolygon | null {
  if (!isRecord(value)) return null;
  if (value.type === "Polygon") {
    const polygon = parsePolygon(value.coordinates);
    return polygon ? [polygon] : null;
  }
  if (value.type === "MultiPolygon" && Array.isArray(value.coordinates) && value.coordinates.length > 0) {
    const polygons = value.coordinates.map(parsePolygon);
    return polygons.some((polygon) => polygon === null) ? null : polygons as MultiPolygon;
  }
  return null;
}

export function isValidLocalBoundaryGeometry(value: unknown): boolean {
  return parseGeometry(value) !== null;
}

const METERS_PER_DEGREE_LAT = 111_195;

function metersPerDegreeLon(lat: number): number {
  return METERS_PER_DEGREE_LAT * Math.cos(lat * Math.PI / 180);
}

// The closest point of the segment to `point`, in meters east and north of
// `point`, or null when the segment stays farther away than `marginMeters`.
function nearestOnSegment(
  point: Point,
  start: Point,
  end: Point,
  marginMeters: number
): readonly [number, number] | null {
  const lonScale = metersPerDegreeLon(point[1]);
  const ax = (start[0] - point[0]) * lonScale;
  const ay = (start[1] - point[1]) * METERS_PER_DEGREE_LAT;
  const bx = (end[0] - point[0]) * lonScale;
  const by = (end[1] - point[1]) * METERS_PER_DEGREE_LAT;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const fraction = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared));
  const x = ax + fraction * dx;
  const y = ay + fraction * dy;
  return Math.hypot(x, y) <= marginMeters ? [x, y] : null;
}

function ringContains(point: Point, ring: Ring): boolean {
  let inside = false;
  for (let index = 1; index < ring.length; index += 1) {
    const from = ring[index - 1];
    const to = ring[index];
    if ((from[1] > point[1]) !== (to[1] > point[1]) &&
      point[0] < (to[0] - from[0]) * (point[1] - from[1]) / (to[1] - from[1]) + from[0]) {
      inside = !inside;
    }
  }
  return inside;
}

function geometryContains(point: Point, geometry: MultiPolygon): boolean {
  return geometry.some((polygon) =>
    ringContains(point, polygon[0]) && !polygon.slice(1).some((hole) => ringContains(point, hole)));
}

// A ring segment is part of the area's edge only where one side of it lies
// outside the area. A district built from several official pieces (for
// example, a list of cities named in statute) is their union, and two
// neighboring pieces share a line that is not an edge. So every segment
// within the margin is probed one step to either side; a hole, a gap between
// pieces, or the outer line has a probe land outside.
const EDGE_PROBE_METERS = 1;

function nearEdge(point: Point, geometry: MultiPolygon, marginMeters: number): boolean {
  if (marginMeters <= 0) return false;
  const lonScale = metersPerDegreeLon(point[1]);
  for (const polygon of geometry) {
    for (const ring of polygon) {
      for (let index = 1; index < ring.length; index += 1) {
        const from = ring[index - 1];
        const to = ring[index];
        const nearest = nearestOnSegment(point, from, to, marginMeters);
        if (!nearest) continue;
        const dx = (to[0] - from[0]) * lonScale;
        const dy = (to[1] - from[1]) * METERS_PER_DEGREE_LAT;
        const length = Math.hypot(dx, dy);
        if (length === 0) continue;
        const normalX = (-dy / length) * EDGE_PROBE_METERS;
        const normalY = (dx / length) * EDGE_PROBE_METERS;
        for (const side of [1, -1]) {
          const probe: Point = [
            point[0] + (nearest[0] + side * normalX) / lonScale,
            point[1] + (nearest[1] + side * normalY) / METERS_PER_DEGREE_LAT,
          ];
          if (!geometryContains(probe, geometry)) return true;
        }
      }
    }
  }
  return false;
}

type BoundingBox = { minLon: number; minLat: number; maxLon: number; maxLat: number };

type ParsedBoundary = {
  geoid_compact: string;
  geometry: MultiPolygon;
  exclusions: MultiPolygon | null;
  bbox: BoundingBox;
  edgeMarginMeters: number;
};

function boundingBox(geometry: MultiPolygon): BoundingBox {
  const box = { minLon: Infinity, minLat: Infinity, maxLon: -Infinity, maxLat: -Infinity };
  for (const polygon of geometry) {
    for (const [lon, lat] of polygon[0]) {
      if (lon < box.minLon) box.minLon = lon;
      if (lon > box.maxLon) box.maxLon = lon;
      if (lat < box.minLat) box.minLat = lat;
      if (lat > box.maxLat) box.maxLat = lat;
    }
  }
  return box;
}

function inBoundingBox(point: Point, box: BoundingBox): boolean {
  return point[0] > box.minLon && point[0] < box.maxLon && point[1] > box.minLat && point[1] < box.maxLat;
}

function pointInParsedBoundary(
  point: Point,
  geometry: MultiPolygon,
  exclusions: MultiPolygon | null,
  marginMeters: number = LOCAL_BOUNDARY_MARGIN_METERS
): boolean {
  if (!geometryContains(point, geometry) || nearEdge(point, geometry, marginMeters)) return false;
  return !exclusions || (!geometryContains(point, exclusions) && !nearEdge(point, exclusions, marginMeters));
}

/** The stored margin, clamped to [0, LOCAL_BOUNDARY_MARGIN_METERS]. A missing
 * or unreadable value falls back to the full margin. */
export function boundaryEdgeMarginMeters(value: number | string | null | undefined): number {
  const margin = typeof value === "string" ? Number(value) : value;
  if (typeof margin !== "number" || !Number.isFinite(margin)) return LOCAL_BOUNDARY_MARGIN_METERS;
  return Math.min(LOCAL_BOUNDARY_MARGIN_METERS, Math.max(0, margin));
}

/** Only a strict interior point beyond the boundary buffer is eligible.
 * Exclusions remove incorporated areas or other electorates verified by the
 * same official source. Invalid geometry always fails closed. */
export function pointInVerifiedLocalBoundary(
  coordinates: CensusAddressCoordinates,
  geometryValue: unknown,
  exclusionValue: unknown = null,
  marginMeters: number = LOCAL_BOUNDARY_MARGIN_METERS
): boolean {
  const geometry = parseGeometry(geometryValue);
  const exclusions = exclusionValue === null ? null : parseGeometry(exclusionValue);
  if (!geometry || (exclusionValue !== null && !exclusions)) return false;
  return pointInParsedBoundary([coordinates.lng, coordinates.lat], geometry, exclusions, boundaryEdgeMarginMeters(marginMeters));
}

// Boundaries change only through a reviewed import, so each process keeps a
// small per-state index (one bounding box per boundary) for a few minutes.
// Full shapes are never cached: one state's verified shapes reached ~100 MB
// of jsonb (California, 2026-10-21) and holding them parsed ran the API out
// of memory. A lookup fetches only the shapes whose box holds the point.
// Building California's index takes Postgres a few seconds, so it is kept
// for 30 minutes; a newly reviewed boundary appears within that window.
export const LOCAL_BOUNDARY_CACHE_TTL_MS = 30 * 60 * 1000;

type BoundaryIndexEntry = { boundary_id: string; geoid_compact: string; bbox: BoundingBox };
type BoundaryIndexRow = {
  boundary_id: string;
  geoid_compact: string;
  min_lon: number | string | null;
  min_lat: number | string | null;
  max_lon: number | string | null;
  max_lat: number | string | null;
};

type CacheEntry = { expiresAt: number; index: Promise<BoundaryIndexEntry[]> };
const boundaryCache = new Map<string, CacheEntry>();

export function clearLocalSpecialBoundaryCache(): void {
  boundaryCache.clear();
}

// The box spans every polygon's outer ring, the same rings boundingBox()
// reads, so a point outside it is outside the shape. Postgres does the walk,
// so the API never holds the full shapes just to build the index.
const BOUNDARY_INDEX_SQL = `
  SELECT boundary.district_id::text AS boundary_id, district.geoid_compact,
         min((pt->>0)::float8) AS min_lon, min((pt->>1)::float8) AS min_lat,
         max((pt->>0)::float8) AS max_lon, max((pt->>1)::float8) AS max_lat
  FROM public.local_special_boundaries AS boundary
  JOIN public.districts AS district ON district.id = boundary.district_id
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN boundary.geometry->>'type' = 'Polygon' AND jsonb_typeof(boundary.geometry->'coordinates') = 'array'
        THEN jsonb_build_array(boundary.geometry->'coordinates')
      WHEN boundary.geometry->>'type' = 'MultiPolygon' AND jsonb_typeof(boundary.geometry->'coordinates') = 'array'
        THEN boundary.geometry->'coordinates'
      ELSE '[]'::jsonb
    END
  ) AS polygon
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(polygon->0) = 'array' THEN polygon->0 ELSE '[]'::jsonb END
  ) AS pt
  WHERE district.state_fips = $1 AND district.district_type = 'local_special'
    AND boundary.review_status = 'verified'
    AND jsonb_typeof(pt) = 'array' AND jsonb_typeof(pt->0) = 'number' AND jsonb_typeof(pt->1) = 'number'
  GROUP BY boundary.district_id, district.geoid_compact
  ORDER BY district.geoid_compact`;

function toFiniteNumber(value: number | string | null): number | null {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : null;
}

async function loadStateBoundaryIndex(db: Queryable, stateFips: string): Promise<BoundaryIndexEntry[]> {
  const result = await db.query<BoundaryIndexRow>(BOUNDARY_INDEX_SQL, [stateFips]);
  const index: BoundaryIndexEntry[] = [];
  for (const row of result.rows) {
    const minLon = toFiniteNumber(row.min_lon);
    const minLat = toFiniteNumber(row.min_lat);
    const maxLon = toFiniteNumber(row.max_lon);
    const maxLat = toFiniteNumber(row.max_lat);
    if (minLon === null || minLat === null || maxLon === null || maxLat === null) continue;
    index.push({ boundary_id: row.boundary_id, geoid_compact: row.geoid_compact, bbox: { minLon, minLat, maxLon, maxLat } });
  }
  return index;
}

function cachedStateBoundaryIndex(db: Queryable, stateFips: string): Promise<BoundaryIndexEntry[]> {
  const now = Date.now();
  const cached = boundaryCache.get(stateFips);
  if (cached && cached.expiresAt > now) return cached.index;
  const index = loadStateBoundaryIndex(db, stateFips);
  const entry = { expiresAt: now + LOCAL_BOUNDARY_CACHE_TTL_MS, index };
  boundaryCache.set(stateFips, entry);
  // Never cache a failed read; the next lookup retries.
  index.catch(() => {
    if (boundaryCache.get(stateFips) === entry) boundaryCache.delete(stateFips);
  });
  return index;
}

// Fetched one at a time so at most one parsed shape is alive per lookup.
async function loadBoundaryShape(db: Queryable, boundaryId: string): Promise<ParsedBoundary | null> {
  const result = await db.query<BoundaryRow>(
    `SELECT district.geoid_compact, boundary.geometry, boundary.exclusion_geometry,
            boundary.edge_margin_meters
     FROM public.local_special_boundaries AS boundary
     JOIN public.districts AS district ON district.id = boundary.district_id
     WHERE boundary.district_id = $1 AND boundary.review_status = 'verified'`,
    [boundaryId]
  );
  const row = result.rows[0];
  if (!row) return null;
  // Invalid geometry is dropped here, so it can never be eligible.
  const geometry = parseGeometry(row.geometry);
  const exclusions = row.exclusion_geometry === null ? null : parseGeometry(row.exclusion_geometry);
  if (!geometry || (row.exclusion_geometry !== null && !exclusions)) return null;
  return {
    geoid_compact: row.geoid_compact,
    geometry,
    exclusions,
    bbox: boundingBox(geometry),
    edgeMarginMeters: boundaryEdgeMarginMeters(row.edge_margin_meters),
  };
}

export async function lookupLocalSpecialDistrictKeys(
  db: Queryable,
  stateFips: string,
  coordinates: CensusAddressCoordinates
): Promise<AddressDistrictKey[]> {
  if (!/^[0-9]{2}$/.test(stateFips) || !Number.isFinite(coordinates.lat) || !Number.isFinite(coordinates.lng)) {
    return [];
  }
  const point: Point = [coordinates.lng, coordinates.lat];
  const index = await cachedStateBoundaryIndex(db, stateFips);
  const keys: AddressDistrictKey[] = [];
  for (const entry of index) {
    if (!inBoundingBox(point, entry.bbox)) continue;
    const shape = await loadBoundaryShape(db, entry.boundary_id);
    if (!shape || !pointInParsedBoundary(point, shape.geometry, shape.exclusions, shape.edgeMarginMeters)) continue;
    keys.push({
      district_type: "local_special",
      geoid_compact: shape.geoid_compact,
      source: "verified_polygon",
      layer_name: "reviewed_local_boundary",
    });
  }
  return keys;
}
