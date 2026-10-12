import { describe, expect, it, vi } from "vitest";
import { utils, write } from "xlsx";
import { createOregonVerifiedSourceClient, type OregonVerifiedRawCapture } from "../../../src/pipeline/oregonFinance/oregonVerifiedSourceClient.js";
import { loadOregonVerifiedFinanceSource as load } from "../../../src/pipeline/oregonFinance/oregonVerifiedFinanceSourceLoader.js";
import { OREGON_VERIFIED_TRANSACTION_HEADERS as HEADERS, hashOregonVerifiedBytes } from "../../../src/pipeline/oregonFinance/oregonVerifiedSourceDecoders.js";
import { validateOregonVerifiedPacProvenance, type OregonPacRawEvidence } from "../../../src/pipeline/oregonFinance/oregonVerifiedPacSource.js";
import { validateOregonVerifiedOutsideEvidence } from "../../../src/pipeline/oregonFinance/oregonVerifiedOutsideSource.js";

const ROOT = "https://secure.sos.state.or.us/orestar/";
const candidateContext = {
  candidateId: "c04b0788-71ae-44fb-9ecd-37b895ef62a2", electionId: "1fe8de34-d0be-4af9-8bd9-faffc87d407b",
  committeeId: "16508", candidateName: "Paul Evans", electionYear: 2026, electionType: "General" as const,
  officeName: "State Representative", district: "20",
};
type Row = Record<string, string | number | null>;
const escape = (s: unknown) => String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;");
const field = (name: string, value: string) => `<tr><td class="label">${name}</td><td>:</td><td>${value}</td></tr>`;
const name = (id: string) => ({ "16508": "Friends of Paul Evans", "169": "Housing PAC", "23238": "Evergreen PAC", "20272": "Other Candidate", "20000": "Example Party" }[id] ?? "Unknown");
function cash(id: string, donorId: string | null, donor: string, amount: number, type = "Political Committee"): Row {
  return Object.assign(Object.fromEntries(HEADERS.map(h => [h, null])), {
    "Tran Id": id, "Original Id": id, "Tran Date": "06/01/2026", "Tran Status": "Original",
    Filer: name("16508"), "Filer Id": "16508", "Contributor/Payee": donor,
    "Contributor/Payee Committee ID": donorId, "Book Type": type, "Sub Type": "Cash Contribution", Amount: amount,
    "Addr Line1": "10 Test St", City: "Salem", State: "OR", Zip: "97301", Country: "United States",
  });
}
function expense(id: string, payerId: string, amount: number): Row {
  return { ...cash(id, null, "Vendor", amount, "Business Entity"), Filer: name(payerId), "Filer Id": payerId,
    "Sub Type": "Cash Expenditure", "Tran Date": "10/07/2026" };
}
function workbook(rows: Row[]): Uint8Array {
  const wb = utils.book_new();
  utils.book_append_sheet(wb, utils.aoa_to_sheet([[...HEADERS], ...rows.map(row => HEADERS.map(h => row[h] ?? null))]), "Transactions");
  return new Uint8Array(write(wb, { bookType: "xlsx", type: "buffer" }));
}
function native(rows: Row[], committeeId: string, internal = false): string {
  const criteria = "Tran Start Date = 01/01/2025, Tran End Date = 12/31/2026" + (committeeId ? ", Filer/Committee ID = " + committeeId : "");
  const header = ["Tran ID", "Tran Date", "Status", "Filer/Committee", "Contributor/Payee", "Sub Type", "Amount"].map(h => `<th>${h}</th>`).join("");
  const content = rows.map(row => `<tr><td><a href="gotoPublicTransactionDetail.do?tranRsn=${row["Tran Id"]}">${row["Tran Id"]}</a></td>
    <td>${row["Tran Date"]}</td><td>${row["Tran Status"]}</td><td><a href="${internal ? "displayFiler.do?filerRsn=53853" : "sooDetail.do?cneCommitteeId=" + row["Filer Id"]}">${row.Filer}</a></td>
    <td>${escape(row["Contributor/Payee"])}</td><td>${row["Sub Type"]}</td><td>$${Number(row.Amount).toFixed(2)}</td></tr>`).join("");
  return `Search Criteria : ${criteria} Results : ${rows.length} records found for the above search criteria
    <table><tr>${header}</tr>${content}</table>${rows.length ? '<a href="XcelCNESearch">Export</a>' : 'No data found matching your search criteria'}`;
}
function soo(id: string): string {
  const type = id === "16508" || id === "20272" ? "Candidate Committee" : id === "20000" ? "Political Party Committee" : "Political Action Committee";
  return `<h1>Statement of Organization for ${type}</h1><!-- ######## Committee Information (b) --><table>
    ${field("Name", name(id))}${field("ID", id)}</table><!-- ######## Committee Information (e) -->
    ${id === "16508" ? `<!-- ######## Candidate Information (b) --><table>${field("Name", "Paul Evans")}${field("Election/Office", "2026 General Election<br>State Representative, 20th District")}</table>` : ""}`;
}
function financialDetail(row: Row, mechanisms = ""): string {
  return `<div id="header2">${row.Filer} (${row["Filer Id"]})</div><h5>Transaction Information (${row["Tran Status"]})</h5><table>${[
    ["Transaction ID", row["Tran Id"]], ["Transaction Date", row["Tran Date"]], ["Transaction Type", row["Sub Type"] === "Cash Contribution" ? "Contribution" : "Expenditure"],
    ["Transaction Sub Type", row["Sub Type"]], ["Amount", "$" + Number(row.Amount).toFixed(2)], ["Process Status", row["Sub Type"] === "Cash Contribution" ? "Complete" : "Filed"],
    ["Address Book Type", row["Book Type"]], ["Name", escape(row["Contributor/Payee"])], ["Address", "10 Test St<br>Salem, OR 97301"],
    ["Associations", ""], ["In-Kind/Independent Expenditures", mechanisms],
  ].map(([k, v]) => field(String(k), String(v))).join("")}</table>`;
}
function history(row: Row): string {
  return `<input name="tranRsn" value="${row["Tran Id"]}">Only versions of this transaction that are public record will display.
    <table><tr><td><a href="transactionHistPubDetail.do?tranRsn=${row["Tran Id"]}">${row["Tran Id"]}</a></td><td>Original</td><td>${row["Tran Date"]}</td>
    <td>10/07/2026 07:00 PM</td><td>${row["Sub Type"]}</td><td>${row["Contributor/Payee"]}</td><td>Filer</td><td>$${Number(row.Amount).toFixed(2)}</td></tr></table>`;
}
function directory(duplicate = false): string {
  const context = (id: string, reference: string) => `<tr><td><input name="committeeName" value="Evans, Paul&lt;BR /&gt;Friends of Paul Evans"><input name="committeeId" value="${id}"><input name="sooRsn" value="${reference}">
    <a href="sooDetail.do?sooRsn=${reference}">Evans, Paul<br>Friends of Paul Evans</a></td><td>${id}</td><td>State Representative, 20th District<br>Democrat</td><td>History</td></tr>`;
  return `Search Criteria : Election Year=2026, Type of Commitee=Candidate Committee (All), Discontinued, Approved, Pending Approval, Pending Insufficient, Pending Resolved, Rejected Filings
    Results : ${duplicate ? 2 : 1} found for the above search criteria<table id="committeeSearchResults">${context("16508", "107100")}${duplicate ? context("25000", "107101") : ""}</table>`;
}
type ProtocolOptions = {
  emptyCash?: boolean; emptyIe?: boolean; nonemptyOd?: boolean; internal?: boolean; secondPayer?: boolean;
  duplicateContext?: boolean; missingDonorId?: boolean; changeCash?: boolean; giftId?: string; maxRequests?: number;
  edit?: (key: string, count: number, body: string) => string | Response;
};
function protocol(options: ProtocolOptions = {}) {
  const rows = [cash(options.giftId ?? "5853252", options.missingDonorId ? null : "169", "Housing PAC", 500), cash("5601330", "20272", "Other Candidate", 50), cash("5573110", "20000", "Example Party", 25)];
  const individual = cash("5770977", null, "Example Individual", 150, "Individual");
  Object.assign(individual, { "Tran Status": "Amended", "Original Id": "5768320" });
  rows.push(individual);
  const ie = [expense("5868897", "23238", 2500), expense("5874824", "23238", 1380)];
  if (options.secondPayer) ie.push(expense("5999999", "169", 100));
  const allRows = [...rows, ...ie];
  const mechanisms: Record<string, string> = {
    "5868897": "Independent Expenditure in Opposition - Paul Evans - $2,500.00",
    "5874824": "Independent Expenditure in Support - Christine Drazan - $1,380.00<br>In-Kind Expenditure - Other Candidate (20272) - $1,380.00",
    "5999999": "Independent Expenditure in Support - Paul Evans - $100.00",
  };
  const counts = new Map<string, number>(), calls: string[] = [], captures: OregonVerifiedRawCapture[] = [];
  let exported: Row[] = [];
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    const u = new URL(url), route = u.pathname.split(";")[0].split("/").at(-1)!;
    const body = new URLSearchParams(typeof init.body === "string" ? init.body : "");
    let key = route, response: string | Uint8Array | Response;
    if (route === "gotoPublicTransactionSearch.do") response = '<form name="cneSearchForm" action="gotoPublicTransactionSearchResults.do"><input name="OWASP_CSRFTOKEN" value="MOCKTOKEN"></form>';
    else if (route === "GotoSearchByElection.do") response = '<form name="CommitteeSearchDynaFormSecond" action="CommitteeSearchSecondPage.do"><input name="OWASP_CSRFTOKEN" value="MOCKTOKEN"></form>';
    else if (route === "gotoPublicTransactionSearchResults.do") {
      const type = body.get("cneSearchTranType")!, committee = body.get("cneSearchFilerCommitteeId") ?? "";
      key = `ledger:${type}:${committee}`;
      const round = (counts.get(key) ?? 0) + 1;
      exported = type === "C" ? options.emptyCash ? [] : rows.map(r => ({ ...r }))
        : type === "OD" ? options.nonemptyOd ? [cash("5539315", null, "Unknown Refunder", 20, "Individual")] : []
        : options.emptyIe ? [] : ie.filter(r => !committee || r["Filer Id"] === committee);
      if (type === "C" && options.changeCash && round === 2) exported[0]["Contributor/Payee"] = "Same Money Replacement";
      response = native(exported, committee, options.internal && type === "E");
    } else if (route === "XcelCNESearch") response = workbook(exported);
    else if (route === "CommitteeSearchSecondPage.do") response = directory(options.duplicateContext);
    else if (route === "sooDetail.do") {
      const committee = u.searchParams.get("cneCommitteeId") ?? "16508";
      key = `soo:${u.searchParams.get("sooRsn") ? "qualified" : committee}`;
      response = soo(committee);
    } else {
      const id = u.searchParams.get("tranRsn")!, row = allRows.find(r => r["Tran Id"] === id);
      if (!row) throw new Error("Missing mock financial packet");
      key = `${route}:${id}`;
      response = route === "ceTransactionHistory.do" ? history(row) : financialDetail(row, mechanisms[id]);
    }
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count); calls.push(key);
    if (typeof response === "string" && options.edit) response = options.edit(key, count, response);
    return response instanceof Response ? response : new Response(response, { status: 200 });
  });
  const client = createOregonVerifiedSourceClient({ fetchFn, maxRequests: options.maxRequests, onRawResponse: async capture => {
    captures.push(capture);
    // Distinct source-capture boundaries in this synthetic protocol, never copied opening packets.
    await new Promise(resolve => setTimeout(resolve, 2));
  } });
  return { client, calls, captures, rows, ie };
}
function saved(path: string, body: string): OregonPacRawEvidence {
  const bytes = new TextEncoder().encode(body);
  return { bytes, request: { url: ROOT + path, method: "GET", requestFields: {}, startedAt: "2026-10-10T18:00:00.000Z", endedAt: "2026-10-10T18:00:01.000Z", status: 200, byteCount: bytes.length, sha256: hashOregonVerifiedBytes(bytes) } };
}

describe("real Oregon pure verifiers composed with bounded synthetic official transport", () => {
  it("pairs verified positive PAC and allocated opposition, retains full sibling identities and unrelated Individual amendment", async () => {
    const p = protocol({ internal: true });
    const result = await load({ candidateContext, client: p.client });
    expect(result.pac?.donors, result.diagnostics.join(" ")).toEqual([expect.objectContaining({ committeeId: "169", amount: 500, contributionCount: 1 })]);
    expect(validateOregonVerifiedPacProvenance({ provenance: result.pac?.provenance, donors: result.pac?.donors, expectedContext: candidateContext })).toBe(true);
    expect(result.positiveOutsideEvidence).toHaveLength(1);
    const outside = result.positiveOutsideEvidence![0];
    expect(validateOregonVerifiedOutsideEvidence(outside, candidateContext)).toBe(true);
    expect(outside).toMatchObject({ payer: { committeeId: "23238" }, opposeCents: 250000, supportCents: 0 });
    expect(outside.transactions).toHaveLength(2);
    expect(outside.allocations).toHaveLength(1);
    expect(p.calls.filter(k => k === "gotoPublicTransactionDetail.do:5770977")).toHaveLength(0);
    expect(p.calls.filter(k => k === "gotoPublicTransactionDetail.do:5601330")).toHaveLength(2);
    expect(p.calls.filter(k => k === "soo:20000")).toHaveLength(2);
    expect(p.calls.filter(k => k === "ceTransactionHistory.do:5874824")).toHaveLength(2);
  });
  it("preserves the entire PAC component on any nonempty OD while positive outside remains usable", async () => {
    const p = protocol({ nonemptyOd: true });
    const result = await load({ candidateContext, client: p.client });
    expect(result.pac).toBeUndefined();
    expect(result.positiveOutsideEvidence).toHaveLength(1);
    expect(result.diagnostics.join(" ")).toMatch(/nonempty current Other Disbursements/);
    expect(p.calls.filter(k => k === "gotoPublicTransactionDetail.do:5853252")).toHaveLength(0);
  });
  it.each(["missing donor", "closing detail", "changing donor SOO", "changed cash identity"])("preserves PAC without blocking IE: %s", async reason => {
    const p = protocol({ missingDonorId: reason === "missing donor", changeCash: reason === "changed cash identity", edit: (key, count, body) => {
      if (reason === "closing detail" && key === "gotoPublicTransactionDetail.do:5853252" && count === 2) return new Response("Unavailable", { status: 503 });
      if (reason === "changing donor SOO" && key === "soo:169" && count === 2) return body.replace("Housing PAC", "Different PAC");
      return body;
    } });
    const result = await load({ candidateContext, client: p.client });
    expect(result.pac).toBeUndefined();
    expect(result.positiveOutsideEvidence).toHaveLength(1);
    expect(result.diagnostics.some(d => /PAC/.test(d))).toBe(true);
  });
  it("uses byte-exact cached openings with original timestamps and performs genuine fresh closing GETs", async () => {
    const p = protocol({ emptyIe: true });
    const opening = saved("gotoPublicTransactionDetail.do?tranRsn=5853252", financialDetail(p.rows[0]));
    const originalRequest = { ...opening.request };
    const read = vi.fn(async (url: string) => url === opening.request.url ? opening : undefined);
    const result = await load({ candidateContext, client: p.client, readSavedPublicGet: read });
    expect(result.pac?.donors[0].amount).toBe(500);
    expect(result.pac?.provenance.sourceHashes).toContain(opening.request.sha256);
    expect(opening.request).toEqual(originalRequest);
    expect(p.calls.filter(k => k === "gotoPublicTransactionDetail.do:5853252")).toHaveLength(1);
    expect(p.captures.some(c => c.kind === "public_response" && c.evidence.request.url === opening.request.url && c.evidence.request.startedAt !== opening.request.startedAt)).toBe(true);
  });
  it("refresh bypasses every saved opening while closing source is always acquired", async () => {
    const p = protocol({ emptyIe: true }), read = vi.fn(async () => undefined);
    const result = await load({ candidateContext, client: p.client, refresh: true, readSavedPublicGet: read });
    expect(result.pac).toBeDefined();
    expect(read).not.toHaveBeenCalled();
    expect(p.calls.filter(k => k === "gotoPublicTransactionDetail.do:5853252")).toHaveLength(2);
  });
  it("corrupt or wrong-source cached opening falls back fresh with an explicit diagnostic", async () => {
    const p = protocol({ emptyIe: true });
    const bad = saved("gotoPublicTransactionDetail.do?tranRsn=5853252", financialDetail(p.rows[0]));
    bad.request.sha256 = "0".repeat(64);
    const result = await load({ candidateContext, client: p.client, readSavedPublicGet: async url => url === bad.request.url ? bad : undefined });
    expect(result.pac).toBeDefined();
    expect(result.diagnostics.join(" ")).toMatch(/Saved opening.*rejected.*fresh/);
    expect(p.calls.filter(k => k === "gotoPublicTransactionDetail.do:5853252")).toHaveLength(2);
  });
  it("cached opening cannot hide a financial change in its mandatory fresh closing", async () => {
    const p = protocol({ emptyIe: true, edit: (key, _count, body) => key === "gotoPublicTransactionDetail.do:5853252" ? body.replace("10 Test St", "11 Test St") : body });
    const opening = saved("gotoPublicTransactionDetail.do?tranRsn=5853252", financialDetail(p.rows[0]));
    const result = await load({ candidateContext, client: p.client, readSavedPublicGet: async url => url === opening.request.url ? opening : undefined });
    expect(result.pac).toBeUndefined();
    expect(result.diagnostics.join(" ")).toMatch(/detail|identity/);
  });
  it("no current source witness cannot authorize money zero or default components", async () => {
    const p = protocol({ emptyCash: true, emptyIe: true });
    const result = await load({ candidateContext, client: p.client });
    expect(result.pac).toBeUndefined();
    expect(result.positiveOutsideEvidence).toBeUndefined();
    expect(result.diagnostics.join(" ")).toMatch(/zero authority/);
  });
  it("global detail failure preserves outside while independently verified PAC remains usable", async () => {
    const p = protocol({ edit: (key, count, body) => key === "gotoPublicTransactionDetail.do:5868897" && count === 1 ? new Response("Unavailable", { status: 503 }) : body });
    const result = await load({ candidateContext, client: p.client });
    expect(result.pac).toBeDefined();
    expect(result.positiveOutsideEvidence).toBeUndefined();
    expect(result.diagnostics.join(" ")).toMatch(/Outside discovery\/context failure/);
  });
  it("exact same full-person directory ambiguity preserves outside without guessing a committee", async () => {
    const p = protocol({ duplicateContext: true });
    const result = await load({ candidateContext, client: p.client });
    expect(result.pac).toBeDefined();
    expect(result.positiveOutsideEvidence).toBeUndefined();
    expect(result.diagnostics.join(" ")).toMatch(/ambiguous exact full candidate/);
  });
  it("payer-specific missing history omits that payer while retaining another whole positive payer proof", async () => {
    const p = protocol({ secondPayer: true, edit: (key, count, body) => key === "ceTransactionHistory.do:5868897" && count === 2 ? new Response("Unavailable", { status: 503 }) : body });
    const result = await load({ candidateContext, client: p.client });
    expect(result.pac).toBeDefined();
    expect(result.positiveOutsideEvidence?.map(e => e.payer.committeeId)).toEqual(["169"]);
    expect(result.positiveOutsideEvidence?.[0].supportCents).toBe(10000);
    expect(result.diagnostics.join(" ")).toMatch(/Outside payer 23238 omitted/);
  });
  it("unrelated candidate name substring never discovers a target payer", async () => {
    const p = protocol({ edit: (key, _count, body) => key.startsWith("gotoPublicTransactionDetail.do:5868897") ? body.replace("Paul Evans", "Paul Evans Jr") : body });
    const result = await load({ candidateContext, client: p.client });
    expect(result.pac).toBeDefined();
    expect(result.positiveOutsideEvidence).toBeUndefined();
  });
  it("prior valid payer omitted from discovery is acquired and remains unknown if its current ledger disappeared", async () => {
    const first = protocol();
    const prior = (await load({ candidateContext, client: first.client })).positiveOutsideEvidence![0];
    const second = protocol({ emptyIe: true });
    const result = await load({ candidateContext, client: second.client, priorOutsideProvenanceByPayer: { "23238": prior } });
    expect(second.calls).toContain("ledger:E:23238");
    expect(result.positiveOutsideEvidence).toBeUndefined();
    expect(result.diagnostics.join(" ")).toMatch(/Outside payer 23238 omitted.*zero authority/);
  });
  it("invalid prior outside authority is diagnosed and does not fabricate a payer or deletion", async () => {
    const p = protocol({ emptyIe: true });
    const result = await load({ candidateContext, client: p.client, priorOutsideProvenanceByPayer: { "23238": { payer: { committeeId: "23238" } } } });
    expect(result.positiveOutsideEvidence).toBeUndefined();
    expect(result.diagnostics.join(" ")).toMatch(/invalid prior authority.*never means deletion/);
    expect(p.calls).not.toContain("ledger:E:23238");
  });
  it("prior accepted PAC gift disappearing preserves PAC while current outside proof remains independent", async () => {
    const original = await load({ candidateContext, client: protocol({ emptyIe: true }).client });
    const p = protocol({ giftId: "5853254" });
    const result = await load({ candidateContext, client: p.client, priorPacProvenance: original.pac!.provenance });
    expect(result.pac).toBeUndefined();
    expect(result.positiveOutsideEvidence).toHaveLength(1);
    expect(result.diagnostics.join(" ")).toMatch(/prior accepted gift disappeared/);
  });
  it("malformed prior PAC evidence cannot authorize replacement of current stored donors", async () => {
    const result = await load({ candidateContext, client: protocol().client, priorPacProvenance: { version: 1 } });
    expect(result.pac).toBeUndefined();
    expect(result.positiveOutsideEvidence).toHaveLength(1);
    expect(result.diagnostics.join(" ")).toMatch(/invalid prior PAC authority/);
  });
  it("source request budget exhaustion cannot manufacture either closing component", async () => {
    const result = await load({ candidateContext, client: protocol({ maxRequests: 8 }).client });
    expect(result.pac).toBeUndefined();
    expect(result.positiveOutsideEvidence).toBeUndefined();
    expect(result.diagnostics.join(" ")).toMatch(/budget exhausted/);
  });
  it("source-receiver seat mismatch preserves both components without parsing a display alias", async () => {
    const result = await load({ candidateContext: { ...candidateContext, district: "21" }, client: protocol().client });
    expect(result.pac).toBeUndefined();
    expect(result.positiveOutsideEvidence).toBeUndefined();
    expect(result.diagnostics.join(" ")).toMatch(/office|seat/);
  });
  it("qualified target closing changes preserve outside while cash remains independently proven", async () => {
    const p = protocol({ edit: (key, count, body) => key === "soo:qualified" && count === 2 ? body.replace("20th District", "21st District") : body });
    const result = await load({ candidateContext, client: p.client });
    expect(result.pac).toBeDefined();
    expect(result.positiveOutsideEvidence).toBeUndefined();
    expect(result.diagnostics.join(" ")).toMatch(/Outside payer 23238.*office/);
  });
  it("full local district display is rejected before source acquisition; exact numeric seat is required", async () => {
    const p = protocol();
    const result = await load({ candidateContext: { ...candidateContext, district: "State House District 20 (2024); Oregon" }, client: p.client });
    expect(result.pac).toBeUndefined();
    expect(result.positiveOutsideEvidence).toBeUndefined();
    expect(p.calls).toEqual([]);
  });
});
