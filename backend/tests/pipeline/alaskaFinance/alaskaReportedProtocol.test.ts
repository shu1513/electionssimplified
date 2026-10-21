import { describe, expect, it } from "vitest";
import {
  akCsv,
  akCsvPopulationComplete,
  akNativePopulationComplete,
  akRecordedPopulations,
} from "../../../src/pipeline/alaskaFinance/alaskaReportedProtocol.js";
import {
  akHash,
  type AlaskaOriginal,
} from "../../../src/pipeline/alaskaFinance/alaskaReportedOriginals.js";
import { ALASKA_REPORTED_URLS } from "../../../src/pipeline/alaskaFinance/alaskaReportedNative.js";

const prefix = "M$C$csfFilter$",
  csvUrl =
    ALASKA_REPORTED_URLS.ie +
    "?exportAll=True&exportFormat=CSV&isExport=True&pageSize=20&pageIndex=0";
const controls = (name: string) =>
  `<input type="hidden" name="__EVENTTARGET"><input type="hidden" name="__EVENTARGUMENT"><select name="${prefix}ddlReportYear"><option value="-1" selected>Any</option></select><select name="${prefix}ddlStatus"><option value="Default">Complete, Not Amended</option></select><select name="${prefix}ddlNameType"><option value="Candidate">Candidate</option></select><select name="${prefix}ddlValue"><option value="-1">Any</option></select><input name="${prefix}txtName" value="${name}"><input type="submit" name="${prefix}btnSearch" value="Search">`;
const html = (page: number, name = "Example") =>
  `<html><body><form>${controls(name)}<table id="M_C_grid_ctl00"><tr><th>Amount</th><th>Status</th></tr><tr class="rgRow"><td>$1.00</td><td><a href="../Common/View.aspx?ID=99100${page}&amp;ViewType=IE">Filed</a></td></tr><tr><td colspan="2"><span class="rgInfoPart">2 items in 2 pages</span><a class="rgCurrentPage">${page}</a></td></tr></table><a id="M_C_ExportDialog_hlAllCSV" href="${csvUrl.replace(/&/g, "&amp;")}">All CSV</a></form></body></html>`;
function original(
  index: number,
  body: string,
  action: "search" | "export" | "page" | "csv",
  name = "Example",
): AlaskaOriginal {
  const raw = new TextEncoder().encode(body),
    request =
      action === "csv"
        ? null
        : new URLSearchParams({
            [prefix + "ddlReportYear"]: "-1",
            [prefix + "ddlStatus"]: "Default",
            [prefix + "ddlNameType"]: "Candidate",
            [prefix + "txtName"]: name,
            ...(action === "search"
              ? { [prefix + "btnSearch"]: "Search" }
              : action === "export"
                ? { [prefix + "btnExport"]: "Export" }
                : { __EVENTTARGET: "M$C$grid$next" }),
          }).toString();
  const ordinal = String(index).padStart(5, "0"),
    stamp = new Date(Date.now() - 10000 + index).toISOString();
  return {
    raw,
    request,
    directory: "/synthetic-source",
    meta: {
      role: "untrusted_success_label",
      url: action === "csv" ? csvUrl : ALASKA_REPORTED_URLS.ie,
      method: action === "csv" ? "GET" : "POST",
      file: ordinal + ".original",
      requestFile: request === null ? null : ordinal + ".request",
      requestSha256: request === null ? null : akHash(request),
      status: 200,
      contentType: action === "csv" ? "text/csv" : "text/html",
      bytes: raw.length,
      sha256: akHash(raw),
      eof: true,
      startedAt: stamp,
      completedAt: stamp,
    },
  };
}
describe("Alaska complete source sequences", () => {
  it("preserves quoted newlines and duplicate occurrences, rejecting malformed or silently dropped rows", () => {
    expect(
      akCsv(
        new TextEncoder().encode(
          'Name,Amount\r\n"Example,\nPAC",1.00\r\n"Example,\nPAC",1.00\r\n',
        ),
      ).rows,
    ).toEqual([
      ["Example,\nPAC", "1.00"],
      ["Example,\nPAC", "1.00"],
    ]);
    for (const body of [
      'Name,Amount\n"unfinished,1.00',
      'Name,Amount\n"closed"junk,1.00',
      "Name,Name\na,b",
      "Name,Amount\na,1.00\n\n",
      "Name,Amount\ra,1.00",
    ])
      expect(() => akCsv(new TextEncoder().encode(body))).toThrow();
  });
  it("distinguishes a complete all-result CSV from incomplete companion HTML pages", () => {
    const observations = [
      original(1, html(1), "search"),
      original(2, html(1), "export"),
      original(3, "Result,Amount\n1,1.00\n2,1.00\n", "csv"),
    ];
    const [population] = akRecordedPopulations(observations);
    expect(akCsvPopulationComplete(population!)).toBe(true);
    expect(akNativePopulationComplete(population!)).toBe(false);
    observations.push(original(4, html(2), "page"));
    const [complete] = akRecordedPopulations(observations);
    expect(akNativePopulationComplete(complete!)).toBe(true);
  });
  it("does not turn failed or mismatched response scopes into a success label or zero", () => {
    expect(
      akRecordedPopulations([original(1, html(1, "Different"), "search")]),
    ).toHaveLength(0);
    const observations = [
      original(1, html(1), "search"),
      original(2, html(1), "export"),
      original(3, "Result,Amount\n1,1.00\n2,1.00\n", "csv"),
    ];
    observations[2] = {
      ...observations[2]!,
      meta: { ...observations[2]!.meta, eof: false },
    };
    const [population] = akRecordedPopulations(observations);
    expect(akCsvPopulationComplete(population!)).toBe(false);
    expect(akNativePopulationComplete(population!)).toBe(false);
  });
  it("accepts an explicit completed-search empty result but never the initial search placeholder", () => {
    const table = (message: string) =>
      `<html><body><form>${controls("Example")}<table id="M_C_grid_ctl00"><tr><th>Amount</th><th>Status</th></tr><tr class="rgNoRecords"><td colspan="2">${message}</td></tr></table></form></body></html>`;
    const [empty] = akRecordedPopulations([
      original(1, table("No records to display."), "search"),
    ]);
    expect(akNativePopulationComplete(empty!)).toBe(true);
    const [placeholder] = akRecordedPopulations([
      original(1, table("Press 'Search' to Load Results."), "search"),
    ]);
    expect(akNativePopulationComplete(placeholder!)).toBe(false);
  });
});
