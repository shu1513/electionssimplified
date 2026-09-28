import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

import { STATE_FIPS_BY_ABBREVIATION } from "../../constants/usStates.js";
import { isValidLocalBoundaryGeometry } from "./localSpecialDistrictEligibility.js";

type Queryable = Pick<PoolClient, "query">;
type FetchLike = (url: URL) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** One official source of boundary pieces. `match` names the exact feature set
 * the reviewer expects: the source must return one feature per value, no more,
 * no fewer. An ArcGIS layer is queried by that field; a GeoJSON file is
 * filtered by it. */
export type BoundarySourceSpec = {
  kind: "arcgis" | "geojson";
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
  if (!isRecord(value) || (value.kind !== "arcgis" && value.kind !== "geojson")) {
    throw new Error(`${label}.kind must be "arcgis" or "geojson"`);
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
  if (spec.kind === "geojson") return new URL(spec.url);
  const url = new URL(`${spec.url}/query`);
  url.searchParams.set("where", `${spec.match.field} IN (${spec.match.values.map((entry) => `'${entry}'`).join(",")})`);
  url.searchParams.set("outFields", "*");
  url.searchParams.set("outSR", "4326");
  url.searchParams.set("f", "geojson");
  return url;
}

async function fetchSourceFeatures(
  spec: BoundarySourceSpec,
  fetchImpl: FetchLike
): Promise<{ url: string; features: Record<string, unknown>[] }> {
  const url = sourceRequestUrl(spec);
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`Official boundary source returned HTTP ${response.status}: ${url}`);
  const body: unknown = await response.json();
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
