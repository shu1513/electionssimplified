import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  captureMarylandPublicContributionPost,
  MarylandCurrentCycleExportError,
  type MarylandCurrentCycleCapture,
} from "./marylandCurrentCycleExportClient.js";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Scope = {
  filerRegistrationGuid: string;
  electionCycle: string;
  pageNumber: number;
  pageSize?: 10 | 25 | 50 | 100;
  isReturn?: boolean | null;
};

/** Literal observed public builder. Omitted undefined filters stay omitted. */
export function buildMarylandPublicContributionRequest(input: Scope) {
  const pageSize = input.pageSize ?? 100;
  const isReturn = input.isReturn ?? null;
  if (
    typeof input.filerRegistrationGuid !== "string" || !GUID.test(input.filerRegistrationGuid) ||
    typeof input.electionCycle !== "string" || !/^[1-9]\d*$/.test(input.electionCycle) ||
    !Number.isSafeInteger(input.pageNumber) || input.pageNumber < 1 ||
    ![10, 25, 50, 100].includes(pageSize) ||
    (isReturn !== null && typeof isReturn !== "boolean")
  ) throw new MarylandCurrentCycleExportError("invalid_request");
  return Object.freeze({
    pageNumber: input.pageNumber,
    pageSize,
    sortBy: "TransactionDate",
    sortType: "desc",
    transactionTypeCode: "TCON" as const,
    contributorName: null,
    contributorTypeCode: null,
    committeeType: null,
    reportType: null,
    isReturn,
    electionCycle: input.electionCycle,
    paymentTypeCode: null,
    contributionTypeCode: null,
    electionID: null,
    reportName: null,
    officeSought: null,
    officeType: null,
    toDate: null,
    fromDate: null,
    filerRegistrationGuid: input.filerRegistrationGuid,
    isPublicFundingRequested: null,
  });
}
export type MarylandPublicContributionRequest = ReturnType<typeof buildMarylandPublicContributionRequest>;
export type MarylandPublicContributionCapture = MarylandCurrentCycleCapture<MarylandPublicContributionRequest>;

type Row = Record<string, unknown>;
function record(value: unknown): value is Row {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const fail = (): never => {
  throw new MarylandCurrentCycleExportError("invalid_contribution_page");
};

/** Acquisition validation only. It neither selects editions nor nets money. */
export function decodeMarylandPublicContributionPage(
  value: unknown,
  request: MarylandPublicContributionRequest,
): { rows: readonly Row[]; totalItems: number } {
  if (!record(value) || value.succeeded !== true || value.error !== null || !record(value.data)) return fail();
  const data = value.data;
  if (!Number.isSafeInteger(data.totalItems) || (data.totalItems as number) < 0 || !Array.isArray(data.items)) return fail();
  const totalItems = data.totalItems as number;
  const offset = (request.pageNumber - 1) * request.pageSize;
  if (!Number.isSafeInteger(offset)) return fail();
  const expected = Math.min(request.pageSize, Math.max(0, totalItems - offset));
  if (data.items.length !== expected) return fail();
  const identities = new Set<string>();
  for (const row of data.items) {
    if (
      !record(row) || typeof row.filerRegistrationGuid !== "string" ||
      row.filerRegistrationGuid.toLowerCase() !== request.filerRegistrationGuid.toLowerCase() ||
      !Number.isSafeInteger(row.electionCycleId) || String(row.electionCycleId) !== request.electionCycle ||
      typeof row.transactionGuid !== "string" || !GUID.test(row.transactionGuid) ||
      typeof row.reportGuid !== "string" || !GUID.test(row.reportGuid) ||
      !Number.isSafeInteger(row.transactionId) || (row.transactionId as number) < 1 ||
      !Number.isSafeInteger(row.transactionVersionID) || (row.transactionVersionID as number) < 1 ||
      !Number.isSafeInteger(row.reportId) || (row.reportId as number) < 1 ||
      !Number.isSafeInteger(row.reportVersionId) || (row.reportVersionId as number) < 1 ||
      row.transactionTypeCode !== "TCON" ||
      typeof row.isReturn !== "boolean" || typeof row.isActive !== "boolean" ||
      typeof row.isAmended !== "boolean" || typeof row.hasChild !== "boolean" ||
      (request.isReturn !== null && row.isReturn !== request.isReturn)
    ) return fail();
    // Keep distinct equal gifts and editions. Never deduplicate a repeated
    // occurrence into a claimed complete collection.
    const identity = JSON.stringify([row.transactionGuid.toLowerCase(), row.transactionVersionID,
      row.reportGuid.toLowerCase(), row.reportVersionId, row.isReturn]);
    if (identities.has(identity)) return fail();
    identities.add(identity);
  }
  // The observed server echoes 0/0 even for a genuine 1/100 request. Those
  // fields are retained in the original, never substituted for request scope.
  return { rows: Object.freeze(data.items), totalItems };
}

/** Safe CLI result: no donor names, contacts, transaction IDs or raw items. */
export async function fetchMarylandPublicContributionPage(input: Scope & {
  outputPath: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  onCapture?: (capture: MarylandPublicContributionCapture) => void | Promise<void>;
}): Promise<{capture: Omit<MarylandPublicContributionCapture, "requestBody">; totalItems: number; physicalCount: number}> {
  const request = buildMarylandPublicContributionRequest(input);
  const capture = await captureMarylandPublicContributionPost(request, input);
  try {
    const raw = await readFile(capture.outputPath);
    if (raw.length !== capture.byteCount || createHash("sha256").update(raw).digest("hex") !== capture.sha256) return fail();
    const page = decodeMarylandPublicContributionPage(
      JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(raw)), request,
    );
    const { requestBody: _privateScope, ...metadata } = capture;
    return Object.freeze({ capture: Object.freeze(metadata), totalItems: page.totalItems, physicalCount: page.rows.length });
  } catch {
    throw new MarylandCurrentCycleExportError("invalid_contribution_page", capture);
  }
}
