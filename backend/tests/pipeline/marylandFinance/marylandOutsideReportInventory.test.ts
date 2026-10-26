import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMarylandPublicReportInventoryRequest,
  buildMarylandPublishedOutsideReportPdfRequest,
  decodeMarylandPublishedOutsideReport,
  decodeMarylandPublishedReport,
  decodeMarylandPublicOutsideReportInventory,
  fetchMarylandCurrentOutsideReportInventory,
  readMarylandCurrentOutsideReportInventory,
  readMarylandCurrentReportInventory,
} from "../../../src/pipeline/marylandFinance/marylandPublicReportClient.js";
const owner = "11111111-1111-4111-8111-111111111111";
const reportGuid = "22222222-2222-4222-8222-222222222222";
const request = buildMarylandPublicReportInventoryRequest({
  filerRegistrationGuid: owner,
  electionCycleId: "12023",
  pageNumber: 1,
});
function parent(extra: Record<string, unknown> = {}) {
  return {
    reportGuid,
    reportVersionId: 1,
    reportName: "Published outside report",
    reportVersion: "Original",
    reportVersionCode: "RPTFLD",
    reportType: "Campaign Finance Transaction Detail Report",
    reportTypeCode: "FPCFTDR",
    filingEntityId: 7,
    filerRegistrationGuid: owner,
    committeeType: "Independent Expenditure Committee",
    committeeTypeCode: "IEC",
    officeSought: null,
    officeSoughtId: null,
    jurisdiction: null,
    jurisdictionId: null,
    reportingCycle: "2023-2026",
    reportingCycleId: 12023,
    reportingYear: 2026,
    startDate: "2026-08-19T00:00:00",
    endDate: "2026-10-18T00:00:00",
    dueDate: "2026-10-23T00:00:00",
    filedDate: "2026-10-22T12:00:00",
    zeroActivity: false,
    hasChild: false,
    childResults: null,
    isActive: true,
    createdBy: "not projected",
    createdIp: "not projected",
    ...extra,
  };
}
function child(version: number) {
  const p = parent();
  return {
    filerReportGuid: reportGuid,
    filerReportVersionID: version,
    totalRows: 2,
    reportName: p.reportName,
    reportType: "Disclosure Report",
    startDate: p.startDate,
    endDate: p.endDate,
    dueDate: p.dueDate,
    filedDate: p.filedDate,
    isCompleted: false,
    generateStatus: "In-Progress",
    generateStatusCode: "GRPROC",
    reportStatus: `Version ${version}`,
    isPaperFile: false,
  };
}
const envelope = (rows: unknown[], totalItems = rows.length) => ({
  succeeded: true,
  error: null,
  data: { items: rows, totalItems, pageNumber: 0, pageSize: 0 },
});
describe("Maryland outside-payer report inventory facts", () => {
  it("retains published null payer context without inventing a candidate office", () => {
    const result = decodeMarylandPublicOutsideReportInventory(
      envelope([parent()]),
      request,
    );
    expect(result.reports[0]).toMatchObject({
      officeSought: null,
      officeSoughtId: null,
      jurisdiction: null,
      jurisdictionId: null,
      isActive: true,
      committeeTypeCode: "IEC",
    });
    expect(Object.isFrozen(result.reports[0])).toBe(true);
    expect(JSON.stringify(result)).not.toContain("not projected");
    for (const key of [
      "qualified",
      "financialAuthority",
      "candidateId",
      "amount",
    ])
      expect(result.reports[0]).not.toHaveProperty(key);
    expect(() => decodeMarylandPublishedReport(parent(), request)).toThrow(
      "invalid_report_inventory",
    );
  });
  it("keeps complete candidate context mandatory in the receiving decoder", () => {
    const r = parent({
      committeeType: "Candidate",
      committeeTypeCode: "CC",
      officeSought: "Governor",
      officeSoughtId: 40,
      jurisdiction: "Maryland State",
      jurisdictionId: 1,
    });
    expect(decodeMarylandPublishedReport(r, request).officeSoughtId).toBe(40);
    expect(() => decodeMarylandPublishedOutsideReport(r, request)).toThrow();
  });
  it.each([
    { officeSoughtId: 0 },
    { officeSoughtId: 40 },
    { officeSought: "Governor" },
    { jurisdictionId: 0 },
    { jurisdiction: "Maryland State" },
    { officeSought: undefined },
    { committeeTypeCode: "NEW" },
    { isActive: undefined },
    { isActive: "true" },
    { filerRegistrationGuid: reportGuid },
    { reportingCycleId: 12019 },
    { zeroActivity: null },
    { endDate: "2026-08-18T00:00:00" },
    { reportVersion: "Latest" },
  ])(
    "holds malformed context, wrong scope or unproved report state %j",
    (extra) => {
      expect(() =>
        decodeMarylandPublishedOutsideReport(parent(extra), request),
      ).toThrow("invalid_report_inventory");
    },
  );
  it("retains explicit inactive metadata without declaring a current financial zero", () => {
    const result = decodeMarylandPublishedOutsideReport(
      parent({ isActive: false, zeroActivity: true }),
      request,
    );
    expect(result.isActive).toBe(false);
    expect(result.zeroActivity).toBe(true);
    expect(result).not.toHaveProperty("financialZeroAuthority");
  });
  it("binds amendment PDF by exact parent/child equality, never maximum version", () => {
    const raw = parent({
      reportVersionId: 2,
      reportVersion: "Amended",
      reportVersionCode: "RPTAMD",
      hasChild: true,
      childResults: [child(9), child(2)],
    });
    const decoded = decodeMarylandPublishedOutsideReport(raw, request);
    expect(decoded.reportVersionId).toBe(2);
    expect(buildMarylandPublishedOutsideReportPdfRequest(decoded)).toEqual({
      documentGuid: reportGuid,
      fileName: "Published outside report V2",
      openInNewTab: true,
    });
  });
  it("preserves the literal original download handler filename without extension", () => {
    expect(
      buildMarylandPublishedOutsideReportPdfRequest(
        decodeMarylandPublishedOutsideReport(parent(), request),
      ),
    ).toEqual({
      documentGuid: reportGuid,
      fileName: "Published outside report Vundefined",
      openInNewTab: true,
    });
  });
  it.each(["missing_current", "period", "repeat", "contradictory_kind"])(
    "holds invalid amended lineage %s",
    (kind) => {
      const a = child(9),
        b = child(2),
        raw = parent({
          reportVersionId: 2,
          reportVersion: "Amended",
          reportVersionCode: "RPTAMD",
          hasChild: true,
          childResults: [a, b],
        });
      if (kind === "missing_current") b.filerReportVersionID = 3;
      if (kind === "period") b.endDate = "2026-10-17T00:00:00";
      if (kind === "repeat") a.filerReportVersionID = 2;
      if (kind === "contradictory_kind") raw.hasChild = false;
      expect(() => decodeMarylandPublishedOutsideReport(raw, request)).toThrow(
        "invalid_report_inventory",
      );
    },
  );
  it("rejects repeated parents, missing interior rows and wrong page echoes", () => {
    expect(() =>
      decodeMarylandPublicOutsideReportInventory(
        envelope([parent(), parent()]),
        request,
      ),
    ).toThrow();
    expect(() =>
      decodeMarylandPublicOutsideReportInventory(
        envelope([parent()], 11),
        request,
      ),
    ).toThrow();
    const v = envelope([parent()]);
    v.data.pageNumber = 2;
    v.data.pageSize = 10;
    expect(() =>
      decodeMarylandPublicOutsideReportInventory(v, request),
    ).toThrow();
  });
});

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
describe("normal Maryland outside-payer report source generations", () => {
  it("collects all pages, retains genuine private journal and replays all nullable payer records", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "md-outside-report-"));
    directories.push(outputDirectory);
    const id = (n: number) =>
      `${String(n).padStart(8, "0")}-3333-4333-8333-333333333333`;
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const page = JSON.parse(String(init!.body)).pageNumber;
      const count = page === 1 ? 10 : 1;
      return new Response(
        JSON.stringify(
          envelope(
            Array.from({ length: count }, (_, i) =>
              parent({ reportGuid: id((page - 1) * 10 + i + 1) }),
            ),
            11,
          ),
        ),
      );
    });
    const source = await fetchMarylandCurrentOutsideReportInventory({
      filerRegistrationGuid: owner,
      electionCycleId: "12023",
      outputDirectory,
      fetchImpl,
    });
    expect(source).toMatchObject({
      totalItems: 11,
      physicalCount: 11,
      childCount: 0,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(
      (await readFile(join(outputDirectory, "captures.private.jsonl"), "utf8"))
        .trim()
        .split("\n"),
    ).toHaveLength(2);
    const saved = await readMarylandCurrentOutsideReportInventory({
      filerRegistrationGuid: owner,
      electionCycleId: "12023",
      outputDirectory,
    });
    expect(saved.sourceFacts).toMatchObject({
      totalItems: 11,
      physicalCount: 11,
      childCount: 0,
    });
    expect(saved.privateReports.every((r) => r.officeSoughtId === null)).toBe(
      true,
    );
    expect(JSON.stringify(saved.sourceFacts)).not.toMatch(
      /Published outside report|11111111/,
    );
    expect(saved).not.toHaveProperty("financialAuthority");
    await expect(
      readMarylandCurrentReportInventory({
        filerRegistrationGuid: owner,
        electionCycleId: "12023",
        outputDirectory,
      }),
    ).rejects.toMatchObject({ code: "invalid_report_inventory" });
    await writeFile(source.captures[0]!.outputPath, "{}");
    await expect(
      readMarylandCurrentOutsideReportInventory({
        filerRegistrationGuid: owner,
        electionCycleId: "12023",
        outputDirectory,
      }),
    ).rejects.toMatchObject({ code: "invalid_report_inventory" });
  });
  it("retains failed public originals without declaring an empty inventory", async () => {
    const outputDirectory = await mkdtemp(
      join(tmpdir(), "md-outside-report-failure-"),
    );
    directories.push(outputDirectory);
    await expect(
      fetchMarylandCurrentOutsideReportInventory({
        filerRegistrationGuid: owner,
        electionCycleId: "12023",
        outputDirectory,
        fetchImpl: async () =>
          new Response("source unavailable", { status: 503 }),
      }),
    ).rejects.toMatchObject({ code: "http_status" });
    expect(
      await readFile(join(outputDirectory, "page-001.original.json"), "utf8"),
    ).toBe("source unavailable");
    await expect(
      readMarylandCurrentOutsideReportInventory({
        filerRegistrationGuid: owner,
        electionCycleId: "12023",
        outputDirectory,
      }),
    ).rejects.toMatchObject({ code: "invalid_report_inventory" });
  });
});
