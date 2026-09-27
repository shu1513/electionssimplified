import { describe, expect, it, vi } from "vitest";

import {
  fetchCarrollBoundarySource,
  insertReviewedCarrollBoundary,
  parseCarrollBoundaryImport,
} from "../../../src/pipeline/address/localSpecialBoundaryImport.js";

const polygon = { type: "Polygon", coordinates: [[
  [-81.32, 40.62], [-81.28, 40.62], [-81.28, 40.66], [-81.32, 40.66], [-81.32, 40.62],
]] };

const rose = {
  district_key: "OH:CARROLL:ROSE",
  boundary_vintage: "2026-09-25",
  eligibility_source_url: "https://lookup.boe.ohio.gov/vtrapp/carroll/precandpoll.aspx",
  review_note: "Rose precinct splits one and three exclude Magnolia village voters; compared official GIS features.",
  expected_source_sha256: null,
};

const features = [
  { type: "Feature", properties: { OBJECTID: 9, Township: "ROSE", MERGE_SRC: "C:\\GIS\\PoliticalTownships" }, geometry: polygon },
  { type: "Feature", properties: { OBJECTID: 18, CorpName: "MAGNOLIA", MERGE_SRC: "C:\\GIS\\Corporate" }, geometry: polygon },
];

describe("Carroll boundary import", () => {
  it("fetches fixed official GIS features and hashes the source snapshot", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ type: "FeatureCollection", features }) });
    const source = await fetchCarrollBoundarySource("OH:CARROLL:ROSE", fetchImpl);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("OBJECTID+IN+%289%2C18%29");
    expect(source.exclusionGeometry).toEqual(polygon);
    expect(source.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects missing Magnolia geometry and wrong official feature identity", async () => {
    const missing = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ type: "FeatureCollection", features: features.slice(0, 1) }) });
    await expect(fetchCarrollBoundarySource("OH:CARROLL:ROSE", missing)).rejects.toThrow("incomplete");
    const wrong = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ type: "FeatureCollection", features: [
      { ...features[0], properties: { OBJECTID: 9, Township: "FOX", MERGE_SRC: "PoliticalTownships" } }, features[1],
    ] }) });
    await expect(fetchCarrollBoundarySource("OH:CARROLL:ROSE", wrong)).rejects.toThrow("no longer identifies");
  });

  it("refuses a changed source hash before opening a transaction", async () => {
    const query = vi.fn();
    const payload = parseCarrollBoundaryImport({ ...rose, expected_source_sha256: "a".repeat(64) });
    const source = { geometry: polygon, exclusionGeometry: polygon, sourceSha256: "b".repeat(64), sourceUrl: "https://example.org" };
    await expect(insertReviewedCarrollBoundary({ query }, payload, source)).rejects.toThrow("changed since review");
    expect(query).not.toHaveBeenCalled();
  });

  it("rolls back when a district already exists instead of overwriting vetted geometry", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const payload = parseCarrollBoundaryImport({ ...rose, expected_source_sha256: "a".repeat(64) });
    const source = { geometry: polygon, exclusionGeometry: polygon, sourceSha256: "a".repeat(64), sourceUrl: "https://example.org" };
    await expect(insertReviewedCarrollBoundary({ query }, payload, source)).rejects.toThrow("already exists");
    expect(query.mock.calls.map((call) => String(call[0]))).toEqual([
      "BEGIN", expect.stringContaining("ON CONFLICT"), "ROLLBACK",
    ]);
  });

  it("stores a missing Fox exclusion as SQL NULL", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "fox-id" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const hash = "a".repeat(64);
    const payload = parseCarrollBoundaryImport({
      ...rose,
      district_key: "OH:CARROLL:FOX",
      expected_source_sha256: hash,
    });
    const source = {
      geometry: polygon,
      exclusionGeometry: null,
      sourceSha256: hash,
      sourceUrl: "https://example.org/official-geometry",
    };
    await expect(insertReviewedCarrollBoundary({ query }, payload, source)).resolves.toBe("fox-id");
    expect(query.mock.calls[2]?.[1]?.[2]).toBeNull();
    expect(query.mock.calls[3]?.[0]).toBe("COMMIT");
  });
});
