import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FLORIDA_CCE_CERTIFICATION_REVOCATION_AUTHORITY } from "../../../src/pipeline/floridaFinance/floridaCommitteeDonorIdentity.js";
import { loadFloridaReviewedCommitteeDates } from "../../../src/pipeline/floridaFinance/floridaReviewedCommitteeDates.js";

let directory: string;
const pdf = Buffer.from("%PDF-1.4\npublic reviewed document\n%%EOF\n");
const url = "https://dos.elections.myflorida.com/campaign-docs/PDFHandler.ashx?AcctType=08/14/13&TrackNum=100208396";
const registration = { effectiveDate: "2013-08-13", metadataPath: "pdf.json" };
const record = { committeeId: "60813", registration };
async function manifest(value: unknown = { version: 1, records: [record] }): Promise<string> {
  const path = join(directory, "reviewed.json");
  await writeFile(path, JSON.stringify(value));
  return path;
}
async function metadata(changes: Record<string, unknown> = {}): Promise<void> {
  await writeFile(join(directory, "pdf.json"), JSON.stringify({
    version: 1, rawPath: "pdf.raw", bytes: pdf.length,
    sha256: createHash("sha256").update(pdf).digest("hex"), url,
    status: 200, method: "GET", financeFields: null, contentType: "application/pdf",
    startedAt: "2026-10-11T20:59:51.807Z", completedAt: "2026-10-11T20:59:52.208Z",
    ...changes,
  }));
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "florida-reviewed-dates-"));
  await writeFile(join(directory, "pdf.raw"), pdf);
  await metadata();
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("human-reviewed committee date artifacts", () => {
  it("loads relative immutable artifacts and retains original source times/bytes", async () => {
    const rows = await loadFloridaReviewedCommitteeDates(await manifest());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ committeeId: "60813", registration: {
      effectiveDate: "2013-08-13", document: { url, startedAt: "2026-10-11T20:59:51.807Z", financeFields: null },
    } });
    expect(Buffer.from(rows[0]!.registration!.document.bytesRaw)).toEqual(pdf);
  });
  it("supports absolute metadata and raw paths without rewriting source timestamps", async () => {
    await metadata({ rawPath: join(directory, "pdf.raw") });
    expect(await loadFloridaReviewedCommitteeDates(await manifest({ version: 1, records: [{
      committeeId: "60813", registration: { ...registration, metadataPath: join(directory, "pdf.json") },
    }] }))).toHaveLength(1);
  });
  it("retains reviewed activeBy/closedBy bounds without inventing effective dates", async () => {
    const rows = await loadFloridaReviewedCommitteeDates(await manifest({ version: 1, records: [{
      committeeId: "60678", registration: { activeBy: "2013-08-01", metadataPath: "pdf.json" },
    }, {
      committeeId: "4529", disbandment: { closedBy: "2013-08-01", metadataPath: "pdf.json" },
    }] }));
    expect(rows[0]!.registration).toMatchObject({ activeBy: "2013-08-01", document: { url } });
    expect(rows[0]!.registration).not.toHaveProperty("effectiveDate");
    expect(rows[1]!.disbandment).toMatchObject({ closedBy: "2013-08-01", document: { url } });
    expect(rows[1]!.disbandment).not.toHaveProperty("effectiveDate");
    expect(Buffer.from(rows[0]!.registration!.document.bytesRaw)).toEqual(pdf);
  });
  it("leaves overlapping conservative bounds for the donor resolver", async () => {
    const rows = await loadFloridaReviewedCommitteeDates(await manifest({ version: 1, records: [{
      committeeId: "60813", registration: { activeBy: "2013-09-01", metadataPath: "pdf.json" },
      disbandment: { closedBy: "2013-08-01", metadataPath: "pdf.json" },
    }] }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.registration).toHaveProperty("activeBy", "2013-09-01");
  });
  it("rejects exact registration later than a proven closure bound", async () => {
    await expect(loadFloridaReviewedCommitteeDates(await manifest({ version: 1, records: [{
      committeeId: "60813", registration,
      disbandment: { closedBy: "2013-08-01", metadataPath: "pdf.json" },
    }] }))).rejects.toThrow("predates registration");
  });
  it.each([
    { registration: { effectiveDate: "2013-08-01", activeBy: "2013-08-01", metadataPath: "pdf.json" } },
    { registration: { closedBy: "2013-08-01", metadataPath: "pdf.json" } },
    { registration: { activeBy: "2013-02-29", metadataPath: "pdf.json" } },
    { registration: { metadataPath: "pdf.json" } },
    { disbandment: { effectiveDate: "2013-08-01", closedBy: "2013-08-01", metadataPath: "pdf.json" } },
    { disbandment: { activeBy: "2013-08-01", metadataPath: "pdf.json" } },
  ])("rejects ambiguous or wrong-kind bounds %j", async entry => {
    await expect(loadFloridaReviewedCommitteeDates(await manifest({ version: 1,
      records: [{ committeeId: "60813", ...entry }],
    }))).rejects.toThrow();
  });
  it("rejects corrupt source bytes equally for bounded date evidence", async () => {
    await writeFile(join(directory, "pdf.raw"), Buffer.from("%PDF-1.4 corrupted"));
    await expect(loadFloridaReviewedCommitteeDates(await manifest({ version: 1, records: [{
      committeeId: "60678", registration: { activeBy: "2013-08-01", metadataPath: "pdf.json" },
    }] }))).rejects.toThrow("mismatch");
  });
  it("exposes only public provenance fields, not arbitrary cache headers", async () => {
    await metadata({ headers: { cookie: "not-a-product-field" }, requestKey: "cache bookkeeping" });
    const rows = await loadFloridaReviewedCommitteeDates(await manifest());
    expect(rows[0]!.registration!.document).not.toHaveProperty("headers");
    expect(rows[0]!.registration!.document).not.toHaveProperty("requestKey");
  });
  it("accepts explicitly empty reviewed records without fabricating date evidence", async () => {
    expect(await loadFloridaReviewedCommitteeDates(await manifest({ version: 1, records: [] }))).toEqual([]);
  });
  it.each([
    ["version", { version: 2, records: [record] }],
    ["unknown field", { version: 1, records: [record], inferred: true }],
    ["duplicate accounts", { version: 1, records: [record, record] }],
    ["numeric account", { version: 1, records: [{ ...record, committeeId: 60813 }] }],
    ["leading-zero account", { version: 1, records: [{ ...record, committeeId: "060813" }] }],
    ["empty date record", { version: 1, records: [{ committeeId: "60813" }] }],
    ["unknown date field", { version: 1, records: [{ ...record, registration: { ...registration, guessed: true } }] }],
    ["nonexistent day", { version: 1, records: [{ ...record, registration: { ...registration, effectiveDate: "2026-02-30" } }] }],
    ["unqualified date", { version: 1, records: [{ ...record, registration: { ...registration, effectiveDate: "08/13/2013" } }] }],
    ["remote metadata", { version: 1, records: [{ ...record, registration: { ...registration, metadataPath: "https://example.com/pdf.json" } }] }],
    ["null entry", { version: 1, records: [{ ...record, registration: null }] }],
    ["reversed dates", { version: 1, records: [{ ...record, disbandment: { effectiveDate: "2013-08-12", metadataPath: "pdf.json" } }] }],
  ])("rejects malformed manifest %s", async (_label, value) => {
    await expect(loadFloridaReviewedCommitteeDates(await manifest(value))).rejects.toThrow();
  });
  it.each([
    { sha256: "0".repeat(64) }, { bytes: pdf.length + 1 }, { bytes: 0 }, { bytes: 3 * 1024 * 1024 },
    { status: 404 }, { method: "POST" }, { financeFields: {} }, { contentType: "text/html" },
    { startedAt: "invalid" }, { completedAt: "2026-10-10T00:00:00.000Z" },
    { url: "https://example.com/campaign-docs/PDFHandler.ashx?AcctType=08/14/13&TrackNum=100208396" },
    { url: url + "&account=60813" }, { url: url.replace("100208396", "0") },
    { url: url.replace("PDFHandler.ashx", "Index.asp") }, { rawPath: "https://example.com/file.pdf" },
  ])("rejects unbound/corrupt PDF metadata %j", async changes => {
    await metadata(changes);
    await expect(loadFloridaReviewedCommitteeDates(await manifest())).rejects.toThrow();
  });
  it("rejects same-size nonPDF bytes even with their correct checksum", async () => {
    const bytes = Buffer.from(pdf);
    bytes.fill(32, 0, 5);
    await writeFile(join(directory, "pdf.raw"), bytes);
    await metadata({ sha256: createHash("sha256").update(bytes).digest("hex") });
    await expect(loadFloridaReviewedCommitteeDates(await manifest())).rejects.toThrow("magic mismatch");
  });
  it("rejects missing raw artifacts and malformed JSON", async () => {
    await rm(join(directory, "pdf.raw"));
    await expect(loadFloridaReviewedCommitteeDates(await manifest())).rejects.toThrow();
    await writeFile(join(directory, "pdf.json"), "{broken");
    await expect(loadFloridaReviewedCommitteeDates(await manifest())).rejects.toThrow("JSON");
  });
  it("bounds actual local reads independently of claimed byte metadata", async () => {
    await writeFile(join(directory, "pdf.raw"), Buffer.alloc(2 * 1024 * 1024 + 1));
    await expect(loadFloridaReviewedCommitteeDates(await manifest())).rejects.toThrow("byte bound");
    await writeFile(join(directory, "pdf.json"), Buffer.alloc(64 * 1024 + 1));
    await expect(loadFloridaReviewedCommitteeDates(await manifest())).rejects.toThrow("byte bound");
  });
  it("does not modify the caller's immutable manifest or raw source", async () => {
    const path = await manifest();
    const original = await readFile(path);
    await loadFloridaReviewedCommitteeDates(path);
    expect(await readFile(path)).toEqual(original);
    expect(await readFile(join(directory, "pdf.raw"))).toEqual(pdf);
  });
});


describe("reviewed distinct certification-revocation artifacts", () => {
  const authority = FLORIDA_CCE_CERTIFICATION_REVOCATION_AUTHORITY;
  const revocation = { revokedOn: authority.revokedOn, section: authority.section, metadataPath: "pdf.json" };
  it("does not accept arbitrary PDF bodies even with the reviewed law URL", async () => {
    await metadata({ url: authority.sourceUrl });
    await expect(loadFloridaReviewedCommitteeDates(await manifest({ version: 1, records: [{
      committeeId: "5478", certificationRevocation: revocation,
    }] }))).rejects.toThrow("unreviewed certification revocation document");
  });
  it("hashes untouched bytes rather than trusting caller-supplied authority SHA", async () => {
    await metadata({ url: authority.sourceUrl, sha256: authority.sha256 });
    await expect(loadFloridaReviewedCommitteeDates(await manifest({ version: 1, records: [{
      committeeId: "5478", certificationRevocation: revocation,
    }] }))).rejects.toThrow("hash/magic mismatch");
  });
  it.each([
    { revokedOn: "2013-10-01" }, { section: "2(4)" }, { closedBy: "2013-09-30" },
    { effectiveDate: "2013-09-30" }, { guessed: true },
  ])("rejects unreviewed or disguised law entries %#", change => {
    return expect(manifest({ version: 1, records: [{ committeeId: "5478",
      certificationRevocation: { ...revocation, ...change } }] }).then(loadFloridaReviewedCommitteeDates))
      .rejects.toThrow();
  });
  it("rejects missing metadata without translating law into an account closure", async () => {
    await expect(loadFloridaReviewedCommitteeDates(await manifest({ version: 1, records: [{
      committeeId: "5478", certificationRevocation: { revokedOn: authority.revokedOn, section: authority.section },
    }] }))).rejects.toThrow();
  });
});
