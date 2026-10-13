import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireVermontCommitteeCash,
  type VermontCommitteeCashResponseCapture,
} from "../../../src/pipeline/vermontFinance/vermontCommitteeCashAcquisition.js";
import { readVermontReportControlPdf } from "../../../src/pipeline/vermontFinance/vermontReportControlPdfParser.js";

vi.mock(
  "../../../src/pipeline/vermontFinance/vermontReportControlPdfParser.js",
  () => ({
    readVermontReportControlPdf: vi.fn(),
  }),
);
const context = {
  filerRegistrationGuid: "source-account",
  entityId: 91,
  receivingFilerName: "DOE, JANE",
  candidateName: "Jane Doe",
  officeId: 19,
  officeName: "Governor",
  electionDate: "2026-11-03",
  electionType: "general" as const,
};
const report = {
  filerReportGuid: "report-source",
  filerFilingCalendarGuid: "calendar-source",
  filerReportVersionID: 2,
  reportName: "Disclosure",
  reportType: "Campaign Finance Disclosure Report",
  reportStatus: "Amended",
  reportVersion: "Amendment 1",
  startDate: "2026-01-01T00:00:00",
  endDate: "2026-09-28T00:00:00",
  dueDate: "2026-10-01T00:00:00",
  filedDate: "2026-10-01T12:00:00",
  isPaperFile: false,
  hasChild: true,
};
function transaction(id: number, type = "TCON") {
  return {
    transactionID: id,
    transactionVersionID: 1,
    guid: `transaction-${id}`,
    filerRegistrationGuid: context.filerRegistrationGuid,
    filerName: context.receivingFilerName,
    transactionAmount: 100,
    transactionDate: "09/22/2026",
    transactionTypeCode: type,
    transactionSubTypeCode: "ITMY",
    transactionSourceTypeCode: "TPAC",
    sourceName: "Example PAC",
    entityId: 91,
    entityID: 91,
    officeID: 19,
    electionId: 97,
    electionYear: 2026,
    filerReportGuid: report.filerReportGuid,
    retainedFinancialField: "literal",
    transactionCategoryCode: type === "TEXP" ? "PURC" : null,
  };
}
function protocol(
  over: {
    reports?: Record<string, unknown>[];
    cash?: Record<string, unknown>[];
    expenses?: Record<string, unknown>[];
    closingElectionId?: number;
    mutate?: (
      path: string,
      fields: Record<string, unknown>,
      data: unknown,
    ) => unknown;
  } = {},
) {
  let lookupCount = 0;
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    vi.setSystemTime(Date.now() + 1000);
    const path = new URL(String(url)).pathname;
    const fields = init?.body ? JSON.parse(String(init.body)) : {};
    let data: unknown;
    if (path.endsWith("GetElectionLookup")) {
      lookupCount++;
      data = {
        succeeded: true,
        data: [
          {
            value: lookupCount > 1 ? (over.closingElectionId ?? 97) : 97,
            name: "2026  Nov 03 - General Election",
          },
        ],
        error: null,
      };
    } else if (path.endsWith("DownloadDocument"))
      return new Response(`%PDF-${fields.fileName}`, { status: 200 });
    else {
      const rows = path.endsWith("GetPublicFilerProfileFiling")
        ? (over.reports ?? [report])
        : path.endsWith("GetContributionsDetails")
          ? (over.cash ?? [transaction(1), transaction(2)])
          : (over.expenses ?? [transaction(3, "TEXP")]);
      const start = (Number(fields.pageNumber) - 1) * Number(fields.pageSize);
      data = {
        succeeded: true,
        data: {
          items: rows.slice(start, start + Number(fields.pageSize)),
          totalItems: rows.length,
          pageNumber: 0,
          pageSize: 0,
        },
        error: null,
      };
    }
    return new Response(
      JSON.stringify(over.mutate?.(path, fields, data) ?? data),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-12T12:00:00Z"));
  vi.mocked(readVermontReportControlPdf).mockImplementation(async (bytes) => {
    vi.setSystemTime(Date.now() + 60_000);
    return {
      pdfSha256: createHash("sha256").update(bytes).digest("hex"),
      byteCount: bytes.byteLength,
      pageCount: 3,
      reportName: "Disclosure",
    } as Awaited<ReturnType<typeof readVermontReportControlPdf>>;
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("fresh Vermont committee cash acquisition", () => {
  it("builds complete nested exact-GUID packets using the dynamic lookup and all raw fields", async () => {
    const fetchImpl = protocol();
    const captures: VermontCommitteeCashResponseCapture[] = [];
    const result = await acquireVermontCommitteeCash({
      context,
      fetchImpl,
      pageSize: 1,
      onCapture: (capture) => {
        captures.push(capture);
      },
    });
    expect(result.context.sourceElection.electionId).toBe(97);
    expect(result.before.queries.contributions).toHaveLength(2);
    expect(result.after.queries.contributions).toHaveLength(2);
    expect(
      result.before.queries.contributions
        .flatMap((page) => page.response.items)
        .map((row) => row.transactionID),
    ).toEqual([1, 2]);
    expect(
      result.before.queries.contributions[0]!.response.items[0]!
        .retainedFinancialField,
    ).toBe("literal");
    expect(
      result.before.queries.expenditures[0]!.response.items[0]!
        .transactionCategoryCode,
    ).toBe("PURC");
    const opening = [
      ...Object.values(result.before.queries).flat(),
      ...result.before.reports,
    ].map((row) => row.capture);
    const closing = [
      ...Object.values(result.after.queries).flat(),
      ...result.after.reports,
    ].map((row) => row.capture);
    expect(
      Math.max(...opening.map((row) => Date.parse(row.completedAt))),
    ).toBeLessThanOrEqual(
      Math.min(...closing.map((row) => Date.parse(row.startedAt))),
    );
    expect(result.observedAt.toISOString()).toBe(captures.at(-1)!.completedAt);
    expect(Date.now()).toBeGreaterThan(result.observedAt.getTime()); // PDF extraction happened later.
    for (const capture of captures) {
      expect(capture.sha256).toBe(
        createHash("sha256").update(capture.body).digest("hex"),
      );
      expect(capture.byteCount).toBe(capture.body.byteLength);
      expect(capture).not.toHaveProperty("headers");
    }
    for (const query of [
      ...result.before.queries.contributions,
      ...result.after.queries.expenditures,
    ]) {
      expect(query.request.body).toMatchObject({
        filerRegistrationGuid: context.filerRegistrationGuid,
        filerName: context.receivingFilerName,
        electionID: 97,
        sortType: "desc",
      });
      expect(query.request.body).not.toHaveProperty("electionYear");
    }
    expect(result.before.reports[0]!.request.body).toEqual({
      filerReportGuid: report.filerReportGuid,
      fileName: "Disclosure V2",
      openInNewTab: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(12);
    expect(vi.mocked(readVermontReportControlPdf)).toHaveBeenCalledTimes(2);
  });
  it("retains all published regular editions without an Original-only or latest-date gate", async () => {
    const reports = [
      report,
      {
        ...report,
        filerReportGuid: "other-period",
        reportName: "Other disclosure",
        filerReportVersionID: 1,
        reportStatus: "Original",
      },
    ];
    const result = await acquireVermontCommitteeCash({
      context,
      fetchImpl: protocol({ reports }),
    });
    expect(result.before.reports).toHaveLength(2);
    expect(result.after.reports).toHaveLength(2);
    expect(result.before.queries.reports[0]!.response.items).toEqual(reports);
  });
  it("returns explicit empty source arrays without authoring monetary-zero authority", async () => {
    const result = await acquireVermontCommitteeCash({
      context,
      fetchImpl: protocol({ reports: [], cash: [], expenses: [] }),
    });
    expect(result.before.queries.contributions[0]!.response).toEqual({
      items: [],
      totalItems: 0,
    });
    expect(result.before.reports).toEqual([]);
    expect(result).not.toHaveProperty("pacDonors");
    expect(result).not.toHaveProperty("verified");
  });
  it.each([0, 1001, 1.5])(
    "rejects invalid page bounds before fetching (%s)",
    async (pageSize) => {
      const fetchImpl = protocol();
      await expect(
        acquireVermontCommitteeCash({ context, fetchImpl, pageSize }),
      ).rejects.toThrow(/bounds/);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );
  it("rejects a prior validated election mapping mismatch and closing scope drift", async () => {
    const fetchImpl = protocol();
    await expect(
      acquireVermontCommitteeCash({
        context: { ...context, sourceElectionId: 45 },
        fetchImpl,
      }),
    ).rejects.toThrow(/conflicts/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(
      acquireVermontCommitteeCash({
        context,
        fetchImpl: protocol({ closingElectionId: 98 }),
      }),
    ).rejects.toThrow(/changed/);
  });
  it("fails incomplete cash pagination without a partial result or fabricated closing", async () => {
    const fetchImpl = protocol({
      mutate: (path, fields, data) =>
        path.endsWith("GetContributionsDetails") && fields.pageNumber === 2
          ? { succeeded: true, data: { items: [], totalItems: 2 }, error: null }
          : data,
    });
    await expect(
      acquireVermontCommitteeCash({ context, fetchImpl, pageSize: 1 }),
    ).rejects.toThrow(/physical page/);
    expect(vi.mocked(readVermontReportControlPdf)).not.toHaveBeenCalled();
  });
  it("rejects repeated report editions across pages and bounded request exhaustion", async () => {
    await expect(
      acquireVermontCommitteeCash({
        context,
        pageSize: 1,
        fetchImpl: protocol({ reports: [report, report] }),
      }),
    ).rejects.toThrow(/repeated edition/);
    await expect(
      acquireVermontCommitteeCash({
        context,
        fetchImpl: protocol(),
        maxRequests: 2,
      }),
    ).rejects.toThrow();
  });
  it("journals source HTTP failure and never uses cached or opening PDFs for a failed close", async () => {
    const source = protocol();
    let pdfs = 0;
    const captures: VermontCommitteeCashResponseCapture[] = [];
    const fetchImpl = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).endsWith("DownloadDocument") && ++pdfs === 2)
          return new Response("unavailable", { status: 503 });
        return source(url, init);
      },
    ) as unknown as typeof fetch;
    await expect(
      acquireVermontCommitteeCash({
        context,
        fetchImpl,
        onCapture: (capture) => {
          captures.push(capture);
        },
      }),
    ).rejects.toThrow(/503/);
    expect(captures.at(-1)!.httpStatus).toBe(503);
    expect(vi.mocked(readVermontReportControlPdf)).not.toHaveBeenCalled();
  });
  it("captures bounded network failure without exposing original error contents", async () => {
    const captures: VermontCommitteeCashResponseCapture[] = [];
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new Error("private-error-content"));
    await expect(
      acquireVermontCommitteeCash({
        context,
        fetchImpl,
        onCapture: (capture) => {
          captures.push(capture);
        },
      }),
    ).rejects.toThrow();
    expect(captures[0]!.error).toBe("request_failed");
    expect(JSON.stringify(captures)).not.toContain("private-error-content");
  });
  it("isolates original bytes and request fields from a mutable capture sink", async () => {
    const result = await acquireVermontCommitteeCash({
      context,
      fetchImpl: protocol(),
      onCapture: (capture) => {
        capture.body.fill(0);
        capture.requestFields.filerRegistrationGuid = "mutated";
      },
    });
    expect(
      result.before.queries.contributions[0]!.request.body
        .filerRegistrationGuid,
    ).toBe(context.filerRegistrationGuid);
    expect(result.before.queries.contributions[0]!.response.items).toHaveLength(
      2,
    );
  });
  it("snapshots canonical context and transport callbacks before acquisition awaits", async () => {
    const original = protocol();
    const captures: VermontCommitteeCashResponseCapture[] = [];
    const options = {
      context: {
        ...context,
        sourceElection: {
          electionId: 97,
          name: "2026 Nov 03 - General Election",
        },
      },
      fetchImpl: original,
      onCapture: (capture: VermontCommitteeCashResponseCapture) => {
        captures.push(capture);
        options.context.filerRegistrationGuid = "changed-account";
        options.context.receivingFilerName = "CHANGED, OWNER";
        options.context.entityId = 999;
        options.context.sourceElection.electionId = 98;
        options.fetchImpl = vi
          .fn()
          .mockRejectedValue(new Error("changed transport"));
        options.onCapture = () => {
          throw new Error("changed sink");
        };
      },
    };
    const result = await acquireVermontCommitteeCash(options);
    expect(result.context).toMatchObject(context);
    expect(result.context.sourceElection.electionId).toBe(97);
    expect(
      result.before.queries.contributions[0]!.request.body
        .filerRegistrationGuid,
    ).toBe(context.filerRegistrationGuid);
    expect(result.after.queries.expenditures[0]!.request.body.filerName).toBe(
      context.receivingFilerName,
    );
    expect(captures).toHaveLength(10);
    expect(original).toHaveBeenCalledTimes(10);
  });

  it("enforces the 20MiB body cap and retains a failed capture", async () => {
    const captures: VermontCommitteeCashResponseCapture[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(new Uint8Array(20 * 1024 * 1024 + 1)));
    await expect(
      acquireVermontCommitteeCash({
        context,
        fetchImpl,
        onCapture: (capture) => {
          captures.push(capture);
        },
      }),
    ).rejects.toThrow();
    expect(captures[0]!.error).toBe("body_limit");
    expect(captures[0]!.byteCount).toBeLessThanOrEqual(20 * 1024 * 1024);
  });
});
