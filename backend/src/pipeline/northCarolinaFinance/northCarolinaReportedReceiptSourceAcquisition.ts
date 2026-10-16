import {
  acquireNcsbeCommitteeArtifacts,
  selectNcsbeCycleReportRows,
} from "./northCarolinaNcsbeArtifactAcquisition.js";
import { readNcsbeArtifact, validateNcsbeArtifactBody } from "./northCarolinaNcsbeArtifactCache.js";
import {
  createNcsbeTransport,
  DEFAULT_NCSBE_USER_AGENT,
  extractNcsbeAntiForgeryToken,
  fetchNcsbeDocumentInventory,
  ncsbeDocumentInventoryUrl,
  NCSBE_MAX_TRANSACTION_ROWS,
  NCSBE_TRANSACTION_PAGE_SIZE,
  type NcsbeFormBody,
} from "./northCarolinaNcsbeClient.js";
import { parseNcsbeDocumentListPage, parseNcsbeReportDetailPage } from "./northCarolinaNcsbeParsers.js";
import { selectNorthCarolinaDirectCycleReportRows } from "./northCarolinaDirectContributionAggregator.js";
import { selectNcsbeCurrentFilings } from "./northCarolinaReportSelector.js";
import { extractNorthCarolinaNativeExportUrl } from "./northCarolinaReportedReceiptSource.js";
import {
  appendNorthCarolinaReportedReceiptOriginal,
  beginNorthCarolinaReportedReceiptGeneration,
  closeNorthCarolinaReportedReceiptGeneration,
  finalizeNorthCarolinaReportedReceiptGeneration,
  NORTH_CAROLINA_REPORTED_RECEIPT_LIMITS as LIMITS,
  NorthCarolinaReportedReceiptSourceError,
  validateNorthCarolinaReportedReceiptOriginalUrl,
} from "./northCarolinaReportedReceiptSourceCache.js";
import {
  type Binding,
  type CaptureScope,
  type Qualified,
} from "./northCarolinaReportedReceiptSourceTypes.js";

/**
 * Record a fresh ordinary producer run and its native current-report CSVs.
 * Only independent cache replay may publish the immutable source generation.
 * HTTP/sleep dependencies are for synthetic tests; source clocks are actual.
 */
export async function acquireNorthCarolinaReportedReceiptSource(input: CaptureScope & {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}): Promise<Qualified> {
  const generation = await beginNorthCarolinaReportedReceiptGeneration(input);
  let stopped = false;
  let firstRequestStart: number | undefined;
  let requests = 0;
  let totalBytes = 0;
  let phase: "ordinary" | "csv" | "closing" = "ordinary";
  let openingCaptured = false;
  const allowedReportIds = new Set<string>();
  const tokens = new Map<string, string>();
  const nextPages = new Map<string, number>();
  const pageCounts = new Map<string, { count: number; received: number }>();
  const nativeExports = new Map<string, string>();
  const cookies = new Map<string, string>();
  const inventoryUrl = ncsbeDocumentInventoryUrl({ orgGroupId: input.orgGroupId, sboeId: input.receivingCommitteeId });
  const sourceFetch = input.fetchImpl ?? fetch;

  function unavailable(): never {
    stopped = true;
    throw new NorthCarolinaReportedReceiptSourceError("unavailable");
  }
  function bindingFor(url: string, form?: NcsbeFormBody): Binding {
    if (url === inventoryUrl) {
      if (form || (phase === "ordinary" && openingCaptured) || phase === "csv") unavailable();
      return { role: phase === "closing" ? "inventory_close" : "inventory_open" };
    }
    if (phase === "csv") {
      const reportId = nativeExports.get(url);
      if (!reportId || form) unavailable();
      return { role: "native_csv", reportId };
    }
    if (phase !== "ordinary" || !openingCaptured) unavailable();
    let parsed: URL;
    try { parsed = new URL(url); } catch { return unavailable(); }
    const reportId = parsed.searchParams.get("RID") ?? parsed.searchParams.get("rid");
    if (!reportId || !allowedReportIds.has(reportId)) unavailable();
    const handler = parsed.searchParams.get("handler");
    if (handler === null) {
      if (form || tokens.has(reportId)) unavailable();
      return { role: "report_cover", reportId };
    }
    const role = handler === "ReadReceipts" ? "receipt_page" : handler === "ReadExpenditures" ? "expenditure_page" : null;
    if (!role || !form || Object.keys(form).sort().join(",") !== "__RequestVerificationToken,page,pageSize"
      || typeof form.page !== "string" || !/^[1-9]\d*$/.test(form.page)
      || form.pageSize !== String(NCSBE_TRANSACTION_PAGE_SIZE)
      || !tokens.has(reportId) || form.__RequestVerificationToken !== tokens.get(reportId)) unavailable();
    const page = Number(form.page) - 1;
    const key = `${reportId}:${role}`;
    if (!Number.isSafeInteger(page) || page !== (nextPages.get(key) ?? 0)) unavailable();
    return { role, reportId, page };
  }

  const pacedTransport = createNcsbeTransport({
    maxAttempts: 1,
    spacingMs: LIMITS.requestSpacingMs,
    sleep: input.sleep,
    fetch: async (url, form) => {
      if (stopped) return unavailable();
      try {
        const binding = bindingFor(url, form);
        validateNorthCarolinaReportedReceiptOriginalUrl({ scope: input, binding, url });
        if (++requests > LIMITS.maxRequests) unavailable();
        const now = Date.now();
        firstRequestStart ??= now;
        const remaining = LIMITS.maxCaptureMs - (now - firstRequestStart);
        if (remaining <= 0) unavailable();
        const startedAt = new Date(now);
        const headers: Record<string, string> = { "User-Agent": DEFAULT_NCSBE_USER_AGENT, Accept: "*/*" };
        if (cookies.size > 0) headers.Cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
        if (form) headers["Content-Type"] = "application/x-www-form-urlencoded";
        const response = await sourceFetch(url, {
          method: form ? "POST" : "GET", redirect: "manual", headers,
          body: form ? new URLSearchParams(form).toString() : undefined,
          signal: AbortSignal.timeout(Math.min(remaining, LIMITS.requestTimeoutMs)),
        });
        const chunks: Buffer[] = [];
        let byteSize = 0;
        let eof = response.body === null;
        let bodyFailed = false;
        const reader = response.body?.getReader();
        if (reader) {
          try {
            while (true) {
              const part = await reader.read();
              if (part.done) { eof = true; break; }
              const retain = Math.max(0, Math.min(part.value.byteLength, LIMITS.maxBodyBytes - byteSize, LIMITS.maxTotalBytes - totalBytes));
              if (retain > 0) {
                chunks.push(Buffer.from(part.value.subarray(0, retain)));
                byteSize += retain;
                totalBytes += retain;
              }
              if (retain !== part.value.byteLength || Date.now() - firstRequestStart > LIMITS.maxCaptureMs) {
                bodyFailed = true;
                break;
              }
            }
          } catch { bodyFailed = true; }
          if (!eof) await reader.cancel().catch(() => {});
        }
        const completedAt = new Date();
        const bytes = Buffer.concat(chunks);
        // Complete HTTP failures and partial streams remain private originals.
        // No failed descriptor can authorize publication through the reader.
        await appendNorthCarolinaReportedReceiptOriginal({ generation, binding, url, status: response.status,
          eof, bytes, startedAt, completedAt });
        const declaredLength = response.headers.get("content-length");
        if (bodyFailed || !eof || response.status !== 200 || response.redirected
          || (response.url !== "" && response.url !== url) || bytes.length === 0
          || completedAt.getTime() - startedAt.getTime() > LIMITS.requestTimeoutMs
          || completedAt.getTime() - firstRequestStart > LIMITS.maxCaptureMs
          || (declaredLength !== null && !response.headers.get("content-encoding")
            && (!/^\d+$/.test(declaredLength) || Number(declaredLength) !== bytes.length))) unavailable();
        let body: string;
        try { body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return unavailable(); }
        for (const setCookie of response.headers.getSetCookie()) {
          const pair = setCookie.split(";", 1)[0]!;
          const separator = pair.indexOf("=");
          if (separator > 0) cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
        }
        // Reuse production shape validators before releasing a response to
        // the ordinary producer, whose per-report isolation otherwise continues.
        if (binding.role === "inventory_open" || binding.role === "inventory_close") {
          const rows = parseNcsbeDocumentListPage(body);
          if (binding.role === "inventory_open") {
            openingCaptured = true;
            for (const row of selectNcsbeCycleReportRows({ rows, cycleYear: input.electionYear }).selected) allowedReportIds.add(row.dataLink!);
          }
        } else if (binding.role === "report_cover") {
          validateNcsbeArtifactBody({ type: "report_cover", reportId: binding.reportId }, body);
          if (parseNcsbeReportDetailPage(body).cover.reportId !== binding.reportId) unavailable();
          tokens.set(binding.reportId, extractNcsbeAntiForgeryToken(body));
        } else if (binding.role === "receipt_page" || binding.role === "expenditure_page") {
          const result = validateNcsbeArtifactBody({ type: "report_transactions", reportId: binding.reportId,
            kind: binding.role === "receipt_page" ? "receipts" : "expenditures", page: binding.page }, body);
          const key = `${binding.reportId}:${binding.role}`;
          const prior = pageCounts.get(key);
          const count = result.recordCountKey;
          if (count === null || !Number.isSafeInteger(count) || count < 0 || count > NCSBE_MAX_TRANSACTION_ROWS
            || (prior && prior.count !== count)
            || result.rowCount !== Math.min(NCSBE_TRANSACTION_PAGE_SIZE, count - (prior?.received ?? 0))) unavailable();
          pageCounts.set(key, { count, received: (prior?.received ?? 0) + result.rowCount });
          nextPages.set(key, binding.page + 1);
        }
        return { status: response.status, body };
      } catch { return unavailable(); }
    },
  });
  const transport = {
    fetchText: async (url: string, form?: NcsbeFormBody): Promise<string> => {
      if (stopped) return unavailable();
      try { return await pacedTransport.fetchText(url, form); }
      catch { return unavailable(); }
    },
  };

  try {
    const acquired = await acquireNcsbeCommitteeArtifacts({ transport, cacheDir: generation.ordinaryCacheDir,
      cycleYear: input.electionYear, committee: { sboeId: input.receivingCommitteeId, orgGroupId: input.orgGroupId }, force: true });
    if (stopped || acquired.failures.length > 0 || acquired.skippedReportIds.length > 0) unavailable();
    const opening = await readNcsbeArtifact({ cacheDir: generation.ordinaryCacheDir,
      key: { type: "document_inventory", sboeId: input.receivingCommitteeId } });
    const scopedRows = parseNcsbeDocumentListPage(opening.body).filter((row) => row.sboeId === input.receivingCommitteeId || row.sboeId === null || row.sboeId.trim() === "");
    const cycle = selectNorthCarolinaDirectCycleReportRows({ rows: scopedRows, electionYear: input.electionYear });
    const current = selectNcsbeCurrentFilings({ rows: cycle.rows });
    if (cycle.rows.some((row) => row.sboeId !== input.receivingCommitteeId)) throw new NorthCarolinaReportedReceiptSourceError("held", "inventory_identity");
    if (current.quarantinedGroups.length > 0) throw new NorthCarolinaReportedReceiptSourceError("held", "current_lineage");
    if (current.supersededUnavailable.length > 0) throw new NorthCarolinaReportedReceiptSourceError("held", "current_image_only");
    if (current.selected.length === 0) throw new NorthCarolinaReportedReceiptSourceError("held", "no_current_reports");
    phase = "csv";
    for (const filing of current.selected) {
      const reportId = filing.reportId!;
      const cover = await readNcsbeArtifact({ cacheDir: generation.ordinaryCacheDir, key: { type: "report_cover", reportId } });
      const url = extractNorthCarolinaNativeExportUrl({ reportId, coverHtml: cover.body });
      nativeExports.set(url, reportId);
      await transport.fetchText(url);
      nativeExports.delete(url);
    }
    phase = "closing";
    await fetchNcsbeDocumentInventory(transport, { orgGroupId: input.orgGroupId, sboeId: input.receivingCommitteeId });
    return await finalizeNorthCarolinaReportedReceiptGeneration(generation);
  } catch (error) {
    if (error instanceof NorthCarolinaReportedReceiptSourceError) throw error;
    throw new NorthCarolinaReportedReceiptSourceError("unavailable");
  } finally {
    await closeNorthCarolinaReportedReceiptGeneration(generation).catch(() => {});
  }
}
