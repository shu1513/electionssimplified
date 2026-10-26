import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireMarylandOutsideParentControls,
  readMarylandOutsideParentControls,
} from "../../../src/pipeline/marylandFinance/marylandOutsideParentControls.js";
const guid = "11111111-1111-4111-8111-111111111111",
  dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
async function fixture() {
  const outputDirectory = await mkdtemp(join(tmpdir(), "md-parent-controls-"));
  dirs.push(outputDirectory);
  const scope = { transactionGuid: guid, transactionId: 7, outputDirectory };
  const result = await acquireMarylandOutsideParentControls({
    ...scope,
    fetchImpl: async (url, init) => {
      const request = JSON.parse(String(init!.body));
      const data = String(url).endsWith("GetTransactionDetailsByGuid")
        ? { guid, transactionSubTypeCode: "TIEXP", transactionAmount: 23 }
        : String(url).endsWith("GetChildTransactionDetails")
          ? { items: [], totalItems: 0 }
          : {
              items: Array.from(
                { length: request.pageNumber < 3 ? 10 : 3 },
                () => ({
                  filerRegistrationGuid: guid,
                  isSupport: true,
                  amount: 1,
                }),
              ),
              totalItems: 23,
            };
      return new Response(
        JSON.stringify({ succeeded: true, error: null, data }),
      );
    },
  });
  return { scope, result };
}
describe("whole Maryland IE parent control sources", () => {
  it("reopens every physical allocation page and an exact native return query", async () => {
    const { scope, result } = await fixture();
    expect(result.allocations).toHaveLength(23);
    expect(result.returns).toHaveLength(0);
    expect(result.captures).toHaveLength(5);
    const saved = await readMarylandOutsideParentControls(scope);
    expect(saved.allocations).toHaveLength(23);
    expect(saved.startedAt).toBe(result.startedAt);
    expect(saved).not.toHaveProperty("qualified");
  });
  it.each(["body", "sort", "owner", "scope", "missing_page"])(
    "holds corrupted or incomplete %s",
    async (kind) => {
      const { scope } = await fixture(),
        journal = join(scope.outputDirectory, "captures.private.jsonl");
      const lines = (await readFile(journal, "utf8"))
        .trim()
        .split("\n")
        .map((s) => JSON.parse(s));
      if (kind === "body") await writeFile(lines[1].outputPath, "{}");
      if (kind === "sort") lines[1].requestBody.sortBy = "";
      if (kind === "owner")
        lines[0].requestBody.transactionGuid =
          "22222222-2222-4222-8222-222222222222";
      if (kind === "scope") lines[4].requestBody.transactionID = 8;
      if (kind === "missing_page") lines.splice(2, 1);
      if (kind !== "body")
        await writeFile(
          journal,
          lines.map((c) => JSON.stringify(c)).join("\n") + "\n",
        );
      await expect(readMarylandOutsideParentControls(scope)).rejects.toThrow(
        "maryland_outside_parent_controls_unavailable",
      );
    },
  );
});
