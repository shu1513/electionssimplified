import { describe, expect, it } from "vitest";

import { localSpecialOverlaps, pointInPolygon, samplePoints } from "../../src/scripts/majorCityCoverage.js";

const square = { rings: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]] };
const squareWithHole = {
  rings: [
    [[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]],
    [[0.25, 0.25], [0.75, 0.25], [0.75, 0.75], [0.25, 0.75], [0.25, 0.25]],
  ],
};

describe("majorCityCoverage geometry", () => {
  it("classifies points against a ring with a hole", () => {
    expect(pointInPolygon(0.1, 0.1, square)).toBe(true);
    expect(pointInPolygon(1.5, 0.5, square)).toBe(false);
    expect(pointInPolygon(0.5, 0.5, squareWithHole)).toBe(false);
    expect(pointInPolygon(0.1, 0.9, squareWithHole)).toBe(true);
  });

  it("samples only points inside the polygon", () => {
    const all = samplePoints(square);
    expect(all).toHaveLength(3600);
    const withHole = samplePoints(squareWithHole);
    expect(withHole.length).toBeLessThan(all.length);
    expect(withHole.every(([lon, lat]) => pointInPolygon(lon, lat, squareWithHole))).toBe(true);
  });
});

describe("majorCityCoverage local_special overlap", () => {
  it("scores reviewed special-district boundaries against the city's sample points", () => {
    const points: Array<[number, number]> = [[-105.05, 39.75], [-104.95, 39.75], [-104.5, 39.75], [-104.4, 39.75]];
    const boundary = {
      geoid_compact: "CO:RTD:DIRECTOR-C",
      name: "RTD Director District C",
      geometry: { type: "Polygon", coordinates: [[[-105.1, 39.7], [-104.9, 39.7], [-104.9, 39.8], [-105.1, 39.8], [-105.1, 39.7]]] },
      exclusion_geometry: null,
    };
    const far = { ...boundary, geoid_compact: "CO:RTD:DIRECTOR-O", geometry: { type: "Polygon", coordinates: [[[-106, 41], [-105.9, 41], [-105.9, 41.1], [-106, 41]]] } };
    expect(localSpecialOverlaps(points, [boundary, far])).toEqual([
      { district_type: "local_special", geoid_compact: "CO:RTD:DIRECTOR-C", name: "RTD Director District C", city_share: 0.5 },
    ]);
    expect(localSpecialOverlaps([], [boundary])).toEqual([]);
  });
});
