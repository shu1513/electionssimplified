import { describe, expect, it, vi } from "vitest";

import {
  lookupLocalSpecialDistrictKeys,
  pointInVerifiedLocalBoundary,
} from "../../../src/pipeline/address/localSpecialDistrictEligibility.js";

const square = (minLon: number, minLat: number, maxLon: number, maxLat: number) => ({
  type: "Polygon",
  coordinates: [[
    [minLon, minLat], [maxLon, minLat], [maxLon, maxLat],
    [minLon, maxLat], [minLon, minLat],
  ]],
});

const township = square(-81.32, 40.62, -81.28, 40.66);
const village = square(-81.301, 40.639, -81.295, 40.645);

describe("local-special district eligibility", () => {
  it("includes only strict interior points and subtracts the village", () => {
    expect(pointInVerifiedLocalBoundary({ lng: -81.31, lat: 40.63 }, township, village)).toBe(true);
    expect(pointInVerifiedLocalBoundary({ lng: -81.298, lat: 40.642 }, township, village)).toBe(false);
    expect(pointInVerifiedLocalBoundary({ lng: -81.3199, lat: 40.63 }, township, village)).toBe(false);
    expect(pointInVerifiedLocalBoundary({ lng: -81.325, lat: 40.63 }, township, village)).toBe(false);
    expect(pointInVerifiedLocalBoundary({ lng: -81.2951, lat: 40.642 }, township, village)).toBe(false);
  });

  it("treats a multi-piece district as the union of its pieces", () => {
    // Two cities side by side share the line lng = -105.0.
    const pieces = {
      type: "MultiPolygon",
      coordinates: [
        square(-105.1, 39.7, -105.0, 39.8).coordinates,
        square(-105.0, 39.7, -104.9, 39.8).coordinates,
      ],
    };
    expect(pointInVerifiedLocalBoundary({ lng: -105.00005, lat: 39.75 }, pieces)).toBe(true);
    expect(pointInVerifiedLocalBoundary({ lng: -105.05, lat: 39.75 }, pieces)).toBe(true);
    // Still refused near the district's own outer edge, and outside it.
    expect(pointInVerifiedLocalBoundary({ lng: -105.0999, lat: 39.75 }, pieces)).toBe(false);
    expect(pointInVerifiedLocalBoundary({ lng: -104.85, lat: 39.75 }, pieces)).toBe(false);
    // A gap between two pieces is not in the district.
    const apart = {
      type: "MultiPolygon",
      coordinates: [
        square(-105.1, 39.7, -105.001, 39.8).coordinates,
        square(-104.999, 39.7, -104.9, 39.8).coordinates,
      ],
    };
    expect(pointInVerifiedLocalBoundary({ lng: -105.0, lat: 39.75 }, apart)).toBe(false);
  });

  it("refuses points near a hole even when the district has other pieces", () => {
    // A 4 m hole 8 m east of the point. Ring sampling at 12.5 m and 25 m
    // missed it once a distant island made the district multi-piece.
    const hole = square(-105.0000234, 39.749982, -104.9999766, 39.750018).coordinates[0];
    const withHole = { type: "Polygon", coordinates: [square(-105.1, 39.7, -104.9, 39.8).coordinates[0], hole] };
    const withIsland = {
      type: "MultiPolygon",
      coordinates: [withHole.coordinates, square(-104.5, 39.7, -104.4, 39.8).coordinates],
    };
    const nearHole = { lng: -105.000117, lat: 39.75 };
    expect(pointInVerifiedLocalBoundary(nearHole, withHole)).toBe(false);
    expect(pointInVerifiedLocalBoundary(nearHole, withIsland)).toBe(false);
    expect(pointInVerifiedLocalBoundary({ lng: -105.05, lat: 39.75 }, withIsland)).toBe(true);
  });

  it("refuses points near a narrow gap between pieces", () => {
    // Two pieces 3 m apart; the point is 18 m from the gap, between the old
    // 12.5 m and 25 m sample rings.
    const gap = {
      type: "MultiPolygon",
      coordinates: [
        square(-105.1, 39.7, -105.0000175, 39.8).coordinates,
        square(-104.9999825, 39.7, -104.9, 39.8).coordinates,
      ],
    };
    expect(pointInVerifiedLocalBoundary({ lng: -105.0002281, lat: 39.75 }, gap)).toBe(false);
    expect(pointInVerifiedLocalBoundary({ lng: -105.05, lat: 39.75 }, gap)).toBe(true);
  });

  it("fails closed for malformed geometry", () => {
    expect(pointInVerifiedLocalBoundary({ lng: -81.31, lat: 40.63 }, { type: "Polygon", coordinates: [] })).toBe(false);
    expect(pointInVerifiedLocalBoundary({ lng: -81.31, lat: 40.63 }, township, { type: "Polygon" })).toBe(false);
  });

  it("reads only reviewed local boundaries in the address state", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ geoid_compact: "OH:CARROLL:FOX", geometry: township, exclusion_geometry: null }],
    });
    const keys = await lookupLocalSpecialDistrictKeys({ query }, "39", { lng: -81.31, lat: 40.63 });
    expect(query.mock.calls[0]?.[0]).toContain("boundary.review_status = 'verified'");
    expect(query.mock.calls[0]?.[1]).toEqual(["39"]);
    expect(keys).toEqual([{
      district_type: "local_special",
      geoid_compact: "OH:CARROLL:FOX",
      source: "verified_polygon",
      layer_name: "reviewed_local_boundary",
    }]);
    await expect(lookupLocalSpecialDistrictKeys({ query }, "not-a-state", { lng: -81.31, lat: 40.63 })).resolves.toEqual([]);
    expect(query).toHaveBeenCalledOnce();
  });
});
