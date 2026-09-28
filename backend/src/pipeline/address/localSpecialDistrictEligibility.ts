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
};

// The Census address-string geocoder places points on street centerlines.
// Those often form voting-area edges. Refuse an edge and a 25 m buffer rather
// than claiming a voter on the wrong side; rooftop coordinates also benefit.
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

function nearEdge(point: Point, geometry: MultiPolygon): boolean {
  const lonScale = metersPerDegreeLon(point[1]);
  for (const polygon of geometry) {
    for (const ring of polygon) {
      for (let index = 1; index < ring.length; index += 1) {
        const from = ring[index - 1];
        const to = ring[index];
        const nearest = nearestOnSegment(point, from, to, LOCAL_BOUNDARY_MARGIN_METERS);
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

function pointInParsedBoundary(point: Point, geometry: MultiPolygon, exclusions: MultiPolygon | null): boolean {
  if (!geometryContains(point, geometry) || nearEdge(point, geometry)) return false;
  return !exclusions || (!geometryContains(point, exclusions) && !nearEdge(point, exclusions));
}

/** Only a strict interior point beyond the boundary buffer is eligible.
 * Exclusions remove incorporated areas or other electorates verified by the
 * same official source. Invalid geometry always fails closed. */
export function pointInVerifiedLocalBoundary(
  coordinates: CensusAddressCoordinates,
  geometryValue: unknown,
  exclusionValue: unknown = null
): boolean {
  const geometry = parseGeometry(geometryValue);
  const exclusions = exclusionValue === null ? null : parseGeometry(exclusionValue);
  if (!geometry || (exclusionValue !== null && !exclusions)) return false;
  return pointInParsedBoundary([coordinates.lng, coordinates.lat], geometry, exclusions);
}

// Boundaries change only through a reviewed import, so each process keeps a
// state's parsed boundaries for a few minutes instead of re-reading and
// re-parsing megabytes of jsonb on every address lookup.
export const LOCAL_BOUNDARY_CACHE_TTL_MS = 5 * 60 * 1000;

type CacheEntry = { expiresAt: number; boundaries: Promise<ParsedBoundary[]> };
const boundaryCache = new Map<string, CacheEntry>();

export function clearLocalSpecialBoundaryCache(): void {
  boundaryCache.clear();
}

async function loadStateBoundaries(db: Queryable, stateFips: string): Promise<ParsedBoundary[]> {
  const result = await db.query<BoundaryRow>(
    `SELECT district.geoid_compact, boundary.geometry, boundary.exclusion_geometry
     FROM public.local_special_boundaries AS boundary
     JOIN public.districts AS district ON district.id = boundary.district_id
     WHERE district.state_fips = $1 AND district.district_type = 'local_special'
       AND boundary.review_status = 'verified'
     ORDER BY district.geoid_compact`,
    [stateFips]
  );
  const boundaries: ParsedBoundary[] = [];
  for (const row of result.rows) {
    // Invalid geometry is dropped here, so it can never be eligible.
    const geometry = parseGeometry(row.geometry);
    const exclusions = row.exclusion_geometry === null ? null : parseGeometry(row.exclusion_geometry);
    if (!geometry || (row.exclusion_geometry !== null && !exclusions)) continue;
    boundaries.push({ geoid_compact: row.geoid_compact, geometry, exclusions, bbox: boundingBox(geometry) });
  }
  return boundaries;
}

function cachedStateBoundaries(db: Queryable, stateFips: string): Promise<ParsedBoundary[]> {
  const now = Date.now();
  const cached = boundaryCache.get(stateFips);
  if (cached && cached.expiresAt > now) return cached.boundaries;
  const boundaries = loadStateBoundaries(db, stateFips);
  const entry = { expiresAt: now + LOCAL_BOUNDARY_CACHE_TTL_MS, boundaries };
  boundaryCache.set(stateFips, entry);
  // Never cache a failed read; the next lookup retries.
  boundaries.catch(() => {
    if (boundaryCache.get(stateFips) === entry) boundaryCache.delete(stateFips);
  });
  return boundaries;
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
  const boundaries = await cachedStateBoundaries(db, stateFips);
  return boundaries
    .filter((boundary) => inBoundingBox(point, boundary.bbox) &&
      pointInParsedBoundary(point, boundary.geometry, boundary.exclusions))
    .map((boundary) => ({
      district_type: "local_special",
      geoid_compact: boundary.geoid_compact,
      source: "verified_polygon",
      layer_name: "reviewed_local_boundary",
    }));
}
