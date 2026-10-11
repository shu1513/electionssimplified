import type { WestVirginiaTransactionRow } from "./westVirginiaCfrsClient.js";
import type { WestVirginiaContributionCsvRow } from "./westVirginiaCfrsCsv.js";
import { apiAmountToCents } from "./westVirginiaPhaseZero.js";
import { isWestVirginiaDateInWindow, type WestVirginiaCycleWindow } from "./westVirginiaReportingCycleWindows.js";

const COMMITTEE_DONOR_SOURCE_TYPES = new Map<string, "102" | "103">([
  ["Political Action Committee", "102"],
  ["Political Party Committee / Caucus Campaign Committee", "103"],
]);
const COMMITTEE_DONOR_CATEGORIES = new Set(["Monetary", "In-Kind", "Return"]);

/** Exact organization spelling after formatting normalization; no aliases or word reordering. */
export function normalizeWestVirginiaCommitteeDonorName(value: string): string {
  return value.normalize("NFKC").toUpperCase().replace(/[^\p{L}\p{N}]/gu, "");
}

export function westVirginiaCommitteeDonorRegistryType(sourceType: string): "102" | "103" | null {
  return COMMITTEE_DONOR_SOURCE_TYPES.get(sourceType) ?? null;
}

export type WestVirginiaCommitteeDonorReconciliation = {
  entityId: string;
  csvRowCount: number;
  apiRowCount: number;
  multisetMatch: boolean;
  onlyInCsv: number;
  onlyInApi: number;
};

export class WestVirginiaCommitteeDonorReconciliationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WestVirginiaCommitteeDonorReconciliationError";
  }
}

/** Names and legal donor types can change in an amendment without changing the money keys.
 * Compare both source multisets, preserving every separate equal receipt and Return. */
export function reconcileWestVirginiaCommitteeDonors(input: {
  entityId: string;
  csvRows: readonly WestVirginiaContributionCsvRow[];
  apiRows: readonly WestVirginiaTransactionRow[];
  window?: Pick<WestVirginiaCycleWindow, "windowStart" | "windowEnd">;
}): WestVirginiaCommitteeDonorReconciliation {
  const inWindow = (date: string) => !input.window || isWestVirginiaDateInWindow(date, input.window);
  const csvRows = input.csvRows.filter((row) =>
    row.registrantId === input.entityId && inWindow(row.transactionDate) &&
    westVirginiaCommitteeDonorRegistryType(row.contributorType) !== null && COMMITTEE_DONOR_CATEGORIES.has(row.transactionCategory)
  );
  const apiRows = input.apiRows.filter((row) =>
    row.entityID === input.entityId && inWindow(row.transactionDate) &&
    westVirginiaCommitteeDonorRegistryType(row.entityTypeDesc ?? "") !== null && COMMITTEE_DONOR_CATEGORIES.has(row.transactionCategoryDesc ?? "")
  );
  const key = (name: string, sourceType: string, date: string, category: string, cents: number) => {
    const normalizedName = normalizeWestVirginiaCommitteeDonorName(name);
    if (!normalizedName || !/^\d{4}-\d{2}-\d{2}$/.test(date.slice(0, 10)) || !Number.isSafeInteger(cents) || cents < 0 || (category === "Return" && cents === 0)) {
      throw new WestVirginiaCommitteeDonorReconciliationError(`Invalid committee donor identity or amount for ${input.entityId}`);
    }
    return JSON.stringify([normalizedName, sourceType, date.slice(0, 10), category, cents]);
  };
  const remaining = new Map<string, number>();
  for (const row of csvRows) {
    const identity = key(row.contributorName, row.contributorType, row.transactionDate, row.transactionCategory, row.amountCents);
    remaining.set(identity, (remaining.get(identity) ?? 0) + 1);
  }
  let onlyInApi = 0;
  for (const row of apiRows) {
    const identity = key(row.contributorPayeeName ?? "", row.entityTypeDesc ?? "", row.transactionDate, row.transactionCategoryDesc ?? "", apiAmountToCents(row.transactionAmount));
    const count = remaining.get(identity) ?? 0;
    if (count > 0) remaining.set(identity, count - 1);
    else onlyInApi += 1;
  }
  const onlyInCsv = [...remaining.values()].reduce((sum, count) => sum + count, 0);
  if (onlyInCsv !== 0 || onlyInApi !== 0) {
    throw new WestVirginiaCommitteeDonorReconciliationError(
      `Committee donor identities do not reconcile for ${input.entityId}: CSV ${csvRows.length} rows vs API ${apiRows.length} rows (only-in-CSV ${onlyInCsv}, only-in-API ${onlyInApi})`
    );
  }
  return { entityId: input.entityId, csvRowCount: csvRows.length, apiRowCount: apiRows.length, multisetMatch: true, onlyInCsv, onlyInApi };
}
