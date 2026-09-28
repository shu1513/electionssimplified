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

function nearSegment(point: Point, start: Point, end: Point, marginMeters: number): boolean {
  const metersPerDegreeLat = 111_195;
  const metersPerDegreeLon = metersPerDegreeLat * Math.cos(point[1] * Math.PI / 180);
  const ax = (start[0] - point[0]) * metersPerDegreeLon;
  const ay = (start[1] - point[1]) * metersPerDegreeLat;
  const bx = (end[0] - point[0]) * metersPerDegreeLon;
  const by = (end[1] - point[1]) * metersPerDegreeLat;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const fraction = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared));
  return Math.hypot(ax + fraction * dx, ay + fraction * dy) <= marginMeters;
}

function classifyRing(point: Point, ring: Ring): "inside" | "outside" | "edge" {
  let inside = false;
  for (let index = 1; index < ring.length; index += 1) {
    const from = ring[index - 1];
    const to = ring[index];
    if (nearSegment(point, from, to, LOCAL_BOUNDARY_MARGIN_METERS)) return "edge";
    if ((from[1] > point[1]) !== (to[1] > point[1]) &&
      point[0] < (to[0] - from[0]) * (point[1] - from[1]) / (to[1] - from[1]) + from[0]) {
      inside = !inside;
    }
  }
  return inside ? "inside" : "outside";
}

function classifyGeometry(point: Point, geometry: MultiPolygon): "inside" | "outside" | "edge" {
  let inside = false;
  for (const polygon of geometry) {
    const outer = classifyRing(point, polygon[0]);
    if (outer === "edge") return "edge";
    if (outer === "outside") continue;
    let inHole = false;
    for (const hole of polygon.slice(1)) {
      const result = classifyRing(point, hole);
      if (result === "edge") return "edge";
      if (result === "inside") inHole = true;
    }
    if (!inHole) inside = true;
  }
  return inside ? "inside" : "outside";
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

function unionContains(point: Point, geometry: MultiPolygon): boolean {
  return geometry.some((polygon) =>
    ringContains(point, polygon[0]) && !polygon.slice(1).some((hole) => ringContains(point, hole)));
}

// A district built from several official pieces (for example, a list of
// cities named in statute) is their union. Two neighboring cities share a
// line that is not the district's edge, so the per-ring edge test above would
// wrongly refuse voters near it. Instead, the point and a ring of points at
// the buffer distance around it must all fall inside some piece.
const UNION_SAMPLE_DIRECTIONS = 16;

function deepInsideUnion(point: Point, geometry: MultiPolygon): boolean {
  if (!unionContains(point, geometry)) return false;
  const metersPerDegreeLat = 111_195;
  const metersPerDegreeLon = metersPerDegreeLat * Math.cos(point[1] * Math.PI / 180);
  for (const radius of [LOCAL_BOUNDARY_MARGIN_METERS / 2, LOCAL_BOUNDARY_MARGIN_METERS]) {
    for (let step = 0; step < UNION_SAMPLE_DIRECTIONS; step += 1) {
      const angle = (2 * Math.PI * step) / UNION_SAMPLE_DIRECTIONS;
      const sample: Point = [
        point[0] + (radius * Math.cos(angle)) / metersPerDegreeLon,
        point[1] + (radius * Math.sin(angle)) / metersPerDegreeLat,
      ];
      if (!unionContains(sample, geometry)) return false;
    }
  }
  return true;
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
  const inside = geometry.length === 1
    ? classifyGeometry(point, geometry) === "inside"
    : deepInsideUnion(point, geometry);
  if (!inside) return false;
  return !exclusions || classifyGeometry(point, exclusions) === "outside";
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
