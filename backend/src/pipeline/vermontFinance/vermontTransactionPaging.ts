import type { VermontPagedResult } from "./vermontCampaignFinanceClient.js";

/** A complete physical query census; this does not certify report versions or dates. */
export async function fetchAllVermontTransactionRows<
  T extends {
    transactionId: number;
    transactionVersionId: number | null;
    guid: string;
  },
>(input: {
  fetchPage: (pageNumber: number) => Promise<VermontPagedResult<T>>;
  pageSize: number;
  maxPages?: number;
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
    const page = await input.fetchPage(pageNumber);
    if (
      !Number.isSafeInteger(page.totalItems) ||
      page.totalItems < 0 ||
      (declaredTotal !== undefined && page.totalItems !== declaredTotal)
    ) {
      throw new Error(
        "Vermont transaction declared total is invalid or changed during paging",
      );
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
