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
