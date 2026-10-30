import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

import { dropDegenerateHoles, stableJson } from "./localSpecialBoundaryImport.js";
import { isValidLocalBoundaryGeometry } from "./localSpecialDistrictEligibility.js";

type Queryable = Pick<PoolClient, "query">;
type FetchLike = (url: URL) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** District of Columbia Advisory Neighborhood Commission single-member
 * districts, as redrawn after the 2020 census (in force from the 2022
 * election). DC GIS publishes them as "Single Member District - 2023". */
export const DC_SMD_LAYER_URL =
  "https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Administrative_Other_Boundaries_WebMercator/MapServer/55";
export const DC_SMD_BOUNDARY_VINTAGE = "2023 (2022 ANC redistricting, 2020 census)";
// The Office of Advisory Neighborhood Commissions lists each commission and
// its SMDs; each SMD's voters elect that SMD's commissioner.
export const DC_SMD_ELIGIBILITY_URL = "https://oanc.dc.gov/";
export const DC_SMD_COUNT = 345;
/** See migration 395: with the 25 m default, 29% of sampled DC addresses got
 * no SMD; with 3 m, 328 of 330 resolved to their official SMD. */
export const DC_SMD_EDGE_MARGIN_METERS = 3;

// Ward digit, commission letter, two-digit seat ("1A01"). One commission
// straddles Wards 3 and 4 and is written "3/4G" ("3/4G01").
const SMD_ID_RE = /^(?:[1-8]|3\/4)[A-G]\d{2}$/;
const MAX_PAGES = 10;

export type DcSmdBoundary = {
  smd_id: string;
  anc_id: string;
  geometry: unknown;
  sha256: string;
};

export type DcSmdLayer = {
  sourceUrl: string;
  sourceSha256: string;
  boundaries: DcSmdBoundary[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** "DC:ANC:1A01"; the slash in "3/4G01" becomes a hyphen ("DC:ANC:3-4G01"). */
export function dcSmdDistrictKey(smdId: string): string {
  return `DC:ANC:${smdId.replace("/", "-")}`;
}

export function dcSmdDistrictName(smdId: string): string {
  return `Advisory Neighborhood Commission ${smdId.slice(0, -2)} Single Member District ${smdId}`;
}

function layerQueryUrl(offset: number): URL {
  const url = new URL(`${DC_SMD_LAYER_URL}/query`);
  url.searchParams.set("where", "1=1");
  // Only the identity fields: the layer also carries the sitting
  // commissioner's name and contact, which change between elections and must
  // not change the reviewed hash.
  url.searchParams.set("outFields", "SMD_ID,ANC_ID");
  url.searchParams.set("outSR", "4326");
  url.searchParams.set("orderByFields", "SMD_ID");
  url.searchParams.set("f", "geojson");
  if (offset > 0) url.searchParams.set("resultOffset", String(offset));
  return url;
}

/** Validates a raw FeatureCollection feature list: exactly DC_SMD_COUNT
 * features, each with a well-formed unique SMD_ID inside its own ANC_ID and a
 * usable polygon. Anything else is an error, never a partial load. */
export function parseDcSmdFeatures(features: unknown[]): DcSmdLayer["boundaries"] {
  const boundaries: DcSmdBoundary[] = [];
  const seen = new Set<string>();
  for (const feature of features) {
    if (!isRecord(feature) || !isRecord(feature.properties)) throw new Error("SMD layer returned a malformed feature");
    const smdId = String(feature.properties.SMD_ID ?? "").trim().toUpperCase();
    const ancId = String(feature.properties.ANC_ID ?? "").trim().toUpperCase();
    if (!SMD_ID_RE.test(smdId)) throw new Error(`SMD layer returned an unreadable SMD_ID: ${smdId || "(blank)"}`);
    if (ancId !== smdId.slice(0, -2)) throw new Error(`SMD ${smdId} is listed under ANC ${ancId || "(blank)"}`);
    if (seen.has(smdId)) throw new Error(`SMD layer returned ${smdId} twice`);
    seen.add(smdId);
    const geometry = dropDegenerateHoles(feature.geometry);
    if (!isValidLocalBoundaryGeometry(geometry)) throw new Error(`SMD layer returned unusable geometry for ${smdId}`);
    const sha256 = createHash("sha256").update(stableJson({ smd_id: smdId, geometry })).digest("hex");
    boundaries.push({ smd_id: smdId, anc_id: ancId, geometry, sha256 });
  }
  if (boundaries.length !== DC_SMD_COUNT) {
    throw new Error(`SMD layer returned ${boundaries.length} districts; expected ${DC_SMD_COUNT}`);
  }
  return boundaries.sort((a, b) => a.smd_id.localeCompare(b.smd_id));
}

export function dcSmdLayerSha256(boundaries: readonly DcSmdBoundary[]): string {
  return createHash("sha256")
    .update(stableJson(boundaries.map((entry) => ({ smd_id: entry.smd_id, geometry: entry.geometry }))))
    .digest("hex");
}

export async function fetchDcSmdLayer(fetchImpl: FetchLike = fetch): Promise<DcSmdLayer> {
  const features: unknown[] = [];
  for (let page = 0; ; page += 1) {
    if (page >= MAX_PAGES) throw new Error("SMD layer kept paging; refusing a partial answer");
    const url = layerQueryUrl(features.length);
    const response = await fetchImpl(url);
    if (!response.ok) throw new Error(`SMD layer returned HTTP ${response.status}: ${url}`);
    const body = await response.json();
    if (!isRecord(body) || body.type !== "FeatureCollection" || !Array.isArray(body.features)) {
      throw new Error(`SMD layer did not return a GeoJSON FeatureCollection: ${url}`);
    }
    features.push(...body.features);
    const truncated = body.exceededTransferLimit === true ||
      (isRecord(body.properties) && body.properties.exceededTransferLimit === true);
    if (!truncated) break;
    if (body.features.length === 0) throw new Error("SMD layer reported more pages but returned none");
  }
  const boundaries = parseDcSmdFeatures(features);
  return { sourceUrl: DC_SMD_LAYER_URL, sourceSha256: dcSmdLayerSha256(boundaries), boundaries };
}

export type DcSmdImportResult = { inserted: number; attached: number; skipped: number };

/** Writes one local_special district and one verified boundary per SMD, in a
 * single transaction. Re-running is safe: an SMD whose row already has a
 * boundary is skipped, and a row that exists without one (a shell written by
 * research before the load) gets its boundary attached rather than a
 * duplicate district. */
export async function insertDcSmdBoundaries(
  db: Queryable,
  layer: DcSmdLayer,
  expectedSha256: string
): Promise<DcSmdImportResult> {
  if (expectedSha256 !== layer.sourceSha256) {
    throw new Error("SMD layer changed since review; repeat the dry run and source comparison");
  }
  const reviewNote = (smdId: string) =>
    `DC single-member district ${smdId} from the DC GIS "Single Member District - 2023" layer ` +
    `(layer hash ${layer.sourceSha256}). Each SMD elects one Advisory Neighborhood Commissioner; ` +
    `its voters are the registered voters living inside it.`;
  const result: DcSmdImportResult = { inserted: 0, attached: 0, skipped: 0 };
  await db.query("BEGIN");
  try {
    for (const boundary of layer.boundaries) {
      const key = dcSmdDistrictKey(boundary.smd_id);
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO public.districts
           (district_type, geoid_compact, name, state, state_fips, population)
         VALUES ('local_special', $1, $2, 'DC', '11', NULL)
         ON CONFLICT (district_type, geoid_compact) DO NOTHING
         RETURNING id`,
        [key, dcSmdDistrictName(boundary.smd_id)]
      );
      let districtId = inserted.rows[0]?.id;
      if (!districtId) {
        const existing = await db.query<{ id: string; has_boundary: boolean }>(
          `SELECT district.id,
                  EXISTS (SELECT 1 FROM public.local_special_boundaries AS b WHERE b.district_id = district.id) AS has_boundary
           FROM public.districts AS district
           WHERE district.district_type = 'local_special' AND district.geoid_compact = $1`,
          [key]
        );
        const row = existing.rows[0];
        if (!row) throw new Error(`District ${key} could not be inserted or found`);
        if (row.has_boundary) {
          result.skipped += 1;
          continue;
        }
        districtId = row.id;
        result.attached += 1;
      } else {
        result.inserted += 1;
      }
      await db.query(
        `INSERT INTO public.local_special_boundaries
           (district_id, geometry, exclusion_geometry, boundary_source_url, boundary_source_sha256,
            boundary_vintage, eligibility_source_url, review_status, reviewed_at, review_note,
            edge_margin_meters)
         VALUES ($1, $2::jsonb, NULL, $3, $4, $5, $6, 'verified', now(), $7, $8)`,
        [districtId, JSON.stringify(boundary.geometry), layer.sourceUrl, boundary.sha256,
          DC_SMD_BOUNDARY_VINTAGE, DC_SMD_ELIGIBILITY_URL, reviewNote(boundary.smd_id),
          DC_SMD_EDGE_MARGIN_METERS]
      );
    }
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}
