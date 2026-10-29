import { buildFloridaVerifiedOutsideAllocations } from "../../../src/pipeline/floridaFinance/floridaVerifiedOutsideAllocations.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFloridaCandidateOutsideFinanceSource } from "../../../src/pipeline/floridaFinance/floridaCandidateOutsideFinanceSource.js";
import * as rawSource from "../../../src/pipeline/floridaFinance/floridaFinanceRawSourceClient.js";
import { FLORIDA_EXPENDITURE_DISCOVERY_HEADERS } from "../../../src/pipeline/floridaFinance/floridaIndependentExpenditureDiscovery.js";
const row = {
  candidate_id: "candidate", candidate_election_id: "candidate-election", election_id: "election", candidate_name: "Adam Botana",
  candidate_status: "qualified", election_date: "2026-11-03", election_stage: "general", race_type: "office", state: "FL",
  office_scope: "state_lower", office_canonical_name: "State Lower Chamber Legislator", district_type: "state_lower", geoid_compact: "12080",
  committee_id: "BOTANA_ADAM_REP_STR", committee_name: "Botana, Adam (REP)(STR)", election_year: 2026
};
const input = { candidateId: row.candidate_id, electionId: row.election_id, committeeId: row.committee_id };
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function source(query: ReturnType<typeof vi.fn>, refresh = false) {
  const cacheDir = await mkdtemp(join(tmpdir(), "fl-outside-test-")); roots.push(cacheDir);
  return createFloridaCandidateOutsideFinanceSource({ db: { query }, cacheDir, minIntervalMs: 0, refresh });
}
describe("Florida normal candidate outside source", () => {
  it("does not interpret empty discovery as a verified component or candidate zero", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(FLORIDA_EXPENDITURE_DISCOVERY_HEADERS.join("\t") + "\n", { headers: { "content-type": "text/tab-separated-values" } }));
    vi.stubGlobal("fetch", fetch);
    const query = vi.fn().mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({ rows: [] });
    const result = await (await source(query)).load(input);
    expect(result).toMatchObject({ status: "loaded", components: [] });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(String(fetch.mock.calls[0][1].body)).toContain("cpurpose=TEXT+MESSAGES%3B+PRO-Adam+Botana");
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][1]).toEqual([row.candidate_election_id, 2026]);
  });
  it("allows the next candidate to acquire discovery after one candidate exhausts its budget", async () => {
    const original = rawSource.createFloridaFinanceRawSourceClient;
    vi.spyOn(rawSource, "createFloridaFinanceRawSourceClient").mockImplementation(options => original({ ...options, maxRequests: 3 }));
    const transport = fullProtocol();
    const fetch = vi.fn().mockImplementationOnce(transport.fetch).mockImplementationOnce(transport.fetch)
      .mockImplementationOnce(transport.fetch).mockImplementation(() => Promise.resolve(new Response(
        FLORIDA_EXPENDITURE_DISCOVERY_HEADERS.join("\t") + "\n", { headers: { "content-type": "text/tab-separated-values" } })));
    vi.stubGlobal("fetch", fetch);
    const query = vi.fn().mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({ rows: [] });
    const batch = await source(query, true);
    expect((await batch.load(input)).diagnostics.join()).toContain("budget exhausted");
    const next = await batch.load(input);
    expect(next.status).toBe("loaded");
    expect(next.diagnostics.join()).not.toContain("budget exhausted");
    expect(fetch).toHaveBeenCalledTimes(6);
  });
  it("refreshes a previously accepted payer even when current discovery fails", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (url: string, req: RequestInit) => {
      requests.push(url);
      if (url.endsWith("expend.exe")) return new Response("Source failed", { status: 503 });
      const prefix = new URLSearchParams(String(req.body)).get("comName");
      return new Response(`<html><body>Search for Committee by Name<input name=ComName value="${prefix}"><font>** No records found for criteria</font></body></html>`, { headers: { "content-type": "text/html" } });
    });
    const query = vi.fn().mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({ rows: [{ payer_name: "Example Committee", payer_type: "PAC" }] });
    const result = await (await source(query)).load(input);
    expect(result).toMatchObject({ status: "loaded", components: [] });
    expect(requests.filter(url => url.endsWith("ComLkupByName.asp"))).toHaveLength(2);
    expect(result).not.toHaveProperty("supportCents");
  });
  it.each([{ election_stage: "primary" }, { candidate_status: "withdrawn" }])("does not acquire source for an ineligible actual local race %#", async change => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const query = vi.fn().mockResolvedValue({ rows: [{ ...row, ...change }] });
    expect(await (await source(query)).load(input)).toMatchObject({ status: "preserve" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves an unavailable local database without contacting source", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect(await (await source(vi.fn().mockRejectedValue(new Error("local unavailable")))).load(input))
      .toMatchObject({ status: "preserve", diagnostics: ["local unavailable"] });
    expect(fetch).not.toHaveBeenCalled();
  });
});

// Real validators consume synthetic protocol responses. No source success or
// financial acceptance is injected into the acquisition composition.
function fullProtocol(changeFinalRegistry = false, purpose = "TEXT MESSAGES; PRO-ADAM BOTANA, HD-80") {
  const events: string[] = [];
  let ownerGets = 0, registryPosts = 0;
  const payer = "Example Committee";
  const generic = FLORIDA_EXPENDITURE_DISCOVERY_HEADERS.join("\t") +
    `\n${payer} (PAC)\t09/30/2026\t525.00\tExample Vendor\tVendor street\tCity FL 12345\t${purpose}\tIEC\n`;
  const native = "Rpt Yr\tRpt Type\tDate\tAmount\tExpense Paid To\tAddress\tCity State Zip\tPurpose\tTyp Reimb\n" +
    `2026\tG4\t09/30/2026\t525.00\tExample Vendor\tVendor street\tCity FL 12345\t${purpose}\tIEC\n`;
  const wrap = (body: string) => `<html><body>${body}</body></html>`;
  const fetch = vi.fn(async (url: string, req: RequestInit) => {
    const fields = new URLSearchParams(String(req.body ?? ""));
    let body: string;
    if (url.endsWith("ComLkupByName.asp")) {
      registryPosts++;
      events.push(registryPosts <= 2 ? "payer-opening-search" : "payer-closing-search");
      const extra = changeFinalRegistry && registryPosts > 2
        ? `<tr><td><a href="ComDetail.asp?account=90002">${payer}</a></td><td>PAC</td><td>Closed</td></tr>` : "";
      body = wrap(`Search for Committee by Name<input name=ComName value="${fields.get("comName")}"><table><tr><td>Committee</td><td>Type</td><td>Status</td></tr><tr><td><a href="ComDetail.asp?account=90001">${payer}</a></td><td>PAC</td><td>Active</td></tr>${extra}</table>`);
    } else if (url.includes("ComDetail.asp")) {
      ownerGets++;
      events.push(ownerGets === 1 ? "payer-opening-detail" : ownerGets === 4 ? "payer-closing-detail" : "expense-owner");
      body = wrap(`Committee Tracking System<table><tr><td colspan=2><font size=+1><b>${payer}</b></font></td></tr><tr><td>Type:</td><td>Political Committee</td></tr><tr><td>Status:</td><td>Active</td></tr><tr><td>Address:</td><td>Legal street<br>Legal city</td></tr></table><input name=account value=90001>`);
    } else if (url.endsWith("TreSel.exe")) {
      events.push("expense-cover");
      body = wrap('<input name=account value=90001><table><tr><th></th><th>Filing Period</th><th>Contributions</th><th>Expend</th><th>Other</th><th>Transfers</th></tr><tr><th>Monetary</th><th>Loans</th><th>InKind</th></tr><tr><td><input type=radio name=seqnum value=2></td><td>09/26/2026 - 10/02/2026</td><td>0.00</td><td>0.00</td><td>0.00</td><td>525.00</td><td>0.00</td><td>0.00</td></tr><tr><td><input type=radio name=seqnum value=0></td><td>All Dates (Totals)</td><td>0.00</td><td>0.00</td><td>0.00</td><td>525.00</td><td>0.00</td><td>0.00</td></tr></table>');
    } else if (url.endsWith("TreFin.exe")) {
      events.push("expense-native"); body = native;
    } else if (url.endsWith("expend.exe")) {
      events.push(fields.get("ComName") ? "expense-generic" : "discovery");
      body = !fields.get("ComName") && !purpose.toUpperCase().startsWith((fields.get("cpurpose") ?? "").toUpperCase())
        ? FLORIDA_EXPENDITURE_DISCOVERY_HEADERS.join("\t") + "\n" : generic;
    } else if (url.includes("PrintReportSubmitted.aspx")) {
      events.push("expense-status");
      if (new URL(url).searchParams.get("SeqNum") !== "2")
        return new Response(wrap("Not found"), { status: 404, headers: { "content-type": "text/html" } });
      const metadata = {
        lblID: "90001", lblFullName: payer, lblElectionID: "2026 General Election",
        lblReportIdentifier: "Report: 2026 - G4 - 2", lblCoveragePeriod: "9/26/2026-10/2/2026",
        lblFileStatus: "Filed Report", lblReviewStatus: "Reviewed", lblCompletenessStatus: "Complete Detail Records",
        lblQueuedItems: "0", lblCntExp: "1", lblCntXfr: "0", lblCntOth: "0"
      };
      body = wrap(Object.entries(metadata).map(([key, value]) => `<span id="${key}">${value}</span>`).join("") +
        '<input id=chkWaiver type=checkbox><input id=chkAmended type=checkbox>');
    } else throw new Error(`Unexpected synthetic request ${url}`);
    return new Response(body, { headers: { "content-type": body.startsWith("<html>") ? "text/html" : "text/tab-separated-values" } });
  });
  return { fetch, events };
}

describe("Florida candidate outside nested acquisition", () => {
  it.each(["DATA", "MAILER & PHONE BANKS"])("allocates %s Senate support through complete native report and registry checks", async prefix => {
    const transport = fullProtocol(false, `${prefix} SUPPORTING JANE EXAMPLE (SD-39)`);
    vi.stubGlobal("fetch", transport.fetch);
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ ...row, candidate_name: "Jane Example",
      office_scope: "state_upper", office_canonical_name: "State Senator", district_type: "state_upper", geoid_compact: "12039" }] })
      .mockResolvedValueOnce({ rows: [] });
    const result = await (await source(query)).load(input);
    expect(result).toMatchObject({ status: "loaded", localContext: { officeScope: "state_upper", district: "39" } });
    if (result.status !== "loaded") return;
    expect(result.components).toHaveLength(1);
    expect(result.components[0].source.after.periodExports).toHaveLength(1);
    expect(transport.events.filter(event => event === "discovery")).toHaveLength(2);
    const allocation = buildFloridaVerifiedOutsideAllocations({
      localContext: result.localContext, source: result.components[0].source,
    });
    expect(allocation).toMatchObject({ status: "verified_payer_target", candidateWideZeroAuthority: false,
      supportCents: 52500, unmatchedExpenseCount: 0,
      allocations: [{ occurrence: 0, reportSequence: 2, amountCents: 52500, supportOppose: "support" }],
    });
  });
  it("accepts default saved-first operation with genuinely fresh nested financial packets", async () => {
    const transport = fullProtocol(); vi.stubGlobal("fetch", transport.fetch);
    const query = vi.fn().mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({ rows: [] });
    const result = await (await source(query, false)).load(input);
    expect(result.status).toBe("loaded");
    if (result.status !== "loaded") return;
    expect(result.components).toHaveLength(1);
    const lastFinancial = transport.events.lastIndexOf("expense-status");
    expect(transport.events.indexOf("payer-closing-detail")).toBeGreaterThan(lastFinancial);
    expect(transport.events.indexOf("payer-closing-search")).toBeGreaterThan(lastFinancial);
    expect(result.components[0]!.source.after.currentReports).toHaveLength(1);
    // Opening owner exists in saved-first cache after the payer phase. Four
    // actual owner GETs prove both financial phases bypassed that saved GET.
    expect(transport.events.filter(event => event === "expense-owner")).toHaveLength(2);
    expect(transport.fetch.mock.calls.filter(([url]) => url.includes("ComDetail.asp"))).toHaveLength(4);
    expect(transport.events.filter(event => event === "expense-native")).toHaveLength(4);
    expect(transport.events.filter(event => event === "expense-status")).toHaveLength(128);
  });
  it("drops financially valid packets if a same-name account appears before final registry closure", async () => {
    const transport = fullProtocol(true); vi.stubGlobal("fetch", transport.fetch);
    const query = vi.fn().mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({ rows: [] });
    const result = await (await source(query, true)).load(input);
    expect(result).toMatchObject({ status: "loaded", components: [] });
    expect(result.diagnostics.join()).toContain("changed all-status payer query");
    expect(transport.events).toContain("expense-native");
    expect(transport.events).toContain("payer-closing-search");
  });
});
