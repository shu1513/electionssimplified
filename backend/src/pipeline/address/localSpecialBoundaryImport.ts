import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

import { isValidLocalBoundaryGeometry } from "./localSpecialDistrictEligibility.js";

type Queryable = Pick<PoolClient, "query">;

export const CARROLL_GIS_LAYER =
  "https://services8.arcgis.com/dZSJY7MSQPhysZUz/arcgis/rest/services/Carroll_Political_Subdivisions/FeatureServer/0";

const CARROLL_DISTRICTS = {
  "OH:CARROLL:FOX": { name: "Fox Township, Ohio", featureId: 13, exclusionId: null },
  "OH:CARROLL:ROSE": { name: "Rose Township outside Magnolia, Ohio", featureId: 9, exclusionId: 18 },
} as const;

export type CarrollBoundaryImport = {
  district_key: keyof typeof CARROLL_DISTRICTS;
  boundary_vintage: string;
  eligibility_source_url: string;
  review_note: string;
  expected_source_sha256: string | null;
};

export type CarrollBoundarySource = {
  geometry: unknown;
  exclusionGeometry: unknown;
  sourceSha256: string;
  sourceUrl: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Dry runs print the hash. The operator verifies GIS and BOE agreement,
 * records that hash in the payload, then a write refetches and requires it. */
export function parseCarrollBoundaryImport(value: unknown): CarrollBoundaryImport {
  if (!isRecord(value) || typeof value.district_key !== "string" ||
    !(value.district_key in CARROLL_DISTRICTS)) {
    throw new Error("district_key must be OH:CARROLL:FOX or OH:CARROLL:ROSE");
  }
  let eligibilityUrl: URL | null = null;
  try {
    if (typeof value.eligibility_source_url === "string") eligibilityUrl = new URL(value.eligibility_source_url);
  } catch {
    // Handled by the official-host validation below.
  }
  if (!eligibilityUrl || eligibilityUrl.protocol !== "https:" ||
    !["lookup.boe.ohio.gov", "www.boe.ohio.gov", "boe.ohio.gov"].includes(eligibilityUrl.hostname)) {
    throw new Error("eligibility_source_url must be an official Carroll BOE HTTPS URL");
  }
  if (typeof value.boundary_vintage !== "string" || !value.boundary_vintage.trim() ||
    typeof value.review_note !== "string" || value.review_note.trim().length < 40) {
    throw new Error("boundary_vintage and a substantive review_note are required");
  }
  const hash = value.expected_source_sha256 ?? null;
  if (hash !== null && (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))) {
    throw new Error("expected_source_sha256 must be a lowercase SHA-256 hex digest");
  }
  return {
    district_key: value.district_key as CarrollBoundaryImport["district_key"],
    boundary_vintage: value.boundary_vintage,
    eligibility_source_url: value.eligibility_source_url as string,
    review_note: value.review_note,
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

function featureById(features: unknown[], id: number): Record<string, unknown> {
  const matches = features.filter((feature) =>
    isRecord(feature) && isRecord(feature.properties) && feature.properties.OBJECTID === id
  );
  if (matches.length !== 1) throw new Error(`Official Carroll GIS returned ${matches.length} features for OBJECTID ${id}`);
  return matches[0] as Record<string, unknown>;
}

export async function fetchCarrollBoundarySource(
  districtKey: CarrollBoundaryImport["district_key"],
  fetchImpl: typeof fetch = fetch
): Promise<CarrollBoundarySource> {
  const expected = CARROLL_DISTRICTS[districtKey];
  const ids = expected.exclusionId === null ? [expected.featureId] : [expected.featureId, expected.exclusionId];
  const url = new URL(`${CARROLL_GIS_LAYER}/query`);
  url.searchParams.set("where", `OBJECTID IN (${ids.join(",")})`);
  url.searchParams.set("outFields", "*");
  url.searchParams.set("outSR", "4326");
  url.searchParams.set("f", "geojson");
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`Official Carroll GIS returned HTTP ${response.status}`);
  const body: unknown = await response.json();
  if (!isRecord(body) || body.type !== "FeatureCollection" || !Array.isArray(body.features) ||
    body.features.length !== ids.length) {
    throw new Error("Official Carroll GIS feature set is incomplete");
  }
  const features = body.features;
  const township = featureById(features, expected.featureId);
  const townshipProps = township.properties as Record<string, unknown>;
  const expectedTownship = expected.featureId === 13 ? "FOX" : "ROSE";
  if (String(townshipProps.Township).trim().toUpperCase() !== expectedTownship ||
    !String(townshipProps.MERGE_SRC).trim().toUpperCase().endsWith("POLITICALTOWNSHIPS") ||
    !isValidLocalBoundaryGeometry(township.geometry)) {
    throw new Error(`Official Carroll GIS OBJECTID ${expected.featureId} no longer identifies ${expectedTownship} township`);
  }
  const exclusion = expected.exclusionId === null ? null : featureById(features, expected.exclusionId);
  if (exclusion) {
    const props = exclusion.properties as Record<string, unknown>;
    if (String(props.CorpName).trim().toUpperCase() !== "MAGNOLIA" ||
      !String(props.MERGE_SRC).trim().toUpperCase().endsWith("CORPORATE") ||
      !isValidLocalBoundaryGeometry(exclusion.geometry)) {
      throw new Error("Official Carroll GIS OBJECTID 18 no longer identifies Magnolia village");
    }
  }
  const sourceSha256 = createHash("sha256")
    .update(stableJson(ids.map((id) => featureById(features, id))))
    .digest("hex");
  return {
    geometry: township.geometry,
    exclusionGeometry: exclusion?.geometry ?? null,
    sourceSha256,
    sourceUrl: url.toString(),
  };
}

export async function insertReviewedCarrollBoundary(
  db: Queryable,
  payload: CarrollBoundaryImport,
  source: CarrollBoundarySource
): Promise<string> {
  if (!payload.expected_source_sha256 || payload.expected_source_sha256 !== source.sourceSha256) {
    throw new Error("Official GIS response changed since review; repeat dry-run and source comparison");
  }
  const expected = CARROLL_DISTRICTS[payload.district_key];
  await db.query("BEGIN");
  try {
    const district = await db.query<{ id: string }>(
      `INSERT INTO public.districts
         (district_type, geoid_compact, name, state, state_fips, population)
       VALUES ('local_special', $1, $2, 'OH', '39', NULL)
       ON CONFLICT (district_type, geoid_compact) DO NOTHING
       RETURNING id`,
      [payload.district_key, expected.name]
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
        payload.eligibility_source_url, payload.review_note]
    );
    await db.query("COMMIT");
    return id;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}
