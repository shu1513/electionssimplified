import { describe, expect, it, vi } from "vitest";

import { getAlabamaCommitteeRegistry } from "../../../src/pipeline/alabamaFinance/alabamaFcpaClient.js";

const pcc = { id: 206, committeeId: "25079", candidateFirstName: "THOMAS", candidateLastName: "JACKSON", committeeStatus: "Active" };
const pac = { id: 33, committeeId: "24906", committeeName: "Electric Cooperatives of Alabama PAC", committeeStatus: "Active" };

function response(totalRecords: number, list: unknown[]): Response {
  return new Response(JSON.stringify({ success: true, data: { totalRecords, list } }));
}

function source(overrides?: (type: string, page: number) => Response | undefined) {
  return vi.fn(async (url: string) => {
    const params = new URL(url).searchParams;
    const criteria = JSON.parse(params.get("criteria")!);
    expect(criteria).toHaveLength(1);
    expect(criteria[0]).toMatchObject({ field_key: "committeeType", comparison_type: "equalTo" });
    expect(params.has("committeeStatus")).toBe(false);
    const type = criteria[0].comparison_value_1 as string;
    const page = Number(params.get("pageNumber"));
    return overrides?.(type, page) ?? response(1, [type === "1" ? pcc : pac]);
  });
}

describe("complete Alabama committee registry", () => {
  it("fetches both legal types without a status filter and retains distinct internal/public IDs", async () => {
    const fetchImpl = source();
    const rows = await getAlabamaCommitteeRegistry({ fetchImpl: fetchImpl as never });
    expect(rows).toEqual([{ ...pcc, committeeType: "1" }, { ...pac, committeeType: "2" }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retains dissolved committees for all-types identity ambiguity checks", async () => {
    const fetchImpl = source((type) => type === "2" ? response(1, [{ ...pac, committeeStatus: "Dissolved" }]) : undefined);
    expect((await getAlabamaCommitteeRegistry({ fetchImpl: fetchImpl as never }))[1]?.committeeStatus).toBe("Dissolved");
  });

  it("accepts only source-identical duplicate registry rows without changing advertised raw coverage", async () => {
    const fetchImpl = source((type) => type === "2" ? response(2, [pac, Object.fromEntries(Object.entries(pac).reverse())]) : undefined);
    expect(await getAlabamaCommitteeRegistry({ fetchImpl: fetchImpl as never })).toHaveLength(2);
  });

  it("keeps paging after a short page until exact advertised coverage", async () => {
    const fetchImpl = source((type, page) => type === "2" ? response(2, [page === 1 ? pac : { ...pac, id: 34, committeeId: "24907" }]) : undefined);
    expect(await getAlabamaCommitteeRegistry({ fetchImpl: fetchImpl as never })).toHaveLength(3);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("rejects even a one-row shortfall instead of inheriting tolerant filings paging", async () => {
    const fetchImpl = source((type, page) => type === "2" ? response(2, page === 1 ? [pac] : []) : undefined);
    await expect(getAlabamaCommitteeRegistry({ fetchImpl: fetchImpl as never })).rejects.toThrow("returned 1 of 2 rows");
  });

  it("rejects changing advertised counts", async () => {
    const fetchImpl = source((type, page) => type === "2" ? response(page === 1 ? 2 : 3, [pac]) : undefined);
    await expect(getAlabamaCommitteeRegistry({ fetchImpl: fetchImpl as never })).rejects.toThrow("totalRecords changed");
  });

  it("rejects a repeated page rather than treating duplicates as missing identities", async () => {
    const fetchImpl = source((type) => type === "2" ? response(2, [pac]) : undefined);
    await expect(getAlabamaCommitteeRegistry({ fetchImpl: fetchImpl as never })).rejects.toThrow("repeated a page");
  });

  it.each([
    { ...pac, committeeName: "Renamed PAC" },
    { ...pac, committeeStatus: "Dissolved" },
    { ...pac, committeeId: "24907" },
    { ...pac, id: 34 },
  ])("rejects conflicting metadata or either identity namespace: %j", async (conflict) => {
    const fetchImpl = source((type) => type === "2" ? response(2, [pac, conflict]) : undefined);
    await expect(getAlabamaCommitteeRegistry({ fetchImpl: fetchImpl as never })).rejects.toThrow("conflicting committee identities");
  });

  it("rejects identity reuse across legal types", async () => {
    const fetchImpl = source((type) => type === "2" ? response(1, [pcc]) : undefined);
    await expect(getAlabamaCommitteeRegistry({ fetchImpl: fetchImpl as never })).rejects.toThrow("conflicting committee identities");
  });

  it.each([
    { ...pac, id: 0 }, { ...pac, id: 1.5 }, { ...pac, id: "33" },
    { ...pac, committeeId: "024906" }, { ...pac, committeeId: "9007199254740992" },
    { ...pac, committeeName: 9 }, { ...pac, committeeType: "1" }, null,
  ])("rejects malformed identity row: %j", async (invalid) => {
    const fetchImpl = source((type) => type === "2" ? response(1, [invalid]) : undefined);
    await expect(getAlabamaCommitteeRegistry({ fetchImpl: fetchImpl as never })).rejects.toThrow("invalid committee identity");
  });

  it.each([-1, 1.5])("rejects invalid advertised count %s", async (count) => {
    const fetchImpl = source((type) => type === "2" ? response(count, []) : undefined);
    await expect(getAlabamaCommitteeRegistry({ fetchImpl: fetchImpl as never })).rejects.toThrow("invalid totalRecords");
  });

  it("rejects excess rows and nonempty zero-count responses", async () => {
    const fetchImpl = source((type) => type === "2" ? response(0, [pac]) : undefined);
    await expect(getAlabamaCommitteeRegistry({ fetchImpl: fetchImpl as never })).rejects.toThrow("advertised row count");
  });

  it("accepts authoritative empty registries for both types", async () => {
    const fetchImpl = source(() => response(0, []));
    expect(await getAlabamaCommitteeRegistry({ fetchImpl: fetchImpl as never })).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
