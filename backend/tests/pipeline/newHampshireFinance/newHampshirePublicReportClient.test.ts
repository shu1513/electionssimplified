import { describe, expect, it, vi } from "vitest";

import { downloadNewHampshirePublicReportPage as download } from "../../../src/pipeline/newHampshireFinance/newHampshireCfsClient.js";

const guid = "00000000-0000-4000-8000-000000000001";
const payload = (items: unknown[] = [], totalItems = items.length) => ({ succeeded: true, data: { items, totalItems } });
const response = (body: string | Uint8Array) => new Response(body, { headers: { "Content-Type": "application/json" } });
const fetchReturning = (res: Response) => vi.fn().mockResolvedValue(res) as unknown as typeof fetch;

describe("New Hampshire public report acquisition", () => {
  it("uses the public profile contract and preserves original bytes", async () => {
    const raw = JSON.stringify(payload([{ reportName: "Synthetic report" }]), null, 2) + "\n";
    const fetchImpl = fetchReturning(response(raw));
    const result = await download({ kind: "profile", registrationGuid: guid, pageSize: 1000 }, { fetchImpl });
    expect(new TextDecoder().decode(result.bytes)).toBe(raw);
    expect(result.envelope).toEqual(JSON.parse(raw));
    const [url, options] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(url).toBe("https://cfsapi.sos.nh.gov/api/PublicFilerDetails/GetPublicFilerProfileFiling");
    expect(options?.redirect).toBe("manual");
    expect(JSON.parse(String(options?.body))).toEqual({ filerRegistrationGuid: guid, pageNumber: 1, pageSize: 1000, sortBy: "", sortType: "" });
    expect(Date.parse(result.completedAt)).toBeGreaterThanOrEqual(Date.parse(result.requestedAt));
  });

  it("requests the public advertised history, including its filing-history flag", async () => {
    const fetchImpl = fetchReturning(response(JSON.stringify(payload())));
    await download({ kind: "history", reportGuid: guid, pageNumber: 2, pageSize: 50 }, { fetchImpl });
    const [url, options] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(url).toBe("https://cfsapi.sos.nh.gov/api/PublicFilerDetails/GetPublicFilerProfileChildFilingDetails");
    expect(JSON.parse(String(options?.body))).toEqual({ filerReportGuid: guid, pageNumber: 2, pageSize: 50, sortBy: null, sortType: null, showFilingHistory: true });
  });

  it("rejects invalid selectors and unsafe page numbers before transmission", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(download({ kind: "profile", registrationGuid: "bad" }, { fetchImpl })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(download({ kind: "profile", registrationGuid: guid, pageNumber: 2 ** 53 }, { fetchImpl })).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects redirects rather than following another endpoint", async () => {
    const fetchImpl = fetchReturning(new Response(null, { status: 302, headers: { Location: "https://example.invalid/" } }));
    await expect(download({ kind: "profile", registrationGuid: guid }, { fetchImpl })).rejects.toMatchObject({ code: "http_error", status: 302 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects impossible page counts", async () => {
    const fetchImpl = fetchReturning(response(JSON.stringify(payload([{}, {}], 1))));
    await expect(download({ kind: "profile", registrationGuid: guid }, { fetchImpl })).rejects.toMatchObject({ code: "bad_response" });
  });

  it("rejects invalid UTF-8 instead of changing the original response", async () => {
    const fetchImpl = fetchReturning(response(new Uint8Array([0xff])));
    await expect(download({ kind: "profile", registrationGuid: guid }, { fetchImpl })).rejects.toMatchObject({ code: "bad_response" });
  });

  it("rejects an interrupted response body", async () => {
    const stream = new ReadableStream({ start(controller) { controller.error(new Error("Synthetic interruption")); } });
    const fetchImpl = fetchReturning(new Response(stream, { headers: { "Content-Type": "application/json" } }));
    await expect(download({ kind: "profile", registrationGuid: guid }, { fetchImpl })).rejects.toMatchObject({ code: "network_error" });
  });

  it("cancels oversized JSON while reading the stream", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(32 * 1024 * 1024 + 1)); }, cancel });
    const fetchImpl = fetchReturning(new Response(stream, { headers: { "Content-Type": "application/json" } }));
    await expect(download({ kind: "profile", registrationGuid: guid }, { fetchImpl })).rejects.toMatchObject({ code: "bad_response" });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
