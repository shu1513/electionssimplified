import { describe, expect, it } from "vitest";
import { parseMaineMapLightReportControls as parse } from "../../../src/pipeline/maineFinance/maineMapLightReportControls.js";

const id = (letter: string) => `a_${letter.repeat(26)}`;
const filerId = `f_${"f".repeat(26)}`;
const reportId = `d_${"d".repeat(26)}`;
const URL = `https://www.mainecampaignfinancedisclosure.com/public/filers/${filerId}/filings/${reportId}`;
const HEADERS = ["Date", "Name", "Address", "Occupation", "Employer", "Amount"];
const LABELS = [
  "Balance at the Beginning of the Period", "Total Contributions", "Total Monetary Contributions",
  "Total In-Kind Contributions", "Unitemized Total - Contributions of $200 or Less",
  "Total General Treasury Transfers", "Total Bank Interest", "Total Expenditures",
  "Total Independent Expenditures", "Total Loans Received", "Total Debts Owed",
  "Balance at the End of the Period", "Loan Balance", "Debt Balance",
];
const dt = (label: string, value: string) => `<div><dt>${label}</dt><dd><span>${value}</span></dd></div>`;
const time = (datetime: string, value: string) => `<time datetime="${datetime}">${value}</time>`;
const section = (label: string, body: string) => `<section><header><div><h2>${label}</h2></div></header><div>${body}</div></section>`;
function row(transactionId = id("a"), amount = "$100.00", date = "09/18/2026") {
  const values = [`<a href="/public/activities/${transactionId}?return_to=source%26scope%3Dkept">${date}</a>`, "Example Vendor", "", "", "", amount];
  return `<tr>${values.map((value, i) => `<td data-label="${HEADERS[i]}">${value}</td>`).join("")}</tr>`;
}
function schedule(label: string, rows: string[], total: string) {
  return section(label, `<table><thead><tr>${HEADERS.map(h => `<th scope="col">${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody><tfoot><tr><th colspan="5">Total</th><td>${total}</td></tr></tfoot></table>`);
}
const empty = (label: string, statement: string) => section(label, `<em class="NoProvidedData">${statement}</em>`);
function fixture(ieRows = [row(id("c"), "$5,003.82", "09/29/2026")], ieTotal = "$5,003.82") {
  const info = [
    dt("Report Name", "End Of Third Quarter 2026"), dt("Report Type", "Campaign Finance"),
    dt("Reporting Period", `${time("2026-07-15T00:01:00-04:00", "July 15, 2026")} - ${time("2026-09-30T23:59:00-04:00", "September 30, 2026")}`),
    dt("Report Due Date", time("2026-10-05T23:59:00-04:00", "October 05, 2026 11:59 PM EDT")),
    dt("Filer Name", "EXAMPLE PAYER"), dt("Filing Status", "Filed"),
    dt("Date Submitted", time("2026-10-05T16:32:15-04:00", "October 05, 2026 4:32 PM EDT")),
    dt("Version of Report", "Amendment 1"), dt("Report ID", reportId),
  ].join("");
  return `<html><body><h1>End Of Third Quarter 2026 - EXAMPLE PAYER</h1>${section("Filing Information", `<dl>${info}</dl>`)}${section("Filing Summary", `<dl>${LABELS.map(label => dt(label, label === "Total Independent Expenditures" ? ieTotal : label === "Total Expenditures" ? "$100.00" : "$0.00")).join("")}</dl>`)}${schedule("Expenditures", [row(id("b"), "$5,125.00")], "$5,125.00")}${schedule("Returned Expenditures", [row(id("a"), "$5,025.00")], "$5,025.00")}${schedule("Independent Expenditures", ieRows, ieTotal)}${empty("Returned Independent Expenditures", "No returned independent expenditures to report")}</body></html>`;
}

describe("Maine MapLight SSR report control source facts", () => {
  it("separates ordinary return, explicit empty IE returns, gross schedules and cover controls", () => {
    const facts = parse(fixture(), URL);
    expect(facts).toMatchObject({ filerId, reportId, filerName: "EXAMPLE PAYER", reportType: "Campaign Finance", filingStatus: "Filed", periodStart: "2026-07-15", periodEnd: "2026-09-30", sourceSubmittedDate: "October 05, 2026 4:32 PM EDT", sourceSubmittedAt: "2026-10-05T16:32:15-04:00", version: { label: "Amendment 1", kind: "amendment", number: 1 } });
    expect(facts.returnedExpenditures).toMatchObject({ totalCents: 502500, rows: [{ occurrence: 1, transactionId: id("a"), date: "2026-09-18", amountCents: 502500 }] });
    expect(facts.returnedIndependentExpenditures).toEqual({ section: "Returned Independent Expenditures", rows: [], totalCents: 0, emptyStatement: "No returned independent expenditures to report" });
    expect(facts.expenditures.totalCents).toBe(512500);
    expect(facts.summaryControls.find(x => x.label === "Total Expenditures")?.amountCents).toBe(10000);
    expect(JSON.stringify(facts)).not.toMatch(/return_to|Example Vendor|Address|latest|acceptedMoney|current/);
  });
  it("retains repeated occurrences, including identical source identities", () => {
    const facts = parse(fixture([row(id("c"), "$10.00"), row(id("c"), "$10.00"), row(id("e"), "$10.00")], "$30.00"), URL);
    expect(facts.independentExpenditures.rows.map(x => [x.occurrence, x.transactionId, x.amountCents])).toEqual([[1,id("c"),1000],[2,id("c"),1000],[3,id("e"),1000]]);
  });
  it("preserves signed and zero row values rather than inventing netting", () => {
    const facts = parse(fixture([row(id("c"), "-$10.00"), row(id("e"), "$0.00")], "-$10.00"), URL);
    expect(facts.independentExpenditures.rows.map(x => x.amountCents)).toEqual([-1000,0]);
  });
  it("handles actual nonempty returned IE as its own schedule", () => {
    const html = fixture().replace(empty("Returned Independent Expenditures", "No returned independent expenditures to report"), schedule("Returned Independent Expenditures", [row(id("e"), "$25.00")], "$25.00"));
    expect(parse(html, URL).returnedIndependentExpenditures).toMatchObject({ totalCents: 2500, emptyStatement: null });
  });
  it("recognizes Original 0 without declaring latest", () => {
    expect(parse(fixture().replace("Amendment 1", "Original 0"), URL).version).toEqual({ label: "Original 0", kind: "original", number: 0 });
  });
  it.each([
    ["missing IE-return section", (s: string) => s.replace(empty("Returned Independent Expenditures", "No returned independent expenditures to report"), "")],
    ["near empty statement", (s: string) => s.replace("No returned independent expenditures to report", "No expenditures to report")],
    ["ordinary section substituted", (s: string) => s.replace("<h2>Returned Independent Expenditures</h2>", "<h2>Returned Expenditures</h2>")],
    ["repeated section", (s: string) => s.replace("</body>", `${empty("Returned Independent Expenditures", "No returned independent expenditures to report")}</body>`)],
    ["extra empty activity", (s: string) => s.replace("<em class=\"NoProvidedData\">", "<span>Unexpected financial activity</span><em class=\"NoProvidedData\">")],
    ["activity outside table", (s: string) => s.replace("<h2>Expenditures</h2></div></header><div>", "<h2>Expenditures</h2></div></header><div><span>$10.00</span>")],
    ["bare body activity", (s: string) => s.replace("<tbody>", "<tbody>$10.00")],
    ["merged financial column", (s: string) => s.replace('data-label="Amount"', 'data-label="Amount" colspan="2"')],
    ["changed header", (s: string) => s.replace("<th scope=\"col\">Amount</th>", "<th scope=\"col\">Net Amount</th>")],
    ["shifted data column", (s: string) => s.replace("data-label=\"Amount\"", "data-label=\"Date\"")],
    ["missing amount column", (s: string) => s.replace('<td data-label="Amount">$5,125.00</td>', "")],
    ["extra hidden amount", (s: string) => s.replace('<td data-label="Amount">$5,125.00</td>', '<td data-label="Amount">$5,125.00<span>$1.00</span></td>')],
    ["changed footer", (s: string) => s.replace('<td>$5,125.00</td>', '<td>$5,124.00</td>')],
    ["unsupported filed status", (s: string) => s.replace(dt("Filing Status", "Filed"), dt("Filing Status", "Not Filed"))],
    ["unsupported type", (s: string) => s.replace(dt("Report Type", "Campaign Finance"), dt("Report Type", "Registration"))],
    ["missing summary control", (s: string) => s.replace(dt("Loan Balance", "$0.00"), "")],
    ["unknown summary control", (s: string) => s.replace(dt("Loan Balance", "$0.00"), dt("Unknown Balance", "$0.00"))],
    ["wrong report ID", (s: string) => s.replace(dt("Report ID", reportId), dt("Report ID", `d_${"e".repeat(26)}`))],
    ["wrong title owner", (s: string) => s.replace("<h1>End Of Third Quarter 2026 - EXAMPLE PAYER</h1>", "<h1>End Of Third Quarter 2026 - DIFFERENT PAYER</h1>")],
    ["invalid leap date", (s: string) => s.replace("09/18/2026</a>", "02/29/2026</a>")],
    ["timestamp display mismatch", (s: string) => s.replace("July 15, 2026", "July 16, 2026")],
    ["truncated section", (s: string) => s.slice(0,-30)],
  ])("rejects %s rather than inferring zero", (_label, mutate) => {
    expect(() => parse(mutate(fixture()), URL)).toThrow("Maine MapLight report controls:");
  });
  it.each(["Original 1", "Amendment 0", "Amendment unknown"])("rejects version %s", value => {
    expect(() => parse(fixture().replace("Amendment 1", value), URL)).toThrow("unknown report version");
  });
  it("rejects header-only schedules rather than treating them as empty", () => {
    expect(() => parse(fixture([], "$0.00"), URL)).toThrow("empty or nested financial rows");
  });
  it("rejects foreign/missing activity identity and noncanonical report URLs", () => {
    expect(() => parse(fixture().replace('href="/public/activities/', 'href="https://example.com/public/activities/'), URL)).toThrow("invalid activity identity");
    expect(() => parse(fixture().replace(`a_${"b".repeat(26)}?`, "unknown?"), URL)).toThrow("invalid activity identity");
    expect(() => parse(fixture(), `${URL}?hidden=value`)).toThrow("noncanonical report URL");
    expect(() => parse(fixture(), URL.replace(".com", ".example"))).toThrow("noncanonical report URL");
  });
  it("rejects unsafe amounts and sums without rounding", () => {
    expect(() => parse(fixture([row(id("c"), "$90071992547409.92")], "$90071992547409.92"), URL)).toThrow("safe exact-cent");
    expect(() => parse(fixture([row(id("c"), "$1.001")], "$1.001"), URL)).toThrow("invalid exact-cent");
  });
  it("does not decode script-contained spoofed financial sections", () => {
    const html=fixture().replace("<body>", `<body><script>${empty("Returned Independent Expenditures", "No returned independent expenditures to report")}</script>`);
    expect(parse(html, URL).returnedIndependentExpenditures.rows).toEqual([]);
  });
});
