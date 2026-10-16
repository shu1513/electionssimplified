import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NCSBE_COVER_SECTIONS } from "../../../src/pipeline/northCarolinaFinance/northCarolinaNcsbeParsers.js";
import { acquireNorthCarolinaReportedReceiptSource } from "../../../src/pipeline/northCarolinaFinance/northCarolinaReportedReceiptSourceAcquisition.js";
import { readNorthCarolinaReportedReceiptSource, NORTH_CAROLINA_REPORTED_RECEIPT_LIMITS } from "../../../src/pipeline/northCarolinaFinance/northCarolinaReportedReceiptSourceCache.js";

// Synthetic official-shaped responses exercise the actual ordinary producer.
// No fixture here establishes coverage or reproduces a real source filing.
const receiver = "STA-AA11BB-C-001";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function scope() {
  const cacheDir = await mkdtemp(join(tmpdir(), "nc-reported-acquisition-"));
  roots.push(cacheDir);
  return { cacheDir, receivingCommitteeId: receiver, electionYear: 2028, orgGroupId: 17 };
}
function inventoryRow(reportId = "11", amendment = false) {
  return { CommitteeName: "Synthetic Receiver", SBoEID: receiver, ReportYear: 2028,
    DocumentType: "Disclosure Report", ReportType: "First Quarter", IsAmendment: amendment ? "Y" : "N",
    ImageReceiptDate: amendment ? "04/20/2028" : "04/10/2028", DataImportDate: amendment ? "04/20/2028" : "04/10/2028",
    PeriodStartDate: "01/01/2028", PeriodEndDate: "03/31/2028", DataLink: reportId, ImageLink: null };
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
function syntheticFetch(options: {
  zero?: boolean;
  payment?: string;
  rows?: ReturnType<typeof inventoryRow>[];
  changeClosingInventory?: boolean;
  bomCover?: boolean;
  failCover?: () => Response;
} = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let inventories = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const parsed = new URL(url);
    if (parsed.pathname === "/CFOrgLkup/DocumentGeneralResult/") {
      inventories += 1;
      const rows = options.rows ?? [inventoryRow()];
      const returned = options.changeClosingInventory && inventories === 2
        ? rows.map((row) => ({ ...row, DataImportDate: "04/11/2028" })) : rows;
      return new Response(`<script>var data = ${JSON.stringify(returned)};</script>`);
    }
    const reportId = parsed.searchParams.get("RID") ?? parsed.searchParams.get("rid") ?? "";
    const report = nativeReport(reportId, options.zero ?? false, options.payment);
    const handler = parsed.searchParams.get("handler");
    if (handler === "ReadReceipts") return new Response(report.receipts);
    if (handler === "ReadExpenditures") return new Response('{"Data":[],"Total":0,"Errors":null}');
    if (handler === "Export") return new Response(report.csv);
    return options.failCover?.() ?? new Response((options.bomCover ? "\ufeff" : "") + report.html, { headers: { "Set-Cookie": "SyntheticCookie=synthetic-cookie; Path=/; Secure; HttpOnly" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("acquireNorthCarolinaReportedReceiptSource", () => {
  it("records the real ordinary producer, native forms, current CSV, and stable closing inventory", async () => {
    const input = await scope();
    const fake = syntheticFetch();
    const sleeps: number[] = [];
    const before = Date.now();
    const result = await acquireNorthCarolinaReportedReceiptSource({ ...input, fetchImpl: fake.fetchImpl, sleep: async (ms) => { sleeps.push(ms); } });
    const after = Date.now();
    expect(result.aggregation.positiveGrossCents).toBe(75);
    expect(result.source.sourceReceiptOccurrenceCount).toBe(1);
    expect(result.source.sourceReportCount).toBe(1);
    expect(result.source.sourceControls.map((item) => item.role)).toEqual(["inventory_open", "report_cover", "receipt_page", "expenditure_page", "native_csv", "inventory_close"]);
    expect(fake.calls).toHaveLength(6);
    expect(sleeps).toEqual([2000, 2000, 2000, 2000, 2000]);
    for (const call of fake.calls) expect(call.init?.redirect).toBe("manual");
    for (const call of fake.calls.filter((call) => call.init?.method === "POST")) {
      const form = new URLSearchParams(String(call.init!.body));
      expect([...form.keys()].sort()).toEqual(["__RequestVerificationToken", "page", "pageSize"]);
      expect(form.get("page")).toBe("1");
      expect(form.get("pageSize")).toBe("300");
      expect(form.get("__RequestVerificationToken")).toBe("synthetic-nonce-11");
      expect((call.init!.headers as Record<string, string>).Cookie).toBe("SyntheticCookie=synthetic-cookie");
    }
    expect(Date.parse(result.source.sourceRetrievedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(result.source.sourceCompletedAt)).toBeLessThanOrEqual(after);
    const replay = await readNorthCarolinaReportedReceiptSource(input);
    expect(replay?.source).toEqual(result.source);
    expect(replay?.aggregation).toEqual(result.aggregation);
    const directory = join(input.cacheDir, receiver, "2028", `generation-${result.source.sourceGeneration}`);
    const manifest = await readFile(join(directory, "manifest.json"), "utf8");
    expect(manifest).not.toContain("synthetic-cookie");
    expect(manifest).not.toContain("synthetic-nonce");
  });

  it("publishes a genuine-shaped explicit zero with a complete current report", async () => {
    const input = await scope();
    const fake = syntheticFetch({ zero: true });
    const result = await acquireNorthCarolinaReportedReceiptSource({ ...input, fetchImpl: fake.fetchImpl, sleep: async () => {} });
    expect(result.aggregation.positiveGrossCents).toBe(0);
    expect(result.aggregation.groups).toEqual([]);
    expect(result.source.sourceReceiptOccurrenceCount).toBe(0);
    expect(result.source.sourceReportCount).toBe(1);
  });

  it("preserves a UTF-8 BOM consistently in the raw HTML and ordinary cache binding", async () => {
    const input = await scope();
    const fake = syntheticFetch({ bomCover: true });
    const result = await acquireNorthCarolinaReportedReceiptSource({ ...input, fetchImpl: fake.fetchImpl, sleep: async () => {} });
    const directory = join(input.cacheDir, receiver, "2028", `generation-${result.source.sourceGeneration}`);
    const raw = await readFile(join(directory, "originals", "0002.raw"));
    const ordinary = await readFile(join(directory, "ordinary-cache", "report", "11", "cover.html"));
    expect([...raw.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(ordinary.equals(raw)).toBe(true);
  });

  it("acquires original and amendment through the producer while exporting only the canonical current report", async () => {
    const input = await scope();
    const fake = syntheticFetch({ rows: [inventoryRow(), inventoryRow("12", true)] });
    const result = await acquireNorthCarolinaReportedReceiptSource({ ...input, fetchImpl: fake.fetchImpl, sleep: async () => {} });
    expect(result.source.sourceControls.filter((item) => item.role === "report_cover").map((item) => "reportId" in item ? item.reportId : null)).toEqual(["11", "12"]);
    expect(result.source.sourceControls.filter((item) => item.role === "native_csv").map((item) => "reportId" in item ? item.reportId : null)).toEqual(["12"]);
    expect(result.aggregation.positiveGrossCents).toBe(75);
    expect(fake.calls).toHaveLength(9);
  });

  it("preserves the previous pointer and source clock when a same-count closing inventory changes", async () => {
    const input = await scope();
    const first = syntheticFetch();
    const committed = await acquireNorthCarolinaReportedReceiptSource({ ...input, fetchImpl: first.fetchImpl, sleep: async () => {} });
    const changed = syntheticFetch({ changeClosingInventory: true });
    await expect(acquireNorthCarolinaReportedReceiptSource({ ...input, fetchImpl: changed.fetchImpl, sleep: async () => {} })).rejects.toMatchObject({ code: "unavailable" });
    const replay = await readNorthCarolinaReportedReceiptSource(input);
    expect(replay?.source.sourceGeneration).toBe(committed.source.sourceGeneration);
    expect(replay?.source.sourceRetrievedAt).toBe(committed.source.sourceRetrievedAt);
    expect(replay?.source.sourceCompletedAt).toBe(committed.source.sourceCompletedAt);
  });

  it.each([
    () => new Response("Synthetic complete error body", { status: 503 }),
    () => new Response("Synthetic redirect body", { status: 302, headers: { Location: "https://other.invalid/" } }),
    () => new Response(new Uint8Array([0xff, 0xfe, 0xff])),
    () => new Response("Synthetic short body", { headers: { "Content-Length": "999" } }),
  ])("retains failed response bytes and stops the host before later producer reports", async (failCover) => {
    const input = await scope();
    const fake = syntheticFetch({ rows: [inventoryRow(), inventoryRow("12", true)], failCover });
    await expect(acquireNorthCarolinaReportedReceiptSource({ ...input, fetchImpl: fake.fetchImpl, sleep: async () => {} })).rejects.toMatchObject({ code: "unavailable" });
    expect(fake.calls).toHaveLength(2);
    expect(await readNorthCarolinaReportedReceiptSource(input)).toBeNull();
    const yearDirectory = join(input.cacheDir, receiver, "2028");
    const directories = (await readdir(yearDirectory)).filter((name) => name.startsWith("generation-"));
    const originals = join(yearDirectory, directories[0]!, "originals");
    expect((await readdir(originals)).sort()).toEqual(["0001.raw", "0002.raw"]);
    expect((await readFile(join(originals, "0002.raw"))).length).toBeGreaterThan(0);
  });

  it("retains an interrupted stream's exact received prefix without publication", async () => {
    const input = await scope();
    const fake = syntheticFetch({ failCover: () => {
      let reads = 0;
      return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
        if (reads++ === 0) controller.enqueue(new TextEncoder().encode("Synthetic partial prefix"));
        else controller.error(new Error("Synthetic stream interruption"));
      } }));
    } });
    await expect(acquireNorthCarolinaReportedReceiptSource({ ...input, fetchImpl: fake.fetchImpl, sleep: async () => {} })).rejects.toMatchObject({ code: "unavailable" });
    expect(fake.calls).toHaveLength(2);
    const yearDirectory = join(input.cacheDir, receiver, "2028");
    const generation = (await readdir(yearDirectory)).find((name) => name.startsWith("generation-"))!;
    expect(await readFile(join(yearDirectory, generation, "originals", "0002.raw"), "utf8")).toBe("Synthetic partial prefix");
    expect(await readNorthCarolinaReportedReceiptSource(input)).toBeNull();
  });

  it("bounds each retained body and stops before any subsequent source request", async () => {
    const input = await scope();
    const fake = syntheticFetch({ failCover: () => {
      let sent = 0;
      return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
        const next = Math.min(1024 * 1024, NORTH_CAROLINA_REPORTED_RECEIPT_LIMITS.maxBodyBytes + 1 - sent);
        if (next <= 0) { controller.close(); return; }
        controller.enqueue(new Uint8Array(next));
        sent += next;
      } }));
    } });
    await expect(acquireNorthCarolinaReportedReceiptSource({ ...input, fetchImpl: fake.fetchImpl, sleep: async () => {} })).rejects.toMatchObject({ code: "unavailable" });
    expect(fake.calls).toHaveLength(2);
    const yearDirectory = join(input.cacheDir, receiver, "2028");
    const generation = (await readdir(yearDirectory)).find((name) => name.startsWith("generation-"))!;
    expect((await readFile(join(yearDirectory, generation, "originals", "0002.raw"))).length).toBe(NORTH_CAROLINA_REPORTED_RECEIPT_LIMITS.maxBodyBytes);
    const journal = JSON.parse(await readFile(join(yearDirectory, generation, "capture-journal.json"), "utf8"));
    expect(journal.originals[1]).toMatchObject({ eof: false, byteSize: NORTH_CAROLINA_REPORTED_RECEIPT_LIMITS.maxBodyBytes });
    expect(await readNorthCarolinaReportedReceiptSource(input)).toBeNull();
  });

  it("holds ambiguous lineage after ordinary acquisition without requesting CSV or closing inventory", async () => {
    const input = await scope();
    const fake = syntheticFetch({ rows: [inventoryRow(), inventoryRow("12")] });
    await expect(acquireNorthCarolinaReportedReceiptSource({ ...input, fetchImpl: fake.fetchImpl, sleep: async () => {} })).rejects.toMatchObject({ code: "held", holdReason: "current_lineage" });
    expect(fake.calls).toHaveLength(7);
    expect(fake.calls.some((call) => call.url.includes("handler=Export"))).toBe(false);
    expect(await readNorthCarolinaReportedReceiptSource(input)).toBeNull();
  });

  it("keeps an unknown relevant payment held through independent final replay", async () => {
    const input = await scope();
    const fake = syntheticFetch({ payment: "Unsupported synthetic payment" });
    await expect(acquireNorthCarolinaReportedReceiptSource({ ...input, fetchImpl: fake.fetchImpl, sleep: async () => {} })).rejects.toMatchObject({ code: "held", holdReason: "payment_type" });
    expect(await readNorthCarolinaReportedReceiptSource(input)).toBeNull();
  });
});
