import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodeFloridaCommitteeExpenseCover,
  verifyFloridaProcessedExpenseSource,
  type FloridaProcessedExpenseContext,
  type FloridaProcessedExpensePacket,
} from "../../../src/pipeline/floridaFinance/floridaProcessedExpenseSource.js";
import type { FloridaProcessedRawEvidence } from "../../../src/pipeline/floridaFinance/floridaProcessedFinanceSource.js";

// Synthetic protocol fixtures: no claim of a source-accepted eligible candidate.
const DOS = "https://dos.elections.myflorida.com";
const context: FloridaProcessedExpenseContext = {
  payerAccount: "93271", payerName: "Example IE Organization", payerType: "IXO",
  electionYear: 2026, electionType: "general", electionDescription: "2026 General Election",
  electionSelector: "20261103-GEN", genericPayerLabel: "Example IE Organization (IXO)",
};
const wrap = (body: string) => `<html><body>${body}</body></html>`;
const nativeHeader = "Rpt Yr\tRpt Type\tDate\tAmount\tExpense Paid To\tAddress\tCity State Zip\tPurpose\tTyp Reimb";
const genericHeader = "Candidate/Committee\tDate\tAmount\tPayee Name\tAddress\tCity State Zip\tPurpose\tType";
const rows = [
  ["08/02/2026", "500.00", "Example Vendor", "1 Example St", "City FL 12345", "SUPPORT FULL SOURCE PURPOSE", "IEC"],
  ["08/03/2026", "100.00", "Example Vendor", "1 Example St", "City FL 12345", "Ordinary expense", "MON"],
  ["08/03/2026", "100.00", "Example Vendor", "1 Example St", "City FL 12345", "Ordinary expense", "MON"],
];
const native = (data = rows) => `${nativeHeader}\n${data.map(r => ["2026", "P7", ...r].join("\t")).join("\n")}\n`;
const generic = (data = rows) => `${genericHeader}\n${data.map(r => [context.genericPayerLabel, ...r].join("\t")).join("\n")}\n`;
const ownership = () => wrap(`<h2>Committee Tracking System</h2><table>
<tr><td colspan=2><font size=+1><b>${context.payerName}</b></font></td></tr>
<tr><td>Type:</td><td>Independent Expenditures Organization</td></tr>
<tr><td>Status:</td><td>Active</td></tr>
<tr><td>Address:</td><td>1 Legal St<br>City, FL 12345</td></tr>
</table><input type=hidden name=account value="93271">`);
const cover = (waiver = false) => wrap(`<input name="account" value="93271"><table>
<tr><th></th><th>Filing Period</th><th>Contributions</th><th>Expend</th><th>Other</th><th>Transfers</th></tr>
<tr><th>Monetary</th><th>Loans</th><th>InKind</th></tr>
${waiver ? '<tr><td>W</td><td>07/01/2026 - 07/31/2026</td><td>0.00</td><td>0.00</td><td>0.00</td><td>0.00</td><td>0.00</td><td>0.00</td></tr>' : ""}
<tr><td><input type="radio" name="seqnum" value="2"></td><td>08/01/2026 - 08/13/2026</td><td>999.00</td><td>0.00</td><td>0.00</td><td>700.00</td><td>0.00</td><td>0.00</td></tr>
<tr><td><input type="radio" name="seqnum" value="0"></td><td>All Dates (Totals)</td><td>999.00</td><td>0.00</td><td>0.00</td><td>700.00</td><td>0.00</td><td>0.00</td></tr></table>`);
function efs(overrides: Record<string, string> = {}, amended = true) {
  const fields = {
    lblID: "93271", lblFullName: context.payerName, lblElectionID: "2026 General Election",
    // Native query key2 is independently joined to EFS sequence41 by actual coverage.
    lblReportIdentifier: "Report: 2026 - P7 - 41", lblCoveragePeriod: "8/1/2026-8/13/2026",
    lblFileStatus: "Filed Report", lblReviewStatus: "Reviewed",
    lblCompletenessStatus: "Complete Detail Records", lblQueuedItems: "0",
    lblCntExp: "3", lblCntXfr: "0", lblCntOth: "0", ...overrides,
  };
  return wrap(Object.entries(fields).map(([k, v]) => `<span id="${k}">${v}</span>`).join("") +
    `<input id="chkAmended" type="checkbox" ${amended ? 'checked="checked"' : ""}><input id="chkWaiver" type="checkbox">`);
}
function evidence(body: string, url: string, fields: Record<string, string> | null, closing: boolean): FloridaProcessedRawEvidence {
  const bytesRaw = new TextEncoder().encode(body);
  return {
    bytesRaw, sha256: createHash("sha256").update(bytesRaw).digest("hex"), url,
    method: fields ? "POST" : "GET", financeFields: fields, status: 200,
    contentType: url.includes(".exe") && !url.includes("TreSel") ? "text/tab-separated-values" : "text/html; charset=utf-8",
    startedAt: `2026-10-11T21:${closing ? "42" : "40"}:00Z`, completedAt: `2026-10-11T21:${closing ? "42" : "40"}:01Z`
  };
}
const nativeFields = (seqnum: string) => ({ account: "93271", seqnum, queryfor: "2", queryorder: "DAT", queryoutput: "2", query: "Submit Query Now" });
function packet(closing = false): FloridaProcessedExpensePacket {
  return {
    ownership: evidence(ownership(), `${DOS}/committees/ComDetail.asp?account=93271`, null, closing),
    activity: evidence(cover(), `${DOS}/cgi-bin/TreSel.exe`, { account: "93271", election: "All", submit: "Campaign Finance Activity" }, closing),
    currentReports: [evidence(efs(), "https://efs.dos.state.fl.us/PrintReportSubmitted.aspx?AcctNum=93271&SeqNum=41", null, closing)],
    periodExports: [evidence(native(), `${DOS}/cgi-bin/TreFin.exe`, nativeFields("2"), closing)],
    allDatesExport: evidence(native(), `${DOS}/cgi-bin/TreFin.exe`, nativeFields("0"), closing),
    genericExport: evidence(generic(), `${DOS}/cgi-bin/expend.exe`, {
      election: "20261103-GEN", search_on: "4", CanFName: "", CanLName: "", CanNameSrch: "2",
      office: "All", cdistrict: "", cgroup: "", party: "All", ComName: context.payerName, ComNameSrch: "2",
      committee: "All", cfname: "", clname: "", namesearch: "2", ccity: "", cstate: "", czipcode: "",
      cpurpose: "", cdollar_minimum: "", cdollar_maximum: "", rowlimit: "1000", csort1: "DAT", csort2: "CAN",
      cdatefrom: "", cdateto: "", queryformat: "2", Submit: "Submit",
    }, closing),
  };
}
function body(raw: FloridaProcessedRawEvidence) { return new TextDecoder().decode(raw.bytesRaw); }
function change(raw: FloridaProcessedRawEvidence, transform: (s: string) => string) {
  raw.bytesRaw = new TextEncoder().encode(transform(body(raw)));
  raw.sha256 = createHash("sha256").update(raw.bytesRaw).digest("hex");
}
function verify(before = packet(), after = packet(true)) {
  return verifyFloridaProcessedExpenseSource({ context, before, after });
}

describe("Florida current processed expense proof", () => {
  it.each([false, true])("compares full legal owner through rotating protected email transport (changed=%s)", changed => {
    const before = packet(), after = packet(true);
    const encoded = (value: string, key: number) => Buffer.from([key, ...Buffer.from(value).map(byte => byte ^ key)]).toString("hex");
    for (const [phase, p] of [before, after].entries()) {
      const email = phase === 1 && changed ? "changed@example.org" : "contact@example.org";
      const span = encoded(email, phase ? 20 : 10), link = encoded(email, phase ? 21 : 11);
      change(p.ownership, body => body.replace("</table>", '<tr><td>Email:</td><td><a href="/cdn-cgi/l/email-protection#' + link + '"><span class="__cf_email__" data-cfemail="' + span + '">[email&#160;protected]</span></a></td></tr></table>'));
    }
    const result = verify(before, after);
    if (changed) expect(result.proof).toBeUndefined();
    else {
      expect(result.proof).toBeDefined();
      expect(result.proof?.owner.fullFields.__sourceAccountTables).toContain(encoded("contact@example.org", 20));
    }
  });
  it("closes whole amended current reports with exact native/EFS coverage and duplicate occurrence parity", () => {
    const result = verify();
    expect(result.proof?.rows).toHaveLength(3);
    expect(result.proof?.rows.reduce((sum, r) => sum + r.amountCents, 0)).toBe(70000);
    expect(result.proof?.reports[0]?.current.amended).toBe(true);
    expect(result.proof?.reports[0]?.current.sequence).toBe(41);
    expect(result.proof?.reports[0]?.cover.nativeSequence).toBe(2);
    expect(result.proof?.candidateWideZeroAuthority).toBe(false);
    expect(result.proof?.sourceMetadata).toHaveLength(12);
  });
  it("uses Expend independently from the three receipt amounts", () => {
    const parsed = decodeFloridaCommitteeExpenseCover(cover(), "93271");
    expect(parsed.periods[0]?.expenseCents).toBe(70000);
    expect(parsed.periods[0]?.sourceCells[2]).toBe("999.00");
  });
  it("retains source waiver covers but preserves unproved current waiver status closure", () => {
    expect(decodeFloridaCommitteeExpenseCover(cover(true), "93271").periods[0]?.waiver).toBe(true);
    const before = packet(), after = packet(true);
    for (const p of [before, after]) change(p.activity, () => cover(true));
    expect(verify(before, after).diagnostics.join()).toContain("missing/extra full current");
    expect(verify(before, after).proof).toBeUndefined();
  });
  it("accepts only source-observed complete zero-waiver status coverage without inventing an export", () => {
    const before = packet(), after = packet(true);
    for (const [p, closing] of [[before, false], [after, true]] as const) {
      change(p.activity, () => cover(true));
      const waived = efs({ lblReportIdentifier: "Report: 2026 - P6 - 39", lblCoveragePeriod: "7/1/2026-7/31/2026",
        lblCompletenessStatus: "No Detail Records Found", lblCntExp: "0", lblCntCon: "0" }, false)
        .replace('id="chkWaiver" type="checkbox"', 'id="chkWaiver" type="checkbox" checked="checked"');
      p.currentReports = [...p.currentReports, evidence(waived,
        "https://efs.dos.state.fl.us/PrintReportSubmitted.aspx?AcctNum=93271&SeqNum=39", null, closing)];
    }
    const result = verify(before, after);
    expect(result.proof?.reports).toHaveLength(2);
    expect(result.proof?.reports.filter(r => r.current.waiver)).toHaveLength(1);
    expect(result.proof?.rows).toHaveLength(3);
    const missing = structuredClone(after);
    change(missing.currentReports[1]!, s => s.replace('<span id="lblCntCon">0</span>', ""));
    expect(verify(before, missing).proof).toBeUndefined();
    const wrong = structuredClone(after);
    change(wrong.currentReports[1]!, s => s.replace("No Detail Records Found", "Complete Detail Records"));
    expect(verify(before, wrong).proof).toBeUndefined();
  });
  it("accepts independent source ordering while retaining every occurrence", () => {
    const after = packet(true);
    change(after.allDatesExport, () => native([...rows].reverse()));
    change(after.genericExport, () => generic([...rows].reverse()));
    expect(verify(packet(), after).proof?.rows).toHaveLength(3);
  });
  it("copies evidence so caller mutation cannot change an accepted proof", () => {
    const before = packet(), after = packet(true), result = verify(before, after);
    after.genericExport.financeFields = {};
    after.allDatesExport.bytesRaw.fill(0);
    expect(result.proof?.rows[0]?.purpose).toBe("SUPPORT FULL SOURCE PURPOSE");
    expect(result.proof?.sourceMetadata.find(r => r.url.includes("expend.exe"))?.financeFields?.election).toBe("20261103-GEN");
  });
  const mutations: [string, (p: FloridaProcessedExpensePacket) => void][] = [
    ["same-money changed full purpose", p => change(p.genericExport, s => s.replace("SUPPORT FULL SOURCE PURPOSE", "DIFFERENT TARGET"))],
    ["same-money changed address", p => change(p.genericExport, s => s.replace("1 Example St", "2 Example St"))],
    ["lost identical occurrence", p => change(p.genericExport, () => generic(rows.slice(0, 2)))],
    ["wrong source owner", p => change(p.ownership, s => s.replace(context.payerName, "Other Owner"))],
    ["wrong legal class", p => change(p.ownership, s => s.replace("Independent Expenditures Organization", "Political Committee"))],
    ["wrong source account", p => change(p.ownership, s => s.replace('value="93271"', 'value="99999"'))],
    ["wrong election", p => change(p.currentReports[0]!, s => s.replace("2026 General Election", "2026 Special Election - Senate 14 &amp; House 87"))],
    ["wrong coverage", p => change(p.currentReports[0]!, s => s.replace("8/1/2026", "7/31/2026"))],
    ["wrong current count", p => change(p.currentReports[0]!, s => s.replace('id="lblCntExp">3', 'id="lblCntExp">2'))],
    ["queued detail", p => change(p.currentReports[0]!, s => s.replace('id="lblQueuedItems">0', 'id="lblQueuedItems">1'))],
    ["unreviewed", p => change(p.currentReports[0]!, s => s.replace('id="lblReviewStatus">Reviewed', 'id="lblReviewStatus">Pending'))],
    ["incomplete", p => change(p.currentReports[0]!, s => s.replace("Complete Detail Records", "Incomplete Detail Records"))],
    ["extra transfer records", p => change(p.currentReports[0]!, s => s.replace('id="lblCntXfr">0', 'id="lblCntXfr">1'))],
    ["missing other count", p => change(p.currentReports[0]!, s => s.replace('<span id="lblCntOth">0</span>', ""))],
    ["duplicate current report", p => p.currentReports = [...p.currentReports, ...p.currentReports]],
    ["missing native period", p => p.periodExports = []],
    ["wrong native selector", p => p.periodExports[0]!.financeFields = { ...nativeFields("41") }],
    ["wrong report membership", p => change(p.periodExports[0]!, s => s.replace("2026\tP7", "2026\tG1"))],
    ["unexpected signed expense", p => change(p.periodExports[0]!, s => s.replace("500.00", "-500.00"))],
    ["unknown financial type", p => change(p.periodExports[0]!, s => s.replace("\tIEC", "\tREF"))],
    ["generic wrong payer", p => change(p.genericExport, s => s.replace(context.genericPayerLabel, "Another IE Organization (IXO)"))],
    ["generic capped", p => p.genericExport.financeFields = { ...p.genericExport.financeFields, rowlimit: "3" }],
    ["generic purpose filter", p => p.genericExport.financeFields = { ...p.genericExport.financeFields, cpurpose: "SUPPORT" }],
    ["source HTML error instead of TSV", p => change(p.genericExport, () => wrap("Invalid Date Range Entered"))],
    ["bad hash", p => p.genericExport.sha256 = "0".repeat(64)],
    ["missing MIME", p => p.activity.contentType = ""],
    ["wrong transport", p => p.activity.method = "GET"],
    ["HTTP failure", p => p.genericExport.status = 500],
    ["HTML truncation", p => change(p.activity, s => s.replace("</html>", ""))],
    ["unjoined Other money", p => change(p.activity, s => s.replaceAll("700.00</td><td>0.00", "700.00</td><td>1.00"))],
    ["changed current amendment", p => change(p.currentReports[0]!, s => s.replace('checked="checked"', ""))],
  ];
  it.each(mutations)("preserves on %s", (_, mutate) => {
    const after = packet(true); mutate(after);
    const result = verify(packet(), after);
    expect(result.proof).toBeUndefined();
    expect(result.diagnostics).not.toEqual([]);
  });
  it("rejects a fabricated/stale closing interval", () => {
    const after = packet(true);
    after.ownership.startedAt = "2026-10-11T21:39:00Z";
    expect(verify(packet(), after).proof).toBeUndefined();
    expect(verify(packet(), after).diagnostics.join()).toContain("closing predates");
  });
  it("rejects source unsupported zero rather than publishing outside zero", () => {
    const p = packet(); p.periodExports = []; p.currentReports = [];
    expect(verify(p, structuredClone(p)).proof).toBeUndefined();
  });
});
