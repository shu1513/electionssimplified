import { strToU8, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";

import { isValidLocalBoundaryGeometry } from "../../../src/pipeline/address/localSpecialDistrictEligibility.js";
import {
  fetchLocalBoundarySource,
  insertReviewedLocalBoundary,
  dropDegenerateHoles,
  kmlZipToFeatureCollection,
  parseLocalBoundaryImport,
} from "../../../src/pipeline/address/localSpecialBoundaryImport.js";

const square = (minLon: number, minLat: number, maxLon: number, maxLat: number) => ({
  type: "Polygon",
  coordinates: [[
    [minLon, minLat], [maxLon, minLat], [maxLon, maxLat], [minLon, maxLat], [minLon, minLat],
  ]],
});

const LAYER = "https://services5.arcgis.com/abc/arcgis/rest/services/RTD_GIS_Boundaries/FeatureServer/1";
const MUNIS = "https://services3.arcgis.com/xyz/arcgis/rest/services/Municipalities/FeatureServer/0";

const rtdO = {
  district_key: "CO:RTD:DIRECTOR-O",
  district_name: "RTD Director District O",
  state: "co",
  boundary_vintage: "RTD director districts, layer edited 2026-02-23",
  eligibility_source_url: "https://assets.bouldercounty.gov/wp-content/uploads/2026/09/sample.pdf",
  review_note: "Boulder County sample ballot prints the District O race; RTD's layer matches the county ballot area.",
  sources: [{ kind: "arcgis", url: LAYER, match: { field: "BND", values: ["O"] } }],
  expected_source_sha256: null,
};

function respond(features: unknown[]) {
  return { ok: true, status: 200, json: async () => ({ type: "FeatureCollection", features }) };
}

describe("reviewed local boundary import", () => {
  it("parses a generic payload and normalizes the state code", () => {
    const payload = parseLocalBoundaryImport(rtdO);
    expect(payload.state).toBe("CO");
    expect(payload.exclusion_sources).toEqual([]);
  });

  it("rejects keys, hosts and sources that skip a review gate", () => {
    expect(() => parseLocalBoundaryImport({ ...rtdO, district_key: "OH:RTD:O" })).toThrow("start with the state code");
    expect(() => parseLocalBoundaryImport({ ...rtdO, eligibility_source_url: "https://ballotpedia.org/x" })).toThrow(".gov or .us");
    expect(() => parseLocalBoundaryImport({ ...rtdO, review_note: "ok" })).toThrow("review_note");
    expect(() => parseLocalBoundaryImport({ ...rtdO, sources: [] })).toThrow("at least one");
    expect(() => parseLocalBoundaryImport({
      ...rtdO, sources: [{ kind: "arcgis", url: "https://example.com/data.json", match: { field: "BND", values: ["O"] } }],
    })).toThrow("ArcGIS layer URL");
    expect(() => parseLocalBoundaryImport({
      ...rtdO, sources: [{ kind: "arcgis", url: LAYER, match: { field: "BND", values: ["O' OR '1'='1"] } }],
    })).toThrow("match");
  });

  it("queries the named features and hashes the snapshot", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respond([
      { type: "Feature", properties: { BND: "O" }, geometry: square(-105.3, 40.0, -105.1, 40.2) },
    ]));
    const source = await fetchLocalBoundarySource(parseLocalBoundaryImport(rtdO), fetchImpl);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("where=BND+IN+%28%27O%27%29");
    expect((source.geometry as { type: string }).type).toBe("Polygon");
    expect(source.exclusionGeometry).toBeNull();
    expect(source.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("combines statute pieces into one MultiPolygon with a stable hash", async () => {
    const payload = parseLocalBoundaryImport({
      ...rtdO,
      district_key: "CO:FRPRD",
      district_name: "Front Range Passenger Rail District",
      sources: [{ kind: "arcgis", url: MUNIS, match: { field: "city", values: ["20000", "07850"] } }],
    });
    const denver = { type: "Feature", properties: { city: "20000" }, geometry: square(-105.1, 39.6, -104.9, 39.8) };
    const boulder = { type: "Feature", properties: { city: "07850" }, geometry: square(-105.3, 40.0, -105.2, 40.1) };
    const first = await fetchLocalBoundarySource(payload, vi.fn().mockResolvedValue(respond([denver, boulder])));
    const second = await fetchLocalBoundarySource(payload, vi.fn().mockResolvedValue(respond([boulder, denver])));
    expect(first.geometry).toMatchObject({ type: "MultiPolygon" });
    expect((first.geometry as { coordinates: unknown[] }).coordinates).toHaveLength(2);
    expect(first.sourceSha256).toBe(second.sourceSha256);
  });

  it("refuses a missing, extra or duplicated official feature", async () => {
    const payload = parseLocalBoundaryImport(rtdO);
    await expect(fetchLocalBoundarySource(payload, vi.fn().mockResolvedValue(respond([]))))
      .rejects.toThrow("incomplete");
    const twice = { type: "Feature", properties: { BND: "O" }, geometry: square(-105.3, 40.0, -105.1, 40.2) };
    await expect(fetchLocalBoundarySource(payload, vi.fn().mockResolvedValue(respond([twice, twice]))))
      .rejects.toThrow("duplicated");
  });

  it("refuses a changed source hash before opening a transaction", async () => {
    const query = vi.fn();
    const payload = parseLocalBoundaryImport({ ...rtdO, expected_source_sha256: "a".repeat(64) });
    const source = {
      geometry: square(0, 0, 1, 1), exclusionGeometry: null, sourceSha256: "b".repeat(64),
      sourceUrl: LAYER, sourceUrls: [LAYER],
    };
    await expect(insertReviewedLocalBoundary({ query }, payload, source)).rejects.toThrow("changed since review");
    expect(query).not.toHaveBeenCalled();
  });

  it("rolls back when a district already exists instead of overwriting vetted geometry", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const payload = parseLocalBoundaryImport({ ...rtdO, expected_source_sha256: "a".repeat(64) });
    const source = {
      geometry: square(0, 0, 1, 1), exclusionGeometry: null, sourceSha256: "a".repeat(64),
      sourceUrl: LAYER, sourceUrls: [LAYER],
    };
    await expect(insertReviewedLocalBoundary({ query }, payload, source)).rejects.toThrow("already exists");
    expect(query.mock.calls.map((call) => String(call[0]))).toEqual([
      "BEGIN", expect.stringContaining("ON CONFLICT"), "ROLLBACK",
    ]);
  });

  it("writes the district with its state FIPS and keeps every source URL in the note", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "district-id" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const hash = "a".repeat(64);
    const payload = parseLocalBoundaryImport({ ...rtdO, expected_source_sha256: hash });
    const source = {
      geometry: square(0, 0, 1, 1), exclusionGeometry: null, sourceSha256: hash,
      sourceUrl: LAYER, sourceUrls: [LAYER, MUNIS],
    };
    await expect(insertReviewedLocalBoundary({ query }, payload, source)).resolves.toBe("district-id");
    expect(query.mock.calls[1]?.[1]).toEqual(["CO:RTD:DIRECTOR-O", "RTD Director District O", "CO", "08"]);
    expect(query.mock.calls[2]?.[1]?.[2]).toBeNull();
    expect(String(query.mock.calls[2]?.[1]?.[7])).toContain(`Sources: ${LAYER} ${MUNIS}`);
    expect(query.mock.calls[3]?.[0]).toBe("COMMIT");
  });
});

describe("zipped KML boundary sources", () => {
  const kml = `<?xml version="1.0"?><kml><Document>
<Placemark><name>District 4</name><ExtendedData><SchemaData><SimpleData name="DISTRICT">4</SimpleData></SchemaData></ExtendedData>
<MultiGeometry><Polygon><outerBoundaryIs><LinearRing><coordinates> 0,0,500 1,0,500 1,1,500 0,1,500 0,0,500 </coordinates></LinearRing></outerBoundaryIs></Polygon></MultiGeometry></Placemark>
<Placemark><name>District 5</name><MultiGeometry>
<Polygon><outerBoundaryIs><LinearRing><coordinates>2,0 4,0 4,2 2,2</coordinates></LinearRing></outerBoundaryIs>
<innerBoundaryIs><LinearRing><coordinates>2.5,0.5 3,0.5 3,1 2.5,0.5</coordinates></LinearRing></innerBoundaryIs></Polygon>
<Polygon><outerBoundaryIs><LinearRing><coordinates>5,5 6,5 6,6 5,5</coordinates></LinearRing></outerBoundaryIs></Polygon>
</MultiGeometry></Placemark>
</Document></kml>`;
  const zipBytes = zipSync({ "PlanE2106.kml": strToU8(kml) });

  it("reads each Placemark as a feature with its name and data fields", () => {
    const collection = kmlZipToFeatureCollection(zipBytes);
    expect(collection.features).toHaveLength(2);
    const [four, five] = collection.features as Array<{ properties: Record<string, string>; geometry: { type: string; coordinates: unknown[] } }>;
    expect(four?.properties).toEqual({ name: "District 4", DISTRICT: "4" });
    expect(four?.geometry).toEqual({ type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] });
    expect(five?.geometry.type).toBe("MultiPolygon");
    // The open outer ring is closed; the hole is kept.
    expect(five?.geometry.coordinates[0]).toEqual([
      [[2, 0], [4, 0], [4, 2], [2, 2], [2, 0]],
      [[2.5, 0.5], [3, 0.5], [3, 1], [2.5, 0.5]],
    ]);
  });

  it("fetches a kml_zip source and keeps only the reviewed Placemark", async () => {
    const payload = parseLocalBoundaryImport({
      ...rtdO,
      district_key: "TX:SBOE:5",
      district_name: "Texas State Board of Education District 5",
      state: "TX",
      sources: [{ kind: "kml_zip", url: "https://data.capitol.texas.gov/plane2106_kml.zip", match: { field: "name", values: ["District 5"] } }],
    });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new Error("not JSON"); },
      arrayBuffer: async () => zipBytes.buffer.slice(zipBytes.byteOffset, zipBytes.byteOffset + zipBytes.byteLength) as ArrayBuffer,
    }));
    const source = await fetchLocalBoundarySource(payload, fetchImpl);
    expect(source.sourceUrl).toBe("https://data.capitol.texas.gov/plane2106_kml.zip");
    expect((source.geometry as { type: string }).type).toBe("MultiPolygon");
  });

  it("reads coordinates tags that carry whitespace or attributes and refuses an unreadable hole", () => {
    const withAttributes = kml.replace("<innerBoundaryIs><LinearRing><coordinates>", "<innerBoundaryIs><LinearRing><coordinates >");
    const collection = kmlZipToFeatureCollection(zipSync({ "plan.kml": strToU8(withAttributes) }));
    const five = collection.features[1] as { geometry: { coordinates: unknown[][] } };
    expect(five.geometry.coordinates[0]).toHaveLength(2);

    const unreadable = kml.replace("<innerBoundaryIs><LinearRing><coordinates>", "<innerBoundaryIs><LinearRing><coords>");
    expect(() => kmlZipToFeatureCollection(zipSync({ "plan.kml": strToU8(unreadable) }))).toThrow(/innerBoundaryIs needs exactly one coordinates/);
  });

  it("refuses a zip with no KML file", () => {
    expect(() => kmlZipToFeatureCollection(zipSync({ "readme.txt": strToU8("hi") }))).toThrow(/no \.kml file/);
  });
});

describe("degenerate holes", () => {
  const outer = [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]];
  const realHole = [[1, 1], [2, 1], [2, 2], [1, 1]];

  it("drops a hole with no area and keeps real holes and the outer ring", () => {
    const slip = [[3, 3], [3, 3], [3.0000001, 3], [3, 3]];
    expect(dropDegenerateHoles({ type: "Polygon", coordinates: [outer, realHole, slip] }))
      .toEqual({ type: "Polygon", coordinates: [outer, realHole] });
    expect(dropDegenerateHoles({ type: "MultiPolygon", coordinates: [[outer, slip]] }))
      .toEqual({ type: "MultiPolygon", coordinates: [[outer]] });
  });

  it("drops a zero-area piece of a multi-part boundary but never the last piece", () => {
    const sliver = [[5, 5], [5.0000001, 5], [5, 5.0000001], [5, 5]];
    expect(dropDegenerateHoles({ type: "MultiPolygon", coordinates: [[outer, realHole], [sliver]] }))
      .toEqual({ type: "MultiPolygon", coordinates: [[outer, realHole]] });
    const onlySliver = { type: "MultiPolygon", coordinates: [[sliver]] };
    expect(dropDegenerateHoles(onlySliver)).toEqual(onlySliver);
    expect(isValidLocalBoundaryGeometry(onlySliver)).toBe(false);
  });

  it("keeps a self-crossing hole whose signed area happens to be zero", () => {
    const bowtie = [[1, 1], [3, 3], [3, 1], [1, 3], [1, 1]];
    const geometry = { type: "Polygon", coordinates: [outer, bowtie] };
    expect(dropDegenerateHoles(geometry)).toEqual(geometry);
    expect(isValidLocalBoundaryGeometry(geometry)).toBe(false);
  });
});
