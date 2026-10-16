import { describe, expect, it } from "vitest";
import { NCSBE_COVER_SECTIONS } from "../../../src/pipeline/northCarolinaFinance/northCarolinaNcsbeParsers.js";
import {
  extractNorthCarolinaNativeExportUrl,
  validateNorthCarolinaReportedReceiptSource,
} from "../../../src/pipeline/northCarolinaFinance/northCarolinaReportedReceiptSource.js";

// Entirely synthetic adversarial fixtures; these do not establish financial coverage.
const headers = ["Group ID", "Date", "Is Prior", "Name", "Street 1", "Street 2", "City", "State", "Full Zip", "Country Name", "Outside US Postal Code", "Profession", "Employers Name", "Purpose", "Receipt Type Desc", "Account Abbr", "Form Of Payment Desc", "Description", "Amount", "Sum To Date"];
const fields = ["GroupID", "OccurDate", "IsPrior", "OrgName", "Street1", "Street2", "City", "State", "FullZip", "CountryName", "OutsideUSPostalCode", "Profession", "EmployersName", "Purpose", "ReceiptTypeDesc", "AccountAbbr", "FormOfPaymentDesc", "Description", "Amount", "SumToDate"];
const nativeHref = "/CFOrgLkup/ReportDetail?handler=Export&RID=11&TP=ALL&sid=&cn=";
const anchor = (href = nativeHref) => `<a href="${href.replace(/&/g, "&amp;")}">Export CSV</a>`;
type Row = Record<string, unknown>;
const receipt = (overrides: Row = {}): Row => ({
  GroupID: 7, OccurDate: "02/03/2026", IsPrior: " ", OrgName: "Synthetic Organization",
  NameSort: "Unused synthetic sort text", Street1: "Synthetic street", Street2: "", City: "Synthetic city", State: "NC",
  FullZip: "00000", CountryName: "", OutsideUSPostalCode: "", Profession: null, EmployersName: null,
  Purpose: "Synthetic purpose", ReceiptTypeDesc: "Other Political Committees", ReceiptTypeCode: "CPCM",
  AccountAbbr: "SYNTH", FormOfPaymentDesc: "Check", Description: "Synthetic description",
  Amount: 2.5, SumToDate: 2.5, IsOrg: true, IsAggregated: false, ...overrides,
});
const cell = (value: unknown): string => {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const csvLine = (row: unknown[]) => row.map(cell).join(",");

function fixture(rows: Row[] = [receipt()], options: { omitReceiptSection?: boolean; controls?: Record<number, number>; legacyEnvelope?: boolean } = {}) {
  const controls: Record<number, number> = { 30: 0, 35: 0 };
  for (const row of rows) {
    if (row.ReceiptTypeCode === "PPTY") controls[30] += Number(row.Amount);
    if (row.ReceiptTypeCode === "CPCM") controls[35] += Number(row.Amount);
  }
  Object.assign(controls, options.controls);
  const summary = [...NCSBE_COVER_SECTIONS].map(([Sequence, Section]) => ({ Sequence, Section, Period: controls[Sequence] ?? 0, Cycle: controls[Sequence] ?? 0 }));
  const cover = { BoeID: null, OrgName: "Synthetic Receiver", EntityTypeDesc: null, FullReportName: null, ReportVersion: null, BeginDate: "01/01/2026", EndDate: "03/31/2026", FiledDate: "04/10/2026" };
  const coverHtml = `${anchor()}<script>var rptID = 11; var dataCover = ${JSON.stringify(cover)}; SetupGrid(${JSON.stringify(summary)});</script>`;
  const parts = ["COVER", "Synthetic Header", "Synthetic Value", "", "SUMMARY", csvLine(["Sequence", "Section", "Period", "Cycle"]), ...summary.map((row) => csvLine([row.Sequence, row.Section, row.Period.toFixed(4), row.Cycle.toFixed(4)]))];
  if (!options.omitReceiptSection) parts.push("", "RECEIPTS", csvLine(headers), ...rows.map((row) => csvLine(fields.map((field) => {
    if (field === "IsPrior") return String(row[field] ?? "").trim();
    if (field === "Amount" || field === "SumToDate") return row[field] === null ? "" : Number(row[field]).toFixed(4);
    return row[field];
  }))));
  // A separately shaped unrelated section does not decide gross receipt eligibility.
  parts.push("", "EXPENDITURES", "Synthetic A,Synthetic B", "one,two", "", "FUTURE SECTION", "Synthetic X,Synthetic Y", "three,four");
  const receiptPages = [];
  for (let page = 0; page < Math.max(1, Math.ceil(rows.length / 300)); page += 1) {
    const slice = rows.slice(page * 300, (page + 1) * 300);
    const body = options.legacyEnvelope ? { Data: { recordCountKey: rows.length, results: slice } } : { Data: slice, Total: rows.length, Errors: null };
    receiptPages.push({ page, body: JSON.stringify(body) });
  }
  return { reportId: "11", coverHtml, exportCsv: parts.join("\r\n") + "\r\n", receiptPages };
}

describe("extractNorthCarolinaNativeExportUrl", () => {
  it("uses the observed anchor with empty native sid/cn and reordered parameters", () => {
    expect(extractNorthCarolinaNativeExportUrl({ reportId: "11", coverHtml: anchor("/CFOrgLkup/ReportDetail?cn=&TP=ALL&RID=11&sid=&handler=Export") }))
      .toBe("https://cf.ncsbe.gov/CFOrgLkup/ReportDetail?cn=&TP=ALL&RID=11&sid=&handler=Export");
  });

  it.each([
    nativeHref.replace("RID=11", "RID=12"), nativeHref.replace("TP=ALL", "TP=RECEIPTS"),
    nativeHref.replace("sid=", "sid=other"), nativeHref.replace("cn=", "cn=other"),
    nativeHref + "&RID=11", nativeHref + "&extra=1", nativeHref + "#fragment", nativeHref + "#",
    nativeHref.replace("ReportDetail?", "ReportDetail/?"),
    nativeHref.replace("ReportDetail?", "other/../ReportDetail?"),
    "https://other.invalid" + nativeHref, "https://user:password@cf.ncsbe.gov" + nativeHref,
    "/CFOrgLkup/ExportDetailResults/?ReportID=11&Type=ALL&Title=synthetic",
  ])("rejects changed identity, origin, scope, or route", (href) => {
    expect(() => extractNorthCarolinaNativeExportUrl({ reportId: "11", coverHtml: anchor(href) })).toThrow("source: export_anchor");
  });

  it("rejects missing, repeated, and ambiguous anchor attributes", () => {
    for (const coverHtml of ["", anchor() + anchor(), `<a data-href="${nativeHref}">Export</a>`, `<a href="${nativeHref}" href="${nativeHref}">Export</a>`]) {
      expect(() => extractNorthCarolinaNativeExportUrl({ reportId: "11", coverHtml })).toThrow("source: export_anchor");
    }
  });
});

describe("validateNorthCarolinaReportedReceiptSource", () => {
  it("preserves source context, blank prior text, and equal occurrence multiplicity", () => {
    const input = fixture([receipt(), receipt()]);
    const result = validateNorthCarolinaReportedReceiptSource(input);
    expect(result.receipts).toHaveLength(2);
    expect(result.receipts[0]).toMatchObject({ amountCents: 250, sumToDateCents: 250, sourceFields: { IsPrior: " ", OrgName: "Synthetic Organization", Description: "Synthetic description", Amount: "2.5" } });
    expect(Object.keys(result.receipts[0]!.sourceFields)).toHaveLength(20);
  });

  it("matches all 20 fields as occurrences, independently of ordering", () => {
    const rows = [receipt(), receipt({ GroupID: 8, Amount: 3.75, FormOfPaymentDesc: "InKind" })];
    const input = fixture(rows);
    input.receiptPages[0]!.body = JSON.stringify({ Data: [...rows].reverse(), Total: 2, Errors: null });
    expect(validateNorthCarolinaReportedReceiptSource(input).receipts).toHaveLength(2);
    for (const field of fields) {
      const changed = { ...rows[0], [field]: field === "Amount" || field === "SumToDate" ? 4 : field === "GroupID" ? 9 : field === "OccurDate" ? "02/04/2026" : "Changed synthetic value" };
      const altered = { ...input, receiptPages: [{ page: 0, body: JSON.stringify({ Data: [changed, rows[1]], Total: 2 }) }] };
      expect(() => validateNorthCarolinaReportedReceiptSource(altered), field).toThrow("source: receipt_occurrences");
    }
  });

  it("uses OrgName rather than NameSort and decodes native HTML entities without collapsing text", () => {
    const input = fixture([receipt({ OrgName: "Synthetic &amp; Organization", Description: "Two  spaces, a \"quote\"\nand a line" })]);
    input.exportCsv = input.exportCsv.replace("Synthetic &amp; Organization", "Synthetic & Organization");
    expect(validateNorthCarolinaReportedReceiptSource(input).receipts[0]!.sourceFields.OrgName).toBe("Synthetic &amp; Organization");
  });

  it("never infers Boolean prior status", () => {
    const input = fixture();
    input.receiptPages[0]!.body = input.receiptPages[0]!.body.replace('"IsPrior":" "', '"IsPrior":false');
    expect(() => validateNorthCarolinaReportedReceiptSource(input)).toThrow("source: receipt_fields");
    expect(validateNorthCarolinaReportedReceiptSource(fixture([receipt({ IsPrior: "X" })])).receipts[0]!.sourceFields.IsPrior).toBe("X");
  });

  it("checks signed CPCM and PPTY amounts including in-kind against cover 35 and 30", () => {
    const rows = [receipt({ Amount: 10, FormOfPaymentDesc: "InKind" }), receipt({ Amount: -2 }), receipt({ ReceiptTypeCode: "PPTY", Amount: 4, FormOfPaymentDesc: "InKind" })];
    expect(validateNorthCarolinaReportedReceiptSource(fixture(rows)).receipts.map((row) => row.amountCents)).toEqual([1000, -200, 400]);
    for (const controls of [{ 35: 10 }, { 30: 0 }]) {
      expect(() => validateNorthCarolinaReportedReceiptSource(fixture(rows, { controls }))).toThrow("source: receipt_controls");
    }
  });

  it("requires explicit zero population and typed cover controls", () => {
    expect(validateNorthCarolinaReportedReceiptSource(fixture([], { omitReceiptSection: true })).receipts).toEqual([]);
    const input = fixture([], { omitReceiptSection: true });
    expect(() => validateNorthCarolinaReportedReceiptSource({ ...input, receiptPages: [] })).toThrow("source: receipt_pages");
    expect(() => validateNorthCarolinaReportedReceiptSource(fixture([], { controls: { 35: 1 }, omitReceiptSection: true }))).toThrow("source: receipt_controls");
    expect(() => validateNorthCarolinaReportedReceiptSource(fixture([receipt()], { omitReceiptSection: true }))).toThrow("source: receipt_occurrences");
  });

  it("validates every Period and Cycle summary value and complete native section set", () => {
    const input = fixture();
    for (const change of [
      input.exportCsv.replace("5,Cash on Hand at Beginning,0.0000,0.0000", "5,Cash on Hand at Beginning,0.0000,1.0000"),
      input.exportCsv.replace("5,Cash on Hand at Beginning", "5,Changed synthetic section"),
      input.exportCsv.replace(/5,Cash on Hand at Beginning[^\r]+\r\n/, ""),
      input.exportCsv.replace("Sequence,Section,Period,Cycle", "Sequence,Section,Cycle,Period"),
    ]) expect(() => validateNorthCarolinaReportedReceiptSource({ ...input, exportCsv: change })).toThrow();
    expect(() => validateNorthCarolinaReportedReceiptSource({ ...input, coverHtml: input.coverHtml.replace('"Period":0', '"Period":0.001') })).toThrow("source: money");
    expect(() => validateNorthCarolinaReportedReceiptSource({ ...input, coverHtml: input.coverHtml.replace("var rptID = 11", "var rptID = 12") })).toThrow("source: cover");
  });

  it.each(["2.5001", "90071992547409.92", "90071992547409.9101", "1e-7"])("rejects lossy source JSON money before legacy rounding: %s", (amount) => {
    const input = fixture();
    input.receiptPages[0]!.body = input.receiptPages[0]!.body.replace('"Amount":2.5', `"Amount":${amount}`);
    expect(() => validateNorthCarolinaReportedReceiptSource(input)).toThrow("source: money");
  });

  it.each(["2.5001", "90071992547409.92", "$2.50", "2.50x"])("rejects non-exact CSV money: %s", (amount) => {
    const input = fixture();
    input.exportCsv = input.exportCsv.replace(/2\.5000,2\.5000/, `${amount},2.5000`);
    expect(() => validateNorthCarolinaReportedReceiptSource(input)).toThrow("source: money");
  });

  it("supports exact nullable cumulative amount and exact four-place zero tails", () => {
    expect(validateNorthCarolinaReportedReceiptSource(fixture([receipt({ SumToDate: null })])).receipts[0]!.sumToDateCents).toBeNull();
    const input = fixture();
    input.receiptPages[0]!.body = input.receiptPages[0]!.body.replace('"Amount":2.5', '"Amount":2.5000');
    expect(validateNorthCarolinaReportedReceiptSource(input).receipts[0]!.amountCents).toBe(250);
  });

  it("retains safe boundary cents from original JSON lexemes despite floating point parsing", () => {
    const input = fixture([receipt({ ReceiptTypeCode: "IND " })]);
    input.receiptPages[0]!.body = input.receiptPages[0]!.body.replace('"Amount":2.5', '"Amount":90071992547409.91');
    input.exportCsv = input.exportCsv.replace("2.5000,2.5000", "90071992547409.9100,2.5000");
    const result = validateNorthCarolinaReportedReceiptSource(input);
    expect(result.receipts[0]!.amountCents).toBe(Number.MAX_SAFE_INTEGER);
    expect(result.receipts[0]!.sourceFields.Amount).toBe("90071992547409.91");
  });

  it("validates fixed 300-row pages in both native envelopes", () => {
    for (const legacyEnvelope of [false, true]) {
      const rows = Array.from({ length: 301 }, (_, index) => receipt({ GroupID: index + 1, ReceiptTypeCode: "IND ", Amount: 1 }));
      const input = fixture(rows, { legacyEnvelope });
      expect(validateNorthCarolinaReportedReceiptSource(input).receipts).toHaveLength(301);
      expect(() => validateNorthCarolinaReportedReceiptSource({ ...input, receiptPages: input.receiptPages.slice(0, 1) })).toThrow("source: receipt_pages");
      expect(() => validateNorthCarolinaReportedReceiptSource({ ...input, receiptPages: [...input.receiptPages].reverse() })).toThrow("source: receipt_pages");
      expect(() => validateNorthCarolinaReportedReceiptSource({ ...input, receiptPages: [...input.receiptPages, input.receiptPages[1]!] })).toThrow("source: receipt_pages");
      input.receiptPages[1]!.body = input.receiptPages[1]!.body.replace(legacyEnvelope ? '"recordCountKey":301' : '"Total":301', legacyEnvelope ? '"recordCountKey":302' : '"Total":302');
      expect(() => validateNorthCarolinaReportedReceiptSource(input)).toThrow("source: receipt_pages");
    }
  });

  it("rejects same-count repeated page populations against native CSV", () => {
    const rows = Array.from({ length: 600 }, (_, index) => receipt({ GroupID: index + 1, ReceiptTypeCode: "IND " }));
    const input = fixture(rows);
    input.receiptPages[1]!.body = input.receiptPages[0]!.body;
    expect(() => validateNorthCarolinaReportedReceiptSource(input)).toThrow("source: receipt_occurrences");
  });

  it("rejects short intermediate pages, omitted rows, changed counts, and unsafe identifiers", () => {
    const input = fixture();
    for (const body of [
      JSON.stringify({ Data: [], Total: 1 }), JSON.stringify({ Data: [receipt()], Total: -1 }),
      JSON.stringify({ Data: [receipt()], Total: 1, Errors: "private synthetic error" }),
      input.receiptPages[0]!.body.replace('"GroupID":7', '"GroupID":9007199254740991.1'),
      input.receiptPages[0]!.body.replace('"Total":1', '"Total":1.0000000000000001'),
    ]) expect(() => validateNorthCarolinaReportedReceiptSource({ ...input, receiptPages: [{ page: 0, body }] })).toThrow();
    const rows = Array.from({ length: 301 }, () => receipt({ ReceiptTypeCode: "IND " }));
    const paged = fixture(rows);
    paged.receiptPages[0]!.body = JSON.stringify({ Data: rows.slice(0, 299), Total: 301 });
    expect(() => validateNorthCarolinaReportedReceiptSource(paged)).toThrow("source: receipt_pages");
  });

  it.each([
    (csv: string) => csv + '"unterminated',
    (csv: string) => csv.replace("Synthetic street", 'bad"quote'),
    (csv: string) => csv.replace("Synthetic street", '"closed"junk'),
    (csv: string) => csv.replace("one,two", "one,two,three"),
    (csv: string) => csv.replace("three,four", "three"),
    (csv: string) => csv.replace("Group ID,Date", "Changed Header,Date"),
    (csv: string) => csv + "\r\nSUMMARY\r\nSequence,Section,Period,Cycle\r\n",
  ])("rejects malformed CSV quoting, widths, truncation, headers, or sections", (change) => {
    const input = fixture();
    expect(() => validateNorthCarolinaReportedReceiptSource({ ...input, exportCsv: change(input.exportCsv) })).toThrow("source: csv");
  });

  it("returns only fixed non-identifying failure reasons", () => {
    const input = fixture();
    input.coverHtml = input.coverHtml.replace('"OrgName":"Synthetic Receiver"', '"OrgName":{"private":"Synthetic private text"}');
    expect(() => validateNorthCarolinaReportedReceiptSource(input)).toThrow(/^NCSBE reported receipt source: cover$/);
  });
});
