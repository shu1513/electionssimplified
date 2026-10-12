import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  FLORIDA_CANDIDATE_ACCOUNT_HEADERS,
  createFloridaCandidateAccountSource,
  decodeFloridaCandidateAccountTsv,
  decodeFloridaNativeCandidateAccountList,
  reconcileFloridaCandidateAccountCatalog,
  resolveFloridaCandidateAccount,
  type FloridaCandidateAccountTarget,
} from "../../../src/pipeline/floridaFinance/floridaCandidateAccountSource.js";
import type { FloridaFinanceRawRequest } from "../../../src/pipeline/floridaFinance/floridaFinanceRawSourceClient.js";
import type { FloridaProcessedRawEvidence } from "../../../src/pipeline/floridaFinance/floridaProcessedFinanceSource.js";

const ELECTION = "20261103-GEN";
function fields(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ...Object.fromEntries(FLORIDA_CANDIDATE_ACCOUNT_HEADERS.map(key => [key, ""])),
    AcctNum: "88807", VoterID: "123456789", ElectionID: ELECTION, OfficeCode: "STR",
    OfficeDesc: "State Representative", Juris1num: "080", StatusCode: "QUA", StatusDesc: "Qualified",
    PartyCode: "REP", PartyDesc: "Republican", NameLast: "Botana", NameFirst: "Adam",
    SuppressAddress: "N", ...overrides,
  };
}
function tsv(rows = [fields()]): string {
  return FLORIDA_CANDIDATE_ACCOUNT_HEADERS.join("\t") + "\r\n" + rows.map(row =>
    FLORIDA_CANDIDATE_ACCOUNT_HEADERS.map(key => row[key]).join("\t")).join("\r\n") + "\r\n";
}
function nativeRow(input: {
  id?: string; first?: string; last?: string; middle?: string; district?: string;
  status?: string; mate?: { id: string; name: string };
} = {}): string {
  const id = input.id ?? "88807";
  const link = (value: string) => `<a href="CanDetail.asp?account=${id}">${value}</a>`;
  return `<tr>${input.district === undefined ? "" : `<td><b>${input.district || "&nbsp;"}</b></td>`}
    <td>${link("")}${link(input.last ?? "Botana")}${link(",")}${link(input.first ?? "Adam")}${link(input.middle ?? "&nbsp;")}
    (REP)${input.mate ? `&nbsp;/&nbsp;<a href="CanDetail.asp?account=${input.mate.id}">${input.mate.name}</a>` : ""}</td>
    <td>${input.status ?? "Qualified"}</td><td>&nbsp;</td><td>&nbsp;</td></tr>`;
}
function html(rows = nativeRow({ district: "80" }), office = "State Representative", district = true): string {
  return `<html><body><h2>Candidate Listing for 2026 General Election</h2>
    <form name="CandSelection" action="canlist.asp" method="post">
    <input type="hidden" name="elecid" value="${ELECTION}"><input name="CanName" value="">
    ${["OfficeGroup", "StatusCode", "OfficeCode", "CountyCode"].map(name =>
      `<select name="${name}"><option value="ALL" selected>ALL</option><option value="ALX">Filtered</option></select>`).join("")}
    </form><br><center><font size=+1><b>${office}</b></font>
    <table class="results"><tr>${district ? "<td><b>District</b></td>" : ""}<th>Candidate</th><th>Status</th><th>Primary</th><th>General</th></tr>
    ${rows}</table></body></html>`;
}
const target: FloridaCandidateAccountTarget = {
  candidateId: "82937afb-9562-422f-8a79-aacd09e63765", candidateName: "ADAM BOTANA",
  electionYear: 2026, electionType: "general", officeName: "State Lower Chamber Legislator", district: "80",
};
function resolve(rows = [fields()], changes: Partial<FloridaCandidateAccountTarget> = {}) {
  return resolveFloridaCandidateAccount({ rows: decodeFloridaCandidateAccountTsv(tsv(rows), ELECTION), target: { ...target, ...changes } });
}
function packet(request: FloridaFinanceRawRequest, body: string): FloridaProcessedRawEvidence {
  const bytesRaw = new TextEncoder().encode(body);
  return {
    bytesRaw, sha256: createHash("sha256").update(bytesRaw).digest("hex"),
    ...request, status: 200, contentType: request.url.endsWith("extractCanList.asp")
      ? "application/tab-separated-values" : "text/html",
    startedAt: "2026-10-11T20:54:56.000Z", completedAt: "2026-10-11T20:54:57.000Z",
  };
}

describe("complete candidate-account decoders", () => {
  it("retains all 26 fields, middle-name content and every unsupported/status row", () => {
    const rows = decodeFloridaCandidateAccountTsv(tsv([fields({ NameMiddle: '"Louie"', Addr2: "Suite 1" }),
      fields({ AcctNum: "89264", OfficeCode: "CTJ", OfficeDesc: "Circuit Judge", Juris1num: "013",
        Juris2num: "007", StatusCode: "WIT", StatusDesc: "Withdrew" })]), ELECTION);
    expect(rows[0]!.candidateName).toBe('Adam "Louie" Botana');
    expect(rows[0]!.rawFields.Addr2).toBe("Suite 1");
    expect(rows[1]).toMatchObject({ occurrence: 1, officeCode: "CTJ", jurisdiction2: "007", statusCode: "WIT" });
  });
  it.each([
    ["header", tsv().replace("AcctNum", "Account")],
    ["width", tsv().replace("88807\t", "88807\textra\t")],
    ["blank row", tsv() + "\r\n"],
    ["header only", FLORIDA_CANDIDATE_ACCOUNT_HEADERS.join("\t") + "\n"],
    ["mixed election", tsv([fields({ ElectionID: "20260324-S01" })])],
    ["account", tsv([fields({ AcctNum: "0" })])],
    ["suppression", tsv([fields({ SuppressAddress: "" })])],
    ["seat", tsv([fields({ Juris1num: "80" })])],
    ["missing full name", tsv([fields({ NameFirst: "" })])],
    ["duplicate ID", tsv([fields(), fields()])],
  ])("rejects %s", (_reason, body) => {
    expect(() => decodeFloridaCandidateAccountTsv(body, ELECTION)).toThrow();
  });
  it("inherits blank district cells and retains primary/general results", () => {
    const rows = decodeFloridaNativeCandidateAccountList(html(nativeRow({ district: "80" }) +
      nativeRow({ id: "90000", first: "Jane", last: "Doe", district: "" })), ELECTION);
    expect(rows.map(row => row.jurisdiction)).toEqual(["80", "80"]);
    expect(rows[1]).toMatchObject({ account: "90000", surnameFirstName: "Doe, Jane" });
  });
  it("retains Governor running mate as separate context, never a primary account", () => {
    const rows = decodeFloridaNativeCandidateAccountList(html(nativeRow({ id: "89243", first: "David", last: "Jolly",
      mate: { id: "91951", name: "Graham, Gwen&nbsp;" } }), "Governor", false), ELECTION);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ account: "89243", surnameFirstName: "Jolly, David",
      runningMates: [{ account: "91951", surnameFirstName: "Graham, Gwen" }] });
  });
  it.each([
    ["default ALX status", html().replace('value="ALL" selected>ALL</option><option value="ALX"', 'value="ALL">ALL</option><option selected value="ALX"')],
    ["nonblank name filter", html().replace('name="CanName" value=""', 'name="CanName" value="Botana"')],
    ["wrong heading", html().replace("2026 General Election", "2026 Special Election")],
    ["truncated", html().replace("</html>", "")],
    ["missing district", html(nativeRow({ district: "" }))],
    ["duplicate primary", html(nativeRow({ district: "80" }) + nativeRow({ district: "" }))],
    ["running mate outside Governor", html(nativeRow({ district: "80", mate: { id: "91951", name: "Graham, Gwen" } }))],
    ["unknown link", html().replace(/CanDetail.asp/g, "ComDetail.asp")],
    ["incomplete cell", html().replace("</td>", "")],
  ])("rejects native %s", (_reason, body) => {
    expect(() => decodeFloridaNativeCandidateAccountList(body, ELECTION)).toThrow();
  });
  it("requires exact full native/export identity, not onlyID and amount", () => {
    const rows = decodeFloridaCandidateAccountTsv(tsv(), ELECTION);
    const native = decodeFloridaNativeCandidateAccountList(html(), ELECTION);
    expect(() => reconcileFloridaCandidateAccountCatalog(rows, native)).not.toThrow();
    for (const change of [{ surnameFirstName: "Botana, Adam Paul" }, { jurisdiction: "81" },
      { officeName: "State Senator" }, { statusName: "Withdrew" }, { account: "88808" }]) {
      expect(() => reconcileFloridaCandidateAccountCatalog(rows, [{ ...native[0]!, ...change }])).toThrow();
    }
  });
});

describe("exact automatic numeric account resolution", () => {
  it("resolves witnessed Botana account with exact source office and numeric seat", () => {
    expect(resolve()).toMatchObject({ status: "matched", account: "88807", officeName: "State Representative", district: "80" });
  });
  it.each([
    { candidateName: "ADAM PAUL BOTANA" }, { candidateName: "A. BOTANA" }, { district: "81" },
    { officeName: "State Senator" }, { electionYear: 2024 }, { electionType: "primary" },
    { electionType: "special" }, { district: null },
  ])("preserves missing or contradictory local identity: %j", change => {
    expect(resolve(undefined, change)).toMatchObject({ status: "unmatched" });
  });
  it("does not delete source middle/suffix names", () => {
    expect(resolve([fields({ NameMiddle: "Paul" })])).toMatchObject({ status: "unmatched" });
    expect(resolve([fields({ NameLast: "Botana Jr." })])).toMatchObject({ status: "unmatched" });
  });
  it("evaluates uniqueness before qualification or status filtering", () => {
    expect(resolve([fields(), fields({ AcctNum: "90000", StatusCode: "WIT", StatusDesc: "Withdrew" })]))
      .toMatchObject({ status: "ambiguous" });
    expect(resolve([fields({ StatusCode: "WIT", StatusDesc: "Withdrew" })])).toMatchObject({ status: "unmatched" });
    expect(resolve([fields({ StatusCode: "UNO", StatusDesc: "Unopposed" })])).toMatchObject({ status: "matched" });
  });
  it("requires the observed source office description as well as its code", () => {
    expect(resolve([fields({ OfficeDesc: "State Senator" })])).toMatchObject({ status: "unmatched" });
  });
  it("does not resolve a Governor running mate as primary candidate", () => {
    expect(resolve([fields({ AcctNum: "89243", NameFirst: "David", NameLast: "Jolly", OfficeCode: "GOV",
      OfficeDesc: "Governor", Juris1num: "" })], { candidateName: "GWEN GRAHAM", officeName: "Governor", district: null }))
      .toMatchObject({ status: "unmatched" });
  });
});

describe("request-bound injected official catalog acquisition", () => {
  it("uses exact observed all-status native and State Candidate export POSTs", async () => {
    const requestRaw = vi.fn(async (request: FloridaFinanceRawRequest) => packet(request,
      request.url.endsWith("extractCanList.asp") ? tsv() : html()));
    const result = await createFloridaCandidateAccountSource({ requestRaw }).fetchCatalog({ electionId: ELECTION, savedFirst: true });
    expect(result.rows).toHaveLength(1);
    expect(requestRaw.mock.calls.map(call => call[0].financeFields)).toEqual([
      { elecid: ELECTION, OfficeGroup: "ALL", StatusCode: "ALL", OfficeCode: "ALL", CountyCode: "ALL",
        CanName: "", OrderBy: "NAM", FormsButton1: "RUN QUERY" },
      { elecID: ELECTION, office: "All", status: "All", cantype: "STA", FormSubmit: "Download Candidate List" },
    ]);
    expect(result.sources[0]!.startedAt).toBe("2026-10-11T20:54:56.000Z");
  });
  it.each([
    { sha256: "0".repeat(64) }, { status: 403 }, { url: "https://example.org/candidates/canlist.asp" },
    { method: "GET" as const }, { financeFields: { elecid: ELECTION, StatusCode: "ALX" } },
    { completedAt: "2026-10-10T00:00:00Z" }, { contentType: "text/plain" },
  ])("rejects source packet mismatch %j", async change => {
    const requestRaw = async (request: FloridaFinanceRawRequest) => ({ ...packet(request, html()), ...change });
    await expect(createFloridaCandidateAccountSource({ requestRaw }).fetchCatalog({ electionId: ELECTION })).rejects.toThrow();
  });
  it("rejects different native/export candidate rather than accepting a standalone TSV", async () => {
    const requestRaw = async (request: FloridaFinanceRawRequest) => packet(request,
      request.url.endsWith("extractCanList.asp") ? tsv([fields({ NameMiddle: "Paul" })]) : html());
    await expect(createFloridaCandidateAccountSource({ requestRaw }).fetchCatalog({ electionId: ELECTION })).rejects.toThrow("identity mismatch");
  });
  it("rejects unsupported Special/invalid General date before acquisition", async () => {
    const requestRaw = vi.fn();
    for (const electionId of ["20260324-S01", "20260230-GEN"]) {
      await expect(createFloridaCandidateAccountSource({ requestRaw }).fetchCatalog({ electionId })).rejects.toThrow();
    }
    expect(requestRaw).not.toHaveBeenCalled();
  });
});
