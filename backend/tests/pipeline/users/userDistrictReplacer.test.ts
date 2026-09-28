import { describe, expect, it, vi } from "vitest";

import {
  replaceUserDistricts,
  ReplaceUserDistrictsError,
  MAX_INITIALIZE_DISTRICT_IDS,
} from "../../../src/pipeline/users/userDistrictReplacer.js";

const userId = "11111111-1111-4111-8111-111111111111";
const districtIdA = "22222222-2222-4222-8222-222222222222";
const districtIdB = "33333333-3333-4333-8333-333333333333";
const districtIdC = "44444444-4444-4444-8444-444444444444";

function createMockDb() {
  const client = {
    query: vi.fn(),
    release: vi.fn(),
  };
  const db = {
    connect: vi.fn().mockResolvedValue(client),
  };
  return { db, client };
}

function expectReplacerError(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(ReplaceUserDistrictsError);
  expect((error as ReplaceUserDistrictsError).code).toBe(code);
}

function makeDistrictId(index: number): string {
  return `22222222-2222-4222-8222-${index.toString().padStart(12, "0")}`;
}

describe("replaceUserDistricts", () => {
  it("rejects invalid user IDs before opening a database connection", async () => {
    const { db } = createMockDb();

    await expect(replaceUserDistricts(db, "not-a-uuid", [districtIdA])).rejects.toSatisfy((error) => {
      expectReplacerError(error, "invalid_user_id");
      return true;
    });
    expect(db.connect).not.toHaveBeenCalled();
  });

  it("rejects empty district IDs before opening a database connection", async () => {
    const { db } = createMockDb();

    await expect(replaceUserDistricts(db, userId, ["  "])).rejects.toSatisfy((error) => {
      expectReplacerError(error, "invalid_district_ids");
      return true;
    });
    expect(db.connect).not.toHaveBeenCalled();
  });

  it("rejects too many district IDs before opening a database connection", async () => {
    const { db } = createMockDb();
    const districtIds = Array.from({ length: MAX_INITIALIZE_DISTRICT_IDS + 1 }, (_value, index) =>
      makeDistrictId(index + 1)
    );

    await expect(replaceUserDistricts(db, userId, districtIds)).rejects.toSatisfy((error) => {
      expectReplacerError(error, "invalid_district_ids");
      return true;
    });
    expect(db.connect).not.toHaveBeenCalled();
  });

  it("locks the user row, validates districts, then replaces saved districts", async () => {
    const { db, client } = createMockDb();
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: userId }] })
      .mockResolvedValueOnce({
        rows: [
          { id: districtIdA, district_type: "county" },
          { id: districtIdB, district_type: "us_house" },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await replaceUserDistricts(db, userId, [districtIdA, districtIdB]);

    expect(result).toEqual({ districtCount: 2 });
    expect(client.query).toHaveBeenCalledTimes(6);
    expect(client.query.mock.calls[0]?.[0]).toBe("BEGIN");
    expect(client.query.mock.calls[1]?.[0]).toContain("FOR UPDATE");
    expect(client.query.mock.calls[1]?.[1]).toEqual([userId]);
    expect(client.query.mock.calls[2]?.[0]).toContain("JOIN public.districts AS d");
    expect(client.query.mock.calls[2]?.[1]).toEqual([[districtIdA, districtIdB]]);
    expect(client.query.mock.calls[3]?.[0]).toContain("DELETE FROM public.user_districts");
    expect(client.query.mock.calls[3]?.[1]).toEqual([userId]);
    expect(client.query.mock.calls[4]?.[0]).toContain("INSERT INTO public.user_districts");
    expect(client.query.mock.calls[4]?.[1]).toEqual([userId, [districtIdA, districtIdB], ["county", "us_house"]]);
    expect(client.query.mock.calls[5]?.[0]).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("replaces districts without requiring the user to have prior saved districts", async () => {
    const { db, client } = createMockDb();
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: userId }] })
      .mockResolvedValueOnce({ rows: [{ id: districtIdA, district_type: "county" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await replaceUserDistricts(db, userId, [districtIdA]);

    expect(result).toEqual({ districtCount: 1 });
    expect(client.query.mock.calls.some((call) => String(call[0]).includes("COUNT(*) AS district_count"))).toBe(false);
    expect(client.query.mock.calls[3]?.[0]).toContain("DELETE FROM public.user_districts");
    expect(client.query.mock.calls[4]?.[0]).toContain("INSERT INTO public.user_districts");
    expect(client.query.mock.calls[5]?.[0]).toBe("COMMIT");
  });

  it("dedupes duplicate district IDs before replacing", async () => {
    const { db, client } = createMockDb();
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: userId }] })
      .mockResolvedValueOnce({ rows: [{ id: districtIdA, district_type: "county" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await replaceUserDistricts(db, userId, [districtIdA, districtIdA.toUpperCase()]);

    expect(result).toEqual({ districtCount: 1 });
    expect(client.query.mock.calls[2]?.[1]).toEqual([[districtIdA]]);
    expect(client.query.mock.calls[4]?.[1]).toEqual([userId, [districtIdA], ["county"]]);
  });

  it("rolls back without deleting old districts when the user does not exist", async () => {
    const { db, client } = createMockDb();
    client.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });

    await expect(replaceUserDistricts(db, userId, [districtIdA])).rejects.toSatisfy((error) => {
      expectReplacerError(error, "user_not_found");
      return true;
    });
    expect(client.query.mock.calls[2]?.[0]).toBe("ROLLBACK");
    expect(client.query.mock.calls.some((call) => String(call[0]).includes("DELETE FROM public.user_districts"))).toBe(
      false
    );
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rolls back without deleting old districts when any replacement district is unknown", async () => {
    const { db, client } = createMockDb();
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: userId }] })
      .mockResolvedValueOnce({ rows: [{ id: districtIdA, district_type: "county" }] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(replaceUserDistricts(db, userId, [districtIdA, districtIdC])).rejects.toSatisfy((error) => {
      expectReplacerError(error, "unknown_district_ids");
      expect((error as ReplaceUserDistrictsError).details.unknownDistrictIds).toEqual([districtIdC]);
      return true;
    });
    expect(client.query.mock.calls[3]?.[0]).toBe("ROLLBACK");
    expect(client.query.mock.calls.some((call) => String(call[0]).includes("DELETE FROM public.user_districts"))).toBe(
      false
    );
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rolls back if inserting replacement districts fails", async () => {
    const { db, client } = createMockDb();
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: userId }] })
      .mockResolvedValueOnce({ rows: [{ id: districtIdA, district_type: "county" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error("insert failed"))
      .mockResolvedValueOnce({ rows: [] });

    await expect(replaceUserDistricts(db, userId, [districtIdA])).rejects.toThrow("insert failed");
    expect(client.query.mock.calls[3]?.[0]).toContain("DELETE FROM public.user_districts");
    expect(client.query.mock.calls[5]?.[0]).toBe("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
  });
});
