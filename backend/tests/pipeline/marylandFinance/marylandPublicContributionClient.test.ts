import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureMarylandPublicContributionPost } from "../../../src/pipeline/marylandFinance/marylandCurrentCycleExportClient.js";
import {
  buildMarylandPublicContributionRequest,
  decodeMarylandPublicContributionPage,
  fetchMarylandPublicContributionPage,
} from "../../../src/pipeline/marylandFinance/marylandPublicContributionClient.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const REPORT = "22222222-2222-4222-8222-222222222222";
const scope = {filerRegistrationGuid: OWNER, electionCycle: "12023", pageNumber: 1, pageSize: 10 as const};
const dirs: string[] = [];
async function outputPath() {
  const dir = await mkdtemp(join(tmpdir(), "md-public-page-"));
  dirs.push(dir);
  return join(dir, "original.json");
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, {recursive: true, force: true})));
});
function row(id = 1, overrides: Record<string, unknown> = {}) {
  return {
    filerRegistrationGuid: OWNER,
    electionCycleId: 12023,
    transactionGuid: `${String(id).padStart(8, "0")}-1111-4111-8111-111111111111`,
    transactionId: id,
    transactionVersionID: 1,
    reportGuid: REPORT,
    reportId: 10,
    reportVersionId: 1,
    isReturn: false,
    isActive: true,
    isAmended: false,
    hasChild: false,
    transactionAmount: 25,
    transactionTypeCode: "TCON",
    contributorName: "private source name",
    ...overrides,
  };
}
function envelope(rows = [row()], totalItems = rows.length) {
  return {succeeded: true, error: null, data: {items: rows, totalItems, pageNumber: 0, pageSize: 0}};
}

describe("Maryland observed public receipt page", () => {
  it("uses the published unrestricted TCON request and omits undefined filters", () => {
    const request = buildMarylandPublicContributionRequest({...scope, pageSize: 100});
    expect(request).toEqual({
      pageNumber: 1, pageSize: 100, sortBy: "TransactionDate", sortType: "desc",
      transactionTypeCode: "TCON", contributorName: null, contributorTypeCode: null,
      committeeType: null, reportType: null, isReturn: null, electionCycle: "12023",
      paymentTypeCode: null, contributionTypeCode: null, electionID: null, reportName: null,
      officeSought: null, officeType: null, toDate: null, fromDate: null,
      filerRegistrationGuid: OWNER, isPublicFundingRequested: null,
    });
    for (const key of ["filerName", "filingEntityId", "transactionAmountMax", "transactionAmountMin",
      "transactionAmount", "transactionAmountBy", "byState"])
      expect(request).not.toHaveProperty(key);
    expect(Object.isFrozen(request)).toBe(true);
    expect(buildMarylandPublicContributionRequest({...scope, isReturn: false}).isReturn).toBe(false);
    expect(buildMarylandPublicContributionRequest({...scope, isReturn: true}).isReturn).toBe(true);
  });
  it.each([
    {filerRegistrationGuid: "not a GUID"}, {filerRegistrationGuid: null},
    {electionCycle: 12023}, {electionCycle: "0"}, {electionCycle: " 12023"},
    {pageNumber: 0}, {pageNumber: 1.5}, {pageSize: 1000}, {isReturn: "Yes"},
  ])("rejects unsupported scope before source work %j", async override => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(fetchMarylandPublicContributionPage({
      ...scope, ...override, outputPath: await outputPath(), fetchImpl,
    } as never)).rejects.toMatchObject({code: "invalid_request"});
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("checks declared physical width while retaining advisory zero echoes", () => {
    const value = envelope([row(), row(2)], 2);
    const page = decodeMarylandPublicContributionPage(value, buildMarylandPublicContributionRequest(scope));
    expect(page.totalItems).toBe(2);
    expect(page.rows).toHaveLength(2);
    expect(page).not.toHaveProperty("qualified");
    expect(page).not.toHaveProperty("current");
    expect(() => decodeMarylandPublicContributionPage(envelope([row()], 11), buildMarylandPublicContributionRequest(scope)))
      .toThrow("invalid_contribution_page");
  });
  it("requires exactly the remainder on the final requested page", () => {
    const request = buildMarylandPublicContributionRequest({...scope, pageNumber: 2});
    expect(decodeMarylandPublicContributionPage(envelope([row()], 11), request).rows).toHaveLength(1);
    expect(() => decodeMarylandPublicContributionPage(envelope([], 11), request)).toThrow("invalid_contribution_page");
    expect(decodeMarylandPublicContributionPage(envelope([], 0), buildMarylandPublicContributionRequest(scope)).totalItems).toBe(0);
  });
  it.each([
    {filerRegistrationGuid: REPORT}, {transactionGuid: ""}, {reportGuid: ""},
    {transactionId: "1"}, {transactionVersionID: 0}, {reportId: null}, {reportVersionId: 1.5},
    {isReturn: "false"}, {isActive: null}, {isAmended: 0}, {hasChild: undefined},
    {transactionTypeCode: "TEXP"}, {electionCycleId: 12019}, {electionCycleId: "12023"},
  ])("rejects malformed identity/flags without dropping the row %j", override => {
    expect(() => decodeMarylandPublicContributionPage(envelope([row(1, override)]), buildMarylandPublicContributionRequest(scope)))
      .toThrow("invalid_contribution_page");
  });
  it("rejects rows outside an explicit published return filter", () => {
    const request = buildMarylandPublicContributionRequest({...scope, isReturn: true});
    expect(() => decodeMarylandPublicContributionPage(envelope([row()]), request)).toThrow("invalid_contribution_page");
    expect(decodeMarylandPublicContributionPage(envelope([row(1, {isReturn: true, transactionTypeCode: "TRCON"})]), request).rows).toHaveLength(1);
    expect(() => decodeMarylandPublicContributionPage(envelope([row(1, {isReturn: true})]), request)).toThrow("invalid_contribution_page");
  });
  it("runtime-closes the raw wrapper before any fetch or capture", async () => {
    const request = buildMarylandPublicContributionRequest(scope);
    const fetchImpl = vi.fn<typeof fetch>();
    for (const mutation of [{...request, privateFilter: "private input"}, {...request, sortType: "ASC"}]) {
      expect(() => captureMarylandPublicContributionPost(mutation as never, {outputPath: "unused", fetchImpl}))
        .toThrow("invalid_request");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    const mutable = {...request};
    fetchImpl.mockResolvedValue(new Response("source"));
    const pending = captureMarylandPublicContributionPost(mutable, {outputPath: await outputPath(), fetchImpl});
    mutable.filerRegistrationGuid = REPORT;
    const captured = await pending;
    expect(captured.requestBody.filerRegistrationGuid).toBe(OWNER);
    expect(Object.isFrozen(captured.requestBody)).toBe(true);
    expect(JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string).filerRegistrationGuid).toBe(OWNER);
  });
  it("uses published date formatting and ascending sort without adding other filters", () => {
    const request = buildMarylandPublicContributionRequest({...scope, sortType: "asc",
      fromDate: "2024-02-29", toDate: "2026-08-18"});
    expect(request).toMatchObject({sortType: "asc", fromDate: "2024-02-29", toDate: "2026-08-18",
      contributorTypeCode: null, contributionTypeCode: null, isReturn: null});
  });
  it("holds ignored date filters and malformed source days without dropping rows", () => {
    const request = buildMarylandPublicContributionRequest({...scope, fromDate: "2026-07-14", toDate: "2026-07-14"});
    expect(decodeMarylandPublicContributionPage(envelope([row(1, {transactionDate: "2026-07-14T00:00:00"})]), request).rows).toHaveLength(1);
    for (const transactionDate of [undefined, "2026-07-13T00:00:00", "2026-07-15T00:00:00", "2026-02-30T00:00:00", "2026-07-14T01:00:00"])
      expect(() => decodeMarylandPublicContributionPage(envelope([row(1, {transactionDate})]), request)).toThrow("invalid_contribution_page");
  });
  it.each([
    {sortType: "ASC"}, {fromDate: "2023-02-29"}, {toDate: "2026-04-31"},
    {fromDate: "2026-08-18T00:00:00"}, {toDate: "08/18/2026"}, {fromDate: "0000-01-01"},
    {fromDate: "2026-08-19", toDate: "2026-08-18"},
  ])("rejects unsupported date/sort scope before source work %j", async override => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(fetchMarylandPublicContributionPage({...scope, ...override,
      outputPath: await outputPath(), fetchImpl} as never)).rejects.toMatchObject({code: "invalid_request"});
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("retains distinct equal gifts, inactive records and separate editions without financial selection", () => {
    const rows = [row(), row(2), row(1, {transactionVersionID: 2, reportVersionId: 2,
      isActive: false, isAmended: true, isReturn: true, transactionTypeCode: "TRCON", transactionAmount: -25})];
    expect(decodeMarylandPublicContributionPage(envelope(rows), buildMarylandPublicContributionRequest(scope)).rows).toEqual(rows);
    expect(() => decodeMarylandPublicContributionPage(envelope([row(), row()]), buildMarylandPublicContributionRequest(scope)))
      .toThrow("invalid_contribution_page");
  });
  it.each([
    {succeeded: false, error: null, data: {items: [], totalItems: 0}},
    {succeeded: true, error: "source failure", data: {items: [], totalItems: 0}},
    {succeeded: true, error: null, data: {items: [], totalItems: "0"}},
    {succeeded: true, error: null, data: {items: [], totalItems: -1}},
  ])("rejects invalid envelopes %j", value => {
    expect(() => decodeMarylandPublicContributionPage(value, buildMarylandPublicContributionRequest(scope)))
      .toThrow("invalid_contribution_page");
  });
  it("captures untouched bytes but returns no names, IDs, selectors, headers or raw items", async () => {
    const path = await outputPath();
    const original = JSON.stringify(envelope([row()]));
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(original, {headers: {"set-cookie": "not retained"}}));
    const observed: unknown[] = [];
    const result = await fetchMarylandPublicContributionPage({...scope, outputPath: path, fetchImpl,
      onCapture: capture => {observed.push(capture);}});
    expect(await readFile(path, "utf8")).toBe(original);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(result.capture.sha256).toBe(createHash("sha256").update(original).digest("hex"));
    expect(result).toMatchObject({totalItems: 1, physicalCount: 1, capture: {httpStatus: 200, bodyComplete: true}});
    expect(result.capture).not.toHaveProperty("requestBody");
    expect(result).not.toHaveProperty("rows");
    expect(JSON.stringify(result)).not.toContain(OWNER);
    expect(JSON.stringify(result)).not.toContain("private source name");
    expect(observed).toHaveLength(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://api-campaignfinance.maryland.gov/api/PublicGrid/GetContributionList");
    expect(JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string)).toEqual(buildMarylandPublicContributionRequest(scope));
  });
  it("holds changed originals after callbacks and retains malformed originals", async () => {
    const path = await outputPath();
    await expect(fetchMarylandPublicContributionPage({...scope, outputPath: path,
      fetchImpl: async () => new Response(JSON.stringify(envelope([row()]))),
      onCapture: async () => {await writeFile(path, "changed");},
    })).rejects.toMatchObject({code: "invalid_contribution_page"});
    const malformedPath = await outputPath();
    await expect(fetchMarylandPublicContributionPage({...scope, outputPath: malformedPath,
      fetchImpl: async () => new Response("invalid original JSON"),
    })).rejects.toMatchObject({code: "invalid_contribution_page"});
    expect(await readFile(malformedPath, "utf8")).toBe("invalid original JSON");
  });
  it("preserves real timeout/cap/status failures without relabelling them as bad JSON", async () => {
    const path = await outputPath();
    await expect(fetchMarylandPublicContributionPage({...scope, outputPath: path, maxBytes: 3,
      fetchImpl: async () => new Response("abcdef"),
    })).rejects.toMatchObject({code: "body_limit", capture: {byteCount: 3, bodyComplete: false}});
    expect(await readFile(path, "utf8")).toBe("abc");
    await expect(fetchMarylandPublicContributionPage({...scope, outputPath: await outputPath(),
      fetchImpl: async () => new Response("not auth", {status: 401}),
    })).rejects.toMatchObject({code: "http_status"});
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(fetchMarylandPublicContributionPage({...scope, outputPath: await outputPath(), timeoutMs: 30001, fetchImpl}))
      .rejects.toMatchObject({code: "invalid_request"});
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(fetchMarylandPublicContributionPage({...scope, outputPath: await outputPath(), timeoutMs: 10,
      fetchImpl: async () => new Promise(() => {}),
    })).rejects.toMatchObject({code: "timeout"});
  });
});
