import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NCSBE_COVER_SECTIONS, parseNcsbeDocumentListPage } from "../../../src/pipeline/northCarolinaFinance/northCarolinaNcsbeParsers.js";
import { storeNcsbeArtifact, getNcsbeArtifactPaths, type NcsbeArtifactKey } from "../../../src/pipeline/northCarolinaFinance/northCarolinaNcsbeArtifactCache.js";
import { ncsbeSourceDocumentMetadata } from "../../../src/pipeline/northCarolinaFinance/northCarolinaNcsbeArtifactAcquisition.js";
import { ncsbeDocumentInventoryUrl, ncsbeReportDetailUrl, ncsbeReceiptsUrl, ncsbeExpendituresUrl } from "../../../src/pipeline/northCarolinaFinance/northCarolinaNcsbeClient.js";
import { appendNorthCarolinaReportedReceiptOriginal as append, beginNorthCarolinaReportedReceiptGeneration as begin, closeNorthCarolinaReportedReceiptGeneration as close, finalizeNorthCarolinaReportedReceiptGeneration as finalize, readNorthCarolinaReportedReceiptSource as read, readNorthCarolinaReportedReceiptSourceRevision as revision, validateNorthCarolinaReportedReceiptOriginalUrl as validateUrl } from "../../../src/pipeline/northCarolinaFinance/northCarolinaReportedReceiptSourceCache.js";
import type { Binding, CaptureScope, Generation } from "../../../src/pipeline/northCarolinaFinance/northCarolinaReportedReceiptSourceTypes.js";
// Keep real filesystem semantics while forcing both reclaimers to observe
// the original occupied lock before either enters the recovery critical section.
const lockRace = vi.hoisted(() => ({ enabled: false, arrivals: 0,
  barrier: Promise.resolve(), release: () => {} }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    try { return await actual.open(...args); }
    catch (error) {
      if (lockRace.enabled && String(args[0]).endsWith("/refresh.lock") && args[1] === "wx"
        && (error as NodeJS.ErrnoException).code === "EEXIST") {
        lockRace.arrivals++;
        if (lockRace.arrivals === 2) lockRace.release();
        await lockRace.barrier;
      }
      throw error;
    }
  } };
});
// Synthetic official-shaped fixtures; no real source records or financial proof.
const receiver = "STA-AA11BB-C-001";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function scope() {
  const cacheDir = await mkdtemp(join(tmpdir(), "nc-reported-cache-"));
  roots.push(cacheDir);
  return { cacheDir, receivingCommitteeId: receiver, electionYear: 2028, orgGroupId: 17 };
}
function inventoryRow(reportId = "11", amendment = false) {
  return { CommitteeName: "Synthetic Receiver", SBoEID: receiver, ReportYear: 2028,
    DocumentType: "Disclosure Report", ReportType: "First Quarter", IsAmendment: amendment ? "Y" : "N",
    ImageReceiptDate: amendment ? "04/20/2028" : "04/10/2028", DataImportDate: amendment ? "04/20/2028" : "04/10/2028",
    PeriodStartDate: "01/01/2028", PeriodEndDate: "03/31/2028", DataLink: reportId, ImageLink: null, DataType: "Synthetic structured", ImageType: "Synthetic image" };
}
function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
const csvLine = (cells: unknown[]) => cells.map(csvCell).join(",");
function nativeReport(reportId: string, zero: boolean, payment = "Check") {
  const summary = [...NCSBE_COVER_SECTIONS].map(([Sequence, Section]) => ({ Sequence, Section,
    Period: Sequence === 35 && !zero ? 0.75 : 0, Cycle: Sequence === 35 && !zero ? 0.75 : 0 }));
  const cover = { BoeID: receiver, OrgName: "Synthetic Receiver", EntityTypeDesc: null, FullReportName: null,
    ReportVersion: null, BeginDate: "01/01/2028", EndDate: "03/31/2028", FiledDate: "04/10/2028" };
  const exportPath = `/CFOrgLkup/ReportDetail?handler=Export&RID=${reportId}&TP=ALL&sid=&cn=`;
  const html = `<a href="${exportPath.replace(/&/g, "&amp;")}">Export CSV</a><input name="__RequestVerificationToken" value="synthetic-nonce-${reportId}"><script>var rptID = ${reportId}; var dataCover = ${JSON.stringify(cover)}; SetupGrid(${JSON.stringify(summary)});</script>`;
  const receipt = { GroupID: 9, OccurDate: "02/02/2028", IsPrior: " ", OrgName: "Synthetic Source",
    Street1: "", Street2: "", City: "", State: "", FullZip: "", CountryName: "", OutsideUSPostalCode: "",
    Profession: null, EmployersName: null, Purpose: null, ReceiptTypeDesc: "Other Political Committees",
    ReceiptTypeCode: "CPCM", AccountAbbr: "SYNTH", FormOfPaymentDesc: payment, Description: null,
    Amount: 0.75, SumToDate: 0.75, IsOrg: true, IsAggregated: false };
  const parts = ["COVER", "Synthetic Header", "Synthetic Value", "", "SUMMARY", "Sequence,Section,Period,Cycle",
    ...summary.map((row) => csvLine([row.Sequence, row.Section, row.Period.toFixed(4), row.Cycle.toFixed(4)]))];
  if (!zero) parts.push("", "RECEIPTS",
    "Group ID,Date,Is Prior,Name,Street 1,Street 2,City,State,Full Zip,Country Name,Outside US Postal Code,Profession,Employers Name,Purpose,Receipt Type Desc,Account Abbr,Form Of Payment Desc,Description,Amount,Sum To Date",
    csvLine([9, "02/02/2028", "", "Synthetic Source", "", "", "", "", "", "", "", "", "", "", "Other Political Committees", "SYNTH", payment, "", "0.7500", "0.7500"]));
  return { html, csv: parts.join("\r\n") + "\r\n", receipts: JSON.stringify({ Data: zero ? [] : [receipt], Total: zero ? 0 : 1, Errors: null }) };
}
type Options = { zero?: boolean; payment?: string; amended?: boolean; changeClosing?: boolean; reorderClosing?: boolean; changeNative?: boolean; skipOrdinaryPage?: boolean; clock?: number; omitOriginal?: string; status?: number; eof?: boolean };
async function stage(input: CaptureScope, options: Options = {}) {
  const g = await begin(input);
  const rows = options.amended ? [inventoryRow(), inventoryRow("12", true)] : [inventoryRow()];
  const inventory = `<script>var data = ${JSON.stringify(rows)};</script>`;
  const parsed = parseNcsbeDocumentListPage(inventory);
  let tick = options.clock ?? Date.now() - 1000;
  async function record(b: Binding, url: string, body: string, key?: NcsbeArtifactKey, rowIndex = 0) {
    if (b.role === options.omitOriginal) return;
    await append({ generation: g, binding: b, url, bytes: Buffer.from(body), status: options.status ?? 200, eof: options.eof ?? true,
      startedAt: new Date(tick), completedAt: new Date(tick++) });
    if (key && !(options.skipOrdinaryPage && b.role === "receipt_page")) await storeNcsbeArtifact({ cacheDir: g.ordinaryCacheDir, key, body, url,
      sourceDocument: key.type === "document_inventory" ? null : ncsbeSourceDocumentMetadata(parsed[rowIndex]!) });
  }
  const inventoryUrl = ncsbeDocumentInventoryUrl({ sboeId: receiver, orgGroupId: input.orgGroupId });
  await record({ role: "inventory_open" }, inventoryUrl, inventory, { type: "document_inventory", sboeId: receiver });
  for (const [index, row] of rows.entries()) {
    const id = row.DataLink, native = nativeReport(id, options.zero ?? false, options.payment);
    await record({ role: "report_cover", reportId: id }, ncsbeReportDetailUrl(id), native.html, { type: "report_cover", reportId: id }, index);
    await record({ role: "receipt_page", reportId: id, page: 0 }, ncsbeReceiptsUrl(id), native.receipts,
      { type: "report_transactions", reportId: id, kind: "receipts", page: 0 }, index);
    await record({ role: "expenditure_page", reportId: id, page: 0 }, ncsbeExpendituresUrl(id), '{"Data":[],"Total":0,"Errors":null}',
      { type: "report_transactions", reportId: id, kind: "expenditures", page: 0 }, index);
  }
  const current = rows.at(-1)!.DataLink, native = nativeReport(current, options.zero ?? false, options.payment);
  await record({ role: "native_csv", reportId: current }, `https://cf.ncsbe.gov/CFOrgLkup/ReportDetail?handler=Export&RID=${current}&TP=ALL&sid=&cn=`, native.csv);
  const ending = options.changeClosing ? inventory.replace('04/10/2028', '04/11/2028') : options.reorderClosing ? `<script>var data = ${JSON.stringify([...rows].reverse())};</script>` : options.changeNative ? inventory.replace("Synthetic structured", "Synthetic changed") : inventory;
  await record({ role: "inventory_close" }, inventoryUrl, ending);
  return g;
}
const base = (input: CaptureScope) => join(input.cacheDir!, receiver, String(input.electionYear));
const pointerPath = (input: CaptureScope) => join(base(input), "current.json");
async function publish(input: CaptureScope, options: Options = {}) { const g = await stage(input, options); try { return await finalize(g); } finally { await close(g); } }
async function changeManifest(g: Generation, edit: (m: any) => void) {
  const file = join(g.directory, "manifest.json"); const m = JSON.parse(await readFile(file, "utf8")); edit(m);
  const bytes = Buffer.from(JSON.stringify(m)); await writeFile(file, bytes, { mode: 0o600 });
  const current = join(g.directory, "..", "current.json"), p = JSON.parse(await readFile(current, "utf8"));
  p.manifestSha256 = createHash("sha256").update(bytes).digest("hex"); await writeFile(current, JSON.stringify(p), { mode: 0o600 });
}

describe("North Carolina immutable reported-receipt source cache", () => {
  it("exposes only a scheduling revision; original corruption still requires full financial replay", async () => {
    const input = await scope();
    expect(await revision(input)).toBeNull();
    const packet = await publish(input);
    const expected = { sourceGeneration: packet.source.sourceGeneration,
      sourceRetrievedAt: packet.source.sourceRetrievedAt, sourceCompletedAt: packet.source.sourceCompletedAt,
      sourceManifestSha256: packet.source.sourceManifestSha256 };
    const hint = await revision(input);
    expect(hint).toEqual(expected);
    expect(Object.isFrozen(hint)).toBe(true);
    await writeFile(join(base(input), `generation-${packet.source.sourceGeneration}`, "originals", "0003.raw"), "Synthetic altered receipt body");
    expect(await revision(input)).toEqual(expected);
    await expect(read(input)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("rejects an invalid scheduling manifest or pointer without falling back", async () => {
    const input = await scope();
    const packet = await publish(input);
    await writeFile(join(base(input), `generation-${packet.source.sourceGeneration}`, "manifest.json"), "{}");
    await expect(revision(input)).rejects.toMatchObject({ code: "unavailable" });
    await writeFile(pointerPath(input), "{}");
    await expect(revision(input)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("independently qualifies complete ordinary originals, retains amendment acquisition, and exports only current receipts", async () => {
    const input = await scope(); const g = await stage(input, { amended: true });
    const result = await finalize(g); await close(g);
    expect(result.aggregation.positiveGrossCents).toBe(75);
    expect(result.source.sourceReceiptOccurrenceCount).toBe(1);
    expect(result.source.sourceReportCount).toBe(1);
    expect(result.source.sourceControls).toHaveLength(9);
    expect(result.source.sourceControls.filter((o) => o.role === "report_cover")).toHaveLength(2);
    expect(result.source.sourceControls.filter((o) => o.role === "native_csv")).toHaveLength(1);
    expect(await read(input)).toEqual(result);
    expect(Object.isFrozen(result.source.sourceControls[0])).toBe(true);
    expect((await lstat(join(g.ordinaryCacheDir, "report", "11", "cover.html"))).mode & 0o777).toBe(0o600);
    const cached = JSON.parse(await readFile(join(g.ordinaryCacheDir, "report", "11", "cover.html.manifest.json"), "utf8"));
    expect(cached.filePath).toBe(join(g.ordinaryCacheDir, "report", "11", "cover.html"));
  });

  it("accepts reordered closing native occurrences without deduplicating the population", async () => {
    const input = await scope();
    await expect(publish(input, { amended: true, reorderClosing: true })).resolves.toHaveProperty("source.sourceReportCount", 1);
  });

  it("restricts already-written ordinary artifacts when a failed capture closes", async () => {
    const input = await scope(), g = await stage(input, { changeClosing: true });
    await close(g);
    expect((await lstat(join(g.ordinaryCacheDir, "report"))).mode & 0o777).toBe(0o700);
    expect((await lstat(join(g.ordinaryCacheDir, "report", "11", "cover.html"))).mode & 0o777).toBe(0o600);
  });

  it("permits only one of two concurrent stale-lease reclaimers to capture", async () => {
    const input = await scope(), abandoned = await stage(input);
    const retainedBody = join(abandoned.ordinaryCacheDir, "report", "11", "cover.html");
    await chmod(retainedBody, 0o644);
    const old = new Date(Date.now() - 41 * 60_000); await utimes(join(base(input), "refresh.lock"), old, old);
    lockRace.arrivals = 0;
    lockRace.barrier = new Promise<void>((resolve) => { lockRace.release = resolve; });
    lockRace.enabled = true;
    let attempts: PromiseSettledResult<Generation>[];
    try { attempts = await Promise.allSettled([begin(input), begin(input)]); }
    finally { lockRace.enabled = false; }
    expect(lockRace.arrivals).toBe(2);
    const winners = attempts.filter((r): r is PromiseFulfilledResult<Generation> => r.status === "fulfilled");
    expect(winners).toHaveLength(1);
    expect(attempts.filter((r) => r.status === "rejected")).toHaveLength(1);
    await expect(close(abandoned)).rejects.toMatchObject({ code: "locked" });
    expect((await lstat(retainedBody)).mode & 0o777).toBe(0o600);
    await expect(begin(input)).rejects.toMatchObject({ code: "locked" });
    await close(winners[0]!.value);
  });

  it("publishes explicit zero from a complete report, keeping true source clocks and zero occurrences", async () => {
    const input = await scope(); const clock = Date.now() - 60_000;
    const result = await publish(input, { zero: true, clock });
    expect(result.aggregation.groups).toEqual([]);
    expect(result.source.sourceReceiptOccurrenceCount).toBe(0);
    expect(result.source.sourceReportCount).toBe(1);
    expect(result.source.sourceRetrievedAt).toBe(new Date(clock).toISOString());
    expect(result.source.sourceCompletedAt).toBe(new Date(clock + 5).toISOString());
  });

  it("holds a relevant unknown payment without changing the previous pointer or clocks", async () => {
    const input = await scope(); const old = await publish(input); const before = await readFile(pointerPath(input));
    const g = await stage(input, { payment: "Synthetic Unknown" });
    await expect(finalize(g)).rejects.toMatchObject({ code: "held", holdReason: "payment_type" }); await close(g);
    expect((await readFile(pointerPath(input))).equals(before)).toBe(true);
    expect((await read(input))?.source).toEqual(old.source);
  });

  it.each([
    { changeClosing: true }, { changeNative: true }, { skipOrdinaryPage: true }, { omitOriginal: "expenditure_page" }, { omitOriginal: "native_csv" },
    { status: 503 }, { eof: false },
  ])("rejects partial or incoherent generations and preserves the last qualified pointer", async (options) => {
    const input = await scope(); await publish(input); const before = await readFile(pointerPath(input));
    const g = await stage(input, options);
    await expect(finalize(g)).rejects.toMatchObject({ code: "unavailable" }); await close(g);
    expect((await readFile(pointerPath(input))).equals(before)).toBe(true);
  });

  it("a crash before publication leaves only private staged originals; a later refresh remains possible", async () => {
    const input = await scope(); const g = await stage(input); await close(g);
    expect(await read(input)).toBeNull();
    expect((await readFile(join(g.directory, "originals", "0001.raw"))).length).toBeGreaterThan(0);
    await expect(publish(input)).resolves.toHaveProperty("source.sourceReportCount", 1);
  });

  it("rejects older and equal first-source clocks without backdating a new pointer", async () => {
    const input = await scope(), clock = Date.now() - 1000; await publish(input, { clock });
    const before = await readFile(pointerPath(input));
    for (const older of [clock - 1, clock]) {
      const g = await stage(input, { clock: older });
      await expect(finalize(g)).rejects.toMatchObject({ code: "stale_generation" }); await close(g);
      expect((await readFile(pointerPath(input))).equals(before)).toBe(true);
    }
  });

  it("serializes live refreshes and allows a properly stale abandoned lease to be reclaimed", async () => {
    const input = await scope(), first = await begin(input);
    await expect(begin(input)).rejects.toMatchObject({ code: "locked" });
    const old = new Date(Date.now() - 41 * 60_000); await utimes(join(base(input), "refresh.lock"), old, old);
    const second = await begin(input);
    await expect(close(first)).rejects.toMatchObject({ code: "locked" });
    await expect(begin(input)).rejects.toMatchObject({ code: "locked" });
    await close(second); await close(second);
    const third = await begin(input); await close(third);
  });

  it("retains failed EOF bytes and a safe diagnostic descriptor without permitting publication", async () => {
    const input = await scope(), g = await begin(input);
    const bytes = Buffer.from("Synthetic partial native response");
    await append({ generation: g, binding: { role: "inventory_open" }, url: ncsbeDocumentInventoryUrl({ sboeId: receiver, orgGroupId: 17 }),
      bytes, status: 200, eof: false, startedAt: new Date(), completedAt: new Date() });
    const journal = JSON.parse(await readFile(join(g.directory, "capture-journal.json"), "utf8"));
    expect(journal.originals[0]).toMatchObject({ eof: false, byteSize: bytes.length });
    expect((await readFile(join(g.directory, "originals", "0001.raw"))).equals(bytes)).toBe(true);
    await expect(finalize(g)).rejects.toMatchObject({ code: "unavailable" }); await close(g);
    expect(await read(input)).toBeNull();
  });

  it.each(["original", "ordinary", "manifest", "utf8", "symlink", "permissions"])("detects %s corruption at every read", async (kind) => {
    const input = await scope(), g = await stage(input); await finalize(g); await close(g);
    const raw = join(g.directory, "originals", "0003.raw");
    if (kind === "original") await writeFile(raw, "Synthetic changed body");
    if (kind === "ordinary") await writeFile(join(g.ordinaryCacheDir, "report", "11", "receipts-p0.json"), '{"Data":[],"Total":0}');
    if (kind === "manifest") await writeFile(join(g.directory, "manifest.json"), "{}");
    if (kind === "utf8") { const bytes = Buffer.from([0xff]); await writeFile(raw, bytes); await changeManifest(g, (m) => { m.originals[2].byteSize = 1; m.originals[2].sha256 = createHash("sha256").update(bytes).digest("hex"); }); }
    if (kind === "symlink") { await rm(raw); await symlink(join(g.ordinaryCacheDir, "report", "11", "receipts-p0.json"), raw); }
    if (kind === "permissions") await chmod(raw, 0o644);
    await expect(read(input)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("never falls back from an invalid present pointer, including on a later zero refresh", async () => {
    const input = await scope(); await publish(input); await writeFile(pointerPath(input), "{}");
    const g = await stage(input, { zero: true });
    await expect(finalize(g)).rejects.toMatchObject({ code: "unavailable" }); await close(g);
    expect(await readFile(pointerPath(input), "utf8")).toBe("{}");
    await expect(read(input)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("rejects descriptor page geometry and source chronology even with a recomputed whole manifest hash", async () => {
    for (const edit of [
      (m: any) => { m.originals[2].page = 1; },
      (m: any) => { m.originals[2].startedAt = m.originals[0].startedAt; },
      (m: any) => { m.originals[0].startedAt = new Date(Date.now() + 10 * 60_000).toISOString(); m.sourceRetrievedAt = m.originals[0].startedAt; },
    ]) {
      const input = await scope(), g = await stage(input); await finalize(g); await close(g); await changeManifest(g, edit);
      await expect(read(input)).rejects.toMatchObject({ code: "unavailable" });
    }
  });

  it("validates native role routes without accepting other hosts, forms, or broadened export scope", () => {
    const input = { receivingCommitteeId: receiver, orgGroupId: 17, electionYear: 2028 };
    const binding = { role: "native_csv", reportId: "11" } as const;
    const good = "https://cf.ncsbe.gov/CFOrgLkup/ReportDetail?handler=Export&RID=11&TP=ALL&sid=&cn=";
    expect(() => validateUrl({ scope: input, binding, url: good })).not.toThrow();
    for (const url of [good.replace("TP=ALL", "TP=RECEIPTS"), good + "&RID=11", good.replace("cf.ncsbe.gov", "other.invalid"), good + "#fragment", good.replace("sid=", "sid=other")])
      expect(() => validateUrl({ scope: input, binding, url })).toThrow("North Carolina reported receipt source unavailable");
  });
});
