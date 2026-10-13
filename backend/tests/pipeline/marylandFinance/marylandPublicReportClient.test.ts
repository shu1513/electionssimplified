import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMarylandPublicReportInventoryRequest, buildMarylandPublishedReportPdfRequest,
  decodeMarylandPublicReportInventory, fetchMarylandCurrentReportInventory, fetchMarylandPublishedReportPdf,
} from "../../../src/pipeline/marylandFinance/marylandPublicReportClient.js";
import {
  captureMarylandPublicReportInventoryPost, captureMarylandPublishedReportPdfPost,
} from "../../../src/pipeline/marylandFinance/marylandCurrentCycleExportClient.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const id = (n: number) => `${String(n).padStart(8, "0")}-2222-4222-8222-222222222222`;
const scope = { filerRegistrationGuid: OWNER, electionCycleId: "12023" };
const request = () => buildMarylandPublicReportInventoryRequest({ ...scope, pageNumber: 1 });
function parent(n = 1, overrides: Record<string, unknown> = {}) {
  return { reportGuid: id(n), reportVersionId: 1, reportName: `Published report ${n}`,
    reportVersion: "Original", reportVersionCode: "RPTFLD", reportType: "Campaign Finance Report", reportTypeCode: "FPCFR",
    filingEntityId: 123, filerRegistrationGuid: OWNER, committeeType: "Candidate Committee", committeeTypeCode: "CC",
    officeSought: "Governor / Lieutenant Governor", officeSoughtId: 40, jurisdiction: "State", jurisdictionId: 1,
    reportingCycle: "2023-2026", reportingCycleId: 12023, reportingYear: 2026,
    startDate: "2026-01-15T00:00:00", endDate: "2026-06-07T00:00:00", dueDate: "2026-06-14T00:00:00",
    filedDate: "2026-06-12T12:34:56.12", zeroActivity: false, hasChild: false, childResults: null,
    createdBy: "excluded-creator", createdIp: "excluded-IP", unknown: "excluded-extra", ...overrides };
}
function child(n = 1, v = 2, overrides: Record<string, unknown> = {}) {
  const p = parent(n);
  return { filerReportGuid: id(n), filerReportVersionID: v, totalRows: 2,
    reportName: p.reportName, reportType: "Disclosure Report", startDate: p.startDate, endDate: p.endDate,
    dueDate: p.dueDate, filedDate: p.filedDate, isCompleted: false, generateStatus: "In-Progress",
    generateStatusCode: "GRPROC", reportStatus: `Version ${v}`, isPaperFile: false, filePath: null, ...overrides };
}
function amended(n = 1, overrides: Record<string, unknown> = {}) {
  return parent(n, { reportVersionId: 2, reportVersion: "Amended", reportVersionCode: "RPTAMD", hasChild: true,
    childResults: [child(n, 9), child(n, 2)], ...overrides });
}
const envelope = (rows: unknown[], totalItems = rows.length) =>
  ({ succeeded: true, error: null, data: { items: rows, totalItems, pageNumber: 0, pageSize: 0 } });
const response = (value: unknown) => new Response(JSON.stringify(value));
const dirs: string[] = [];
async function directory() { const d = await mkdtemp(join(tmpdir(), "md-report-")); dirs.push(d); return d; }
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });

describe("Maryland published report inventory", () => {
  it("uses the exact unrestricted profile request and projects no creator/IP/paths", () => {
    expect(request()).toEqual({ ...scope, pageNumber: 1, pageSize: 10, sortBy: "End Of Period", sortType: "desc" });
    const raw = amended(), decoded = decodeMarylandPublicReportInventory(envelope([raw]), request());
    expect(decoded.reports).toHaveLength(1);
    const p = decoded.reports[0]!;
    expect(JSON.stringify(p)).not.toMatch(/excluded|filePath/);
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.childResults)).toBe(true);
    raw.reportName = "mutated source object";
    expect(p.reportName).toBe("Published report 1");
    expect(decoded).not.toHaveProperty("qualified");
    expect(decoded).not.toHaveProperty("current");
  });
  it("binds the exact parent/child version despite a higher historical version and incomplete generation flag", () => {
    const p = decodeMarylandPublicReportInventory(envelope([amended()]), request()).reports[0]!;
    expect(p.childResults).toHaveLength(2);
    expect(buildMarylandPublishedReportPdfRequest(p)).toEqual({ documentGuid: id(1),
      fileName: "Published report 1 V2", openInNewTab: true });
    expect(p.reportType).toBe("Campaign Finance Report");
    expect(p.childResults![1]!.reportType).toBe("Disclosure Report");
  });
  it("preserves the literal Original Vundefined handler without a PDF extension or guessed version", () => {
    const p = decodeMarylandPublicReportInventory(envelope([parent()]), request()).reports[0]!;
    expect(buildMarylandPublishedReportPdfRequest(p)).toEqual({ documentGuid: id(1),
      fileName: "Published report 1 Vundefined", openInNewTab: true });
    expect(() => decodeMarylandPublicReportInventory(envelope([parent(1, { filerReportVersionID: 1 })]), request()))
      .toThrow("invalid_report_inventory");
  });
  it.each([
    { childResults: [child(1, 3), child(1, 4)] },
    { childResults: [child(1, 2), child(1, 2)] },
    { childResults: [child(1, 2, { totalRows: 3 }), child(1, 1)] },
    { childResults: null }, { hasChild: false },
    { childResults: [child(1, 1), child(1, 2, { endDate: "2026-06-06T00:00:00" })] },
    { childResults: [child(1, 1), child(1, 2, { filedDate: "2026-06-13T12:34:56.12" })] },
  ])("holds missing, duplicate, incomplete or changed current child: %j", override => {
    expect(() => decodeMarylandPublicReportInventory(envelope([amended(1, override)]), request())).toThrow("invalid_report_inventory");
  });
  it.each([
    { filerRegistrationGuid: id(2) }, { reportingCycleId: 12019 }, { reportGuid: "" },
    { startDate: "2026-02-30T00:00:00" }, { filedDate: "2026-06-12T12:34:56Z" },
    { zeroActivity: "false" }, { reportVersionCode: "RPTAMD" },
  ])("holds malformed scope, dates or financial metadata: %j", override => {
    expect(() => decodeMarylandPublicReportInventory(envelope([parent(1, override)]), request())).toThrow("invalid_report_inventory");
  });
  it("requires exact requested physical page cardinality rather than the server's zero echoes", () => {
    expect(decodeMarylandPublicReportInventory(envelope([parent()]), request()).totalItems).toBe(1);
    expect(() => decodeMarylandPublicReportInventory(envelope([parent()], 11), request())).toThrow("invalid_report_inventory");
    expect(() => decodeMarylandPublicReportInventory(envelope([parent(), parent()]), request())).toThrow("invalid_report_inventory");
    expect(() => decodeMarylandPublicReportInventory({ succeeded: false, error: null, data: {} }, request())).toThrow("invalid_report_inventory");
  });
  it("collects every requested page and returns only original refs and counts", async () => {
    const outputDirectory = await directory(), first = Array.from({ length: 10 }, (_, i) => parent(i + 1));
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response(envelope(first, 11)))
      .mockResolvedValueOnce(response(envelope([amended(11)], 11)));
    const r = await fetchMarylandCurrentReportInventory({ ...scope, outputDirectory, fetchImpl });
    expect(r).toMatchObject({ totalItems: 11, physicalCount: 11, childCount: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.map(c => JSON.parse(c[1]!.body as string).pageNumber)).toEqual([1, 2]);
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://api-campaignfinance.maryland.gov/api/PublicFilerDetails/GetCfPublicProfileFiling");
    expect(JSON.stringify(r)).not.toMatch(/Published report|excluded|requestBody|filerRegistrationGuid/);
    expect(await stat(r.captures[0]!.outputPath).then(s => s.mode & 0o777)).toBe(0o600);
  });
  it.each(["count_drift", "duplicate_parent", "duplicate_lineage", "empty_page", "page_limit"])("holds whole inventory on %s", async kind => {
    const first = Array.from({ length: 10 }, (_, i) => parent(i + 1));
    let second: unknown[] = [parent(11)], total = 11;
    if (kind === "count_drift") total = 12;
    if (kind === "duplicate_parent") second = [parent(1)];
    if (kind === "duplicate_lineage") second = [amended(11, { childResults: [child(1, 1), child(11, 2)] })];
    if (kind === "empty_page") second = [];
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response(envelope(first, 11)))
      .mockResolvedValueOnce(response(envelope(second, total)));
    await expect(fetchMarylandCurrentReportInventory({ ...scope, outputDirectory: await directory(), fetchImpl,
      maxPages: kind === "page_limit" ? 1 : 100 })).rejects.toMatchObject({ code: "invalid_report_inventory" });
    expect(fetchImpl).toHaveBeenCalledTimes(kind === "page_limit" ? 1 : 2);
  });
  it("records a structurally empty inventory without granting empty financial authority", async () => {
    const r = await fetchMarylandCurrentReportInventory({ ...scope, outputDirectory: await directory(),
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response(envelope([]))) });
    expect(r).toMatchObject({ totalItems: 0, physicalCount: 0, childCount: 0 });
    expect(r).not.toHaveProperty("qualified");
  });
  it("rejects extra request filters before any fetch and isolates mutation after start", async () => {
    const outputPath = join(await directory(), "original.json"), fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(envelope([parent()])));
    expect(() => captureMarylandPublicReportInventoryPost({ ...request(), reportName: "positive subset" } as never,
      { outputPath, fetchImpl })).toThrow("invalid_request");
    expect(fetchImpl).not.toHaveBeenCalled();
    const mutable = { ...request() }, pending = captureMarylandPublicReportInventoryPost(mutable, { outputPath, fetchImpl });
    mutable.pageNumber = 99; mutable.filerRegistrationGuid = id(99);
    const capture = await pending;
    expect(capture.requestBody).toEqual(request());
    expect(JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string)).toEqual(request());
  });
  it("retains a bad UTF-8 original but holds decoding and callback failures", async () => {
    const outputDirectory = await directory();
    await expect(fetchMarylandCurrentReportInventory({ ...scope, outputDirectory,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(Uint8Array.from([255]))) }))
      .rejects.toMatchObject({ code: "invalid_report_inventory" });
    expect(await readFile(join(outputDirectory, "page-001.original.json"))).toEqual(Buffer.from([255]));
    await expect(fetchMarylandCurrentReportInventory({ ...scope, outputDirectory: await directory(),
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response(envelope([parent()]))), onCapture: () => { throw Error("observer failed"); } }))
      .rejects.toMatchObject({ code: "capture_callback_failed" });
  });
});

describe("Maryland report PDF original capture", () => {
  const body = { documentGuid: id(1), fileName: "Published report 1 Vundefined", openInNewTab: true as const };
  it("retains PDF bytes through EOF with the closed published body and no selector in ordinary result", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("%PDF-1.7\noriginal bytes\n%%EOF"));
    const r = await fetchMarylandPublishedReportPdf({ request: body, outputPath: join(await directory(), "original.pdf"), fetchImpl });
    expect(r.capture).toMatchObject({ httpStatus: 200, bodyComplete: true, errorCode: null });
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://api-campaignfinance.maryland.gov/api/PublicFiledReportAndDownload/DownloadDocument");
    expect(JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string)).toEqual(body);
    expect(JSON.stringify(r)).not.toMatch(/documentGuid|Published report|requestBody/);
  });
  it("retains an HTML/error original without treating it as a PDF", async () => {
    const outputPath = join(await directory(), "original.pdf");
    await expect(fetchMarylandPublishedReportPdf({ request: body, outputPath,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response("<html>error</html>")) }))
      .rejects.toMatchObject({ code: "invalid_report_document" });
    expect(await readFile(outputPath, "utf8")).toBe("<html>error</html>");
  });
  it("rejects extra fields and oversize settings before fetch; partial bytes survive a cap failure", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("%PDF-1.7\ncontent")), outputPath = join(await directory(), "original.pdf");
    expect(() => captureMarylandPublishedReportPdfPost({ ...body, arbitrary: true } as never, { outputPath, fetchImpl })).toThrow("invalid_request");
    await expect(fetchMarylandPublishedReportPdf({ request: body, outputPath, fetchImpl, maxBytes: 65 * 1024 * 1024 }))
      .rejects.toMatchObject({ code: "invalid_request" });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(fetchMarylandPublishedReportPdf({ request: body, outputPath, fetchImpl, maxBytes: 6 }))
      .rejects.toMatchObject({ code: "body_limit" });
    expect(await readFile(outputPath, "utf8")).toBe("%PDF-1");
  });
});
