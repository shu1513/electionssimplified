import { describe, expect, it, vi } from "vitest";
import { getAlabamaCompleteCommitteeFilings, getAlabamaNativeContributionRows } from "../../../src/pipeline/alabamaFinance/alabamaFcpaClient.js";

const row = {
  TRANSACTIONID: 1871301, COMMITTEEID: 206, FILINGDATE: "10/02/2026",
  CONTRIBUTOR: "Electric Cooperatives of Alabama PAC", CITYSTATE: "Montgomery, AL", ZIP: "36124",
  CONTRIBUTIONTYPE: "Cash (Itemized)", DESCRIPTION: "", AMOUNT: 1500,
  TRANSACTIONDATE: "09/17/2026", RECIPIENTNAME: "THOMAS E ACTION JACKSON",
};
const input = { fcpaCommitteeNumber: "25079", internalCommitteeId: 206 };
const filing = { ID: 175978, DESCRIPTION: "September Monthly", PERIODBEGIN: "09/01/2026", PERIODEND: "09/30/2026", FILEDDATE: "10/02/2026 09:49 AM", AMENDED: "No" };
const response = (totalRecords: number, list: unknown[]) => new Response(JSON.stringify({ success: true, data: { totalRecords, list } }));

describe("Alabama authoritative native source client", () => {
  it.each([false, true])("uses the public request number and validates the internal receiving ID; PAC filter=%s", async (pacOnly) => {
    const fetchImpl = vi.fn(async (url: string) => {
      const params = new URL(url).searchParams;
      const criteria = JSON.parse(params.get("criteria")!);
      expect(criteria).toEqual([
        { field_key: "committeeId", comparison_type: "equalTo", comparison_value_1: "25079" },
        ...(pacOnly ? [{ field_key: "contributorType", comparison_type: "equalTo", comparison_value_1: "4" }] : []),
      ]);
      return response(1, [row]);
    });
    expect(await getAlabamaNativeContributionRows({ ...input, pacOnly }, { fetchImpl: fetchImpl as never })).toEqual([row]);
  });

  it("retains distinct IDs for equal gifts and all source metadata", async () => {
    const fetchImpl = vi.fn(async () => response(2, [row, { ...row, TRANSACTIONID: 1871302 }]));
    expect(await getAlabamaNativeContributionRows(input, { fetchImpl: fetchImpl as never })).toHaveLength(2);
  });

  it("retains source-omitted optional description and location fields without inventing values", async () => {
    const { DESCRIPTION: _description, CITYSTATE: _city, ZIP: _zip, ...historical } = row;
    const fetchImpl = vi.fn(async () => response(1, [historical]));
    expect(await getAlabamaNativeContributionRows(input, { fetchImpl: fetchImpl as never })).toEqual([historical]);
  });

  it("retains literal null for historical non-itemized cash in the full ledger", async () => {
    const historical = { ...row, CONTRIBUTOR: null, CONTRIBUTIONTYPE: "Cash (Non-Itemized)", TRANSACTIONDATE: "06/22/2018" };
    const fetchImpl = vi.fn(async () => response(1, [historical]));
    expect(await getAlabamaNativeContributionRows(input, { fetchImpl: fetchImpl as never })).toEqual([historical]);
  });

  it("rejects a nameless receipt in the source-typed PAC filter", async () => {
    const fetchImpl = vi.fn(async () => response(1, [{ ...row, CONTRIBUTOR: null, CONTRIBUTIONTYPE: "Cash (Non-Itemized)" }]));
    await expect(getAlabamaNativeContributionRows({ ...input, pacOnly: true }, { fetchImpl: fetchImpl as never })).rejects.toThrow("invalid or repeated identities");
  });

  it.each([
    { CONTRIBUTOR: null, CONTRIBUTIONTYPE: "Unknown" },
    { CONTRIBUTOR: null, CONTRIBUTIONTYPE: "In-Kind (Non-Itemized)" },
    { CONTRIBUTOR: undefined, CONTRIBUTIONTYPE: "Cash (Non-Itemized)" },
  ])("does not extend the observed null schema to other missing donor fields: %j", async (change) => {
    const fetchImpl = vi.fn(async () => response(1, [{ ...row, ...change }]));
    await expect(getAlabamaNativeContributionRows(input, { fetchImpl: fetchImpl as never })).rejects.toThrow("invalid or repeated identities");
  });

  it.each([
    { ...row, TRANSACTIONID: 0 }, { ...row, TRANSACTIONID: "1871301" },
    { ...row, COMMITTEEID: 25079 }, { ...row, AMOUNT: null },
    { ...row, CONTRIBUTOR: null }, { ...row, DESCRIPTION: 1 },
  ])("rejects malformed or mismatched receiving identities: %j", async (invalid) => {
    const fetchImpl = vi.fn(async () => response(1, [invalid]));
    await expect(getAlabamaNativeContributionRows(input, { fetchImpl: fetchImpl as never })).rejects.toThrow("invalid or repeated identities");
  });

  it("rejects repeated transaction IDs even for identical returned rows", async () => {
    const fetchImpl = vi.fn(async () => response(2, [row, row]));
    await expect(getAlabamaNativeContributionRows(input, { fetchImpl: fetchImpl as never })).rejects.toThrow("repeated identities");
  });

  it("rejects one missing native row instead of applying the legacy filing tolerance", async () => {
    const fetchImpl = vi.fn(async (url: string) => response(2, Number(new URL(url).searchParams.get("pageNumber")) === 1 ? [row] : []));
    await expect(getAlabamaNativeContributionRows(input, { fetchImpl: fetchImpl as never })).rejects.toThrow("returned 1 of 2 rows");
  });

  it("continues after a short page and rejects changing totalRecords", async () => {
    const fetchImpl = vi.fn(async (url: string) => response(Number(new URL(url).searchParams.get("pageNumber")) === 1 ? 2 : 3, [row]));
    await expect(getAlabamaNativeContributionRows(input, { fetchImpl: fetchImpl as never })).rejects.toThrow("totalRecords changed");
  });

  it.each([-1, 1.5, 0])("rejects invalid native coverage count %s", async (count) => {
    const fetchImpl = vi.fn(async () => response(count, [row]));
    await expect(getAlabamaNativeContributionRows(input, { fetchImpl: fetchImpl as never })).rejects.toThrow("invalid complete-list coverage");
  });

  it("accepts a complete zero-row native response", async () => {
    const fetchImpl = vi.fn(async () => response(0, []));
    expect(await getAlabamaNativeContributionRows(input, { fetchImpl: fetchImpl as never })).toEqual([]);
  });

  it.each([
    { ...input, fcpaCommitteeNumber: "0" }, { ...input, fcpaCommitteeNumber: "025079" },
    { ...input, internalCommitteeId: 0 },
  ])("rejects invalid request before fetch: %j", async (invalid) => {
    const fetchImpl = vi.fn();
    await expect(getAlabamaNativeContributionRows(invalid, { fetchImpl })).rejects.toThrow("Invalid Alabama receipt committee identity");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("acquires complete current filings using only the internal recipient namespace", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(new URL(url).searchParams.get("committeeId")).toBe("206");
      return response(1, [filing]);
    });
    expect(await getAlabamaCompleteCommitteeFilings(206, { fetchImpl: fetchImpl as never })).toEqual([filing]);
  });

  it("rejects short current filing manifests", async () => {
    const fetchImpl = vi.fn(async (url: string) => response(2, Number(new URL(url).searchParams.get("pageNumber")) === 1 ? [filing] : []));
    await expect(getAlabamaCompleteCommitteeFilings(206, { fetchImpl: fetchImpl as never })).rejects.toThrow("returned 1 of 2 rows");
  });

  it.each([{ ...filing, ID: 0 }, { ...filing, PERIODBEGIN: undefined }, { ...filing, DESCRIPTION: null }])("rejects malformed current filing identity: %j", async (invalid) => {
    const fetchImpl = vi.fn(async () => response(1, [invalid]));
    await expect(getAlabamaCompleteCommitteeFilings(206, { fetchImpl: fetchImpl as never })).rejects.toThrow("invalid or repeated identities");
  });

  it("rejects repeated current filing IDs", async () => {
    const fetchImpl = vi.fn(async () => response(2, [filing, filing]));
    await expect(getAlabamaCompleteCommitteeFilings(206, { fetchImpl: fetchImpl as never })).rejects.toThrow("invalid or repeated identities");
  });
});
