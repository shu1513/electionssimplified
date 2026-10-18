/**
 * CFS gives an amended filing a different report GUID (and sometimes a
 * different numeric report ID). Transaction rows alone cannot identify the
 * current version, including an amendment with no transactions left in it.
 * These pages must come from the public profile filing and child-history APIs.
 * This reconciles report identity only; callers still validate source scope,
 * transaction types, amounts, allocation and acquisition freshness separately.
 */
export type NewHampshireReportTransactionIdentity = {
  filerReportGuid: unknown;
  filerReportVersionId: unknown;
};

export type NewHampshireReportHistory = {
  parentReportGuid: string;
  pages: readonly unknown[];
};

type HoldReason =
  | "invalid_page"
  | "incomplete_pages"
  | "invalid_report"
  | "duplicate_report"
  | "empty_current_inventory"
  | "incomplete_history"
  | "unexpected_history"
  | "unknown_transaction_report";

export type NewHampshireCurrentReportResult<T> =
  | { status: "held"; reason: HoldReason }
  | {
      status: "reconciled";
      currentRows: T[];
      currentReportCount: number;
      historicalReportCount: number;
      historicalRowCount: number;
    };

class AuthorityHold extends Error {
  constructor(readonly reason: HoldReason) {
    super(reason);
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AuthorityHold("invalid_page");
  }
  return value as Record<string, unknown>;
}

function closedPageRows(pages: readonly unknown[]): Record<string, unknown>[] {
  if (pages.length === 0) throw new AuthorityHold("incomplete_pages");
  let total: number | undefined;
  const rows: Record<string, unknown>[] = [];
  for (const page of pages) {
    const envelope = object(page);
    if (envelope.succeeded !== true) throw new AuthorityHold("invalid_page");
    const data = object(envelope.data);
    if (!Array.isArray(data.items) || !Number.isSafeInteger(data.totalItems) || Number(data.totalItems) < 0) {
      throw new AuthorityHold("invalid_page");
    }
    if (total !== undefined && total !== data.totalItems) throw new AuthorityHold("incomplete_pages");
    total = Number(data.totalItems);
    if (data.items.length === 0 && (pages.length !== 1 || total !== 0)) {
      throw new AuthorityHold("incomplete_pages");
    }
    rows.push(...data.items.map(object));
  }
  if (rows.length !== total) throw new AuthorityHold("incomplete_pages");
  return rows;
}

function guid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) {
    throw new AuthorityHold("invalid_report");
  }
  return value.toLowerCase();
}

function version(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new AuthorityHold("invalid_report");
  }
  return value;
}

function identity(reportGuid: string, reportVersion: number): string {
  return `${reportGuid}:${reportVersion}`;
}

export function reconcileNewHampshireCurrentReports<T extends NewHampshireReportTransactionIdentity>(input: {
  currentPages: readonly unknown[];
  histories: readonly NewHampshireReportHistory[];
  transactions: readonly T[];
}): NewHampshireCurrentReportResult<T> {
  try {
    const parents = closedPageRows(input.currentPages);
    if (parents.length === 0) throw new AuthorityHold("empty_current_inventory");
    const current = new Set<string>();
    const currentGuids = new Set<string>();
    const expectedHistory = new Map<string, number>();
    for (const parent of parents) {
      const id = guid(parent.filerReportGuid);
      const v = version(parent.filerReportVersionID);
      if (typeof parent.hasChild !== "boolean" || parent.hasChild !== (v > 1)) {
        throw new AuthorityHold("invalid_report");
      }
      if (currentGuids.has(id)) throw new AuthorityHold("duplicate_report");
      currentGuids.add(id);
      current.add(identity(id, v));
      if (parent.hasChild) expectedHistory.set(id, v);
    }

    const historical = new Set<string>();
    const historyParents = new Set<string>();
    for (const history of input.histories) {
      const parentId = guid(history.parentReportGuid);
      const currentVersion = expectedHistory.get(parentId);
      if (currentVersion === undefined || historyParents.has(parentId)) throw new AuthorityHold("unexpected_history");
      historyParents.add(parentId);
      const versions = new Set<number>();
      for (const row of closedPageRows(history.pages)) {
        const id = guid(row.filerReportGuid);
        const v = version(row.filerReportVersionID);
        const key = identity(id, v);
        if (v >= currentVersion || versions.has(v) || historical.has(key) || current.has(key)) {
          throw new AuthorityHold("incomplete_history");
        }
        historical.add(key);
        versions.add(v);
      }
      // The public history includes every preceding version, not the parent.
      if (versions.size !== currentVersion - 1) throw new AuthorityHold("incomplete_history");
    }
    if (historyParents.size !== expectedHistory.size) throw new AuthorityHold("incomplete_history");

    const currentRows: T[] = [];
    let historicalRowCount = 0;
    for (const transaction of input.transactions) {
      const key = identity(guid(transaction.filerReportGuid), version(transaction.filerReportVersionId));
      if (current.has(key)) currentRows.push(transaction);
      else if (historical.has(key)) historicalRowCount += 1;
      else throw new AuthorityHold("unknown_transaction_report");
    }
    return {
      status: "reconciled",
      currentRows,
      currentReportCount: current.size,
      historicalReportCount: historical.size,
      historicalRowCount,
    };
  } catch (error) {
    if (error instanceof AuthorityHold) return { status: "held", reason: error.reason };
    throw error;
  }
}
