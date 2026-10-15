import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  buildMarylandPublicContributionDetailRequest, captureMarylandPublicContributionDetailPost,
  MarylandCurrentCycleExportError, type MarylandPublicContributionDetailRequest,
} from "./marylandCurrentCycleExportClient.js";

type Row = Record<string, unknown>;
const record = (value: unknown): value is Row => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (): never => {throw new MarylandCurrentCycleExportError("invalid_contribution_detail");};
/** Identity/schema acquisition only. Receiver, original-gift ownership, role,
 * source edition and cash attribution still require independent qualification. */
export function decodeMarylandPublicContributionDetail(value: unknown, request: MarylandPublicContributionDetailRequest) {
  if (!record(value) || value.succeeded !== true || value.error !== null || !record(value.data)) return fail();
  const row = value.data;
  if (typeof row.guid !== "string" || row.guid.toLowerCase() !== request.transactionGuid.toLowerCase() ||
    typeof row.transactionDate !== "string" || !/^\d{4}-\d{2}-\d{2}T00:00:00$/.test(row.transactionDate) ||
    !Number.isFinite(Date.parse(`${row.transactionDate}Z`)) ||
    new Date(`${row.transactionDate}Z`).toISOString().slice(0, 19) !== row.transactionDate ||
    row.transactionDate.startsWith("0000") ||
    typeof row.transactionAmount !== "number" || !Number.isFinite(row.transactionAmount) ||
    typeof row.transactionSubTypeCode !== "string" || !row.transactionSubTypeCode ||
    typeof row.transactionSourceType !== "string" || !row.transactionSourceType ||
    typeof row.payeeName !== "string" || !row.payeeName.trim() ||
    typeof row.committeeName !== "string" || !row.committeeName.trim() ||
    typeof row.committeeType !== "string" || !row.committeeType ||
    typeof row.isReturnContribution !== "boolean" ||
    (request.transactionTypeCode === "TRCON" && row.isReturnContribution !== true)) return fail();
  return Object.freeze({...row});
}

/** Ordinary result contains no contributor identity, source selector or item. */
export async function fetchMarylandPublicContributionDetail(input:
  Omit<Parameters<typeof captureMarylandPublicContributionDetailPost>[1], "onCapture"> & {
    transactionGuid: string;
    transactionTypeCode?: "TCON" | "TRCON";
    onCapture?: Parameters<typeof captureMarylandPublicContributionDetailPost>[1]["onCapture"];
  },
) {
  const request = buildMarylandPublicContributionDetailRequest(input.transactionGuid, input.transactionTypeCode);
  const capture = await captureMarylandPublicContributionDetailPost(request, input);
  try {
    const raw = await readFile(capture.outputPath);
    if (raw.length !== capture.byteCount || createHash("sha256").update(raw).digest("hex") !== capture.sha256) return fail();
    decodeMarylandPublicContributionDetail(JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(raw)), request);
    const {requestBody: _privateScope, ...metadata} = capture;
    return Object.freeze({capture: Object.freeze(metadata)});
  } catch {throw new MarylandCurrentCycleExportError("invalid_contribution_detail", capture);}
}
