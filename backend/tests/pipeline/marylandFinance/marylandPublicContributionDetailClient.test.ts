import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMarylandPublicContributionDetailRequest, captureMarylandPublicContributionDetailPost } from "../../../src/pipeline/marylandFinance/marylandCurrentCycleExportClient.js";
import { decodeMarylandPublicContributionDetail, fetchMarylandPublicContributionDetail } from "../../../src/pipeline/marylandFinance/marylandPublicContributionDetailClient.js";
const GUID = "11111111-1111-4111-8111-111111111111";
const directories: string[] = [];
async function path() {const dir = await mkdtemp(join(tmpdir(), "md-detail-"));directories.push(dir);return join(dir, "original.json");}
afterEach(async () => {await Promise.all(directories.splice(0).map(dir => rm(dir, {recursive: true, force: true})));});
const value = () => ({succeeded: true, error: null, data: {guid: GUID,
  transactionDate: "2024-01-08T00:00:00", transactionAmount: 1000,
  transactionSubTypeCode: "TRFR", transactionSourceType: "Political Action Committee",
  payeeName: "private source name", committeeName: "private receiving name",
  committeeType: "Candidate", isReturnContribution: false}});
describe("Maryland published contribution detail", () => {
  it.each(["", "not-a-guid", "00000000-0000-0000-0000-000000000000", null, 1])("rejects invalid public selectors before any source call %j", async transactionGuid => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(fetchMarylandPublicContributionDetail({transactionGuid, outputPath: await path(), fetchImpl} as never))
      .rejects.toMatchObject({code: "invalid_request"});
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("runtime-closes the exact published request before any await", () => {
    const request = buildMarylandPublicContributionDetailRequest(GUID);
    for (const mutation of [{...request, numericId: 1}, {...request, transactionTypeCode: "TEXP"}])
      expect(() => captureMarylandPublicContributionDetailPost(mutation as never, {outputPath: "unused"})).toThrow("invalid_request");
  });
  it("captures the explicit published return role and rejects a nonreturn response", async () => {
    const source = value(); source.data.isReturnContribution = true;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(source)));
    await fetchMarylandPublicContributionDetail({transactionGuid: GUID, transactionTypeCode: "TRCON", outputPath: await path(), fetchImpl});
    expect(JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string)).toEqual({transactionGuid: GUID, transactionTypeCode: "TRCON"});
    expect(() => decodeMarylandPublicContributionDetail(value(), buildMarylandPublicContributionDetailRequest(GUID, "TRCON"))).toThrow("invalid_contribution_detail");
  });
  it.each([{guid: "22222222-2222-4222-8222-222222222222"}, {transactionDate: "2024-02-30T00:00:00"},
    {transactionDate: "2024-01-08"}, {transactionAmount: "1000"}, {isReturnContribution: null}, {payeeName: ""}])(
    "holds mismatched or malformed detail without inferring gift ownership %j", override => {
      const source = value();Object.assign(source.data, override);
      expect(() => decodeMarylandPublicContributionDetail(source, buildMarylandPublicContributionDetailRequest(GUID))).toThrow("invalid_contribution_detail");
    });
  it("captures an unchanged original with source times and returns no names/items/selectors", async () => {
    const outputPath = await path(), raw = JSON.stringify(value());
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(raw));
    const result = await fetchMarylandPublicContributionDetail({transactionGuid: GUID, outputPath, fetchImpl});
    expect(await readFile(outputPath, "utf8")).toBe(raw);
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://api-campaignfinance.maryland.gov/api/PublicTransactionDetails/GetTransactionDetailsByGuid");
    expect(JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string)).toEqual({transactionGuid: GUID, transactionTypeCode: "TCON"});
    expect(result.capture).toMatchObject({httpStatus: 200, bodyComplete: true});
    for (const privateValue of [GUID, "private source name", "private receiving name"])
      expect(JSON.stringify(result)).not.toContain(privateValue);
    expect(result).not.toHaveProperty("qualified");
  });
  it("retains genuine HTTP failures and rejects originals changed after capture", async () => {
    await expect(fetchMarylandPublicContributionDetail({transactionGuid: GUID, outputPath: await path(),
      fetchImpl: async () => new Response("failed source", {status: 400})})).rejects.toMatchObject({code: "http_status"});
    const outputPath = await path();
    await expect(fetchMarylandPublicContributionDetail({transactionGuid: GUID, outputPath,
      fetchImpl: async () => new Response(JSON.stringify(value())),
      onCapture: () => writeFile(outputPath, "changed")})).rejects.toMatchObject({code: "invalid_contribution_detail"});
  });
});
