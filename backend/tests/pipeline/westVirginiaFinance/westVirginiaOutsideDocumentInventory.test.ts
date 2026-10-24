import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { refreshWestVirginiaOutsideDocumentInventory } from "../../../src/pipeline/westVirginiaFinance/westVirginiaOutsideDocumentInventory.js";

vi.mock("../../../src/pipeline/westVirginiaFinance/westVirginiaCfrsRegistryCache.js", () => ({
  readWestVirginiaCommitteeRegistryArtifact: async () => ({
    metadata: { sha256: "r".repeat(64) },
    rows: [{ orgID: 3981, entityId: "1040003981", orgName: "Citizens for Better Communities", orgTypeCode: "104", orgType: "Independent Expenditure Committee",
      orgSubType: null, candidateName: null, office: null, district: null, party: null, election: null, registrationYear: "2026", orgStatus: "Active" }],
  }),
}));

function harness(s3DocName: string, body: string) {
  const fetchDocuments = vi.fn(async () => [{ orgID: 3981, documentID: 10001, documentName: "Independent Expenditure Report",
    documentType: "Independent Expenditure Report", registrantID: "1040003981", receivedDate: "05/08/2026 10:00:00", s3DocName }]);
  const mintUrl = vi.fn(async () => "https://s3.example/presigned");
  const download = vi.fn(async (input: { outputPath: string }) => {
    await mkdir(join(input.outputPath, ".."), { recursive: true });
    await writeFile(input.outputPath, body);
    const { createHash } = await import("node:crypto");
    return { redactedUrl: "x", contentType: "application/pdf", outputPath: input.outputPath, bytesWritten: body.length, sha256: createHash("sha256").update(body).digest("hex") };
  });
  return { fetchDocuments, mintUrl, download };
}

describe("WV outside document inventory refresh", () => {
  it("reuses a cached PDF only while the remote object is unchanged", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "wv-inv-"));
    const first = harness("prd/Docs/3981/a.pdf", "%PDF-1 original");
    const run1 = await refreshWestVirginiaOutsideDocumentInventory({ cacheDir, years: [2026], ...first });
    expect(run1).toMatchObject({ downloaded: 1, reused: 0, replaced: 0 });
    const run2 = await refreshWestVirginiaOutsideDocumentInventory({ cacheDir, years: [2026], ...harness("prd/Docs/3981/a.pdf", "ignored") });
    expect(run2).toMatchObject({ downloaded: 0, reused: 1, replaced: 0 });
    expect(run2.inventory.documents[0]!.sha256).toBe(run1.inventory.documents[0]!.sha256);
    const run3 = await refreshWestVirginiaOutsideDocumentInventory({ cacheDir, years: [2026], ...harness("prd/Docs/3981/b.pdf", "%PDF-1 replacement") });
    expect(run3).toMatchObject({ downloaded: 1, reused: 0, replaced: 1 });
    expect(run3.inventory.documents[0]!.sha256).not.toBe(run1.inventory.documents[0]!.sha256);
    expect(await readFile(join(cacheDir, "outside-documents/3981/10001.pdf"), "utf8")).toBe("%PDF-1 replacement");
  });
});
