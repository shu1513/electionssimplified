import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createArkansasVerifiedSourceClient,
  fingerprintArkansasVerifiedRawRows,
  type ArkansasVerifiedRawResponse,
} from "../../../src/pipeline/arkansasFinance/arkansasVerifiedSourceClient.js";

const GUID = "443afad5-559c-4d29-9ab3-37e45e112713";
const guid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function registry(n = 1, overrides: Record<string, unknown> = {}) {
  return {
    filerName: "Example PAC", office: null, officeDistrictName: null,
    filerEntityVersionID: 1, filerEntityID: n, filerType: "Political Action Committee",
    politicalParty: null, filerStatus: "Active", totalRaised: 500, totalSpent: 0,
    balanceofFunds: 500, electionYear: "", guid: guid(n), filerTypeCode: "PAC",
    filerTypeDesc: "Political Action Committee", filingYear: "2026", committeeName: "Example PAC",
    firstName: null, lastName: null, suffix: null, balanceofFundsNew: "500.00",
    totalRaisedNew: "500.00", totalSpentNew: "0.00", filingTypeCode: "PAC",
    isPaperFiler: false, jurisdictionName: null, totalRows: 1, ...overrides,
  };
}
function transaction(n = 1, overrides: Record<string, unknown> = {}) {
  return {
    guid: guid(n), filerName: "Clark, Alan", transactionAmount: 500,
    transactionDate: "04/22/2026", sourceName: "Example PAC",
    employerName: null, occupation: null, sourceAddress: "Published source address",
    transactionSource: "Political Action Committee", reportName: "2026 April Monthly Report (P)",
    transactionSubTypeDesc: "Itemized Monetary", hasChild: false,
    filerRegistrationGuid: GUID, transactionCategory: null, totalRows: 1, ...overrides,
  };
}
function report(n = 1, overrides: Record<string, unknown> = {}) {
  return {
    reportName: "2026 April Monthly Report (P)", dueDate: "2026-05-20T00:00:00",
    startDate: "2026-03-04T00:00:00", endDate: "2026-04-30T00:00:00",
    filedDate: "2026-05-19T10:50:12.123456789", filerFilingCalendarGuid: guid(999),
    reportStatus: "Original", reportVersion: "Original", reportType: "Scheduled Financial Report",
    filerReportGuid: guid(n), isPaperFile: false, electionTypeCode: "GRNELEC",
    reportElectionType: "General", filePath: "Reports\\exact.pdf", hasChild: false,
    filerReportVersionID: 1, totalRows: 1, ...overrides,
  };
}
function detail(overrides: Record<string, unknown> = {}) {
  return {
    transactionID: 1904137, transactionVersionID: 1, guid: guid(1),
    transactionSubTypeCode: "ITMY", electionTypeCode: "GRNELEC",
    transactionDate: "2026-04-22T00:00:00", transactionSourceTypeCode: "TPAC",
    contributor: "Example PAC", valueOfNonMoneyItem: 500,
    transactionSubTypeDesc: "Itemized Monetary", electionTypeDesc: "General",
    transactionSourceTypeDesc: "Political Action Committee", comments: null,
    transactionTypeCode: "TCON", transactionSource: "Political Action Committee",
    transactionTypeDescription: "Contribution", otherCategory: null,
    transactionCategoryDesc: null, filerName: "Clark, Alan", electionYear: "2026", ...overrides,
  };
}
function envelope(data: unknown) { return { data, succeeded: true, error: null }; }
function page(rows: Record<string, unknown>[], total = rows.length) {
  return envelope({ items: rows.map(r => ({ ...r, totalRows: total })), totalItems: total, pageNumber: 0, pageSize: 0 });
}
function json(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json; charset=utf-8" } });
}
function mockFetch(fn: (url: string, body: Record<string, unknown>) => Response | Promise<Response>) {
  return vi.fn(async (url: unknown, init?: RequestInit) => fn(String(url), JSON.parse(String(init?.body)))) as unknown as typeof fetch;
}
const pdfBytes = new TextEncoder().encode("%PDF-1.7\nUntouched bounded public report bytes\n%%EOF\n");

describe("Arkansas verified source client", () => {
  it("collects all registry request pages despite zero paging echoes, retaining annual entities/all statuses", async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => registry(i + 1));
    rows[1000] = registry(1001, { filerEntityID: 1, filerStatus: "Terminated", filingYear: "2023",
      filerTypeCode: "UNKNOWN", filerType: "Unknown class", isPaperFiler: null,
      extraFutureField: { name: "unchanged" } });
    const fetchImpl = mockFetch((url, body) => {
      expect(url).toContain("GetCandidateCommitteDetails");
      expect(Object.keys(body).sort()).toEqual(["pageNumber", "pageSize"]);
      return json(page(Number(body.pageNumber) === 1 ? rows.slice(0, 1000) : rows.slice(1000), 1001));
    });
    const result = await createArkansasVerifiedSourceClient({ fetchImpl }).fetchRegistry();
    expect(result.complete).toBe(true);
    expect(result.totalItems).toBe(1001);
    expect(result.rows[1000]).toMatchObject({ filerEntityId: 1, filerStatus: "Terminated", filingYear: 2023, filerTypeCode: "UNKNOWN", isPaperFiler: null });
    expect(result.rows[1000]!.rawFields.extraFutureField).toEqual({ name: "unchanged" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["duplicate GUID", () => page([registry(), registry()], 2), /duplicate/],
    ["partial page", () => page([registry()], 1001), /partial/],
    ["empty registry", () => page([]), /empty full registry/],
    ["bad boolean", () => page([registry(1, { isPaperFiler: "false" })]), /isPaperFiler/],
    ["missing boolean", () => { const r = registry(); delete (r as Record<string, unknown>).isPaperFiler; return page([r]); }, /missing isPaperFiler/],
    ["unsafe ID", () => page([registry(1, { filerEntityID: Number.MAX_SAFE_INTEGER + 1 })]), /filerEntityID/],
    ["missing native names", () => { const r = registry(); delete (r as Record<string, unknown>).committeeName; return page([r]); }, /committeeName/],
  ] as const)("rejects incomplete/invalid registry: %s", async (_label, make, error) => {
    await expect(createArkansasVerifiedSourceClient({ fetchImpl: mockFetch(() => json(make())) }).fetchRegistry()).rejects.toThrow(error);
  });

  it("rejects changing declared totals rather than returning a partial registry", async () => {
    const first = Array.from({ length: 1000 }, (_, i) => registry(i + 1));
    const fetchImpl = mockFetch((_url, body) => json(Number(body.pageNumber) === 1 ? page(first, 1001) : page([registry(1001)], 1002)));
    await expect(createArkansasVerifiedSourceClient({ fetchImpl }).fetchRegistry()).rejects.toThrow(/changed/);
  });

  it("enforces finite request/row bounds and creates a fresh request budget per method", async () => {
    const fetchImpl = mockFetch(url => json(url.endsWith("GetCandidateCommitteDetails") ? page([registry()]) : page([report()])));
    const client = createArkansasVerifiedSourceClient({ fetchImpl, maxRequests: 1, maxRows: 1 });
    await expect(client.fetchRegistry()).resolves.toMatchObject({ totalItems: 1 });
    await expect(client.fetchCurrentReports({ registrationGuid: GUID })).resolves.toMatchObject({ totalItems: 1 });
    const rows = Array.from({ length: 1000 }, (_, i) => registry(i + 1));
    await expect(createArkansasVerifiedSourceClient({ fetchImpl: mockFetch(() => json(page(rows, 1001))), maxRequests: 1 })
      .fetchRegistry()).rejects.toThrow(/request limit/);
    await expect(createArkansasVerifiedSourceClient({ fetchImpl: mockFetch(() => json(page([registry()], 2))), maxRows: 1 })
      .fetchRegistry()).rejects.toThrow(/row limit/);
    expect(() => createArkansasVerifiedSourceClient({ maxRequests: Infinity })).toThrow(/bound/);
  });

  it("retains complete native identity, signed fractional amounts and equal gifts as separate GUIDs", async () => {
    const rows = [transaction(1, { transactionAmount: -10.001, sourceName: null }),
      transaction(2), transaction(3)];
    const result = await createArkansasVerifiedSourceClient({ fetchImpl: mockFetch(() => json(page(rows))) })
      .fetchTransactions({ registrationGuid: GUID, transactionTypeCode: "TCON" });
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]!.transactionAmount).toBe(-10.001);
    expect(result.rows[0]!.sourceName).toBeNull();
    expect(result.rows[1]!.sourceAddress).toBe("Published source address");
    expect(result.rows[1]!.rawFields).toEqual({ ...rows[1], totalRows: 3 });
    expect(new Set(result.rows.map(r => r.guid)).size).toBe(3);
  });

  it.each([
    ["wrong receiver", transaction(1, { filerRegistrationGuid: guid(555) }), /receiver/],
    ["invalid date", transaction(1, { transactionDate: "02/30/2026" }), /calendar date/],
    ["missing child status", (() => { const r = transaction(); delete (r as Record<string, unknown>).hasChild; return r; })(), /hasChild/],
    ["invalid address", transaction(1, { sourceAddress: {} }), /sourceAddress/],
  ] as const)("rejects native identity errors: %s", async (_label, row, error) => {
    await expect(createArkansasVerifiedSourceClient({ fetchImpl: mockFetch(() => json(page([row]))) })
      .fetchTransactions({ registrationGuid: GUID, transactionTypeCode: "TCON" })).rejects.toThrow(error);
  });
  it("rejects duplicate native GUIDs without economic dedupe", async () => {
    await expect(createArkansasVerifiedSourceClient({ fetchImpl: mockFetch(() => json(page([transaction(), transaction()]))) })
      .fetchTransactions({ registrationGuid: GUID, transactionTypeCode: "TCON" })).rejects.toThrow(/duplicate/);
  });
  it("accepts explicit empty native/current scope but not missing items or unsupported returns queries", async () => {
    const client = createArkansasVerifiedSourceClient({ fetchImpl: mockFetch(() => json(page([]))) });
    await expect(client.fetchTransactions({ registrationGuid: GUID, transactionTypeCode: "TEXP" })).resolves.toMatchObject({ rows: [], totalItems: 0 });
    await expect(client.fetchCurrentReports({ registrationGuid: GUID })).resolves.toMatchObject({ rows: [], totalItems: 0 });
    await expect(client.fetchTransactions({ registrationGuid: GUID, transactionTypeCode: "TRCON" as "TCON" })).rejects.toThrow(/Only TCON/);
    await expect(createArkansasVerifiedSourceClient({ fetchImpl: mockFetch(() => json(envelope({ totalItems: 0, pageNumber: 0, pageSize: 0 }))) })
      .fetchTransactions({ registrationGuid: GUID, transactionTypeCode: "TEXP" })).rejects.toThrow(/missing items/);
  });

  it("partitions a large native ledger by inclusive dates and reconciles parent totals", async () => {
    const all = Array.from({ length: 1501 }, (_, i) => transaction(i + 1, { transactionDate: i < 750 ? "01/01/2026" : "01/02/2026" }));
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = mockFetch((_url, body) => {
      bodies.push(body);
      let selected = all;
      if (body.fromDate) selected = all.filter(r => r.transactionDate >= String(body.fromDate) && r.transactionDate <= String(body.toDate));
      if (body.sortType === "desc") selected = [...selected].reverse();
      const offset = (Number(body.pageNumber) - 1) * Number(body.pageSize);
      return json(page(selected.slice(offset, offset + Number(body.pageSize)), selected.length));
    });
    const result = await createArkansasVerifiedSourceClient({ fetchImpl }).fetchTransactions({ registrationGuid: GUID, transactionTypeCode: "TCON" });
    expect(result.rows).toHaveLength(1501);
    expect(bodies.some(b => b.fromDate === "01/01/2026" && b.toDate === "01/01/2026")).toBe(true);
    expect(bodies.some(b => b.fromDate === "01/02/2026" && b.toDate === "01/02/2026")).toBe(true);
    expect(bodies).toHaveLength(6);
  });

  it("fails on duplicate identities across overflowing single-day pages", async () => {
    const all = Array.from({ length: 1001 }, (_, i) => transaction(i + 1, { transactionDate: "01/01/2026" }));
    const fetchImpl = mockFetch((_url, body) => {
      const rows = Number(body.pageNumber) === 2 ? [all[0]!] : all.slice(0, Number(body.pageSize));
      return json(page(rows, 1001));
    });
    await expect(createArkansasVerifiedSourceClient({ fetchImpl }).fetchTransactions({ registrationGuid: GUID, transactionTypeCode: "TCON" })).rejects.toThrow(/duplicate/);
  });

  it("uses exact current profile route and preserves full version/period/paper evidence", async () => {
    const rows = [report(), report(2, { filerReportVersionID: 2, reportStatus: "Amended", reportVersion: "Amended", hasChild: true, isPaperFile: true })];
    const fetchImpl = mockFetch((url, body) => {
      expect(url).toContain("/PublicFilerDetails/GetPublicFilerProfileFiling");
      expect(body).toEqual({ filerRegistrationGuid: GUID, pageNumber: 1, pageSize: 1000 });
      return json(page(rows));
    });
    const result = await createArkansasVerifiedSourceClient({ fetchImpl }).fetchCurrentReports({ registrationGuid: GUID });
    expect(result.rows[0]!.filedDate).toBe("2026-05-19T10:50:12.123456789");
    expect(result.rows[1]).toMatchObject({ filerReportVersionId: 2, reportStatus: "Amended", isPaperFile: true, hasChild: true });
    expect(result.rows[0]!.rawFields).not.toHaveProperty("filerRegistrationGuid");
    expect(result.rows[0]!.registrationGuid).toBe(GUID);
  });
  it.each([
    ["duplicate report", [report(), report()], /duplicate/],
    ["missing paper flag", [(() => { const r = report(); delete (r as Record<string, unknown>).isPaperFile; return r; })()], /isPaperFile/],
    ["invalid period date", [report(1, { endDate: "2026-02-30T00:00:00" })], /calendar date/],
    ["invalid version", [report(1, { filerReportVersionID: 0 })], /filerReportVersionID/],
  ] as const)("rejects invalid current metadata: %s", async (_label, rows, error) => {
    await expect(createArkansasVerifiedSourceClient({ fetchImpl: mockFetch(() => json(page([...rows]))) })
      .fetchCurrentReports({ registrationGuid: GUID })).rejects.toThrow(error);
  });

  it("retains exact detail fields without inventing cash amount/report identity or filtering year", async () => {
    const fetchImpl = mockFetch((url, body) => {
      expect(url).toContain("GetTransactionDetailsByGuid");
      expect(body).toEqual({ transactionGuid: guid(1) });
      return json(envelope(detail({ electionYear: "2025", comments: "Full source purpose", transactionTypeCode: "TEXP" })));
    });
    const result = await createArkansasVerifiedSourceClient({ fetchImpl }).fetchTransactionDetail({ transactionGuid: guid(1) });
    expect(result.row).toMatchObject({ transactionId: 1904137, transactionVersionId: 1, electionYear: 2025, transactionTypeCode: "TEXP", comments: "Full source purpose", valueOfNonMoneyItem: 500 });
    expect(result.row.rawFields).toHaveProperty("transactionSourceTypeDesc");
    expect(result.row).not.toHaveProperty("amount");
    expect(result.row).not.toHaveProperty("reportGuid");
  });
  it.each([
    ["wrong GUID", detail({ guid: guid(2) }), /GUID differs/],
    ["invalid version", detail({ transactionVersionID: 0 }), /transactionVersionID/],
    ["missing year", (() => { const r = detail(); delete (r as Record<string, unknown>).electionYear; return r; })(), /electionYear/],
    ["invalid nullable comment", detail({ comments: [] }), /comments/],
  ] as const)("rejects invalid detail identity: %s", async (_label, row, error) => {
    await expect(createArkansasVerifiedSourceClient({ fetchImpl: mockFetch(() => json(envelope(row))) })
      .fetchTransactionDetail({ transactionGuid: guid(1) })).rejects.toThrow(error);
  });
  it("retains explicit unknown detail fields for separate financial preservation", async () => {
    const result = await createArkansasVerifiedSourceClient({ fetchImpl: mockFetch(() => json(envelope(detail({ electionYear: "", contributor: null, transactionSourceTypeCode: null })))) })
      .fetchTransactionDetail({ transactionGuid: guid(1) });
    expect(result.row).toMatchObject({ electionYear: null, contributor: null, transactionSourceTypeCode: null });
  });

  it("captures untouched JSON bytes/hashes/body before parsing and isolates callback mutation", async () => {
    const captures: ArkansasVerifiedRawResponse[] = [];
    const body = JSON.stringify(page([registry()]));
    const result = await createArkansasVerifiedSourceClient({
      fetchImpl: mockFetch(() => new Response(body, { headers: { "content-type": "application/json" } })),
      onRawResponse: raw => { captures.push({ ...raw, bytesRaw: new Uint8Array(raw.bytesRaw) }); raw.bytesRaw.fill(0); },
    }).fetchRegistry();
    const raw = captures[0]!;
    expect(new TextDecoder().decode(raw.bytesRaw)).toBe(body);
    expect(raw.sha256).toBe(createHash("sha256").update(body).digest("hex"));
    expect(raw.requestBody).toEqual({ pageNumber: 1, pageSize: 1000 });
    expect(raw).not.toHaveProperty("headers");
    expect(Date.parse(raw.endedAt)).toBeGreaterThanOrEqual(Date.parse(raw.startedAt));
    expect(result.rows).toHaveLength(1);
    expect(Object.isFrozen(result.rows[0]!.rawFields)).toBe(true);
  });
  it("callback persistence failure aborts source acceptance", async () => {
    await expect(createArkansasVerifiedSourceClient({ fetchImpl: mockFetch(() => json(page([registry()]))),
      onRawResponse: () => { throw new Error("capture failed"); } }).fetchRegistry()).rejects.toThrow("capture failed");
  });
  it.each([
    ["HTML login200", () => new Response("<html>Login</html>", { headers: { "content-type": "text/html" } }), /content type/],
    ["failed envelope", () => json({ data: {}, succeeded: false, error: null }), /envelope/],
    ["missing success field", () => json({ data: {}, error: null }), /succeeded/],
    ["error with success", () => json({ data: {}, succeeded: true, error: "failure" }), /envelope/],
    ["invalid UTF8", () => new Response(new Uint8Array([0xc3, 0x28]), { headers: { "content-type": "application/json" } }), /UTF-8/],
    ["HTTP failure", () => new Response("failed", { status: 503, headers: { "content-type": "text/plain" } }), /HTTP 503/],
  ] as const)("rejects transport/envelope failures: %s", async (_label, make, error) => {
    await expect(createArkansasVerifiedSourceClient({ fetchImpl: mockFetch(() => make()) }).fetchRegistry()).rejects.toThrow(error);
  });

  it("bounds actual streamed bytes and cancels overflow even without Content-Length", async () => {
    const cancelled = vi.fn();
    const fetchImpl = mockFetch(() => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(20)); },
      cancel: cancelled,
    }), { headers: { "content-type": "application/json" } }));
    await expect(createArkansasVerifiedSourceClient({ fetchImpl, maxResponseBytes: 10 }).fetchRegistry()).rejects.toThrow(/byte limit/);
    expect(cancelled).toHaveBeenCalled();
  });
  it("times out a stalled body as well as a stalled fetch", async () => {
    const cancelled = vi.fn();
    const fetchImpl = mockFetch(() => new Response(new ReadableStream({ cancel: cancelled }), { headers: { "content-type": "application/json" } }));
    await expect(createArkansasVerifiedSourceClient({ fetchImpl, timeoutMs: 10 }).fetchRegistry()).rejects.toThrow(/timed out/);
    expect(cancelled).toHaveBeenCalled();
    const never = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    await expect(createArkansasVerifiedSourceClient({ fetchImpl: never, timeoutMs: 10 }).fetchRegistry()).rejects.toThrow(/timed out/);
  });

  it("downloads only the exact stored report action and returns original PDF/hash", async () => {
    const fetchImpl = mockFetch((url, body) => {
      expect(url).toContain("/PublicFiledReportAndDownload/DownloadDocument");
      expect(body).toEqual({ filerReportGuid: guid(1), fileName: "2026 April Monthly Report V1", openInNewTab: true });
      return new Response(pdfBytes, { headers: { "content-type": "application/octet-stream" } });
    });
    const result = await createArkansasVerifiedSourceClient({ fetchImpl }).fetchStoredReport({ filerReportGuid: guid(1), fileName: "2026 April Monthly Report V1" });
    expect(result.bytesRaw).toEqual(pdfBytes);
    expect(result.sha256).toBe(createHash("sha256").update(pdfBytes).digest("hex"));
  });
  it.each([
    ["HTML", new TextEncoder().encode("<html>Login</html>"), /PDF bytes/],
    ["truncated", new TextEncoder().encode("%PDF-1.7\nunfinished"), /PDF bytes/],
  ] as const)("rejects invalid stored report bytes: %s", async (_label, bytes, error) => {
    await expect(createArkansasVerifiedSourceClient({ fetchImpl: mockFetch(() => new Response(bytes, { headers: { "content-type": "application/pdf" } })) })
      .fetchStoredReport({ filerReportGuid: guid(1), fileName: "Actual source report" })).rejects.toThrow(error);
  });

  it("fingerprints complete raw identity multisets independent of object/row order, preserving multiplicity", () => {
    const a = { rawFields: { donor: "Exact full name", nested: { b: 2, a: 1 } } };
    const b = { rawFields: { nested: { a: 1, b: 2 }, donor: "Exact full name" } };
    const other = { rawFields: { donor: "Other", nested: { a: 1, b: 2 } } };
    expect(fingerprintArkansasVerifiedRawRows([a, other])).toBe(fingerprintArkansasVerifiedRawRows([other, b]));
    expect(fingerprintArkansasVerifiedRawRows([a])).not.toBe(fingerprintArkansasVerifiedRawRows([a, b]));
    expect(fingerprintArkansasVerifiedRawRows([a])).not.toBe(fingerprintArkansasVerifiedRawRows([{ rawFields: { ...a.rawFields, donor: "Changed same-money donor" } }]));
  });
  it("rejects unfaithful raw fingerprint inputs instead of normalizing them into another identity", () => {
    for (const value of [undefined, NaN, Infinity, new Date("2026-01-01"), new Map()]) {
      expect(() => fingerprintArkansasVerifiedRawRows([{ rawFields: { donor: value } }])).toThrow(/non-JSON/);
    }
  });
  it("rejects rows outside date filters even when advertised counts still reconcile", async () => {
    const all = Array.from({ length: 1001 }, (_, i) => transaction(i + 1, { transactionDate: i < 500 ? "01/01/2026" : "01/02/2026" }));
    const fetchImpl = mockFetch((_url, body) => {
      if (body.fromDate) return json(page([transaction(9000, { transactionDate: "01/03/2026" })]));
      const rows = body.sortType === "desc" ? [...all].reverse() : all;
      return json(page(rows.slice(0, Number(body.pageSize)), 1001));
    });
    await expect(createArkansasVerifiedSourceClient({ fetchImpl }).fetchTransactions({ registrationGuid: GUID, transactionTypeCode: "TCON" })).rejects.toThrow(/outside requested/);
  });
  it("rejects conflicting row/envelope totals before declaring source completeness", async () => {
    const data = page([transaction()]);
    data.data.items[0]!.totalRows = 2;
    await expect(createArkansasVerifiedSourceClient({ fetchImpl: mockFetch(() => json(data)) })
      .fetchTransactions({ registrationGuid: GUID, transactionTypeCode: "TCON" })).rejects.toThrow(/totalRows differs/);
  });

});
