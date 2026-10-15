import { createHash } from "node:crypto";
import {
  getVermontContributionDetails,
  getVermontElectionLookup,
  getVermontExpenditureDetails,
  getVermontFiledReports,
  resolveVermontElectionLookup,
  type VermontCampaignFinanceClientOptions,
  type VermontElectionLookupItem,
  type VermontFiledReportRow,
} from "./vermontCampaignFinanceClient.js";
import type { VermontCommitteeCashContext } from "./vermontCommitteeCashContext.js";
import type {
  VermontCommitteeCashCapture,
  VermontCommitteeCashQueryPage,
  VermontCommitteeCashPdfObservation,
  VermontCommitteeCashPhase,
} from "./vermontCommitteeCashQualification.js";
export type {
  VermontCommitteeCashQueryPage,
  VermontCommitteeCashPdfObservation,
  VermontCommitteeCashPhase,
} from "./vermontCommitteeCashQualification.js";
import { fetchVermontFiledReportPdf } from "./vermontFiledReportClient.js";
import { readVermontReportControlPdf } from "./vermontReportControlPdfParser.js";
import { fetchAllVermontTransactionRows } from "./vermontTransactionPaging.js";

export type VermontCommitteeCashAcquisitionContext = Pick<
  VermontCommitteeCashContext,
  | "filerRegistrationGuid"
  | "entityId"
  | "receivingFilerName"
  | "candidateName"
  | "officeId"
  | "officeName"
  | "electionDate"
  | "electionType"
> &
  Partial<
    Pick<VermontCommitteeCashContext, "sourceElectionId" | "sourceElection">
  >;

export type VermontCommitteeCashCaptureMetadata = VermontCommitteeCashCapture;
type MutablePhase = {
  queries: {
    [
      K in keyof VermontCommitteeCashPhase["queries"]
    ]: VermontCommitteeCashQueryPage[];
  };
  reports: VermontCommitteeCashPdfObservation[];
};
/** Restricted original response evidence. No headers or authentication metadata. */
export type VermontCommitteeCashResponseCapture = Omit<
  VermontCommitteeCashCaptureMetadata,
  "httpStatus"
> & {
  url: string;
  method: string;
  requestFields: Record<string, unknown>;
  httpStatus: number | null;
  body: Uint8Array;
  error?: "request_failed" | "body_limit";
};

type PendingPdf = {
  capture: VermontCommitteeCashResponseCapture;
  bytes: Uint8Array;
};
const BODY_LIMIT = 20 * 1024 * 1024;
const API_PREFIX = "https://api.campaignfinance.vermont.gov/api/";

/** Fresh acquisition only. Returned packets are source facts, not financial acceptance. */
export async function acquireVermontCommitteeCash<
  T extends VermontCommitteeCashAcquisitionContext,
>(input: {
  context: T;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  pageSize?: number;
  maxPages?: number;
  maxRequests?: number;
  onCapture?: (
    capture: VermontCommitteeCashResponseCapture,
  ) => void | Promise<void>;
}) {
  const timeoutMs = input.timeoutMs ?? 30_000;
  const pageSize = input.pageSize ?? 1000;
  const maxPages = input.maxPages ?? 25;
  const maxRequests = input.maxRequests ?? 100;
  for (const [value, max] of [
    [timeoutMs, 90_000],
    [pageSize, 1000],
    [maxPages, 25],
    [maxRequests, 1000],
  ]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > max)
      throw new Error("Invalid Vermont cash acquisition bounds");
  }
  const c = structuredClone(input.context);
  const networkFetch = input.fetchImpl ?? fetch;
  const onCapture = input.onCapture;
  const electionDate = new Date(`${c.electionDate}T00:00:00Z`);
  if (
    !c.filerRegistrationGuid?.trim() ||
    !c.receivingFilerName?.trim() ||
    !c.candidateName?.trim() ||
    !c.officeName?.trim() ||
    !Number.isSafeInteger(c.entityId) ||
    c.entityId <= 0 ||
    !Number.isSafeInteger(c.officeId) ||
    c.officeId <= 0 ||
    !/^\d{4}-\d{2}-\d{2}$/.test(c.electionDate) ||
    !Number.isFinite(electionDate.getTime()) ||
    electionDate.toISOString().slice(0, 10) !== c.electionDate ||
    !["general", "primary"].includes(c.electionType)
  ) {
    throw new Error("Invalid Vermont cash acquisition context");
  }
  const captures: VermontCommitteeCashResponseCapture[] = [];
  let totalBytes = 0;
  let requests = 0;
  const fetchImpl: typeof fetch = async (url, init = {}) => {
    if (++requests > maxRequests)
      throw new Error("Vermont cash acquisition request bound exhausted");
    const sourceUrl = String(url);
    if (!sourceUrl.startsWith(API_PREFIX))
      throw new Error("Unsupported Vermont cash acquisition origin");
    const fields = init.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};
    const startedAt = new Date().toISOString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const chunks: Uint8Array[] = [];
    let size = 0;
    let status: number | null = null;
    let response: Response | undefined;
    let failure: VermontCommitteeCashResponseCapture["error"];
    try {
      const headers = new Headers(init.headers);
      headers.set("User-Agent", "Mozilla/5.0");
      response = await networkFetch(url, {
        ...init,
        headers,
        signal: init.signal
          ? AbortSignal.any([init.signal, controller.signal])
          : controller.signal,
      });
      status = response.status;
      const reader = response.clone().body?.getReader();
      if (!reader) throw new Error("Missing source body");
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          if (
            size + part.value.byteLength > BODY_LIMIT ||
            totalBytes + size + part.value.byteLength > 128 * 1024 * 1024
          ) {
            failure = "body_limit";
            controller.abort();
            void reader.cancel().catch(() => undefined);
            throw new Error("Source body bound exhausted");
          }
          chunks.push(part.value);
          size += part.value.byteLength;
        }
      } finally {
        reader.releaseLock();
      }
    } catch {
      failure ??= "request_failed";
    } finally {
      clearTimeout(timer);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    totalBytes += size;
    const capture: VermontCommitteeCashResponseCapture = {
      url: sourceUrl,
      method: init.method ?? "GET",
      requestFields: fields,
      startedAt,
      completedAt: new Date().toISOString(),
      httpStatus: status,
      byteCount: size,
      sha256: createHash("sha256").update(body).digest("hex"),
      body,
      ...(failure ? { error: failure } : {}),
    };
    captures.push(capture);
    await onCapture?.({
      ...capture,
      requestFields: structuredClone(fields),
      body: body.slice(),
    });
    if (failure || !response)
      throw new Error("Vermont cash source acquisition failed");
    return response; // Original network response, not a reconstructed response.
  };
  const options: VermontCampaignFinanceClientOptions = { fetchImpl, timeoutMs };
  const latestCapture = () => captures[captures.length - 1]!;
  const metadata = (
    capture: VermontCommitteeCashResponseCapture,
  ): VermontCommitteeCashCaptureMetadata => {
    if (capture.error || capture.httpStatus !== 200)
      throw new Error("Vermont cash source response unavailable");
    return {
      startedAt: capture.startedAt,
      completedAt: capture.completedAt,
      httpStatus: capture.httpStatus,
      sha256: capture.sha256,
      byteCount: capture.byteCount,
    };
  };
  const endpoint = (capture: VermontCommitteeCashResponseCapture) =>
    capture.url.slice(API_PREFIX.length);
  const query = (): VermontCommitteeCashQueryPage => {
    const capture = latestCapture();
    const envelope = JSON.parse(new TextDecoder().decode(capture.body)) as {
      data: { items: Record<string, unknown>[]; totalItems: number };
    };
    return {
      request: {
        endpoint: endpoint(capture),
        body: structuredClone(capture.requestFields),
      },
      response: {
        items: envelope.data.items,
        totalItems: envelope.data.totalItems,
      },
      capture: metadata(capture),
    };
  };
  const sourceElection = resolveVermontElectionLookup(
    await getVermontElectionLookup(options),
    c,
  );
  if (
    (c.sourceElectionId !== undefined &&
      c.sourceElectionId !== sourceElection.electionId) ||
    (c.sourceElection &&
      (c.sourceElection.electionId !== sourceElection.electionId ||
        c.sourceElection.name.replace(/\s+/g, " ").trim() !==
          sourceElection.name.replace(/\s+/g, " ").trim()))
  ) {
    throw new Error(
      "Vermont cash source election conflicts with canonical context",
    );
  }
  const phase = (): MutablePhase => ({
    queries: { reports: [], contributions: [], expenditures: [] },
    reports: [],
  });
  async function queries(
    target: MutablePhase,
  ): Promise<VermontFiledReportRow[]> {
    const reports: VermontFiledReportRow[] = [];
    const identities = new Set<string>();
    let total: number | undefined;
    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
      const page = await getVermontFiledReports(
        {
          filerRegistrationGuid: c.filerRegistrationGuid,
          pageNumber,
          pageSize,
        },
        options,
      );
      target.queries.reports.push(query());
      if (total !== undefined && total !== page.totalItems)
        throw new Error("Vermont report inventory count changed");
      total = page.totalItems;
      if (page.items.length !== Math.min(pageSize, total - reports.length))
        throw new Error("Vermont report inventory pagination incomplete");
      for (const report of page.items) {
        const key = JSON.stringify([
          report.filerReportGuid,
          report.filerReportVersionId,
        ]);
        if (identities.has(key))
          throw new Error("Vermont report inventory repeated edition");
        identities.add(key);
        reports.push(report);
      }
      if (reports.length === total) break;
    }
    if (reports.length !== total)
      throw new Error("Vermont report inventory page bound exhausted");
    const search = {
      filerRegistrationGuid: c.filerRegistrationGuid,
      filerName: c.receivingFilerName,
      electionId: sourceElection.electionId,
      pageSize,
      sortBy: "TransactionDate",
      sortType: "desc" as const,
    };
    await fetchAllVermontTransactionRows({
      pageSize,
      maxPages,
      fetchPage: async (pageNumber) => {
        const page = await getVermontContributionDetails(
          { ...search, pageNumber },
          options,
        );
        target.queries.contributions.push(query());
        return page;
      },
    });
    await fetchAllVermontTransactionRows({
      pageSize,
      maxPages,
      fetchPage: async (pageNumber) => {
        const page = await getVermontExpenditureDetails(
          { ...search, pageNumber },
          options,
        );
        target.queries.expenditures.push(query());
        return page;
      },
    });
    return reports;
  }
  async function pdfs(
    reports: readonly VermontFiledReportRow[],
  ): Promise<PendingPdf[]> {
    const result: PendingPdf[] = [];
    for (const report of reports) {
      const bytes = await fetchVermontFiledReportPdf(report, options);
      result.push({ capture: latestCapture(), bytes: new Uint8Array(bytes) });
    }
    return result;
  }
  const before = phase();
  const after = phase();
  const allReports = await queries(before);
  const regular = allReports.filter(
    (report) => report.reportType === "Campaign Finance Disclosure Report",
  );
  const openingPdfs = await pdfs(regular);
  const closingPdfs = await pdfs(regular);
  await queries(after);
  const closingElection = resolveVermontElectionLookup(
    await getVermontElectionLookup(options),
    c,
  );
  if (
    closingElection.electionId !== sourceElection.electionId ||
    closingElection.name.replace(/\s+/g, " ").trim() !==
      sourceElection.name.replace(/\s+/g, " ").trim()
  ) {
    throw new Error("Vermont cash source election changed during acquisition");
  }
  // Pin genuine last body completion before asynchronous PDF extraction.
  const observedAt = new Date(latestCapture().completedAt);
  for (const [target, pending] of [
    [before, openingPdfs],
    [after, closingPdfs],
  ] as const) {
    for (const pdf of pending) {
      target.reports.push({
        request: {
          endpoint: endpoint(pdf.capture),
          body: pdf.capture
            .requestFields as VermontCommitteeCashPdfObservation["request"]["body"],
        },
        capture: metadata(pdf.capture),
        facts: await readVermontReportControlPdf(pdf.bytes),
      });
    }
  }
  return {
    context: {
      ...c,
      sourceElection,
      sourceElectionId: sourceElection.electionId,
    },
    before,
    after,
    observedAt,
  };
}
