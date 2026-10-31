import type { VermontPagedResult } from "./vermontCampaignFinanceClient.js";

/** A valid declared count changed between pages; callers may restart the census. */
export class VermontCensusMovedError extends Error {
  constructor() {
    super("Vermont transaction declared total changed during paging");
    this.name = "VermontCensusMovedError";
  }
}

type VermontTransactionIdentity = {
  transactionId: number;
  transactionVersionId: number | null;
  guid: string;
};

/**
 * The API answers at most this many rows per query: pages past 10 x 1000 come
 * back empty while totalItems still reports the full count (observed
 * 2026-10-30 with 105,089 election-year expenditures).
 */
export const VERMONT_TRANSACTION_QUERY_ROW_CAP = 10_000;
export const VERMONT_TRANSACTION_DATE_WINDOW_START = "1900-01-01";
export const VERMONT_TRANSACTION_DATE_WINDOW_END = "2100-12-31";

export type VermontTransactionDateWindow = { fromDate: string; toDate: string };

/** A complete physical query census; this does not certify report versions or dates. */
export async function fetchAllVermontTransactionRows<T extends VermontTransactionIdentity>(input: {
  fetchPage: (pageNumber: number) => Promise<VermontPagedResult<T>>;
  pageSize: number;
  maxPages?: number;
}): Promise<T[]> {
  return censusRows(input);
}

async function censusRows<T extends VermontTransactionIdentity>(input: {
  fetchPage: (pageNumber: number) => Promise<VermontPagedResult<T>>;
  pageSize: number;
  maxPages?: number;
  firstPage?: VermontPagedResult<T>;
}): Promise<T[]> {
  const maxPages = input.maxPages ?? 25;
  if (
    !Number.isSafeInteger(input.pageSize) ||
    input.pageSize < 1 ||
    input.pageSize > 1000 ||
    !Number.isSafeInteger(maxPages) ||
    maxPages < 1
  ) {
    throw new Error("Invalid Vermont transaction paging bounds");
  }
  const rows: T[] = [];
  const identities = new Set<string>();
  let declaredTotal: number | undefined;
  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const page =
      pageNumber === 1 && input.firstPage ? input.firstPage : await input.fetchPage(pageNumber);
    if (
      !Number.isSafeInteger(page.totalItems) ||
      page.totalItems < 0
    ) {
      throw new Error(
        "Vermont transaction declared total is invalid",
      );
    }
    if (declaredTotal !== undefined && page.totalItems !== declaredTotal) {
      throw new VermontCensusMovedError();
    }
    declaredTotal = page.totalItems;
    const expected = Math.min(input.pageSize, declaredTotal - rows.length);
    if (page.items.length !== expected) {
      throw new Error(
        `Vermont transaction physical page ${pageNumber} has ${page.items.length} rows; expected ${expected}`,
      );
    }
    for (const row of page.items) {
      const key = JSON.stringify([row.transactionId, row.transactionVersionId]);
      if (identities.has(key)) {
        throw new Error(
          "Vermont transaction ID/version repeats within the query census",
        );
      }
      identities.add(key);
      rows.push(row);
    }
    if (rows.length === declaredTotal) return rows;
  }
  throw new Error(
    `Vermont finance transaction fetch reached maxPages=${maxPages} before all ${declaredTotal} rows were loaded`,
  );
}

function utcDay(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid Vermont transaction window date: ${date}`);
  }
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid Vermont transaction window date: ${date}`);
  }
  return Math.floor(ms / 86_400_000);
}

function isoDay(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

/**
 * A complete census of a query whose declared total may exceed the API row cap.
 *
 * Small censuses page the unfiltered query exactly as before. Larger ones are
 * split into transaction-date windows by bisection until each window fits the
 * cap. Window bounds are inclusive on both ends (toDate keeps rows stamped at
 * midnight of that day; rows later that day fall to the next window, which
 * starts on the same day), so the windows overlap on their boundary day and
 * duplicates are dropped. A two-day window is the smallest split: single-day
 * windows would drop the first day's later-stamped rows (observed live
 * 2026-10-30: 2026-10-01..02 held 330 rows, each single day 164, two rows
 * stamped 20:00). The merged row count must still equal the unfiltered
 * declared total, otherwise the census moved and callers may retry.
 */
export async function fetchAllVermontTransactionRowsByDateWindow<T extends VermontTransactionIdentity>(input: {
  fetchPage: (
    pageNumber: number,
    window: VermontTransactionDateWindow | null,
  ) => Promise<VermontPagedResult<T>>;
  pageSize: number;
  maxPages?: number;
  queryRowCap?: number;
  window?: VermontTransactionDateWindow;
}): Promise<T[]> {
  const cap = input.queryRowCap ?? VERMONT_TRANSACTION_QUERY_ROW_CAP;
  if (!Number.isSafeInteger(cap) || cap < 1) {
    throw new Error("Invalid Vermont transaction query row cap");
  }
  const firstPage = await input.fetchPage(1, null);
  if (!Number.isSafeInteger(firstPage.totalItems) || firstPage.totalItems < 0) {
    throw new Error("Vermont transaction declared total is invalid");
  }
  const declaredTotal = firstPage.totalItems;
  if (declaredTotal <= cap) {
    return censusRows({
      fetchPage: (pageNumber) => input.fetchPage(pageNumber, null),
      pageSize: input.pageSize,
      maxPages: input.maxPages,
      firstPage,
    });
  }

  const rows: T[] = [];
  const identities = new Set<string>();
  const censusWindow = async (fromDay: number, toDay: number): Promise<void> => {
    const window = { fromDate: isoDay(fromDay), toDate: isoDay(toDay) };
    const probe = await input.fetchPage(1, window);
    if (!Number.isSafeInteger(probe.totalItems) || probe.totalItems < 0) {
      throw new Error("Vermont transaction declared total is invalid");
    }
    if (probe.totalItems > cap) {
      if (toDay - fromDay <= 1) {
        throw new Error(
          `Vermont transaction window ${window.fromDate}..${window.toDate} holds ${probe.totalItems} rows; the API serves at most ${cap}`,
        );
      }
      const midDay = fromDay + Math.floor((toDay - fromDay) / 2);
      await censusWindow(fromDay, midDay);
      await censusWindow(midDay, toDay);
      return;
    }
    const windowRows = await censusRows({
      fetchPage: (pageNumber) => input.fetchPage(pageNumber, window),
      pageSize: input.pageSize,
      maxPages: input.maxPages,
      firstPage: probe,
    });
    for (const row of windowRows) {
      const key = JSON.stringify([row.transactionId, row.transactionVersionId]);
      if (identities.has(key)) continue;
      identities.add(key);
      rows.push(row);
    }
  };
  const window = input.window ?? {
    fromDate: VERMONT_TRANSACTION_DATE_WINDOW_START,
    toDate: VERMONT_TRANSACTION_DATE_WINDOW_END,
  };
  const fromDay = utcDay(window.fromDate);
  const toDay = utcDay(window.toDate);
  if (fromDay > toDay) {
    throw new Error("Invalid Vermont transaction date window");
  }
  await censusWindow(fromDay, toDay);
  if (rows.length !== declaredTotal) {
    throw new VermontCensusMovedError();
  }
  return rows;
}
