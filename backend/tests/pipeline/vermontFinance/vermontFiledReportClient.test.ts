import { describe, expect, it, vi } from "vitest";
import { getVermontFiledReports, getVermontContributionDetails, getVermontContributionCategoriesByFilerRegistrationGuid, getVermontTransactionDetailsByGuid } from "../../../src/pipeline/vermontFinance/vermontCampaignFinanceClient.js";
import { fetchVermontFiledReportPdf } from "../../../src/pipeline/vermontFinance/vermontFiledReportClient.js";

const report = {
  filerReportGuid: "report-reference",
  filerFilingCalendarGuid: "calendar-reference",
  filerReportVersionID: 1,
  reportName: "2026 Oct 1 - Disclosures",
  reportType: "Campaign Finance Disclosure Report",
  reportStatus: "Original",
  reportVersion: "Original",
  startDate: "2026-08-30T00:00:00",
  endDate: "2026-09-28T00:00:00",
  dueDate: "2026-10-01T00:00:00",
  filedDate: "2026-10-01T17:42:28",
  isPaperFile: false,
  hasChild: false,
};
const response = (items: unknown[]) => new Response(JSON.stringify({ succeeded: true, data: { items, totalItems: items.length, pageNumber: 0, pageSize: 0 } }));

describe("Vermont public stored report acquisition", () => {
  it("uses the observed profile protocol and retains all editions without ranking them", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response([report, { ...report, filerReportVersionID: 2, reportStatus: "Amended", reportVersion: "Amended", hasChild: true }])) as unknown as typeof fetch;
    const result = await getVermontFiledReports({ filerRegistrationGuid: "receiver", pageNumber: 2, pageSize: 20 }, { fetchImpl });
    expect(result.totalItems).toBe(2);
    expect(result.items.map((r) => [r.filerReportVersionId, r.reportStatus, r.hasChild])).toEqual([[1, "Original", false], [2, "Amended", true]]);
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(String(url)).toBe("https://api.campaignfinance.vermont.gov/api/PublicFilerDetails/GetPublicFilerProfileFiling");
    expect(JSON.parse(String(init?.body))).toEqual({ filerRegistrationGuid: "receiver", pageNumber: 2, pageSize: 20, sortBy: "", sortType: "" });
  });

  it("rejects incomplete report metadata instead of assuming Original/current", async () => {
    for (const patch of [{ reportStatus: null }, { startDate: "" }, { hasChild: null }, { isPaperFile: "false" }, { filerReportVersionID: 1.001 }]) {
      const fetchImpl = vi.fn().mockResolvedValue(response([{ ...report, ...patch }])) as unknown as typeof fetch;
      await expect(getVermontFiledReports({ filerRegistrationGuid: "receiver" }, { fetchImpl })).rejects.toMatchObject({ code: "bad_response" });
    }
  });

  it("downloads the exact observed report/edition through the public UI action", async () => {
    const bytes = Buffer.from("%PDF-1.7\nsource-body\n%%EOF");
    const fetchImpl = vi.fn().mockResolvedValue(new Response(bytes)) as unknown as typeof fetch;
    await expect(fetchVermontFiledReportPdf({ ...report, filerReportVersionId: 1 }, { fetchImpl })).resolves.toEqual(bytes);
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(String(url)).toBe("https://api.campaignfinance.vermont.gov/api/PublicFiledReportAndDownload/DownloadDocument");
    expect(JSON.parse(String(init?.body))).toEqual({ filerReportGuid: "report-reference", fileName: "2026 Oct 1 - Disclosures V1", openInNewTab: true });
  });

  it("preserves download failures and rejects HTML/JSON/empty bodies", async () => {
    for (const body of ["<html>blocked</html>", "{}", ""]) {
      const fetchImpl = vi.fn().mockResolvedValue(new Response(body)) as unknown as typeof fetch;
      await expect(fetchVermontFiledReportPdf({ ...report, filerReportVersionId: 1 }, { fetchImpl })).rejects.toMatchObject({ code: "bad_response" });
    }
    const fetchImpl = vi.fn().mockResolvedValue(new Response("denied", { status: 401 })) as unknown as typeof fetch;
    await expect(fetchVermontFiledReportPdf({ ...report, filerReportVersionId: 1 }, { fetchImpl })).rejects.toMatchObject({ code: "http_error", status: 401 });
  });

  it("bounds streamed PDF bodies before accepting a source document", async () => {
    const bytes = Buffer.alloc(20 * 1024 * 1024 + 1);
    const fetchImpl = vi.fn().mockResolvedValue(new Response(bytes)) as unknown as typeof fetch;
    await expect(fetchVermontFiledReportPdf({ ...report, filerReportVersionId: 1 }, { fetchImpl })).rejects.toMatchObject({ code: "bad_response", message: "Vermont public report PDF exceeds 20 MiB" });
  });

  it("keeps report identity/role/row year intact for independent qualification", async () => {
    const item = { transactionID: 658531, transactionVersionID: 1, guid: "tx", filerRegistrationGuid: "receiver", filerName: "SCOTT, PHIL", transactionAmount: 5180, electionYear: 2024, transactionTypeCode: "TCON", transactionSubTypeCode: "ITMY", transactionSourceTypeCode: "TPAC", filerReportGuid: "report-reference", timedFiledReportGuid: null, hasChild: false };
    const fetchImpl = vi.fn().mockResolvedValue(response([item])) as unknown as typeof fetch;
    await expect(getVermontContributionDetails({ electionId: 45 }, { fetchImpl })).resolves.toMatchObject({ items: [{ electionYear: 2024, transactionTypeCode: "TCON", filerReportGuid: "report-reference", timedFiledReportGuid: null, hasChild: false }] });
  });

  it("rejects subcent detail/category money instead of silently rounding it", async () => {
    for (const value of ["8.005", "90071992547409.90", true]) {
      const detailFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ succeeded: true, data: { transactionID: 1, guid: "tx", valueOfNonMoneyItem: value } }))) as unknown as typeof fetch;
      await expect(getVermontTransactionDetailsByGuid("tx", { fetchImpl: detailFetch })).rejects.toMatchObject({ code: "bad_response" });
      const categoryFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ succeeded: true, data: [{ amount: value, transactionSourceTypeCode: "TPAC", transactionSourceType: "PAC" }] }))) as unknown as typeof fetch;
      await expect(getVermontContributionCategoriesByFilerRegistrationGuid("receiver", { fetchImpl: categoryFetch })).rejects.toMatchObject({ code: "bad_response" });
    }
    for (const data of [[null], [{ amount: 1 }], [{ transactionSourceTypeCode: "TPAC", transactionSourceType: "PAC" }]]) {
      const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ succeeded: true, data }))) as unknown as typeof fetch;
      await expect(getVermontContributionCategoriesByFilerRegistrationGuid("receiver", { fetchImpl })).rejects.toMatchObject({ code: "bad_response" });
    }
  });
});
