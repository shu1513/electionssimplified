import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMarylandPublicOutsideDetailRequest,
  buildMarylandPublicOutsideReturnedChildrenRequest,
  captureMarylandPublicOutsideDetailPost,
  captureMarylandPublicOutsideReturnedChildrenPost,
} from "../../../src/pipeline/marylandFinance/marylandCurrentCycleExportClient.js";
const guid = "11111111-1111-4111-8111-111111111111";
const otherGuid = "22222222-2222-4222-8222-222222222222";
const dirs: string[] = [];
async function path() {
  const d = await mkdtemp(join(tmpdir(), "md-ie-controls-"));
  dirs.push(d);
  return join(d, "whole.original.json");
}
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
describe("current Maryland public IE popup controls", () => {
  it("keeps the actual combined parent role separate from returned IE/EC subtype", () => {
    expect(buildMarylandPublicOutsideDetailRequest(guid)).toEqual({
      transactionGuid: guid,
      transactionTypeCode: "TIECOM",
    });
    const child = buildMarylandPublicOutsideReturnedChildrenRequest({
      transactionGuid: guid,
      transactionId: 7,
      pageNumber: 1,
    });
    expect(child).toEqual({
      pageNumber: 1,
      pageSize: 10,
      transactionID: 7,
      transactionType: "TIECOM",
      transactionGuid: guid,
    });
    expect(child).not.toHaveProperty("sortBy");
    expect(child).not.toHaveProperty("sortType");
    expect(Object.isFrozen(child)).toBe(true);
  });
  it.each([null, "", "bad", 7, "00000000-0000-0000-0000-000000000000"])(
    "rejects invalid parent GUID %j",
    (value) => {
      expect(() =>
        buildMarylandPublicOutsideDetailRequest(value as never),
      ).toThrow("invalid_request");
    },
  );
  it.each([
    { transactionId: "7" },
    { transactionId: 0 },
    { pageNumber: 0 },
    { pageNumber: 1.5 },
    { transactionGuid: otherGuid, transactionType: "TIEXP" },
    { sortBy: "" },
  ])("holds invalid or extended input scope %j", (extra) => {
    expect(() =>
      buildMarylandPublicOutsideReturnedChildrenRequest({
        transactionGuid: guid,
        transactionId: 7,
        pageNumber: 1,
        ...extra,
      } as never),
    ).toThrow("invalid_request");
  });
  it("transmits only exact closed detail and return bodies and retains complete private originals", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            succeeded: true,
            error: null,
            data: { items: [], totalItems: 0 },
          }),
        ),
    );
    const detail = buildMarylandPublicOutsideDetailRequest(guid),
      children = buildMarylandPublicOutsideReturnedChildrenRequest({
        transactionGuid: guid,
        transactionId: 7,
        pageNumber: 1,
      });
    const a = await captureMarylandPublicOutsideDetailPost(detail, {
      outputPath: await path(),
      fetchImpl,
    });
    const b = await captureMarylandPublicOutsideReturnedChildrenPost(children, {
      outputPath: await path(),
      fetchImpl,
    });
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "https://api-campaignfinance.maryland.gov/api/PublicTransactionDetails/GetTransactionDetailsByGuid",
      "https://api-campaignfinance.maryland.gov/api/PublicTransactionDetails/GetChildTransactionDetails",
    ]);
    expect(
      fetchImpl.mock.calls.map(([, init]) => JSON.parse(String(init!.body))),
    ).toEqual([detail, children]);
    for (const capture of [a, b]) {
      expect(capture).toMatchObject({
        httpStatus: 200,
        bodyComplete: true,
        errorCode: null,
      });
      expect(capture).not.toHaveProperty("headers");
      expect((await stat(capture.outputPath)).mode & 0o777).toBe(0o600);
      expect(Buffer.byteLength(await readFile(capture.outputPath))).toBe(
        capture.byteCount,
      );
      expect(capture).not.toHaveProperty("financialAuthority");
    }
  });
  it("holds altered wire roles, selector casing, initial sorts and added cycle filters before fetch", async () => {
    const request = buildMarylandPublicOutsideReturnedChildrenRequest({
      transactionGuid: guid,
      transactionId: 7,
      pageNumber: 1,
    });
    const fetchImpl = vi.fn<typeof fetch>();
    for (const extra of [
      { transactionType: "TIEXP" },
      { transactionId: 7 },
      { sortBy: "" },
      { electionCycleId: 12023 },
      { pageSize: 100 },
    ]) {
      expect(() =>
        captureMarylandPublicOutsideReturnedChildrenPost(
          { ...request, ...extra } as never,
          { outputPath: "/unused", fetchImpl },
        ),
      ).toThrow("invalid_request");
    }
    expect(() =>
      captureMarylandPublicOutsideDetailPost(
        {
          ...buildMarylandPublicOutsideDetailRequest(guid),
          transactionTypeCode: "TCON",
        } as never,
        { outputPath: "/unused", fetchImpl },
      ),
    ).toThrow("invalid_request");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("retains source HTTP failure and never turns it into empty-return authority", async () => {
    const outputPath = await path();
    await expect(
      captureMarylandPublicOutsideReturnedChildrenPost(
        buildMarylandPublicOutsideReturnedChildrenRequest({
          transactionGuid: guid,
          transactionId: 7,
          pageNumber: 1,
        }),
        {
          outputPath,
          fetchImpl: async () =>
            new Response("source unavailable", { status: 503 }),
        },
      ),
    ).rejects.toMatchObject({ code: "http_status" });
    expect(await readFile(outputPath, "utf8")).toBe("source unavailable");
  });
  it("retains the validated wire snapshot while caller mutates its request during fetch", async () => {
    const request = { ...buildMarylandPublicOutsideDetailRequest(guid) };
    const outputPath = await path();
    const capture = await captureMarylandPublicOutsideDetailPost(request, {
      outputPath,
      fetchImpl: async (_url, init) => {
        request.transactionGuid = otherGuid;
        expect(JSON.parse(String(init!.body)).transactionGuid).toBe(guid);
        return new Response('{"succeeded":true,"data":{}}');
      },
    });
    expect(capture.requestBody.transactionGuid).toBe(guid);
  });
});
