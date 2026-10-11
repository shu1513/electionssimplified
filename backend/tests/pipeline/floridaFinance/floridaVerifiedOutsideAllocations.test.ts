import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildFloridaVerifiedOutsideAllocations, type FloridaOutsideAllocationSource } from "../../../src/pipeline/floridaFinance/floridaVerifiedOutsideAllocations.js";
import type { FloridaLocalFinanceContext } from "../../../src/pipeline/floridaFinance/floridaLocalFinanceContext.js";
import type { FloridaProcessedRawEvidence } from "../../../src/pipeline/floridaFinance/floridaProcessedFinanceSource.js";

// Synthetic protocol fixtures, never evidence of an accepted real candidate.
const DOS = "https://dos.elections.myflorida.com";
const local: FloridaLocalFinanceContext = { candidateId: "candidate-example", candidateElectionId: "race-example", electionId: "election-example",
  candidateName: "John Example", electionYear: 2026, electionDate: "2026-11-03", officeScope: "state_lower",
  officeCanonicalName: "State Lower Chamber Legislator", district: "87", committeeId: "LOCAL_EXAMPLE", genericRecipientName: "Example, John (REP)(STR)" };
const context = { payerAccount: "90001", payerName: "Example Committee", payerType: "PAC" as const,
  electionYear: 2026, electionType: "general" as const, electionDescription: "2026 General Election", electionSelector: "20261103-GEN", genericPayerLabel: "Example Committee (PAC)" };
const rows = [
  ["09/30/2026", "525.00", "Example Vendor", "Vendor address", "Vendor city", "TEXT MESSAGES; PRO-JOHN EXAMPLE, HD-87", "IEC"],
  ["09/30/2026", "525.00", "Example Vendor", "Vendor address", "Vendor city", "TEXT MESSAGES; PRO-JOHN EXAMPLE, HD-87", "IEC"],
  ["09/30/2026", "100.00", "Example Vendor", "Vendor address", "Vendor city", "Ordinary expense", "MON"],
];
const html = (body: string) => `<html><body>${body}</body></html>`;
function raw(body: string, url: string, fields: Record<string, string> | null, close: boolean): FloridaProcessedRawEvidence {
  const bytesRaw = Buffer.from(body);
  return { bytesRaw, sha256: createHash("sha256").update(bytesRaw).digest("hex"), url, method: fields ? "POST" : "GET", financeFields: fields,
    status: 200, contentType: "text/html", startedAt: `2026-10-11T21:${close ? "42" : "40"}:00Z`, completedAt: `2026-10-11T21:${close ? "42" : "40"}:01Z` };
}
function packet(close: boolean) {
  const native = "Rpt Yr\tRpt Type\tDate\tAmount\tExpense Paid To\tAddress\tCity State Zip\tPurpose\tTyp Reimb\n" + rows.map(row => ["2026", "G4", ...row].join("\t")).join("\n") + "\n";
  const generic = "Candidate/Committee\tDate\tAmount\tPayee Name\tAddress\tCity State Zip\tPurpose\tType\n" + rows.map(row => [context.genericPayerLabel, ...row].join("\t")).join("\n") + "\n";
  const nativeFields = (seqnum: string) => ({ account: context.payerAccount, seqnum, queryfor: "2", queryorder: "DAT", queryoutput: "2", query: "Submit Query Now" });
  const metadata = { lblID: "90001", lblFullName: context.payerName, lblElectionID: context.electionDescription, lblReportIdentifier: "Report: 2026 - G4 - 41",
    lblCoveragePeriod: "9/26/2026-10/2/2026", lblFileStatus: "Filed Report", lblReviewStatus: "Reviewed", lblCompletenessStatus: "Complete Detail Records", lblQueuedItems: "0", lblCntExp: "3", lblCntXfr: "0", lblCntOth: "0" };
  return {
    ownership: raw(html(`<h2>Committee Tracking System</h2><table><tr><td colspan=2><font size=+1><b>${context.payerName}</b></font></td></tr><tr><td>Type:</td><td>Political Committee</td></tr><tr><td>Status:</td><td>Active</td></tr><tr><td>Address:</td><td>Legal address<br>Legal city</td></tr></table><input name=account value="90001">`), `${DOS}/committees/ComDetail.asp?account=90001`, null, close),
    activity: raw(html(`<input name=account value="90001"><table><tr><th></th><th>Filing Period</th><th>Contributions</th><th>Expend</th><th>Other</th><th>Transfers</th></tr><tr><th>Monetary</th><th>Loans</th><th>InKind</th></tr><tr><td><input type=radio name=seqnum value=2></td><td>09/26/2026 - 10/02/2026</td><td>0.00</td><td>0.00</td><td>0.00</td><td>1150.00</td><td>0.00</td><td>0.00</td></tr><tr><td><input type=radio name=seqnum value=0></td><td>All Dates (Totals)</td><td>0.00</td><td>0.00</td><td>0.00</td><td>1150.00</td><td>0.00</td><td>0.00</td></tr></table>`), `${DOS}/cgi-bin/TreSel.exe`, { account: "90001", election: "All", submit: "Campaign Finance Activity" }, close),
    currentReports: [raw(html(Object.entries(metadata).map(([key, value]) => `<span id="${key}">${value}</span>`).join("") + '<input type=checkbox id=chkWaiver><input type=checkbox id=chkAmended checked>'), "https://efs.dos.state.fl.us/PrintReportSubmitted.aspx?AcctNum=90001&SeqNum=41", null, close)],
    periodExports: [raw(native, `${DOS}/cgi-bin/TreFin.exe`, nativeFields("2"), close)],
    allDatesExport: raw(native, `${DOS}/cgi-bin/TreFin.exe`, nativeFields("0"), close),
    genericExport: raw(generic, `${DOS}/cgi-bin/expend.exe`, { election: context.electionSelector, search_on: "4", CanFName: "", CanLName: "", CanNameSrch: "2", office: "All", cdistrict: "", cgroup: "", party: "All", ComName: context.payerName, ComNameSrch: "2", committee: "All", cfname: "", clname: "", namesearch: "2", ccity: "", cstate: "", czipcode: "", cpurpose: "", cdollar_minimum: "", cdollar_maximum: "", rowlimit: "1000", csort1: "DAT", csort2: "CAN", cdatefrom: "", cdateto: "", queryformat: "2", Submit: "Submit" }, close),
  };
}
function source(): FloridaOutsideAllocationSource { return { context, before: packet(false), after: packet(true) }; }
describe("Florida full-source outside allocations", () => {
  it("reverifies whole source then retains two equal matched occurrences, excludes ordinary expense", () => {
    const result = buildFloridaVerifiedOutsideAllocations({ source: source(), localContext: local });
    expect(result).toMatchObject({ status: "verified_payer_target", candidateWideZeroAuthority: false, supportCents: 105000, unmatchedExpenseCount: 1 });
    if (result.status === "verified_payer_target") {
      expect(result.allocations.map(row => [row.occurrence, row.reportSequence, row.amountCents])).toEqual([[0, 41, 52500], [1, 41, 52500]]);
      expect(result.proof.reports[0].current.amended).toBe(true);
      expect(result.proof.rows).toHaveLength(3);
    }
  });
  it("empty exact target is scoped to one verified payer, no headline zero", () => {
    expect(buildFloridaVerifiedOutsideAllocations({ source: source(), localContext: { ...local, candidateName: "John Other" } }))
      .toMatchObject({ status: "verified_payer_target", supportCents: 0, allocations: [], candidateWideZeroAuthority: false });
  });
  it.each([{ electionDate: "2026-08-18" }, { district: "087" }, { officeScope: "county_school_board" }, { district: "121" }])("preserves invalid local race %#", change => {
    expect(buildFloridaVerifiedOutsideAllocations({ source: source(), localContext: { ...local, ...change } })).toMatchObject({ status: "preserve" });
  });
  it("preserves Special source before any empty allocation can alter General money", () => {
    const input = source();
    input.context = { ...input.context, electionType: "special", electionSelector: "20260324-S01", electionDescription: "2026 Special Election - Senate 14 & House 87" };
    expect(buildFloridaVerifiedOutsideAllocations({ source: input, localContext: local })).toMatchObject({ status: "preserve", diagnostics: ["Source and local target elections differ."] });
  });
  it.each(["hash", "missing", "changed", "count", "filter"])("rechecks source authority before target filtering: %s", kind => {
    const input = source();
    if (kind === "hash") input.before.genericExport.sha256 = "a".repeat(64);
    if (kind === "missing") input.after.currentReports = [];
    if (kind === "filter") input.before.genericExport.financeFields = { ...input.before.genericExport.financeFields, cpurpose: "TEXT" };
    if (kind === "changed" || kind === "count") {
      const evidence = kind === "changed" ? input.after.periodExports[0] : input.after.currentReports[0];
      evidence.bytesRaw = Buffer.from(Buffer.from(evidence.bytesRaw).toString().replace(kind === "changed" ? "JOHN" : 'id="lblCntExp">3', kind === "changed" ? "JANE" : 'id="lblCntExp">2'));
      evidence.sha256 = createHash("sha256").update(evidence.bytesRaw).digest("hex");
    }
    expect(buildFloridaVerifiedOutsideAllocations({ source: input, localContext: local })).toMatchObject({ status: "preserve" });
  });
  it("does not retain caller-mutable source/local objects", () => {
    const input = source(), target = { ...local };
    const result = buildFloridaVerifiedOutsideAllocations({ source: input, localContext: target });
    target.candidateName = "Changed"; input.after.periodExports[0].bytesRaw.fill(0);
    expect(result.status).toBe("verified_payer_target");
    if (result.status === "verified_payer_target") expect(result.localContext.candidateName).toBe("John Example");
  });
});
