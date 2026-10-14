import {
  buildVermontCampaignFinanceApiUrl,
  VermontCampaignFinanceClientError,
  VERMONT_CAMPAIGN_FINANCE_DEFAULT_TIMEOUT_MS,
  type VermontCampaignFinanceClientOptions,
  type VermontFiledReportRow,
} from "./vermontCampaignFinanceClient.js";

/** Uses the public UI's stored-document action; never chooses an edition. */
export async function fetchVermontFiledReportPdf(
  report: Pick<VermontFiledReportRow, "filerReportGuid" | "reportName" | "filerReportVersionId">,
  options: VermontCampaignFinanceClientOptions = {}
): Promise<Buffer> {
  if (!report.filerReportGuid.trim() || !report.reportName.trim() ||
      !Number.isSafeInteger(report.filerReportVersionId) || report.filerReportVersionId <= 0) {
    throw new VermontCampaignFinanceClientError("invalid_request", "Invalid Vermont public report download reference");
  }
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? VERMONT_CAMPAIGN_FINANCE_DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (options.fetchImpl ?? fetch)(buildVermontCampaignFinanceApiUrl("PublicFiledReportAndDownload/DownloadDocument"), {
      method: "POST",
      headers: { accept: "application/pdf", "content-type": "application/json" },
      body: JSON.stringify({ filerReportGuid: report.filerReportGuid, fileName: `${report.reportName} V${report.filerReportVersionId}`, openInNewTab: true }),
      signal: controller.signal,
    });
    if (!response.ok) throw new VermontCampaignFinanceClientError("http_error", `Vermont public report download failed: ${response.status}`, response.status);
    const reader = response.body?.getReader();
    if (!reader) throw new VermontCampaignFinanceClientError("bad_response", "Empty Vermont public report download");
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 20 * 1024 * 1024) throw new VermontCampaignFinanceClientError("bad_response", "Vermont public report PDF exceeds 20 MiB");
        chunks.push(Buffer.from(part.value));
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
    const pdf = Buffer.concat(chunks);
    if (pdf.subarray(0, 5).toString() !== "%PDF-") throw new VermontCampaignFinanceClientError("bad_response", "Vermont public report response was not a PDF");
    return pdf;
  } catch (error) {
    if (error instanceof VermontCampaignFinanceClientError) throw error;
    throw new VermontCampaignFinanceClientError("network_error", `Vermont public report download failed${controller.signal.aborted ? ` after ${timeoutMs}ms` : ""}`);
  } finally {
    clearTimeout(timer);
  }
}
