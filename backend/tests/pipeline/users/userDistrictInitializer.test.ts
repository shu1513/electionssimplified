import { describe, expect, it, vi } from "vitest";

import {
  initializeUserDistricts,
  InitializeUserDistrictsError,
  MAX_INITIALIZE_DISTRICT_IDS,
} from "../../../src/pipeline/users/userDistrictInitializer.js";

const userId = "11111111-1111-4111-8111-111111111111";
const districtIdA = "22222222-2222-4222-8222-222222222222";
const districtIdB = "33333333-3333-4333-8333-333333333333";

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

function expectInitializerError(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(InitializeUserDistrictsError);
  expect((error as InitializeUserDistrictsError).code).toBe(code);
}

function makeDistrictId(index: number): string {
  return `22222222-2222-4222-8222-${index.toString().padStart(12, "0")}`;
}

describe("initializeUserDistricts", () => {
  it("rejects invalid user IDs before opening a database connection", async () => {
    const { db } = createMockDb();

    await expect(initializeUserDistricts(db, "not-a-uuid", [districtIdA])).rejects.toSatisfy((error) => {
      expectInitializerError(error, "invalid_user_id");
      return true;
    });
    expect(db.connect).not.toHaveBeenCalled();
  });

  it("rejects empty district IDs before opening a database connection", async () => {
    const { db } = createMockDb();

    await expect(initializeUserDistricts(db, userId, ["  "])).rejects.toSatisfy((error) => {
      expectInitializerError(error, "invalid_district_ids");
      return true;
    });
    expect(db.connect).not.toHaveBeenCalled();
  });

  it("rejects too many district IDs before opening a database connection", async () => {
    const { db } = createMockDb();
    const districtIds = Array.from({ length: MAX_INITIALIZE_DISTRICT_IDS + 1 }, (_value, index) =>
      makeDistrictId(index + 1)
    );

    await expect(initializeUserDistricts(db, userId, districtIds)).rejects.toSatisfy((error) => {
      expectInitializerError(error, "invalid_district_ids");
      return true;
    });
    expect(db.connect).not.toHaveBeenCalled();
  });

  it("locks the user row and initializes first-time user districts from public.districts", async () => {
    const { db, client } = createMockDb();
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: userId }] })
      .mockResolvedValueOnce({ rows: [{ district_count: "0" }] })
      .mockResolvedValueOnce({ rows: [{ found_count: "2", inserted_count: "2" }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await initializeUserDistricts(db, userId, [districtIdA, districtIdB]);

    expect(result).toEqual({
      status: "initialized",
      districtCount: 2,
    });
    expect(client.query).toHaveBeenCalledTimes(5);
    expect(client.query.mock.calls[0]?.[0]).toBe("BEGIN");
    expect(client.query.mock.calls[1]?.[0]).toContain("FOR UPDATE");
    expect(client.query.mock.calls[1]?.[1]).toEqual([userId]);
    expect(client.query.mock.calls[3]?.[0]).toContain("INSERT INTO public.user_districts");
    expect(client.query.mock.calls[3]?.[0]).toContain("found.district_type");
    expect(client.query.mock.calls[3]?.[1]).toEqual([userId, [districtIdA, districtIdB]]);
    expect(client.query.mock.calls[4]?.[0]).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("dedupes duplicate district IDs before inserting", async () => {
    const { db, client } = createMockDb();
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: userId }] })
      .mockResolvedValueOnce({ rows: [{ district_count: 0 }] })
      .mockResolvedValueOnce({ rows: [{ found_count: 1, inserted_count: 1 }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await initializeUserDistricts(db, userId, [districtIdA, districtIdA.toUpperCase()]);

    expect(result).toEqual({
      status: "initialized",
      districtCount: 1,
    });
    expect(client.query.mock.calls[3]?.[1]).toEqual([userId, [districtIdA]]);
  });

  it("returns already_initialized without changing existing saved districts", async () => {
    const { db, client } = createMockDb();
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: userId }] })
      .mockResolvedValueOnce({ rows: [{ district_count: "7" }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await initializeUserDistricts(db, userId, [districtIdA, districtIdB]);

    expect(result).toEqual({
      status: "already_initialized",
      districtCount: 7,
    });
    expect(client.query).toHaveBeenCalledTimes(4);
    expect(client.query.mock.calls.some((call) => String(call[0]).includes("INSERT INTO public.user_districts"))).toBe(
      false
    );
    expect(client.query.mock.calls[3]?.[0]).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rolls back when the user does not exist", async () => {
    const { db, client } = createMockDb();
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(initializeUserDistricts(db, userId, [districtIdA])).rejects.toSatisfy((error) => {
      expectInitializerError(error, "user_not_found");
      return true;
    });
    expect(client.query.mock.calls[2]?.[0]).toBe("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rolls back and reports unknown district IDs", async () => {
    const { db, client } = createMockDb();
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: userId }] })
      .mockResolvedValueOnce({ rows: [{ district_count: 0 }] })
      .mockResolvedValueOnce({ rows: [{ found_count: 1, inserted_count: 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: districtIdA }] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(initializeUserDistricts(db, userId, [districtIdA, districtIdB])).rejects.toSatisfy((error) => {
      expectInitializerError(error, "unknown_district_ids");
      expect((error as InitializeUserDistrictsError).details.unknownDistrictIds).toEqual([districtIdB]);
      return true;
    });
    expect(client.query.mock.calls[4]?.[0]).toContain("WHERE id = ANY");
    expect(client.query.mock.calls[5]?.[0]).toBe("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
  });
});
