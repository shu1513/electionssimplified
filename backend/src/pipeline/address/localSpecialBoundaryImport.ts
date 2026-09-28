import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import type { PoolClient } from "pg";

import { STATE_FIPS_BY_ABBREVIATION } from "../../constants/usStates.js";
import { isValidLocalBoundaryGeometry } from "./localSpecialDistrictEligibility.js";

type Queryable = Pick<PoolClient, "query">;
type FetchLike = (url: URL) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  arrayBuffer?(): Promise<ArrayBuffer>;
}>;

/** One official source of boundary pieces. `match` names the exact feature set
 * the reviewer expects: the source must return one feature per value, no more,
 * no fewer. An ArcGIS layer is queried by that field; a GeoJSON file is
 * filtered by it. A `kml_zip` source is a zipped KML file, the format some
 * state offices publish instead of a map service (the Texas Legislative
 * Council's redistricting plans, for example); each Placemark becomes a
 * feature whose `name` and ExtendedData fields can be matched. */
export type BoundarySourceSpec = {
  kind: "arcgis" | "geojson" | "kml_zip";
  url: string;
  match: { field: string; values: string[] };
};

export type LocalBoundaryImport = {
  district_key: string;
  district_name: string;
  state: string;
  boundary_vintage: string;
  eligibility_source_url: string;
  review_note: string;
  sources: BoundarySourceSpec[];
  exclusion_sources: BoundarySourceSpec[];
  expected_source_sha256: string | null;
};

export type LocalBoundarySource = {
  geometry: unknown;
  exclusionGeometry: unknown;
  sourceSha256: string;
  sourceUrl: string;
  sourceUrls: string[];
};

type Polygon = unknown[];

const ARCGIS_LAYER_RE = /^https:\/\/[^\s?#]+\/(?:FeatureServer|MapServer)\/\d+$/;
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DISTRICT_KEY_RE = /^[A-Z]{2}:[A-Z0-9][A-Z0-9:_-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function httpsUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function parseSource(value: unknown, label: string): BoundarySourceSpec {
  if (!isRecord(value) || (value.kind !== "arcgis" && value.kind !== "geojson" && value.kind !== "kml_zip")) {
    throw new Error(`${label}.kind must be "arcgis", "geojson", or "kml_zip"`);
  }
  const url = httpsUrl(value.url);
  if (!url) throw new Error(`${label}.url must be an HTTPS URL`);
  if (value.kind === "arcgis" && !ARCGIS_LAYER_RE.test(value.url as string)) {
    throw new Error(`${label}.url must be an ArcGIS layer URL ending in /FeatureServer/<n> or /MapServer/<n>`);
  }
  const match = value.match;
  if (!isRecord(match) || typeof match.field !== "string" || !FIELD_RE.test(match.field) ||
    !Array.isArray(match.values) || match.values.length === 0 ||
    match.values.some((entry) => typeof entry !== "string" || entry.trim() === "" || entry.includes("'"))) {
    throw new Error(`${label}.match needs a field name and a non-empty list of string values`);
  }
  const values = match.values as string[];
  if (new Set(values).size !== values.length) throw new Error(`${label}.match.values has duplicates`);
  return { kind: value.kind, url: value.url as string, match: { field: match.field, values } };
}

/** Dry runs print the hash. The reviewer compares the official geometry with
 * the ballot authority's own description of who votes, records that hash in
 * the payload, then a write refetches and requires it. */
export function parseLocalBoundaryImport(value: unknown): LocalBoundaryImport {
  if (!isRecord(value)) throw new Error("payload must be a JSON object");
  const state = typeof value.state === "string" ? value.state.trim().toUpperCase() : "";
  if (!STATE_FIPS_BY_ABBREVIATION[state]) throw new Error("state must be a two-letter state code");
  if (typeof value.district_key !== "string" || !DISTRICT_KEY_RE.test(value.district_key) ||
    !value.district_key.startsWith(`${state}:`)) {
    throw new Error(`district_key must look like ${state}:NAME and start with the state code`);
  }
  if (typeof value.district_name !== "string" || value.district_name.trim().length < 3) {
    throw new Error("district_name is required");
  }
  // Who votes on a local contest is an election-office fact. Only a
  // government host may attest it.
  const eligibilityUrl = httpsUrl(value.eligibility_source_url);
  if (!eligibilityUrl || !/\.(gov|us)$/.test(eligibilityUrl.hostname)) {
    throw new Error("eligibility_source_url must be an HTTPS URL on a .gov or .us host");
  }
  if (typeof value.boundary_vintage !== "string" || !value.boundary_vintage.trim() ||
    typeof value.review_note !== "string" || value.review_note.trim().length < 40) {
    throw new Error("boundary_vintage and a substantive review_note are required");
  }
  if (!Array.isArray(value.sources) || value.sources.length === 0) {
    throw new Error("sources must list at least one official boundary source");
  }
  const exclusions = value.exclusion_sources ?? [];
  if (!Array.isArray(exclusions)) throw new Error("exclusion_sources must be a list");
  const hash = value.expected_source_sha256 ?? null;
  if (hash !== null && (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))) {
    throw new Error("expected_source_sha256 must be a lowercase SHA-256 hex digest");
  }
  return {
    district_key: value.district_key,
    district_name: value.district_name.trim(),
    state,
    boundary_vintage: value.boundary_vintage,
    eligibility_source_url: value.eligibility_source_url as string,
    review_note: value.review_note,
    sources: value.sources.map((entry, index) => parseSource(entry, `sources[${index}]`)),
    exclusion_sources: exclusions.map((entry, index) => parseSource(entry, `exclusion_sources[${index}]`)),
    expected_source_sha256: hash,
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sourceRequestUrl(spec: BoundarySourceSpec): URL {
  if (spec.kind === "geojson" || spec.kind === "kml_zip") return new URL(spec.url);
  const url = new URL(`${spec.url}/query`);
  url.searchParams.set("where", `${spec.match.field} IN (${spec.match.values.map((entry) => `'${entry}'`).join(",")})`);
  url.searchParams.set("outFields", "*");
  url.searchParams.set("outSR", "4326");
  url.searchParams.set("f", "geojson");
  return url;
}

async function readArrayBuffer(
  response: { arrayBuffer?(): Promise<ArrayBuffer> },
  url: URL
): Promise<Uint8Array> {
  if (!response.arrayBuffer) throw new Error(`Official boundary source cannot be read as a file: ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}

function decodeXmlText(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function parseKmlRing(text: string): number[][] {
  const ring = text.trim().split(/\s+/).filter(Boolean).map((tuple) => {
    const [lon, lat] = tuple.split(",").map(Number);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) throw new Error(`KML coordinate is not a number: ${tuple}`);
    return [lon as number, lat as number];
  });
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) ring.push([first[0] as number, first[1] as number]);
  return ring;
}

/** One ring per boundary element. A boundary whose coordinates cannot be read
 * is an error, never a silently missing hole. */
function ringsIn(block: string, tag: "outerBoundaryIs" | "innerBoundaryIs"): number[][][] {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "g");
  return [...block.matchAll(pattern)].map((boundary) => {
    const coordinates = [...(boundary[1] as string).matchAll(/<coordinates\b[^>]*>([\s\S]*?)<\/coordinates>/g)];
    if (coordinates.length !== 1) throw new Error(`KML ${tag} needs exactly one coordinates element`);
    return parseKmlRing(coordinates[0]?.[1] as string);
  });
}

/** Reads the first .kml file in a zip into a GeoJSON FeatureCollection: one
 * feature per Placemark, with `name` and every ExtendedData SimpleData or
 * Data value as properties. Only polygon geometry is kept. */
export function kmlZipToFeatureCollection(zipBytes: Uint8Array): { type: "FeatureCollection"; features: unknown[] } {
  const files = unzipSync(zipBytes);
  const kmlName = Object.keys(files).sort().find((name) => name.toLowerCase().endsWith(".kml"));
  if (!kmlName) throw new Error("Official boundary zip holds no .kml file");
  const kml = new TextDecoder("utf-8").decode(files[kmlName]);
  const features = [...kml.matchAll(/<Placemark\b[\s\S]*?<\/Placemark>/g)].map((match) => {
    const block = match[0];
    const properties: Record<string, string> = {};
    const name = /<name>([\s\S]*?)<\/name>/.exec(block);
    if (name) properties.name = decodeXmlText(name[1] as string);
    for (const field of block.matchAll(/<SimpleData name="([^"]+)">([\s\S]*?)<\/SimpleData>/g)) {
      properties[field[1] as string] = decodeXmlText(field[2] as string);
    }
    for (const field of block.matchAll(/<Data name="([^"]+)">\s*<value>([\s\S]*?)<\/value>/g)) {
      properties[field[1] as string] = decodeXmlText(field[2] as string);
    }
    const polygons = [...block.matchAll(/<Polygon\b[\s\S]*?<\/Polygon>/g)].map((polygon) => {
      const outer = ringsIn(polygon[0], "outerBoundaryIs");
      if (outer.length !== 1) throw new Error(`KML polygon needs exactly one outer ring (${properties.name ?? "unnamed"})`);
      return [outer[0] as number[][], ...ringsIn(polygon[0], "innerBoundaryIs")];
    });
    const geometry = polygons.length === 0
      ? null
      : polygons.length === 1
        ? { type: "Polygon", coordinates: polygons[0] }
        : { type: "MultiPolygon", coordinates: polygons };
    return { type: "Feature", properties, geometry };
  });
  return { type: "FeatureCollection", features };
}

/** True when every point of the ring lies on one line (or all coincide), so
 * the ring provably encloses nothing. The line runs from the first point to
 * the point farthest from it: anchoring on the first *different* point would
 * let a near-duplicate vertex (float noise) shrink every cross product under
 * the tolerance and condemn a real polygon. A self-crossing ring can also sum
 * to zero area without being empty; it is not degenerate and is left alone. */
function isDegenerateRing(ring: unknown): boolean {
  if (!Array.isArray(ring)) return false;
  const points = ring as number[][];
  const [ox = 0, oy = 0] = points[0] ?? [];
  const offsets = points.map((point) => [(point[0] ?? 0) - ox, (point[1] ?? 0) - oy] as const);
  const [dx, dy] = offsets.reduce((far, next) => (next[0] ** 2 + next[1] ** 2 > far[0] ** 2 + far[1] ** 2 ? next : far), [0, 0] as const);
  if (dx === 0 && dy === 0) return true;
  return offsets.every(([px, py]) => Math.abs(px * dy - py * dx) <= 1e-12);
}

/** Official layers sometimes carry a hole with no area (a digitizing slip:
 * three copies of one point). It removes nothing from the district, but the
 * boundary check rejects zero-area rings, so drop such holes. A multi-part
 * layer can carry the same slip as a whole piece (Douglas County's MUD
 * Subdivision 4 has a three-point sliver); a piece with no area adds no
 * territory, so it goes too while at least one real piece remains. Only
 * provably degenerate rings go; any other malformed ring stays and fails the
 * boundary check. A single polygon's outer ring is never touched. */
export function dropDegenerateHoles(geometry: unknown): unknown {
  if (!isRecord(geometry) || !Array.isArray(geometry.coordinates)) return geometry;
  const clean = (polygon: unknown) => Array.isArray(polygon)
    ? polygon.filter((ring, index) => index === 0 || !isDegenerateRing(ring))
    : polygon;
  if (geometry.type === "Polygon") return { ...geometry, coordinates: clean(geometry.coordinates) };
  if (geometry.type === "MultiPolygon") {
    const pieces = geometry.coordinates.map(clean);
    const real = pieces.filter((polygon) => !Array.isArray(polygon) || !isDegenerateRing(polygon[0]));
    return { ...geometry, coordinates: real.length > 0 ? real : pieces };
  }
  return geometry;
}

async function fetchSourceFeatures(
  spec: BoundarySourceSpec,
  fetchImpl: FetchLike
): Promise<{ url: string; features: Record<string, unknown>[] }> {
  const url = sourceRequestUrl(spec);
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`Official boundary source returned HTTP ${response.status}: ${url}`);
  const body: unknown = spec.kind === "kml_zip"
    ? kmlZipToFeatureCollection(await readArrayBuffer(response, url))
    : await response.json();
  if (!isRecord(body) || body.type !== "FeatureCollection" || !Array.isArray(body.features)) {
    throw new Error(`Official boundary source did not return a GeoJSON FeatureCollection: ${url}`);
  }
  if (body.exceededTransferLimit === true || (isRecord(body.properties) && body.properties.exceededTransferLimit === true)) {
    throw new Error(`Official boundary source truncated its answer: ${url}`);
  }
  const wanted = new Set(spec.match.values);
  const features = body.features.filter((feature): feature is Record<string, unknown> =>
    isRecord(feature) && isRecord(feature.properties) &&
    wanted.has(String(feature.properties[spec.match.field] ?? "").trim()));
  const seen = features.map((feature) => String((feature.properties as Record<string, unknown>)[spec.match.field]).trim());
  const missing = spec.match.values.filter((entry) => !seen.includes(entry));
  if (missing.length > 0 || seen.length !== spec.match.values.length) {
    throw new Error(`Official boundary source feature set is incomplete or duplicated (${spec.match.field}; missing: ${missing.join(", ") || "none"}): ${url}`);
  }
  for (const feature of features) {
    feature.geometry = dropDegenerateHoles(feature.geometry);
    if (!isValidLocalBoundaryGeometry(feature.geometry)) {
      throw new Error(`Official boundary source returned unusable geometry for ${spec.match.field}=${String((feature.properties as Record<string, unknown>)[spec.match.field])}`);
    }
  }
  features.sort((a, b) => String((a.properties as Record<string, unknown>)[spec.match.field])
    .localeCompare(String((b.properties as Record<string, unknown>)[spec.match.field])));
  return { url: url.toString(), features };
}

function polygonsOf(geometry: unknown): Polygon[] {
  const value = geometry as { type: string; coordinates: unknown[] };
  return value.type === "Polygon" ? [value.coordinates] : value.coordinates as Polygon[];
}

/** Pieces are kept side by side as one MultiPolygon. The eligibility check
 * treats that as their union, so a line shared by two pieces is not an edge. */
function combine(features: Record<string, unknown>[]): unknown {
  const polygons = features.flatMap((feature) => polygonsOf(feature.geometry));
  return polygons.length === 1
    ? { type: "Polygon", coordinates: polygons[0] }
    : { type: "MultiPolygon", coordinates: polygons };
}

export async function fetchLocalBoundarySource(
  payload: LocalBoundaryImport,
  fetchImpl: FetchLike = fetch
): Promise<LocalBoundarySource> {
  const included = [];
  for (const spec of payload.sources) included.push(await fetchSourceFeatures(spec, fetchImpl));
  const excluded = [];
  for (const spec of payload.exclusion_sources) excluded.push(await fetchSourceFeatures(spec, fetchImpl));
  const sourceSha256 = createHash("sha256")
    .update(stableJson({
      sources: included.map((entry) => entry.features),
      exclusions: excluded.map((entry) => entry.features),
    }))
    .digest("hex");
  const sourceUrls = [...included, ...excluded].map((entry) => entry.url);
  return {
    geometry: combine(included.flatMap((entry) => entry.features)),
    exclusionGeometry: excluded.length === 0 ? null : combine(excluded.flatMap((entry) => entry.features)),
    sourceSha256,
    sourceUrl: sourceUrls[0] as string,
    sourceUrls,
  };
}

export async function insertReviewedLocalBoundary(
  db: Queryable,
  payload: LocalBoundaryImport,
  source: LocalBoundarySource
): Promise<string> {
  if (!payload.expected_source_sha256 || payload.expected_source_sha256 !== source.sourceSha256) {
    throw new Error("Official GIS response changed since review; repeat dry-run and source comparison");
  }
  // boundary_source_url holds one URL; the note keeps every source queried.
  const reviewNote = source.sourceUrls.length > 1
    ? `${payload.review_note.trim()} Sources: ${source.sourceUrls.join(" ")}`
    : payload.review_note;
  await db.query("BEGIN");
  try {
    const district = await db.query<{ id: string }>(
      `INSERT INTO public.districts
         (district_type, geoid_compact, name, state, state_fips, population)
       VALUES ('local_special', $1, $2, $3, $4, NULL)
       ON CONFLICT (district_type, geoid_compact) DO NOTHING
       RETURNING id`,
      [payload.district_key, payload.district_name, payload.state, STATE_FIPS_BY_ABBREVIATION[payload.state]]
    );
    const id = district.rows[0]?.id;
    if (!id) throw new Error(`District ${payload.district_key} already exists; refusing to replace reviewed geometry`);
    await db.query(
      `INSERT INTO public.local_special_boundaries
         (district_id, geometry, exclusion_geometry, boundary_source_url, boundary_source_sha256,
          boundary_vintage, eligibility_source_url, review_status, reviewed_at, review_note)
       VALUES ($1, $2::jsonb, $3::jsonb, $4, $5, $6, $7, 'verified', now(), $8)`,
      [id, JSON.stringify(source.geometry),
        source.exclusionGeometry === null ? null : JSON.stringify(source.exclusionGeometry),
        source.sourceUrl, source.sourceSha256, payload.boundary_vintage,
        payload.eligibility_source_url, reviewNote]
    );
    await db.query("COMMIT");
    return id;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}
