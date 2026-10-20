import { describe, expect, it } from "vitest";
import { hiB2CoverCents, hiFiledDay, hiItemizedCoverCents, hiDocument, hiInventoryRows, parseHawaiiNativeCover, selectHawaiiNativeReport,
  type HawaiiNativeReport } from "../../../src/pipeline/hawaiiFinance/hawaiiReportedNative.js";

const base = "https://csc.hawaii.gov/NCFSPublic/report_detail/";
function report(change: Partial<HawaiiNativeReport> = {}): HawaiiNativeReport {
  return { type: "Disclosure", period: "2024-2026 1st Preliminary General", amended: "No", filed: "10/01/2026",
    href: "../report/?PERIOD=synthetic-period&RPT_DTS=synthetic-date", ...change };
}
const choose = (rows: HawaiiNativeReport[]) => selectHawaiiNativeReport(rows, "2024-2026", base, "2026-10-19", true);
describe("Hawaii native report lineage", () => {
  it("retains non-disclosure schedule rows with blank filing metadata, while requiring disclosure metadata", () => {
    const html = '<span id="id_sc_field_report_file_rpt_type_1">Schedule B2 - Expenditures Made</span><span id="id_sc_field_rpt_name_1"></span>';
    expect(hiInventoryRows(hiDocument(html), true)[0]?.amended).toBe("");
    expect(() => hiInventoryRows(hiDocument(html.replace("Schedule B2 - Expenditures Made", "Disclosure")), true)).toThrow();
  });
  it("uses amendment date, retains versions, never chooses selector order", () => {
    const old = report({ filed: "09/29/2026", href: "../report/?PERIOD=synthetic-period&RPT_DTS=z-old" });
    const amended = report({ amended: "Yes", href: "../report/?PERIOD=synthetic-period&RPT_DTS=a-new" });
    const a = choose([amended, old]); expect(a.report).toEqual(amended); expect(a.sourceVersions).toBe(2); expect(a.supersededVersions).toBe(1);
  });
  it("does not merge different report labels sharing one PERIOD selector", () => {
    const a = choose([report({ period: "2024-2026 Final Primary", filed: "08/31/2026" }), report()]);
    expect(a.report.period).toContain("1st Preliminary General"); expect(a.supersededVersions).toBe(0);
  });
  it.each([
    [report(), report({ amended: "Yes" })],
    [report({ filed: "09/29/2026", amended: "Yes" }), report({ amended: "Yes" })],
    [report({ filed: "09/29/2026" }), report()],
  ])("holds tied clocks and invalid amendment lineage", (...rows) => expect(() => choose(rows)).toThrow());
  it("rejects future, unknown and cross-origin versions", () => {
    for (const changes of [{ filed: "10/20/2026" }, { amended: "Maybe" }, { period: "2024-2026 Unknown" }, { href: "https://example.invalid/?PERIOD=x&RPT_DTS=y" }])
      expect(() => choose([report(changes)])).toThrow();
    expect(() => hiFiledDay("2/29/2026")).toThrow("invalid_source_date");
  });
  it("holds equal-ranked current reports from different families", () => {
    expect(() => choose([report(), report({ href: "../report/?PERIOD=another&RPT_DTS=another" })])).toThrow("native_current_report_tie");
  });
  it("uses candidate report-year labels, then leaves election-period qualification to the exact cover heading", () => {
    const label = "1st Preliminary General Aug 9 - Sep 26, 2026";
    const selected = selectHawaiiNativeReport([report({ period: label, href: "/synthetic-current.html" }),
      report({ period: "2nd Preliminary General Sep 27 - Oct 21, 2024", filed: "10/28/2024", href: "/synthetic-old.html", amended: "" })],
    "2024-2026", "https://csc.hawaii.gov/CFSPublic/report_detail/", "2026-10-19", false);
    expect(selected.report.period).toBe(label);
    expect(() => selectHawaiiNativeReport([report({ period: label, amended: "" })], "2024-2026", base, "2026-10-19", false)).toThrow("native_version_metadata");
  });
});
describe("Hawaii native financial controls", () => {
  const html = (label: string) => `<p>Synthetic Education PAC</p><table><tr><td>${label}</td><td>$1,234.56</td><td>$6,789.01</td></tr></table>`;
  it("selects exact B2 election-period control, not report-period or similar amount", () => {
    expect(hiB2CoverCents(parseHawaiiNativeCover(html("13. Expenditures Made (Schedule B2)"), "Synthetic Education PAC"))).toBe(678_901);
    expect(() => hiB2CoverCents(parseHawaiiNativeCover(html("Total Disbursements"), "Synthetic Education PAC"))).toThrow("native_b2_control");
  });
  it("requires both resident and nonresident itemized controls", () => {
    const label = "(ii) Monetary and Non-Monetary Contributions of More Than $100 (Schedule A)";
    const controls = parseHawaiiNativeCover(html(label) + html(label), "Synthetic Education PAC");
    expect(hiItemizedCoverCents(controls)).toBe(1_357_802);
    expect(() => hiItemizedCoverCents(controls.slice(1))).toThrow("native_itemized_control");
  });
  it("holds a missing filer identity or unavailable report rather than zero", () => {
    expect(() => parseHawaiiNativeCover(html("Total"), "Different PAC")).toThrow("cover_filer_identity");
    expect(() => parseHawaiiNativeCover("<p>Synthetic Education PAC No Records Found</p>", "Synthetic Education PAC")).toThrow("native_cover_controls");
  });
});
