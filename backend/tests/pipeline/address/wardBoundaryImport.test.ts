import { describe, expect, it, vi } from "vitest";

import {
  fetchWardLayer,
  importWardBoundaries,
  matchSeat,
  parseWardBoundaryImport,
  planWardElections,
  seatPattern,
  wardDistrictKey,
  wardDistrictName,
} from "../../../src/pipeline/address/wardBoundaryImport.js";

const square = (index: number) => {
  const lon = -97.8 + index * 0.02;
  return {
    type: "Polygon",
    coordinates: [[[lon, 30.2], [lon + 0.01, 30.2], [lon + 0.01, 30.21], [lon, 30.21], [lon, 30.2]]],
  };
};

const payload = (overrides: Record<string, unknown> = {}) => ({
  state: "TX",
  jurisdiction: { district_type: "place", geoid_compact: "4805000", name: "Austin city, Texas" },
  body_key: "TX:AUSTIN:CC",
  seat_name_template: "Austin City Council District {seat}",
  boundary_vintage: "2021 redistricting (2020 census)",
  eligibility_source_url: "https://www.austintexas.gov/department/city-council",
  review_note: "Official single-member district layer from the City of Austin; each district's voters elect its member.",
  source: { kind: "arcgis", url: "https://gis.example.gov/arcgis/rest/services/Council/FeatureServer/0", seat_field: "DISTRICT" },
  seats: [{ seat: "1", source_value: "1" }, { seat: "2", source_value: "2" }, { seat: "10", source_value: "10" }],
  expected_source_sha256: null,
  ...overrides,
});

const featureCollection = (values: string[]) => ({
  type: "FeatureCollection",
  features: values.map((value, index) => ({
    type: "Feature",
    properties: { DISTRICT: Number(value), OBJECTID: index },
    geometry: square(index),
  })),
});

const fetchOk = (body: unknown) => vi.fn(async () => ({ ok: true, status: 200, json: async () => body }));

describe("ward boundary payload", () => {
  it("parses seats, keys and names", () => {
    const parsed = parseWardBoundaryImport(payload());
    expect(parsed.seats).toEqual([
      { seat: "1", source_values: ["1"] },
      { seat: "2", source_values: ["2"] },
      { seat: "10", source_values: ["10"] },
    ]);
    expect(parsed.source.match).toEqual({ field: "DISTRICT", values: ["1", "2", "10"] });
    expect(parsed.edge_margin_meters).toBe(25);
    expect(parsed.from_election_date).toBe("2026-11-01");
    expect(wardDistrictKey(parsed.body_key, "10")).toBe("TX:AUSTIN:CC:10");
    expect(wardDistrictName(parsed.seat_name_template, "10")).toBe("Austin City Council District 10");
  });

  it("combines several source values into one seat as a dissolved layer", () => {
    const parsed = parseWardBoundaryImport(payload({
      seats: [{ seat: "1", source_values: ["1", "2"] }, { seat: "2", source_value: "3" }],
    }));
    expect(parsed.source.dissolve).toBe(true);
    expect(parsed.source.match.values).toEqual(["1", "2", "3"]);
  });

  it("rejects a non-government eligibility host unless flagged as the official site", () => {
    expect(() => parseWardBoundaryImport(payload({ eligibility_source_url: "https://www.tulsacouncil.org/about" })))
      .toThrow("eligibility_source_url");
    expect(parseWardBoundaryImport(payload({
      eligibility_source_url: "https://www.tulsacouncil.org/about",
      eligibility_source_is_official_site: true,
    })).eligibility_source_url).toBe("https://www.tulsacouncil.org/about");
  });

  it("rejects malformed keys, seats and margins", () => {
    expect(() => parseWardBoundaryImport(payload({ body_key: "CA:AUSTIN:CC" }))).toThrow("start with the state code");
    expect(() => parseWardBoundaryImport(payload({ seats: [{ seat: "W2", source_value: "2" }] }))).toThrow("seats[0].seat");
    expect(() => parseWardBoundaryImport(payload({ seats: [{ seat: "1", source_value: "1" }, { seat: "1", source_value: "2" }] })))
      .toThrow("repeat a seat label");
    expect(() => parseWardBoundaryImport(payload({ edge_margin_meters: 30 }))).toThrow("edge_margin_meters");
    expect(() => parseWardBoundaryImport(payload({ seat_name_template: "Austin City Council District" }))).toThrow("{seat}");
  });
});

describe("seat matching", () => {
  it("reads only the exact seat, with leading zeros and letters", () => {
    expect(seatPattern("1").test("City Council Member District 1")).toBe(true);
    expect(seatPattern("1").test("City Council Member District 10")).toBe(false);
    expect(seatPattern("1").test("Board of Education Member, District 1A")).toBe(false);
    expect(seatPattern("1A").test("Board of Education Member, District 1A")).toBe(true);
    expect(seatPattern("1").test("Wake Board of Education District 01")).toBe(true);
    expect(seatPattern("2").test("Las Vegas City Council, Ward 2")).toBe(true);
    expect(seatPattern("3").test("Governing Board Member, Trustee Area 3")).toBe(true);
    expect(seatPattern("11").test("Independent School District No. 11 Board Member")).toBe(false);
  });

  it("leaves at-large titles and unrelated titles alone", () => {
    const seats = [{ seat: "3", source_values: ["3"] }, { seat: "5", source_values: ["5"] }];
    expect(matchSeat("School Board Member District 3 - At Large", seats)).toBeNull();
    expect(matchSeat("Mayor", seats)).toBeNull();
    expect(matchSeat("City Council Member District 5", seats)?.seat).toBe("5");
    expect(() => matchSeat("Justice of the Peace Ward 3, District 5", seats)).toThrow("more than one seat");
  });
});

describe("ward layer fetch", () => {
  it("builds one boundary per seat and a layer hash", async () => {
    const parsed = parseWardBoundaryImport(payload());
    const layer = await fetchWardLayer(parsed, fetchOk(featureCollection(["1", "2", "10"])));
    expect(layer.boundaries.map((entry) => entry.district_key)).toEqual(["TX:AUSTIN:CC:1", "TX:AUSTIN:CC:2", "TX:AUSTIN:CC:10"]);
    expect(layer.boundaries[0]?.geometry).toEqual(square(0));
    expect(layer.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(layer.sourceUrl).toContain("DISTRICT+IN+%28%271%27%2C%272%27%2C%2710%27%29");
  });

  it("retries with bare numbers when the server rejects quoted values", async () => {
    const parsed = parseWardBoundaryImport(payload());
    const fetchImpl = vi.fn(async (url: URL) => ({
      ok: true,
      status: 200,
      json: async () => (url.searchParams.get("where")?.includes("'")
        ? { error: { code: 400, message: "Failed to execute query." } }
        : featureCollection(["1", "2", "10"])),
    }));
    const layer = await fetchWardLayer(parsed, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(layer.sourceUrl).toContain("DISTRICT+IN+%281%2C2%2C10%29");
    expect(layer.boundaries).toHaveLength(3);
  });

  it("refuses a layer missing a seat", async () => {
    const parsed = parseWardBoundaryImport(payload());
    await expect(fetchWardLayer(parsed, fetchOk(featureCollection(["1", "2"])))).rejects.toThrow("missing: 10");
  });
});

type Call = { sql: string; params: unknown[] };

function fakeDb(options: { existingWard?: boolean; clash?: boolean } = {}) {
  const calls: Call[] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.includes("FROM public.districts WHERE district_type = $1")) return { rows: [{ id: "city-1", name: "Austin city, Texas" }] };
    if (sql.includes("WHERE district_id = $1 AND race_type = 'office'")) {
      return { rows: [
        { id: "e1", official_ballot_title: "City Council Member District 1", official_ballot_title_key: "city council member district 1", election_date: "2026-11-03", race_type: "office" },
        { id: "e10", official_ballot_title: "City Council Member District 10", official_ballot_title_key: "city council member district 10", election_date: "2026-11-03", race_type: "office" },
        { id: "m", official_ballot_title: "Mayor", official_ballot_title_key: "mayor", election_date: "2026-11-03", race_type: "office" },
      ] };
    }
    if (sql.startsWith("INSERT INTO public.districts")) {
      return options.existingWard ? { rows: [] } : { rows: [{ id: `ward-${String(params[0])}` }] };
    }
    if (sql.includes("AS has_boundary")) return { rows: [{ id: `ward-${String(params[0])}`, has_boundary: true }] };
    if (sql.includes("FROM public.elections WHERE id = $1 AND district_id = $2")) {
      const id = String(params[0]);
      return { rows: [{ id, official_ballot_title: `City Council Member District ${id.slice(1)}`, official_ballot_title_key: `city council member district ${id.slice(1)}`, election_date: "2026-11-03", race_type: "office" }] };
    }
    if (sql.includes("official_ballot_title_key = $2 AND election_date")) return { rows: options.clash ? [{ id: "dup" }] : [] };
    if (sql.startsWith("DELETE FROM public.manual_research_deferrals")) {
      return { rows: String(params[0]) === "e1" ? [{ id: "d1", district_id: "city-1", election_id: "e1", stage: "roster", reason: "x" }] : [] };
    }
    if (sql.includes("INSERT INTO public.retired_election_identities")) return { rows: [{ id: "r" }] };
    return { rows: [] };
  });
  return { query, calls };
}

describe("ward election plan and import", () => {
  it("maps each jurisdiction-row election to its seat and reports uncovered designators", async () => {
    const parsed = parseWardBoundaryImport(payload({ seats: [{ seat: "1", source_value: "1" }, { seat: "2", source_value: "2" }] }));
    const db = fakeDb();
    const plan = await planWardElections(db, parsed);
    expect(plan.jurisdiction_district_id).toBe("city-1");
    expect(plan.seats.find((entry) => entry.seat === "1")?.elections.map((election) => election.id)).toEqual(["e1"]);
    expect(plan.seats.find((entry) => entry.seat === "2")?.elections).toEqual([]);
    expect(plan.unmatched.map((entry) => entry.id)).toEqual(["e10"]);
    await expect(importWardBoundaries(db, { ...parsed, expected_source_sha256: "a".repeat(64) },
      { sourceUrl: "u", sourceSha256: "a".repeat(64), boundaries: [] }, plan)).rejects.toThrow("does not list");
  });

  it("writes districts and boundaries, moves elections with their deferrals, and records the old identity", async () => {
    const parsed = parseWardBoundaryImport(payload());
    const layer = await fetchWardLayer(parsed, fetchOk(featureCollection(["1", "2", "10"])));
    const db = fakeDb();
    const plan = await planWardElections(db, parsed);
    expect(plan.unmatched).toEqual([]);
    const result = await importWardBoundaries(db, { ...parsed, expected_source_sha256: layer.sourceSha256 }, layer, plan);
    expect(result).toEqual({ districts_inserted: 3, boundaries_attached: 0, boundaries_skipped: 0, elections_moved: 2 });
    const sqls = db.calls.map((call) => call.sql);
    expect(sqls).toContain("BEGIN");
    expect(sqls[sqls.length - 1]).toBe("COMMIT");
    expect(sqls.filter((sql) => sql.includes("INSERT INTO public.local_special_boundaries"))).toHaveLength(3);
    const boundary = db.calls.find((call) => call.sql.includes("INSERT INTO public.local_special_boundaries"));
    expect(boundary?.params[0]).toBe("ward-TX:AUSTIN:CC:1");
    expect(boundary?.sql).toContain("'verified'");
    expect(boundary?.params[7]).toBe(25);
    const moves = db.calls.filter((call) => call.sql.startsWith("UPDATE public.elections SET district_id"));
    expect(moves.map((call) => call.params)).toEqual([["ward-TX:AUSTIN:CC:1", "e1"], ["ward-TX:AUSTIN:CC:10", "e10"]]);
    const deferral = db.calls.find((call) => call.sql.startsWith("INSERT INTO public.manual_research_deferrals"));
    expect(deferral?.params).toEqual(["d1", "e1", "roster", "x", "ward-TX:AUSTIN:CC:1"]);
    const ledger = db.calls.filter((call) => call.sql.includes("INSERT INTO public.retired_election_identities"));
    expect(ledger).toHaveLength(2);
    expect(ledger[0]?.params.slice(0, 3)).toEqual(["city-1", "2026-11-03", "city council member district 1"]);
    expect(ledger[0]?.params[6]).toBe("superseded");
  });

  it("keeps an existing reviewed boundary but still moves the seat's elections", async () => {
    const parsed = parseWardBoundaryImport(payload());
    const layer = await fetchWardLayer(parsed, fetchOk(featureCollection(["1", "2", "10"])));
    const db = fakeDb({ existingWard: true });
    const plan = await planWardElections(db, parsed);
    const result = await importWardBoundaries(db, { ...parsed, expected_source_sha256: layer.sourceSha256 }, layer, plan);
    expect(result).toEqual({ districts_inserted: 0, boundaries_attached: 0, boundaries_skipped: 3, elections_moved: 2 });
    expect(db.calls.some((call) => call.sql.includes("INSERT INTO public.local_special_boundaries"))).toBe(false);
  });

  it("rolls back on a stale hash or a title already on the ward row", async () => {
    const parsed = parseWardBoundaryImport(payload());
    const layer = await fetchWardLayer(parsed, fetchOk(featureCollection(["1", "2", "10"])));
    const stale = fakeDb();
    const plan = await planWardElections(stale, parsed);
    await expect(importWardBoundaries(stale, { ...parsed, expected_source_sha256: "b".repeat(64) }, layer, plan))
      .rejects.toThrow("changed since review");
    const clash = fakeDb({ clash: true });
    await expect(importWardBoundaries(clash, { ...parsed, expected_source_sha256: layer.sourceSha256 }, layer, await planWardElections(clash, parsed)))
      .rejects.toThrow("already carries");
    expect(clash.calls.map((call) => call.sql)).toContain("ROLLBACK");
  });
});
