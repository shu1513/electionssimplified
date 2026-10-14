import { describe, expect, it, vi } from "vitest";
import { fetchAllVermontTransactionRows } from "../../../src/pipeline/vermontFinance/vermontTransactionPaging.js";

const row = (id: number) => ({
  transactionId: id,
  transactionVersionId: 1,
  guid: `tx-${id}`,
});

describe("Vermont physical transaction census", () => {
  it("closes exact declared counts without relying on echoed pagination", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ items: [row(1), row(2)], totalItems: 3 })
      .mockResolvedValueOnce({ items: [row(3)], totalItems: 3 });
    await expect(
      fetchAllVermontTransactionRows({ fetchPage, pageSize: 2 }),
    ).resolves.toEqual([row(1), row(2), row(3)]);
    expect(fetchPage.mock.calls).toEqual([[1], [2]]);
  });

  it("allows a declared empty physical census", async () => {
    await expect(
      fetchAllVermontTransactionRows({
        fetchPage: async () => ({ items: [], totalItems: 0 }),
        pageSize: 100,
      }),
    ).resolves.toEqual([]);
  });

  it.each([
    { items: [], totalItems: 2 },
    { items: [row(1)], totalItems: 2 },
    { items: [row(1), row(2), row(3)], totalItems: 2 },
    { items: [], totalItems: -1 },
    { items: [], totalItems: 1.1 },
    { items: [], totalItems: Number.MAX_SAFE_INTEGER + 1 },
  ])(
    "rejects premature/overfull pages or invalid count $totalItems",
    async (page) => {
      await expect(
        fetchAllVermontTransactionRows({
          fetchPage: async () => page,
          pageSize: 2,
        }),
      ).rejects.toThrow();
    },
  );

  it("rejects a changed declaration instead of claiming a complete moving census", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ items: [row(1), row(2)], totalItems: 3 })
      .mockResolvedValueOnce({ items: [row(3), row(4)], totalItems: 4 });
    await expect(
      fetchAllVermontTransactionRows({ fetchPage, pageSize: 2 }),
    ).rejects.toMatchObject({ name: "VermontCensusMovedError" });
  });

  it("rejects repeated IDs/versions and repeated pages", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ items: [row(1), row(2)], totalItems: 4 })
      .mockResolvedValueOnce({ items: [row(1), row(2)], totalItems: 4 });
    await expect(
      fetchAllVermontTransactionRows({ fetchPage, pageSize: 2 }),
    ).rejects.toThrow("ID/version repeats");
  });

  it("retains distinct versions without selecting a latest version", async () => {
    const rows = [row(1), { ...row(1), transactionVersionId: 2 }];
    await expect(
      fetchAllVermontTransactionRows({
        fetchPage: async () => ({ items: rows, totalItems: 2 }),
        pageSize: 2,
      }),
    ).resolves.toEqual(rows);
  });

  it("enforces a bounded census rather than crawling unresolved history", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValue({ items: [row(1), row(2)], totalItems: 3 });
    await expect(
      fetchAllVermontTransactionRows({ fetchPage, pageSize: 2, maxPages: 1 }),
    ).rejects.toThrow("maxPages=1");
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});
