import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createTennesseeCurrentReportClient,
  decodeTennesseeCurrentReportBytes,
  parseTennesseeCurrentReport,
  parseTennesseeCurrentReportManifestPage,
  type TennesseeCurrentReportManifestRow,
  type TennesseeCurrentReportRawSource,
} from "../../../src/pipeline/tennesseeFinance/tennesseeCurrentReportClient.js";

// Compact synthetic fixtures use the observed official schema; they do not claim
// an actual deleted gift or financial acceptance of an acquired generation.
const base = "https://apps.tn.gov";
const row: TennesseeCurrentReportManifestRow = {
  campId: "794", ownerName: "CROWE, RUSTY", reportId: "122149",
  electionYear: 2026, reportYear: 2025, reportName: "Early Mid Year Supplemental 2025",
  amended: true, submittedDate: "2025-07-11",
  sourceUrl: base + "/tncamp/search/pub/report_full.htm?reportId=122149",
};
function raw(html: string, manifestRow = row): TennesseeCurrentReportRawSource {
  const bytes = Buffer.from(html);
  return { url: manifestRow.sourceUrl, bytes, byteCount: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"), encoding: "utf-8" };
}
function cover(label: string, value: string): string {
  return '<div class="row control-group report-row-solid"><div>' + label +
    '</div><div>' + value + '</div></div>';
}
function table(id: string, headers: string[], rows: string[][]): string {
  return '<table id="' + id + '"><thead><tr>' + headers.map(v => "<th>" + v + "</th>").join("") +
    "</tr></thead><tbody>" + rows.map(r => "<tr>" + r.map(v => "<td>" + v + "</td>").join("") +
      "</tr>").join("") + "</tbody></table>";
}
function report(input: { cash?: string[][]; cashTotal?: string; pac?: boolean;
  heading?: string; extra?: string } = {}): string {
  const cash = input.cash ?? [
    ["REPORTED PAC<br>10 MAIN ST<br>NASHVILLE, TN 37000", "P", "Primary", "06/23/2025", "$1,000.00", "$1,000.00"],
    ["REPORTED PAC<br>10 MAIN ST<br>NASHVILLE, TN 37000", "P", "Primary", "06/23/2025", "$1,000.00", "$1,000.00"],
  ];
  const cashHeaders = input.pac ? ["Contributor", "C/P", "Date", "Amount"] :
    ["Contributor", "C/P", "Rec'd For", "Date", "Amount", "Aggregate"];
  const total = input.cashTotal ?? "$2,000.00";
  return "<html><body><h1>" + (input.heading ?? "Amended 2026 Early Mid Year Supplemental (2025) for RUSTY CROWE submitted on 07/11/2025") +
    '</h1><a href="/tncamp/public/search.htm?x=1">Back to Search Results</a>' +
    "<h2>Beginning Balance</h2>" + cover("Beginning Balance", "$1,000.00") +
    "<h2>Receipts</h2>" + cover("Monetary Contributions, Unitemized", "$0.00") +
    cover("Monetary Contributions, Itemized", "") + (cash.length ? table("contribution", cashHeaders, cash) : "") +
    cover("TOTAL CONTRIBUTIONS<br><small>(other than adjustments, loans, and interest)</small>", total) +
    cover("Contribution Adjustments", "$0.00") + cover("Loans Received", "$0.00") +
    cover("Interest Received This Reporting Period", "$0.00") + cover("TOTAL RECEIPTS", total) +
    "<h2>Disbursements</h2>" + cover("Expenditures, Unitemized", "$0.00") +
    table("expenditure", input.pac ? ["Vendor", "C/P", "Purpose", "In-Kind", "Independent", "S/O", "Date", "Amount"] :
      ["Vendor", "C/P", "Purpose", "Date", "Amount"],
      input.pac ? [["VENDOR<br>20 MAIN ST", "", "CONTRIBUTION", "", "CROWE, RUSTY", "S", "07/27/2026", "$5,910.62"]] :
        [["VENDOR<br>20 MAIN ST", "", "ADVERTISING", "06/23/2025", "$100.00"]]) +
    cover("TOTAL DISBURSEMENTS", input.pac ? "$5,910.62" : "$100.00") +
    "<h2>Ending Balance</h2>" + cover("ENDING BALANCE", "$2,900.00") +
    "<h2>In-Kind Contributions</h2>" +
    table("contribution", ["Contributor", "Description"], [["INKIND DONOR", "GOODS"]]) +
    "<h2>Obligations</h2>" + (input.extra ?? "") + "</body></html>";
}
function parse(html: string, manifestRow = row) {
  return parseTennesseeCurrentReport({ rawSource: raw(html, manifestRow), manifestRow });
}
function manifest(rows: { id: string; label?: string }[], total = rows.length, page = 1, next = false): string {
  const start = (page - 1) * 50 + 1;
  const banner = total === 1 ? "One result found." : total === 0 ? "No results found." :
    total + " results found, displaying " + start + " to " + (start + rows.length - 1) + ".";
  return '<html><body><h1>Reports for CROWE, RUSTY</h1><span class="pagebanner">' + banner +
    '</span><span class="pagelinks">' + (next ?
      '<a href="?id=794&amp;owner=CROWE%2C+RUSTY&amp;d-1341904-p=' + (page + 1) + '">Next</a>' : "") +
    "</span>" + table("results", ["Election", "Report Name", "A", "Submitted On"],
      rows.map(r => ["2026", '<a href="/tncamp/search/pub/report_full.htm?reportId=' + r.id + '">' +
        (r.label ?? "Early Mid Year Supplemental 2025") + "</a>", "Y", "07/11/2025"])) + "</body></html>";
}
function manifestInput(html: string, pageNumber = 1) {
  return { html, campId: "794", ownerName: "CROWE, RUSTY",
    sourceUrl: base + "/tncamp/public/replist.htm?id=794&owner=CROWE%2C+RUSTY", pageNumber };
}
function response(html: string, headers: Record<string, string> = {}): Response {
  return new Response(html, { headers: { "content-type": "text/html", ...headers } });
}

describe("Tennessee current report source client", () => {
  it("retains equal distinct gifts, complete published identity, designated election and other schedules", () => {
    const result = parse(report());
    expect(result.cashLedger).toHaveLength(2);
    expect(result.cashLedger.map(r => r.occurrence)).toEqual([1, 2]);
    expect(result.cashLedger[0]).toMatchObject({ reportedName: "REPORTED PAC", sourceClass: "P",
      receivedFor: "Primary", amountCents: 100000, aggregateCents: 100000,
      publishedIdentityLines: ["REPORTED PAC", "10 MAIN ST", "NASHVILLE, TN 37000"] });
    expect(result.schedules.map(s => [s.section, s.tableId])).toEqual([
      ["Receipts", "contribution"], ["Disbursements", "expenditure"], ["In-Kind Contributions", "contribution"],
    ]);
    expect(result.period).toBeNull();
    expect(result.rawSource.sha256).toBe(createHash("sha256").update(report()).digest("hex"));
  });

  it("retains PAC report heading without election year and source-declared target despite purpose CONTRIBUTION", () => {
    const pacRow = { ...row, campId: "136", ownerName: "TEST PAC", electionYear: null,
      reportYear: 2026, reportName: "Pre-Primary 2026", amended: false, submittedDate: "2026-07-29" };
    const html = report({ pac: true, heading: "Pre-Primary for TEST PAC submitted on 07/29/2026",
      cash: [["REPORTED PAC<br>10 MAIN ST", "P", "07/01/2026", "$2,000.00"]] });
    const result = parse(html, pacRow);
    expect(result.cashLedger[0].receivedFor).toBeNull();
    expect(result.expenseLedger[0]).toMatchObject({ purpose: "CONTRIBUTION",
      independentTargetName: "CROWE, RUSTY", supportOppose: "S", amountCents: 591062 });
  });

  it("supports an explicit current amended zero ledger without inventing candidate-wide zero", () => {
    const result = parse(report({ cash: [], cashTotal: "$0.00" }));
    expect(result.cashLedger).toEqual([]);
    expect(result.manifestRow.amended).toBe(true);
    expect(result.period).toBeNull();
    expect(result.expenseLedger).toHaveLength(1);
  });

  it("retains signed negative amounts for a future return/adjustment policy", () => {
    const result = parse(report({ cash: [["REPORTED PAC", "P", "General", "06/23/2025", "-$10.00", "-$10.00"]],
      cashTotal: "-$10.00" }));
    expect(result.cashLedger[0].amountCents).toBe(-1000);
  });

  it("period remains external authoritative context and is not inferred from heading", () => {
    const expectedPeriod = { start: "2025-01-16", end: "2025-06-30",
      sourceUrl: "https://www.tn.gov/tref/filing-calendar.html", sourceContext: "candidate supplemental published interval" };
    expect(parseTennesseeCurrentReport({ rawSource: raw(report()), manifestRow: row, expectedPeriod }).period)
      .toEqual(expectedPeriod);
    expect(() => parseTennesseeCurrentReport({ rawSource: raw(report()), manifestRow: row,
      expectedPeriod: { ...expectedPeriod, start: "2025-02-30" } })).toThrow(/calendar/);
    expect(() => parseTennesseeCurrentReport({ rawSource: raw(report()), manifestRow: row,
      expectedPeriod: { ...expectedPeriod, sourceUrl: "https://example.com/calendar" } })).toThrow(/provenance/);
  });

  it("fingerprint ignores only the observed Back to Search Results href change", () => {
    const initial = report();
    const changedNavigation = initial.replace("search.htm?x=1", "replist.htm?x=2");
    expect(parse(initial).fingerprint).toBe(parse(changedNavigation).fingerprint);
    expect(parse(initial).fingerprint).not.toBe(parse(initial.replace("10 MAIN ST", "11 MAIN ST")).fingerprint);
    expect(() => parse(initial.replace("</body>", '<a href="#">Back to Search Results</a></body>')))
      .toThrow(/navigation/);
  });

  it("rejects conflicting linked report ID", () => {
    expect(() => parse(report({ extra: '<a href="?reportId=99">Financial row</a>' }))).toThrow(/identity/);
  });

  it.each([
    ["$1,000.00", "$1,000.001", /money/],
    ["06/23/2025", "02/30/2025", /calendar/],
    ["<td>P</td>", "<td>ORG</td>", /C\/P/],
    ["</table>", "", /table/],
    ["</html>", "", /Incomplete/],
    ["$2,000.00", "$2,001.00", /cover mismatch/],
    ["<th>Aggregate</th>", "<th>Changed</th>", /schema/],
  ])("rejects malformed financial/schema source %s", (from, to, error) => {
    expect(() => parse(report().replace(from, to))).toThrow(error);
  });

  it("rejects financial pagination rather than accepting a partially shown full report", () => {
    expect(() => parse(report({ extra: '<span class="pagebanner">200 results found, displaying 1 to 50.</span>' })))
      .toThrow(/Partial/);
  });

  it("rejects login HTML and response bytes/hash/encoding mismatch", () => {
    expect(() => parse("<html><input type='password'></html>")).toThrow(/login/);
    const source = raw(report());
    expect(() => parseTennesseeCurrentReport({ rawSource: { ...source, sha256: "bad" }, manifestRow: row }))
      .toThrow(/integrity/);
    expect(() => parseTennesseeCurrentReport({ rawSource: { ...source, encoding: "windows-1252" }, manifestRow: row }))
      .toThrow(/integrity/);
  });

  it("decodes source CP1252 punctuation exactly, rejecting undefined C1 bytes", () => {
    expect(decodeTennesseeCurrentReportBytes(Uint8Array.from([0x41, 0x92, 0x42])))
      .toEqual({ html: "A’B", encoding: "windows-1252" });
    expect(() => decodeTennesseeCurrentReportBytes(Uint8Array.from([0x81]))).toThrow(/CP1252/);
  });

  it("manifest retains current list versions rather than picking latest", () => {
    const parsed = parseTennesseeCurrentReportManifestPage(manifestInput(
      manifest([{ id: "122149" }, { id: "122150" }])
    ));
    expect(parsed.rows.map(r => r.reportId)).toEqual(["122149", "122150"]);
    expect(parsed.rows[0]).toMatchObject({ amended: true, reportYear: 2025, electionYear: 2026 });
  });

  it.each([
    ["Reports for CROWE, RUSTY", "Reports for OTHER", /receiver/],
    ["<th>A</th>", "<th>Changed</th>", /schema/],
    ["https://apps.tn.gov", "https://evil.example", /official/],
  ])("manifest rejects incorrect source %s", (from, to, error) => {
    const html = manifest([{ id: "122149" }]).replace(from, to);
    const input = manifestInput(html);
    if (from.startsWith("https")) input.sourceUrl = input.sourceUrl.replace(from, to);
    expect(() => parseTennesseeCurrentReportManifestPage(input)).toThrow(error);
  });

  it("retains source-blank PAC Election while keeping source label reportYear", () => {
    const parsed = parseTennesseeCurrentReportManifestPage(manifestInput(
      manifest([{ id: "122149" }]).replace("<td>2026</td>", "<td></td>")
    ));
    expect(parsed.rows[0]).toMatchObject({ electionYear: null, reportYear: 2025 });
  });

  it("preserves unresolved receiver rename by rejecting a mismatched current heading", () => {
    expect(() => parse(report({ heading: "Amended 2026 Early Mid Year Supplemental (2025) for OTHER RECEIVER submitted on 07/11/2025" })))
      .toThrow(/receiver/);
    expect(parse(report()).reportedOwnerName).toBe("RUSTY CROWE");
  });

  it("validates explicit zero manifest count and refuses unproven empty result", () => {
    expect(parseTennesseeCurrentReportManifestPage(manifestInput(manifest([]))).total).toBe(0);
    expect(() => parseTennesseeCurrentReportManifestPage(manifestInput(
      manifest([]).replace("No results found.", "")))).toThrow(/count/);
  });

  it("bootstraps one private public session, follows complete pages and preserves 51 source rows", async () => {
    const calls: { url: string; cookie: string | null }[] = [];
    const firstRows = Array.from({ length: 50 }, (_, n) => ({ id: String(n + 1) }));
    const fetchImpl = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const url = String(request);
      calls.push({ url, cookie: new Headers(init?.headers).get("cookie") });
      if (url.endsWith("cpsearch.htm")) return response('<html><form id="frmCandidates">Search Candidates</form></html>',
        { "set-cookie": "JSESSIONID=test-public-session; Path=/tncamp" });
      return response(url.includes("d-1341904-p=2") ? manifest([{ id: "51" }], 51, 2) :
        manifest(firstRows, 51, 1, true));
    }) as typeof fetch;
    const result = await createTennesseeCurrentReportClient({ fetchImpl }).fetchManifest({ campId: "794", ownerName: "CROWE, RUSTY" });
    expect(result.rows).toHaveLength(51);
    expect(result.rawPages).toHaveLength(2);
    expect(calls).toHaveLength(3);
    expect(calls.slice(1).map(r => r.cookie)).toEqual(["JSESSIONID=test-public-session", "JSESSIONID=test-public-session"]);
  });

  it("incomplete pagination, repeated IDs and changed totals abort the manifest", async () => {
    const first = Array.from({ length: 50 }, (_, n) => ({ id: String(n + 1) }));
    for (const second of [manifest([{ id: "1" }], 51, 2), manifest([{ id: "51" }], 52, 2)]) {
      const fetchImpl = vi.fn().mockResolvedValueOnce(response("<html>Search Candidates</html>"))
        .mockResolvedValueOnce(response(manifest(first, 51, 1, true))).mockResolvedValueOnce(response(second));
      await expect(createTennesseeCurrentReportClient({ fetchImpl }).fetchManifest({ campId: "794", ownerName: "CROWE, RUSTY" }))
        .rejects.toThrow(/Repeated|changed/);
    }
    const fetchImpl = vi.fn().mockResolvedValueOnce(response("<html>Search Candidates</html>"))
      .mockResolvedValueOnce(response(manifest(first, 51)));
    await expect(createTennesseeCurrentReportClient({ fetchImpl }).fetchManifest({ campId: "794", ownerName: "CROWE, RUSTY" }))
      .rejects.toThrow(/Incomplete/);
  });

  it("client enforces total body bound and content type", async () => {
    for (const options of [
      { maxResponseBytes: 20, fetchImpl: vi.fn(async () => response("<html>Search Candidates</html>")) },
      { fetchImpl: vi.fn(async () => new Response("<html>Search Candidates</html>",
        { headers: { "content-type": "application/json" } })) },
    ]) {
      await expect(createTennesseeCurrentReportClient(options).fetchManifest({ campId: "794", ownerName: "CROWE, RUSTY" }))
        .rejects.toThrow(/byte bound|not HTML/);
    }
  });

  it.each([
    "?reportId=122149&extra=1", "?reportId=122149&reportId=122149",
    "?reportId=%31%32%32%31%34%39", "?reportId=0122149",
  ])("rejects noncanonical report URL query %s before acquiring money", async query => {
    const sourceUrl = base + "/tncamp/search/pub/report_full.htm" + query;
    const changedRow = { ...row, sourceUrl };
    expect(() => parseTennesseeCurrentReport({ rawSource: { ...raw(report()), url: sourceUrl }, manifestRow: row }))
      .toThrow();
    expect(() => parseTennesseeCurrentReport({ rawSource: raw(report()), manifestRow: changedRow })).toThrow();
    const fetchImpl = vi.fn();
    await expect(createTennesseeCurrentReportClient({ fetchImpl }).fetchReport({ manifestRow: changedRow }))
      .rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    "https://user:password@www.tn.gov/calendar", "https://www.tn.gov:8443/calendar",
    "https://www.tn.gov:443/calendar", "https://www.tn.gov/calendar#fragment",
  ])("rejects credentials/port/fragment on authoritative calendar URL %s", sourceUrl => {
    expect(() => parseTennesseeCurrentReport({ rawSource: raw(report()), manifestRow: row,
      expectedPeriod: { start: "2025-01-01", end: "2025-06-30", sourceUrl, sourceContext: "calendar" } }))
      .toThrow(/provenance/);
  });

  it("rejects an explicit default port in an otherwise official report URL", async () => {
    const sourceUrl = row.sourceUrl.replace("apps.tn.gov", "apps.tn.gov:443");
    const fetchImpl = vi.fn();
    await expect(createTennesseeCurrentReportClient({ fetchImpl }).fetchReport({ manifestRow: { ...row, sourceUrl } }))
      .rejects.toThrow(/official endpoint/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("decodes observed numeric C1 apostrophes without changing raw source identity", () => {
    const owner = "TENNESSEE MEDICAL ASSOCIATION’S PAC (TMA PAC)";
    const changedRow = { ...row, ownerName: owner, electionYear: null,
      reportName: "Pre-Primary 2026", reportYear: 2026, amended: false, submittedDate: "2026-07-29" };
    const html = report({ pac: true, cash: [], cashTotal: "$0.00",
      heading: "Pre-Primary (2026) for TENNESSEE MEDICAL ASSOCIATION&#146;S PAC (TMA PAC) submitted on 07/29/2026" });
    const result = parse(html, changedRow);
    expect(result.reportedOwnerName).toBe(owner);
    expect(result.rawSource.bytes).toEqual(Buffer.from(html));
    expect(result.fingerprint).not.toBe(parse(html.replace("&#146;", "’"), changedRow).fingerprint);
  });

  it("journals bounded bootstrap/report bodies without headers or cookies", async () => {
    const onRawResponse = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValueOnce(response("<html>Search Candidates</html>", { "set-cookie": "private=session" }))
      .mockResolvedValueOnce(response(report()));
    await createTennesseeCurrentReportClient({ fetchImpl, onRawResponse }).fetchReport({ manifestRow: row });
    expect(onRawResponse).toHaveBeenCalledTimes(2);
    const journal = onRawResponse.mock.calls[1][0];
    expect(journal).toMatchObject({ url: row.sourceUrl, method: "GET", byteCount: Buffer.byteLength(report()),
      sha256: createHash("sha256").update(report()).digest("hex"), encoding: "utf-8" });
    expect(Number.isNaN(Date.parse(journal.fetchedAt))).toBe(false);
    expect(journal).not.toHaveProperty("headers");
    expect(journal).not.toHaveProperty("cookie");
    expect(Buffer.from(journal.bytes)).toEqual(Buffer.from(report()));
  });

  it("isolates raw capture mutations from report parsing and immutable hashes", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response("<html>Search Candidates</html>"))
      .mockResolvedValueOnce(response(report()));
    const onRawResponse = vi.fn((raw) => { expect(Object.isFrozen(raw)).toBe(true); raw.bytes.fill(0); });
    const parsed = await createTennesseeCurrentReportClient({ fetchImpl, onRawResponse }).fetchReport({ manifestRow: row });
    expect(Buffer.from(parsed.rawSource.bytes)).toEqual(Buffer.from(report()));
    expect(parsed.rawSource.sha256).toBe(createHash("sha256").update(parsed.rawSource.bytes).digest("hex"));
    expect(parsed.cashLedger).toHaveLength(2);
  });

  it("journals a complete decoded login body before rejecting financial source acceptance", async () => {
    const onRawResponse = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValueOnce(response("<html>Search Candidates</html>"))
      .mockResolvedValueOnce(response('<html><input type="password"></html>'));
    await expect(createTennesseeCurrentReportClient({ fetchImpl, onRawResponse }).fetchReport({ manifestRow: row }))
      .rejects.toThrow(/login/);
    expect(onRawResponse).toHaveBeenCalledTimes(2);
    expect(Buffer.from(onRawResponse.mock.calls[1][0].bytes).toString()).toContain('type="password"');
  });

  it("does not accept a report when its proof journal callback fails", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response("<html>Search Candidates</html>"));
    await expect(createTennesseeCurrentReportClient({ fetchImpl, onRawResponse: () => { throw new Error("journal unavailable"); } })
      .fetchReport({ manifestRow: row })).rejects.toThrow(/journal unavailable/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("client acquires report by observed URL after public session bootstrap", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response("<html>Search Candidates</html>"))
      .mockResolvedValueOnce(response(report()));
    const result = await createTennesseeCurrentReportClient({ fetchImpl }).fetchReport({ manifestRow: row });
    expect(result.cashLedger).toHaveLength(2);
    expect(fetchImpl.mock.calls[1][0]).toBe(row.sourceUrl);
  });
});
