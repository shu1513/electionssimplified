import { describe, expect, it, vi } from "vitest";
import {
  fetchAllVermontTransactionRows,
  fetchAllVermontTransactionRowsByDateWindow,
  type VermontTransactionDateWindow,
} from "../../../src/pipeline/vermontFinance/vermontTransactionPaging.js";

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

describe("Vermont date-window census", () => {
  it("pages the unfiltered query when the declared total fits the API cap", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ items: [row(1), row(2)], totalItems: 3 })
      .mockResolvedValueOnce({ items: [row(3)], totalItems: 3 });
    await expect(
      fetchAllVermontTransactionRowsByDateWindow({ fetchPage, pageSize: 2, queryRowCap: 10 }),
    ).resolves.toEqual([row(1), row(2), row(3)]);
    expect(fetchPage.mock.calls).toEqual([[1, null], [2, null]]);
  });

  // Stamped dates; the API keeps a midnight row inside both windows that share its day.
  const dated: Record<number, string> = {
    1: "2026-01-01", 2: "2026-01-02", 3: "2026-01-02", 4: "2026-01-03", 5: "2026-01-04",
  };
  const source = (ids: number[], pageSize: number) =>
    vi.fn(async (pageNumber: number, window: VermontTransactionDateWindow | null) => {
      const all = ids.filter(
        (id) => !window || (dated[id]! >= window.fromDate && dated[id]! <= window.toDate),
      );
      return {
        items: all.slice((pageNumber - 1) * pageSize, pageNumber * pageSize).map(row),
        totalItems: all.length,
      };
    });

  it("bisects date windows until each fits the cap and drops boundary duplicates", async () => {
    const fetchPage = source([1, 2, 3, 4, 5], 2);
    await expect(
      fetchAllVermontTransactionRowsByDateWindow({
        fetchPage, pageSize: 2, queryRowCap: 3,
        window: { fromDate: "2026-01-01", toDate: "2026-01-04" },
      }),
    ).resolves.toEqual([row(1), row(2), row(3), row(4), row(5)]);
    expect(fetchPage.mock.calls.map(([pageNumber, window]) => [pageNumber, window?.fromDate, window?.toDate])).toEqual([
      [1, undefined, undefined],
      [1, "2026-01-01", "2026-01-04"],
      [1, "2026-01-01", "2026-01-02"],
      [2, "2026-01-01", "2026-01-02"],
      [1, "2026-01-02", "2026-01-04"],
      [1, "2026-01-02", "2026-01-03"],
      [2, "2026-01-02", "2026-01-03"],
      [1, "2026-01-03", "2026-01-04"],
    ]);
  });

  it("refuses a single day that exceeds the cap instead of returning a partial census", async () => {
    const fetchPage = source([2, 3], 2);
    await expect(
      fetchAllVermontTransactionRowsByDateWindow({
        fetchPage, pageSize: 2, queryRowCap: 1,
        window: { fromDate: "2026-01-01", toDate: "2026-01-02" },
      }),
    ).rejects.toThrow("serves at most 1");
  });

  // Live API semantics (2026-10-30): toDate keeps only that day's midnight rows,
  // and some rows carry a time of day. Single-day windows would lose those rows.
  const stamped: Record<number, string> = {
    1: "2026-01-01T00:00:00", 2: "2026-01-01T20:00:00", 3: "2026-01-02T00:00:00", 4: "2026-01-03T00:00:00",
  };
  const stampedSource = (ids: number[]) =>
    vi.fn(async (pageNumber: number, window: VermontTransactionDateWindow | null) => {
      const all = ids.filter(
        (id) =>
          !window ||
          (stamped[id]! >= `${window.fromDate}T00:00:00` && stamped[id]! <= `${window.toDate}T00:00:00`),
      );
      return { items: all.slice((pageNumber - 1) * 2, pageNumber * 2).map(row), totalItems: all.length };
    });

  it("keeps a later-stamped row exactly once when its day is a bisection boundary", async () => {
    await expect(
      fetchAllVermontTransactionRowsByDateWindow({
        fetchPage: stampedSource([1, 2, 3, 4]), pageSize: 2, queryRowCap: 3,
        window: { fromDate: "2026-01-01", toDate: "2026-01-03" },
      }),
    ).resolves.toEqual([row(1), row(2), row(3), row(4)]);
  });

  it("refuses to split a two-day window into single days, which would drop later-stamped rows", async () => {
    await expect(
      fetchAllVermontTransactionRowsByDateWindow({
        fetchPage: stampedSource([1, 2, 3]), pageSize: 2, queryRowCap: 2,
        window: { fromDate: "2026-01-01", toDate: "2026-01-02" },
      }),
    ).rejects.toThrow("serves at most 2");
  });

  it("reports a moved census when the windows do not add up to the declared total", async () => {
    const fetchPage = vi.fn(async (_pageNumber: number, window: VermontTransactionDateWindow | null) =>
      window ? { items: [row(1)], totalItems: 1 } : { items: [row(1), row(2)], totalItems: 2 },
    );
    await expect(
      fetchAllVermontTransactionRowsByDateWindow({
        fetchPage, pageSize: 2, queryRowCap: 1,
        window: { fromDate: "2026-01-01", toDate: "2026-01-01" },
      }),
    ).rejects.toMatchObject({ name: "VermontCensusMovedError" });
  });
});
