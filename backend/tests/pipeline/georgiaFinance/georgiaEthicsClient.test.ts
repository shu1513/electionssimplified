import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildGeorgiaCandidateIndexRequestBody,
  buildGeorgiaFilerReportRequestBody,
  buildGeorgiaIndependentExpenditureRequestBody,
  buildGeorgiaTransactionRequestBody,
  buildGeorgiaReportInventory,
  createGeorgiaEthicsTransport,
  fetchGeorgiaCandidateIndexRows,
  fetchGeorgiaFiledReportRows,
  fetchGeorgiaIndependentExpenditureRows,
  fetchGeorgiaTransactionRows,
  fetchGeorgiaTransactionRowsStable,
  fetchGeorgiaTransactionRowsWindowed,
  formatGeorgiaFilterDate,
  georgiaTransactionReportGroupGuid,
  GeorgiaEthicsClientError,
  GEORGIA_ETHICS_PAGE_SIZE,
  GEORGIA_ZERO_GUID,
  isGeorgiaRecognizedTransactionStatus,
  normalizeGeorgiaReportFamily,
  type GeorgiaEthicsTransport,
  type GeorgiaFiledReportRow,
} from "../../../src/pipeline/georgiaFinance/georgiaEthicsClient.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/georgiaFinance");

function fixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf-8");
}

function transportFromResponses(
  responses: Array<{ status?: number; body: string }>,
  calls: Array<{ url: string; body: string }> = []
): GeorgiaEthicsTransport {
  let index = 0;
  return createGeorgiaEthicsTransport({
    sleep: async () => {},
    fetch: async (url, body) => {
      calls.push({ url, body });
      const response = responses[Math.min(index, responses.length - 1)]!;
      index += 1;
      return { status: response.status ?? 200, body: response.body };
    },
  });
}

function pageBody(items: unknown[]): string {
  return JSON.stringify({ data: { items }, succeeded: true, error: null });
}

function transactionItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    guid: "d67d1da2-5d3e-476d-a022-0c8deace85bf",
    transactionId: 10284,
    transactionAmount: 2800.0,
    filerEntityId: 100035,
    filerRegistrationGuid: "d973ab3b-54c2-416e-81ce-f5b1ee9a6f57",
    filerReportGuid: "7d5e2ef2-e1b5-4bc9-a555-13f6392f4199",
    timedFiledReportGuid: null,
    filerReportId: 37,
    filerReportVersionId: 1,
    transactionDate: "11/22/2024",
    sourceName: "Paul Thomas Kim",
    payeeOccupation: "Other",
    payeeEmployer: "Securities and Exchange Comm",
    transactionTypeCode: "TCON",
    transactionSubTypeCode: "ITMY",
    transactionSubTypeDesc: "Itemized Contribution",
    transactionSourceTypeCode: "TBSN",
    transactionStatusCode: "TFIL",
    reportName: "Campaign Contribution Disclosure Report",
    electionYear: 2026,
    ...overrides,
  };
}

describe("request bodies", () => {
  it("pins the candidate-index body to the spike-verified shape", () => {
    const body = JSON.parse(buildGeorgiaCandidateIndexRequestBody({ filerName: "Carr", pageNumber: 1 }));
    expect(body).toMatchObject({
      pageNumber: 1,
      pageSize: GEORGIA_ETHICS_PAGE_SIZE,
      filerTypeCode: "RC",
      filerName: "Carr",
      politicalPartyCode: null,
      OfficeSought: null,
      jurisdictionIsStateOrIsCounty: null,
    });
    expect(Object.keys(body)).toHaveLength(22);
  });

  it("pins the filed-report body to the spike-verified shape", () => {
    const body = JSON.parse(buildGeorgiaFilerReportRequestBody({ filerName: "Carr, Christopher", pageNumber: 2 }));
    expect(body).toMatchObject({
      pageNumber: 2,
      pageSize: GEORGIA_ETHICS_PAGE_SIZE,
      filerTypeCode: "",
      filerName: "Carr, Christopher",
      reportStatus: null,
      reportVersion: "",
    });
    expect(Object.keys(body)).toHaveLength(21);
  });

  it("pins the transaction body: sortBy Transaction Date, TCON, host-dialect dates", () => {
    const peachfile = JSON.parse(
      buildGeorgiaTransactionRequestBody(
        "peachfile",
        { filerName: "Carr for Georgia", fromDate: "2025-07-01", toDate: "2026-01-31" },
        3
      )
    );
    expect(peachfile).toMatchObject({
      pageNumber: 3,
      pageSize: GEORGIA_ETHICS_PAGE_SIZE,
      sortBy: "Transaction Date",
      sortType: "desc",
      transactionTypeCode: "TCON",
      filerName: "Carr for Georgia",
      fromDate: "07/01/2025",
      toDate: "01/31/2026",
      electionYear: "",
    });
    expect(Object.keys(peachfile)).toHaveLength(17);

    const archive = JSON.parse(
      buildGeorgiaTransactionRequestBody(
        "efile_archive",
        { filerName: "Carr, Christopher Michael", fromDate: "2024-07-02", toDate: null },
        1
      )
    );
    expect(archive.fromDate).toBe("2024-07-02");
    expect(archive.toDate).toBeNull();
  });

  it("rejects empty filer names and bad dates", () => {
    expect(() => buildGeorgiaCandidateIndexRequestBody({ filerName: "  ", pageNumber: 1 })).toThrow(
      GeorgiaEthicsClientError
    );
    expect(() => formatGeorgiaFilterDate("peachfile", "07/01/2025")).toThrow(GeorgiaEthicsClientError);
  });
});

describe("transport", () => {
  it("runs one request at a time with spacing before every request after the first", async () => {
    const sleeps: number[] = [];
    const transport = createGeorgiaEthicsTransport({
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      fetch: async () => ({ status: 200, body: pageBody([]) }),
    });
    await transport.postJson("https://example.test/a", "{}");
    await transport.postJson("https://example.test/b", "{}");
    expect(sleeps).toEqual([2_000]);
  });

  it("retries 5xx and 429 with backoff, fails other statuses immediately", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const transport = transportFromResponses(
      [{ status: 500, body: "boom" }, { status: 429, body: "slow" }, { body: pageBody([]) }],
      calls
    );
    await expect(transport.postJson("https://example.test/x", "{}")).resolves.toEqual({ items: [] });
    expect(calls).toHaveLength(3);

    const notFound = transportFromResponses([{ status: 404, body: "missing" }]);
    await expect(notFound.postJson("https://example.test/x", "{}")).rejects.toMatchObject({
      code: "http_error",
      status: 404,
    });
  });

  it("fails closed on the WAF harmful-payload message, envelope errors, and non-JSON", async () => {
    const waf = transportFromResponses([{ body: JSON.stringify({ message: "Potentially harmful payload detected!" }) }]);
    await expect(waf.postJson("https://example.test/x", "{}")).rejects.toMatchObject({ code: "bad_response" });

    const failed = transportFromResponses([{ body: JSON.stringify({ data: null, succeeded: false, error: null }) }]);
    await expect(failed.postJson("https://example.test/x", "{}")).rejects.toMatchObject({ code: "bad_response" });

    const html = transportFromResponses([{ body: "<html>error</html>" }]);
    await expect(html.postJson("https://example.test/x", "{}")).rejects.toMatchObject({ code: "bad_response" });
  });
});

describe("fetchGeorgiaCandidateIndexRows", () => {
  it("parses the PeachFile Carr fixture", async () => {
    const transport = transportFromResponses([{ body: fixture("peachfile_candidate_index_carr.json") }]);
    const rows = await fetchGeorgiaCandidateIndexRows(transport, "peachfile", { filerName: "Carr" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      filerEntityId: 100035,
      guid: "d973ab3b-54c2-416e-81ce-f5b1ee9a6f57",
      filerName: "Carr, Christopher M.",
      committeeName: "Carr for Georgia, Inc.",
      office: "Governor",
      filerStatusCode: "FACT",
      totalContributions: 5374711.06,
      cashOnHand: 1167791.24,
    });
  });

  it("parses the archive Carr fixture including the terminated legacy registration", async () => {
    const transport = transportFromResponses([{ body: fixture("archive_candidate_index_carr.json") }]);
    const rows = await fetchGeorgiaCandidateIndexRows(transport, "efile_archive", { filerName: "Carr" });
    expect(rows).toHaveLength(3);
    const legacy = rows.find((row) => row.filerStatusCode === "T");
    // The termination signal is the string status code — the isTerminated
    // boolean is false on this very registration (D8 boolean-flag ban).
    expect(legacy).toMatchObject({ filerEntityId: 2750, committeeName: "Friends of Chris Carr, Inc." });
  });
});

describe("fetchGeorgiaFiledReportRows", () => {
  it("parses PeachFile reports with amendment childResults version chains", async () => {
    const transport = transportFromResponses([{ body: fixture("peachfile_filed_reports_carr.json") }]);
    const rows = await fetchGeorgiaFiledReportRows(transport, "peachfile", { filerName: "Carr, Christopher" });
    expect(rows).toHaveLength(4);
    const amended = rows.find((row) => row.filerReportId === 38)!;
    expect(amended.reportStatus).toBe("Amended");
    expect(amended.reportTypeCode).toBe("FPCFDR");
    expect(amended.childVersions).toHaveLength(2);
    expect(amended.childVersions[0]).toMatchObject({ filerReportVersionId: 2, reportStatus: "Version 2" });
    const original = rows.find((row) => row.filerReportId === 37)!;
    expect(original.hasChild).toBe(false);
    expect(original.childVersions).toEqual([]);
  });
});

describe("fetchGeorgiaTransactionRows", () => {
  it("pages until a short page, dedups by transactionId, and drops foreign rows", async () => {
    const fullPage = Array.from({ length: GEORGIA_ETHICS_PAGE_SIZE }, (_, i) => transactionItem({ transactionId: i + 1 }));
    const secondPage = [
      transactionItem({ transactionId: 100 }), // offset-drift duplicate
      transactionItem({ transactionId: 200 }),
      transactionItem({ transactionId: 300, filerEntityId: 999 }), // foreign filer
    ];
    const calls: Array<{ url: string; body: string }> = [];
    const transport = transportFromResponses([{ body: pageBody(fullPage) }, { body: pageBody(secondPage) }], calls);
    const result = await fetchGeorgiaTransactionRows(
      transport,
      "peachfile",
      { filerName: "Carr for Georgia" },
      { expectedFilerEntityIds: [100035] }
    );
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[1]!.body).pageNumber).toBe(2);
    expect(result.fetchedRowCount).toBe(103);
    expect(result.rows).toHaveLength(101);
    expect(result.duplicateRowCount).toBe(1);
    expect(result.foreignRowCount).toBe(1);
  });

  it("treats a result that matched only foreign filers as a hard error", async () => {
    const transport = transportFromResponses([
      { body: pageBody([transactionItem({ filerEntityId: 999 }), transactionItem({ transactionId: 2, filerEntityId: 998 })]) },
    ]);
    await expect(
      fetchGeorgiaTransactionRows(
        transport,
        "peachfile",
        { filerName: "Carr for Georgia" },
        { expectedFilerEntityIds: [100035] }
      )
    ).rejects.toMatchObject({ code: "filter_ineffective" });
  });

  it("returns empty without error when the store has no rows at all", async () => {
    const transport = transportFromResponses([{ body: pageBody([]) }]);
    const result = await fetchGeorgiaTransactionRows(
      transport,
      "efile_archive",
      { filerName: "Nobody" },
      { expectedFilerEntityIds: [1] }
    );
    expect(result.rows).toEqual([]);
    expect(result.foreignRowCount).toBe(0);
  });
});

describe("fetchGeorgiaTransactionRowsStable", () => {
  it("returns once two consecutive passes agree on the unique id set", async () => {
    const passA = [transactionItem({ transactionId: 1 }), transactionItem({ transactionId: 2 })];
    const passB = [transactionItem({ transactionId: 2 }), transactionItem({ transactionId: 3 })];
    const responses = [pageBody(passA), pageBody(passB), pageBody(passB)];
    let call = 0;
    const transport = createGeorgiaEthicsTransport({
      sleep: async () => {},
      fetch: async () => ({ status: 200, body: responses[Math.min(call++, responses.length - 1)]! }),
    });
    const result = await fetchGeorgiaTransactionRowsStable(
      transport,
      "peachfile",
      { filerName: "Carr for Georgia" },
      { expectedFilerEntityIds: [100035] }
    );
    expect(result.passCount).toBe(3);
    expect(result.rows.map((row) => row.transactionId).sort()).toEqual([2, 3]);
  });

  it("fails closed when the id set never stabilizes", async () => {
    let call = 0;
    const transport = createGeorgiaEthicsTransport({
      sleep: async () => {},
      fetch: async () => ({
        status: 200,
        body: pageBody([transactionItem({ transactionId: (call += 1) })]),
      }),
    });
    await expect(
      fetchGeorgiaTransactionRowsStable(
        transport,
        "peachfile",
        { filerName: "Carr for Georgia" },
        { expectedFilerEntityIds: [100035], maxPasses: 3 }
      )
    ).rejects.toMatchObject({ code: "unstable_result" });
  });
});

describe("fetchGeorgiaTransactionRowsWindowed", () => {
  // Deterministic fake store: dated queries filter on the row date and
  // REPRODUCIBLY drop transaction 42 (every pass, identical id sets — each
  // window is "stable" yet incomplete); the unbounded sweep returns
  // everything, including a garbage-dated row no window can ever cover.
  const STORE = [
    transactionItem({ transactionId: 1, transactionDate: "2026-01-05" }),
    transactionItem({ transactionId: 5, transactionDate: "2026-01-11" }), // shared boundary day
    transactionItem({ transactionId: 2, transactionDate: "2026-01-15" }),
    transactionItem({ transactionId: 42, transactionDate: "2026-01-08" }), // dropped by dated queries
    transactionItem({ transactionId: 7, transactionDate: "2001-04-27" }), // garbage date, sweep-only
  ];

  function windowedFakeTransport(calls: Array<{ fromDate: string | null; toDate: string | null }> = []) {
    return createGeorgiaEthicsTransport({
      sleep: async () => {},
      fetch: async (_url, rawBody) => {
        const body = JSON.parse(rawBody) as { fromDate: string | null; toDate: string | null; pageNumber: number };
        if (body.pageNumber === 1) {
          calls.push({ fromDate: body.fromDate, toDate: body.toDate });
        }
        const items = STORE.filter((row) => {
          if (body.fromDate === null && body.toDate === null) {
            return true;
          }
          if (row.transactionId === 42) {
            return false;
          }
          const date = row.transactionDate as string;
          return date >= (body.fromDate ?? "0000") && date <= (body.toDate ?? "9999");
        });
        return { status: 200, body: pageBody(items) };
      },
    });
  }

  it("unions stable windows with the mandatory unbounded sweep — equal id sets alone never prove completeness", async () => {
    const calls: Array<{ fromDate: string | null; toDate: string | null }> = [];
    const result = await fetchGeorgiaTransactionRowsWindowed(windowedFakeTransport(calls), "efile_archive", {
      filerName: "Carr, Christopher Michael",
      fromDate: "2026-01-01",
      toDate: "2026-01-25",
      windowDays: 10,
      expectedFilerEntityIds: [100035],
    });

    // Three windows sharing boundary days, then the unbounded sweep.
    expect(calls).toEqual([
      { fromDate: "2026-01-01", toDate: "2026-01-11" },
      { fromDate: "2026-01-01", toDate: "2026-01-11" },
      { fromDate: "2026-01-11", toDate: "2026-01-21" },
      { fromDate: "2026-01-11", toDate: "2026-01-21" },
      { fromDate: "2026-01-21", toDate: "2026-01-25" },
      { fromDate: "2026-01-21", toDate: "2026-01-25" },
      { fromDate: null, toDate: null },
      { fromDate: null, toDate: null },
    ]);
    expect(result.windows).toHaveLength(3);
    expect(result.windows.every((window) => window.passCount === 2)).toBe(true);

    // Every window was stable (identical id sets across passes) and yet the
    // dated queries never surfaced 42, and 7's garbage date is outside every
    // window — only the sweep union recovers them.
    expect(result.rows.map((row) => row.transactionId).sort((a, b) => a - b)).toEqual([1, 2, 5, 7, 42]);
    expect(result.sweepOnlyRowCount).toBe(2);
    expect(result.sweepMissedRowCount).toBe(0);
  });

  it("tolerates a quiet window that matched only foreign filers, while the sweep stays strict", async () => {
    // Window 1 holds only a foreign filer's row (the quiet-quarter shape);
    // the rest of the store belongs to the expected filer.
    const store = [
      transactionItem({ transactionId: 900, filerEntityId: 999, transactionDate: "2026-01-05" }),
      transactionItem({ transactionId: 1, transactionDate: "2026-01-15" }),
    ];
    const transport = createGeorgiaEthicsTransport({
      sleep: async () => {},
      fetch: async (_url, rawBody) => {
        const body = JSON.parse(rawBody) as { fromDate: string | null; toDate: string | null };
        const items = store.filter((row) => {
          if (body.fromDate === null && body.toDate === null) {
            return true;
          }
          const date = row.transactionDate as string;
          return date >= (body.fromDate ?? "0000") && date <= (body.toDate ?? "9999");
        });
        return { status: 200, body: pageBody(items) };
      },
    });
    const result = await fetchGeorgiaTransactionRowsWindowed(transport, "efile_archive", {
      filerName: "Carr, Christopher Michael",
      fromDate: "2026-01-01",
      toDate: "2026-01-20",
      windowDays: 10,
      expectedFilerEntityIds: [100035],
    });
    expect(result.windowFilterIneffectiveCount).toBe(1);
    expect(result.windows[0]).toMatchObject({ filterIneffective: true, uniqueRowCount: 0, passCount: 0 });
    expect(result.rows.map((row) => row.transactionId)).toEqual([1]);

    // The whole-store shape — nothing for the expected filer anywhere —
    // still fails via the sweep.
    const foreignOnlyTransport = createGeorgiaEthicsTransport({
      sleep: async () => {},
      fetch: async () => ({
        status: 200,
        body: pageBody([transactionItem({ transactionId: 900, filerEntityId: 999, transactionDate: "2026-01-05" })]),
      }),
    });
    await expect(
      fetchGeorgiaTransactionRowsWindowed(foreignOnlyTransport, "efile_archive", {
        filerName: "Carr, Christopher Michael",
        fromDate: "2026-01-01",
        toDate: "2026-01-20",
        windowDays: 10,
        expectedFilerEntityIds: [100035],
      })
    ).rejects.toMatchObject({ code: "filter_ineffective" });
  });

  it("rejects inverted ranges and invalid window sizes", async () => {
    const transport = windowedFakeTransport();
    await expect(
      fetchGeorgiaTransactionRowsWindowed(transport, "efile_archive", {
        filerName: "X",
        fromDate: "2026-02-01",
        toDate: "2026-01-01",
        expectedFilerEntityIds: [1],
      })
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      fetchGeorgiaTransactionRowsWindowed(transport, "efile_archive", {
        filerName: "X",
        fromDate: "2026-01-01",
        toDate: "2026-01-02",
        windowDays: 0,
        expectedFilerEntityIds: [1],
      })
    ).rejects.toMatchObject({ code: "invalid_request" });
  });
});

describe("independent expenditures", () => {
  function ieItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      guid: "15f89f57-bce7-4d1b-bc54-2a376b36e19a",
      transactionId: 257851,
      amountApplied: 5093.25,
      filerRegistrationGuid: "639d6189-d718-40b3-ba3f-d4d7544a3451",
      filerName: "Georgia REALTORS IE Committee",
      filerReportGuid: "3c02a2fd-25bf-4f15-a9d7-3dd06822dc9d",
      timedFiledReportGuid: null,
      filerReportVersionId: 1,
      transactionDate: "2026-01-15T00:00:00",
      transactionStatusCode: "TFIL",
      transactionTypeCode: "TIE",
      electionYear: 2026,
      candidateMeasures: [
        {
          candidateMeasureTitle: "LeMario Brown for Georgia",
          stance: "Support",
          reasonTypeCode: "CAN",
          filerRegistrationGuid: "d627fc6e-f324-4077-82f5-bec26f54aac7",
        },
      ],
      ...overrides,
    };
  }

  it("pins the IE body to the spike-verified shape with the per-host sort direction", () => {
    const peachfile = JSON.parse(buildGeorgiaIndependentExpenditureRequestBody("peachfile", 2));
    expect(peachfile).toMatchObject({
      filerName: null,
      candidateMeasure: null,
      stance: null,
      disclosureReport: null,
      payeeName: null,
      officeSought: null,
      transactionType: null,
      pageNumber: 2,
      pageSize: GEORGIA_ETHICS_PAGE_SIZE,
      sortBy: "Transaction Date",
      sortType: "asc",
    });
    expect(Object.keys(peachfile)).toHaveLength(20);
    const archive = JSON.parse(buildGeorgiaIndependentExpenditureRequestBody("efile_archive", 1));
    expect(archive.sortType).toBe("desc");
  });

  it("parses both hosts' fixture rows, including targets and the timed-pending null report guid", async () => {
    const peachfileTransport = transportFromResponses([{ body: fixture("peachfile_ie_rows_sample.json") }]);
    const peachfile = await fetchGeorgiaIndependentExpenditureRows(peachfileTransport, "peachfile");
    expect(peachfile.rows).toHaveLength(3);
    expect(peachfile.passCount).toBe(2);
    const [single, timed, multi] = peachfile.rows;
    // Unregistered local target: no registration guid.
    expect(single).toMatchObject({ transactionId: 257851, amountApplied: 5093.25 });
    expect(single!.candidateMeasures).toEqual([
      { candidateMeasureTitle: "Engel, Gary", stance: "Support", reasonTypeCode: "CAN", filerRegistrationGuid: null },
    ]);
    // Timed-pending IE rows encode the missing report as null (D8).
    expect(timed).toMatchObject({
      transactionStatusCode: "TPEN",
      filerReportGuid: null,
      timedFiledReportGuid: "459fb7c2-0ef4-437f-a02d-e21319528437",
    });
    // The 65-target transaction survives parsing whole.
    expect(multi!.candidateMeasures).toHaveLength(65);
    expect(multi!.candidateMeasures.at(-1)).toMatchObject({ stance: "Oppose", reasonTypeCode: "CAN" });

    // Archive targets carry neither a registration guid nor a reason code —
    // the pinned fact behind the PeachFile-only IE leg.
    const archiveTransport = transportFromResponses([{ body: fixture("archive_ie_rows_sample.json") }]);
    const archive = await fetchGeorgiaIndependentExpenditureRows(archiveTransport, "efile_archive");
    expect(archive.rows).toHaveLength(2);
    expect(archive.rows[0]!.candidateMeasures).toEqual([
      {
        candidateMeasureTitle: "Fincher, William W (Bill Fincher for Cherokee)",
        stance: "Support",
        reasonTypeCode: null,
        filerRegistrationGuid: null,
      },
    ]);
  });

  it("pages until a short page, dedups by transactionId, and requires two stable passes", async () => {
    const fullPage = Array.from({ length: GEORGIA_ETHICS_PAGE_SIZE }, (_, index) =>
      ieItem({ transactionId: index + 1, guid: `guid-${index + 1}` })
    );
    // Offset drift: the second page re-lists id 100 before the new id 101.
    const secondPage = [fullPage[99]!, ieItem({ transactionId: 101 })];
    const calls: Array<{ url: string; body: string }> = [];
    const transport = transportFromResponses(
      [
        { body: pageBody(fullPage) },
        { body: pageBody(secondPage) },
        { body: pageBody(fullPage) },
        { body: pageBody(secondPage) },
      ],
      calls
    );
    const result = await fetchGeorgiaIndependentExpenditureRows(transport, "peachfile");
    expect(result.rows).toHaveLength(101);
    expect(result.duplicateRowCount).toBe(1);
    expect(result.passCount).toBe(2);
    expect(calls).toHaveLength(4);
    expect(calls.every((call) => call.url.endsWith("/GetIndependentExpenditureDetails"))).toBe(true);
  });

  it("fails closed when the store never stabilizes", async () => {
    let call = 0;
    const transport = createGeorgiaEthicsTransport({
      sleep: async () => {},
      fetch: async () => ({ status: 200, body: pageBody([ieItem({ transactionId: (call += 1) })]) }),
    });
    await expect(fetchGeorgiaIndependentExpenditureRows(transport, "peachfile", { maxPasses: 3 })).rejects.toMatchObject(
      {
        code: "unstable_result",
      }
    );
  });

  it.each([
    { amountApplied: 7000 },
    { transactionStatusCode: "TAMD" },
    { filerReportVersionId: 2 },
    { candidateMeasures: [{ stance: "Oppose", reasonTypeCode: "CAN", filerRegistrationGuid: "other-target" }] },
  ])("does not stabilize on identical IDs with changed financial payload %j", async (change) => {
    const original = ieItem();
    const updated = ieItem(change);
    const transport = transportFromResponses([
      { body: pageBody([original]) }, { body: pageBody([updated]) }, { body: pageBody([updated]) },
    ]);
    const result = await fetchGeorgiaIndependentExpenditureRows(transport, "peachfile", { maxPasses: 3 });
    expect(result.passCount).toBe(3);
    expect(result.rows[0]).toMatchObject(change);
  });

  it("rejects conflicting duplicates within one pass", async () => {
    const transport = transportFromResponses([{ body: pageBody([ieItem(), ieItem({ amountApplied: 1 })]) }]);
    await expect(fetchGeorgiaIndependentExpenditureRows(transport, "peachfile")).rejects.toMatchObject({
      code: "unstable_result", message: expect.stringContaining("conflicting duplicate IDs"),
    });
  });

  function countedPage(items: unknown[], totalItems: unknown): string {
    return JSON.stringify({ data: { items, totalItems }, succeeded: true, error: null });
  }

  it("closes every native page against a stable declared total", async () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => ieItem({ transactionId: index + 1 }));
    const lastPage = [ieItem({ transactionId: 101 })];
    const transport = transportFromResponses([
      { body: countedPage(fullPage, 101) }, { body: countedPage(lastPage, 101) },
      { body: countedPage(fullPage, 101) }, { body: countedPage(lastPage, 101) },
    ]);
    expect(await fetchGeorgiaIndependentExpenditureRows(transport, "peachfile")).toMatchObject({
      passCount: 2, fetchedRowCount: 101, duplicateRowCount: 0,
    });
  });

  it("rejects repeated IDs even when the native page cardinalities match", async () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => ieItem({ transactionId: index + 1 }));
    const transport = transportFromResponses([
      { body: countedPage(fullPage, 101) }, { body: countedPage([fullPage[99]], 101) },
    ]);
    await expect(fetchGeorgiaIndependentExpenditureRows(transport, "peachfile")).rejects.toMatchObject({
      code: "bad_response", message: expect.stringContaining("unique rows do not match"),
    });
  });

  it.each([-1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1])("rejects invalid native total %j", async (total) => {
    const transport = transportFromResponses([{ body: countedPage([ieItem()], total) }]);
    await expect(fetchGeorgiaIndependentExpenditureRows(transport, "peachfile")).rejects.toMatchObject({ code: "bad_response" });
  });

  it.each([102, null, undefined])("rejects native count changes between pages: %j", async (nextTotal) => {
    const fullPage = Array.from({ length: 100 }, (_, index) => ieItem({ transactionId: index + 1 }));
    const transport = transportFromResponses([
      { body: countedPage(fullPage, 101) }, { body: countedPage([ieItem({ transactionId: 101 })], nextTotal) },
    ]);
    await expect(fetchGeorgiaIndependentExpenditureRows(transport, "peachfile")).rejects.toMatchObject({ code: "bad_response" });
  });

  it("rejects a short page before the declared count", async () => {
    const transport = transportFromResponses([{ body: countedPage([ieItem()], 101) }]);
    await expect(fetchGeorgiaIndependentExpenditureRows(transport, "peachfile")).rejects.toMatchObject({
      code: "bad_response", message: expect.stringContaining("page does not match"),
    });
  });

  it.each([null, undefined, {}, [null], ["target"]])("rejects malformed target collections: %j", async (targets) => {
    const transport = transportFromResponses([{ body: pageBody([ieItem({ candidateMeasures: targets })]) }]);
    await expect(fetchGeorgiaIndependentExpenditureRows(transport, "peachfile")).rejects.toMatchObject({ code: "bad_response" });
  });

  it.each([1.001, Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY])("rejects unsupported native cents: %j", async (amountApplied) => {
    const transport = transportFromResponses([{ body: pageBody([ieItem({ amountApplied })]) }]);
    await expect(fetchGeorgiaIndependentExpenditureRows(transport, "peachfile")).rejects.toMatchObject({ code: "bad_response" });
  });

  it("retains genuine empty target arrays and valid timed-only rows", async () => {
    const transport = transportFromResponses([{ body: pageBody([
      ieItem({ candidateMeasures: [], filerReportGuid: null, timedFiledReportGuid: "timed", transactionStatusCode: "TPEN" }),
    ]) }]);
    const result = await fetchGeorgiaIndependentExpenditureRows(transport, "peachfile");
    expect(result.rows[0]).toMatchObject({ candidateMeasures: [], filerReportGuid: null, transactionStatusCode: "TPEN" });
  });

  it("fails closed on a stable EMPTY store — the IE stores are known nonempty", async () => {
    // A dead endpoint answering [] every pass is perfectly "stable"; writing
    // it through would delete every stored outside group.
    const transport = transportFromResponses([{ body: pageBody([]) }]);
    await expect(fetchGeorgiaIndependentExpenditureRows(transport, "peachfile")).rejects.toMatchObject({
      code: "bad_response",
      message: expect.stringContaining("stable EMPTY store"),
    });
  });
});

describe("per-host vocabularies", () => {
  it("recognizes each host's own status codes and rejects the other host's", () => {
    expect(isGeorgiaRecognizedTransactionStatus("peachfile", "TFIL")).toBe(true);
    expect(isGeorgiaRecognizedTransactionStatus("peachfile", "TPEN")).toBe(true);
    expect(isGeorgiaRecognizedTransactionStatus("peachfile", "F")).toBe(false);
    expect(isGeorgiaRecognizedTransactionStatus("efile_archive", "F")).toBe(true);
    expect(isGeorgiaRecognizedTransactionStatus("efile_archive", "A")).toBe(true);
    expect(isGeorgiaRecognizedTransactionStatus("efile_archive", "TFIL")).toBe(false);
    expect(isGeorgiaRecognizedTransactionStatus("peachfile", null)).toBe(false);
  });

  it("normalizes report families per host and fails closed on unknown codes", () => {
    expect(normalizeGeorgiaReportFamily("peachfile", "FPCFDR")).toBe("ccdr");
    expect(normalizeGeorgiaReportFamily("efile_archive", "103")).toBe("ccdr");
    expect(normalizeGeorgiaReportFamily("peachfile", "FPTBDR")).toBe("two_business_day");
    expect(normalizeGeorgiaReportFamily("efile_archive", "104")).toBe("two_business_day");
    expect(normalizeGeorgiaReportFamily("peachfile", "FPICTBDR")).toBe("independent_committee_two_business_day");
    expect(normalizeGeorgiaReportFamily("efile_archive", "107")).toBe("independent_committee_two_business_day");
    // Raw codes never cross hosts (D8): each host's codes are unknown on the other.
    expect(() => normalizeGeorgiaReportFamily("peachfile", "103")).toThrow(GeorgiaEthicsClientError);
    expect(() => normalizeGeorgiaReportFamily("efile_archive", "FPCFDR")).toThrow(GeorgiaEthicsClientError);
  });
});

describe("georgiaTransactionReportGroupGuid", () => {
  it("groups timed-pending rows by timedFiledReportGuid for both null and zero-GUID encodings", () => {
    // TCON endpoint encodes "no CCDR yet" as the zero GUID (fixture row).
    expect(
      georgiaTransactionReportGroupGuid({
        filerReportGuid: GEORGIA_ZERO_GUID,
        timedFiledReportGuid: "5c00b4f9-7baa-4d77-8870-3413cd0ed090",
      })
    ).toBe("5c00b4f9-7baa-4d77-8870-3413cd0ed090");
    // IE endpoint encodes it as null.
    expect(
      georgiaTransactionReportGroupGuid({
        filerReportGuid: null,
        timedFiledReportGuid: "5C00B4F9-7BAA-4D77-8870-3413CD0ED090",
      })
    ).toBe("5c00b4f9-7baa-4d77-8870-3413cd0ed090");
    expect(
      georgiaTransactionReportGroupGuid({
        filerReportGuid: "7d5e2ef2-e1b5-4bc9-a555-13f6392f4199",
        timedFiledReportGuid: null,
      })
    ).toBe("7d5e2ef2-e1b5-4bc9-a555-13f6392f4199");
    expect(georgiaTransactionReportGroupGuid({ filerReportGuid: null, timedFiledReportGuid: null })).toBeNull();
  });
});

describe("buildGeorgiaReportInventory", () => {
  async function loadFixtureReports(): Promise<{
    peachfile: GeorgiaFiledReportRow[];
    archive: GeorgiaFiledReportRow[];
  }> {
    const pfTransport = transportFromResponses([{ body: fixture("peachfile_filed_reports_carr.json") }]);
    const arTransport = transportFromResponses([{ body: fixture("archive_filed_reports_carr.json") }]);
    return {
      peachfile: await fetchGeorgiaFiledReportRows(pfTransport, "peachfile", { filerName: "Carr, Christopher" }),
      archive: await fetchGeorgiaFiledReportRows(arTransport, "efile_archive", { filerName: "Carr, Christopher" }),
    };
  }

  it("unions the Carr fixtures: PeachFile wins migrated reports, archive-only reports stay", async () => {
    const { peachfile, archive } = await loadFixtureReports();
    // Scope the archive rows to the candidate registration chain (the 2022
    // legacy-committee reports belong to a different registration — D3).
    const archiveChain = archive.filter((row) => row.filerEntityId === 757274);
    const inventory = buildGeorgiaReportInventory({ peachfileReports: peachfile, archiveReports: archiveChain });

    expect(inventory).toHaveLength(4);
    // Migrated pre-cutover reports: both hosts hold them, PeachFile wins.
    const jun2025 = inventory.find((entry) => entry.periodEnd === "2025-06-30")!;
    expect(jun2025.source).toBe("peachfile");
    expect(jun2025.report.filerReportId).toBe(38);
    expect(jun2025.supersededArchiveReport?.filerReportId).toBe(84109);
    const jan2025 = inventory.find((entry) => entry.periodEnd === "2025-01-31")!;
    expect(jan2025.source).toBe("peachfile");
    expect(jan2025.report.filerReportId).toBe(37);
    expect(jan2025.supersededArchiveReport?.filerReportId).toBe(69996);
    // PeachFile-era reports have no archive copy.
    const jan2026 = inventory.find((entry) => entry.periodEnd === "2026-01-31")!;
    expect(jan2026.source).toBe("peachfile");
    expect(jan2026.supersededArchiveReport).toBeUndefined();
  });

  it("keeps archive-only reports from the archive source", async () => {
    const { archive } = await loadFixtureReports();
    const legacyReports = archive.filter((row) => row.filerEntityId === 2750);
    const inventory = buildGeorgiaReportInventory({ peachfileReports: [], archiveReports: legacyReports });
    expect(inventory).toHaveLength(2);
    expect(inventory.every((entry) => entry.source === "efile_archive")).toBe(true);
  });

  it("matches by normalized family and period, never raw reportTypeCode or status", async () => {
    const { peachfile, archive } = await loadFixtureReports();
    // The matched June-2025 pair has disjoint raw codes (FPCFDR vs 103) and
    // different statuses (Amended vs Original) — identity must still match.
    const pf = peachfile.find((row) => row.filerReportId === 38)!;
    const ar = archive.find((row) => row.filerReportId === 84109)!;
    expect(pf.reportTypeCode).not.toBe(ar.reportTypeCode);
    expect(pf.reportStatus).not.toBe(ar.reportStatus);
    const inventory = buildGeorgiaReportInventory({ peachfileReports: [pf], archiveReports: [ar] });
    expect(inventory).toHaveLength(1);
    expect(inventory[0]!.source).toBe("peachfile");
  });

  it("treats null-period reports as standalone entries that never merge", async () => {
    const { archive } = await loadFixtureReports();
    const base = archive.find((row) => row.filerReportId === 84109)!;
    const nullPeriodA: GeorgiaFiledReportRow = { ...base, filerReportGuid: "guid-a", startDate: null, endDate: null };
    const nullPeriodB: GeorgiaFiledReportRow = { ...base, filerReportGuid: "guid-b", startDate: null, endDate: null };
    const inventory = buildGeorgiaReportInventory({
      peachfileReports: [],
      archiveReports: [nullPeriodA, nullPeriodB],
    });
    expect(inventory).toHaveLength(2);
    expect(inventory.every((entry) => entry.periodStart === null)).toBe(true);
  });

  it("keeps same-day Two Business Day reports as standalone entries", async () => {
    // A filer can legally file several TBD reports on the same day (live-hit
    // 2026-06-02): the family|period key is not an identity for the
    // per-event family, so each stands alone instead of failing closed.
    const { peachfile } = await loadFixtureReports();
    const base = peachfile[0]!;
    const tbdA: GeorgiaFiledReportRow = {
      ...base,
      filerReportGuid: "tbd-a",
      reportTypeCode: "FPTBDR",
      startDate: "2026-06-02T00:00:00",
      endDate: "2026-06-02T00:00:00",
    };
    const tbdB: GeorgiaFiledReportRow = { ...tbdA, filerReportGuid: "tbd-b" };
    const inventory = buildGeorgiaReportInventory({ peachfileReports: [tbdA, tbdB], archiveReports: [] });
    expect(inventory).toHaveLength(2);
    expect(inventory.map((entry) => entry.report.filerReportGuid).sort()).toEqual(["tbd-a", "tbd-b"]);
  });

  it("fails closed when one host holds two reports with the same identity key", async () => {
    const { archive } = await loadFixtureReports();
    const base = archive.find((row) => row.filerReportId === 84109)!;
    const duplicate: GeorgiaFiledReportRow = { ...base, filerReportGuid: "another-guid" };
    expect(() =>
      buildGeorgiaReportInventory({ peachfileReports: [], archiveReports: [base, duplicate] })
    ).toThrow(GeorgiaEthicsClientError);
  });

  it("fails closed on unknown report type codes", async () => {
    const { peachfile } = await loadFixtureReports();
    const unknown: GeorgiaFiledReportRow = { ...peachfile[0]!, reportTypeCode: "FPXYZ" };
    expect(() => buildGeorgiaReportInventory({ peachfileReports: [unknown], archiveReports: [] })).toThrow(
      /Unknown Georgia peachfile reportTypeCode/
    );
  });
});
