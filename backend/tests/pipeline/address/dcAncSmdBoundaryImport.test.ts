import { describe, expect, it, vi } from "vitest";

import {
  DC_SMD_COUNT,
  DC_SMD_EDGE_MARGIN_METERS,
  dcSmdDistrictKey,
  dcSmdDistrictName,
  dcSmdLayerSha256,
  fetchDcSmdLayer,
  insertDcSmdBoundaries,
  parseDcSmdFeatures,
} from "../../../src/pipeline/address/dcAncSmdBoundaryImport.js";

const square = (index: number) => {
  const lon = -77.1 + index * 0.0002;
  return {
    type: "Polygon",
    coordinates: [[[lon, 38.9], [lon + 0.0001, 38.9], [lon + 0.0001, 38.9001], [lon, 38.9001], [lon, 38.9]]],
  };
};

// 345 distinct SMD codes, including the Ward 3/4 commission.
function smdIds(): string[] {
  const ids = ["3/4G01", "3/4G02"];
  for (let ward = 1; ids.length < DC_SMD_COUNT; ward = (ward % 8) + 1) {
    for (const letter of "ABCDEFG") {
      for (let seat = 1; seat <= 9 && ids.length < DC_SMD_COUNT; seat += 1) {
        const id = `${ward}${letter}${String(seat).padStart(2, "0")}`;
        if (!ids.includes(id)) ids.push(id);
      }
    }
  }
  return ids;
}

function features(ids = smdIds(), extra: Record<string, unknown> = {}) {
  return ids.map((id, index) => ({
    type: "Feature",
    properties: { SMD_ID: id, ANC_ID: id.slice(0, -2), ...extra },
    geometry: square(index),
  }));
}

describe("DC ANC single-member district import", () => {
  it("builds district keys and names from SMD codes", () => {
    expect(dcSmdDistrictKey("1A01")).toBe("DC:ANC:1A01");
    expect(dcSmdDistrictKey("3/4G01")).toBe("DC:ANC:3-4G01");
    expect(dcSmdDistrictName("6B04")).toBe("Advisory Neighborhood Commission 6B Single Member District 6B04");
    expect(dcSmdDistrictName("3/4G01")).toBe("Advisory Neighborhood Commission 3/4G Single Member District 3/4G01");
  });

  it("accepts exactly the expected SMD set, sorted by code", () => {
    const boundaries = parseDcSmdFeatures(features());
    expect(boundaries).toHaveLength(DC_SMD_COUNT);
    expect(boundaries[0]?.smd_id).toBe("1A01");
    expect(boundaries.find((entry) => entry.smd_id === "3/4G01")?.anc_id).toBe("3/4G");
    expect(boundaries.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256))).toBe(true);
  });

  it("rejects a partial, duplicated, or malformed layer", () => {
    const ids = smdIds();
    expect(() => parseDcSmdFeatures(features(ids.slice(1)))).toThrow("expected 345");
    expect(() => parseDcSmdFeatures(features([...ids.slice(1), ids[2] as string]))).toThrow("twice");
    expect(() => parseDcSmdFeatures(features([...ids.slice(1), "9A01"]))).toThrow("unreadable SMD_ID");
    const misfiled = features();
    (misfiled[5]!.properties as Record<string, unknown>).ANC_ID = "8F";
    expect(() => parseDcSmdFeatures(misfiled)).toThrow("is listed under ANC 8F");
    const broken = features();
    broken[3]!.geometry = { type: "Polygon", coordinates: [] } as never;
    expect(() => parseDcSmdFeatures(broken)).toThrow("unusable geometry");
  });

  it("hashes only the code and geometry, not the sitting commissioner", () => {
    const a = parseDcSmdFeatures(features(smdIds(), { REP_NAME: "A", EDITED: 1 }));
    const b = parseDcSmdFeatures(features(smdIds(), { REP_NAME: "B", EDITED: 2 }));
    expect(dcSmdLayerSha256(a)).toBe(dcSmdLayerSha256(b));
    const moved = features();
    moved[0]!.geometry = square(999);
    expect(dcSmdLayerSha256(parseDcSmdFeatures(moved))).not.toBe(dcSmdLayerSha256(a));
  });

  it("follows ArcGIS paging and asks only for identity fields", async () => {
    const all = features();
    const fetchImpl = vi.fn(async (url: URL) => {
      const offset = Number(url.searchParams.get("resultOffset") ?? 0);
      const page = all.slice(offset, offset + 200);
      return {
        ok: true,
        status: 200,
        json: async () => ({ type: "FeatureCollection", features: page, exceededTransferLimit: offset + 200 < all.length }),
      };
    });
    const layer = await fetchDcSmdLayer(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[0].searchParams.get("outFields")).toBe("SMD_ID,ANC_ID");
    expect(fetchImpl.mock.calls[1]?.[0].searchParams.get("resultOffset")).toBe("200");
    expect(layer.boundaries).toHaveLength(DC_SMD_COUNT);
    expect(layer.sourceSha256).toBe(dcSmdLayerSha256(layer.boundaries));
  });

  it("fails on an HTTP error", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    await expect(fetchDcSmdLayer(fetchImpl)).rejects.toThrow("HTTP 503");
  });

  describe("insert", () => {
    const layer = () => {
      const boundaries = parseDcSmdFeatures(features());
      return { sourceUrl: "https://example.test/layer", sourceSha256: dcSmdLayerSha256(boundaries), boundaries };
    };

    // New rows insert; "1A02" exists as a shell with no boundary; "1A03"
    // already has its boundary.
    const fakeDb = () => vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("INSERT INTO public.districts")) {
        const key = params[0];
        return { rows: key === "DC:ANC:1A02" || key === "DC:ANC:1A03" ? [] : [{ id: `id-${String(key)}` }] };
      }
      if (sql.includes("FROM public.districts AS district")) {
        return { rows: [{ id: `shell-${String(params[0])}`, has_boundary: params[0] === "DC:ANC:1A03" }] };
      }
      return { rows: [] };
    });

    it("refuses a layer that changed since review", async () => {
      const query = fakeDb();
      await expect(insertDcSmdBoundaries({ query } as never, layer(), "0".repeat(64))).rejects.toThrow("changed since review");
      expect(query).not.toHaveBeenCalled();
    });

    it("inserts new SMDs, attaches shells, and skips loaded ones in one transaction", async () => {
      const query = fakeDb();
      const source = layer();
      const result = await insertDcSmdBoundaries({ query } as never, source, source.sourceSha256);
      expect(result).toEqual({ inserted: DC_SMD_COUNT - 2, attached: 1, skipped: 1 });
      const sqls = query.mock.calls.map((call) => String(call[0]));
      expect(sqls[0]).toBe("BEGIN");
      expect(sqls[sqls.length - 1]).toBe("COMMIT");
      const boundaryInserts = query.mock.calls.filter((call) => String(call[0]).includes("local_special_boundaries\n"));
      expect(boundaryInserts).toHaveLength(DC_SMD_COUNT - 1);
      const shell = boundaryInserts.find((call) => call[1]?.[0] === "shell-DC:ANC:1A02");
      expect(shell?.[1]?.[7]).toBe(DC_SMD_EDGE_MARGIN_METERS);
      expect(String(shell?.[1]?.[6])).toContain("single-member district 1A02");
    });

    it("rolls back on a write error", async () => {
      const query = vi.fn(async (sql: string) => {
        if (sql.includes("local_special_boundaries\n")) throw new Error("constraint");
        return { rows: sql.includes("INSERT INTO public.districts") ? [{ id: "x" }] : [] };
      });
      const source = layer();
      await expect(insertDcSmdBoundaries({ query } as never, source, source.sourceSha256)).rejects.toThrow("constraint");
      expect(query.mock.calls.map((call) => call[0])).toContain("ROLLBACK");
    });
  });
});
