import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createFloridaOutsidePayerSource, selectFloridaOutsidePayerLeads, verifyFloridaOutsidePayerIdentity } from "../../../src/pipeline/floridaFinance/floridaOutsidePayerSource.js";
import { decodeFloridaExpenditureDiscoveryTsv, FLORIDA_EXPENDITURE_DISCOVERY_HEADERS } from "../../../src/pipeline/floridaFinance/floridaIndependentExpenditureDiscovery.js";
import type { FloridaLocalFinanceContext } from "../../../src/pipeline/floridaFinance/floridaLocalFinanceContext.js";
import type { FloridaCommitteeRegistryRequest } from "../../../src/pipeline/floridaFinance/floridaCommitteeRegistrySource.js";
import type { FloridaProcessedRawEvidence } from "../../../src/pipeline/floridaFinance/floridaProcessedFinanceSource.js";

const local: FloridaLocalFinanceContext = {
  candidateId: "example-candidate", candidateElectionId: "example-race", electionId: "example-election",
  candidateName: "John Example", electionYear: 2026, electionDate: "2026-11-03",
  officeScope: "state_lower", officeCanonicalName: "State Lower Chamber Legislator", district: "87",
  committeeId: "EXAMPLE_SYNTHETIC", genericRecipientName: "Example, John (REP)(STR)",
};
function leads(purpose = "TEXT MESSAGES; PRO-JOHN EXAMPLE, HD-87", type = "IEC", amount = "525.00") {
  const cells = ["Example Committee (PAC)", "03/23/2026", amount, "Expense Vendor", "Vendor address", "Vendor city", purpose, type];
  return decodeFloridaExpenditureDiscoveryTsv(`${FLORIDA_EXPENDITURE_DISCOVERY_HEADERS.join("\t")}\n${cells.join("\t")}\n${cells.join("\t")}\n`);
}
type Row = { id: string; name: string; type: string; status: string };
const current: Row = { id: "90001", name: "Example Committee (Florida)", type: "PAC", status: "Active" };
const descriptions: Record<string, string> = { PAC: "Political Committee", CCE: "Committee of Continuous Existence", IXO: "Independent Expenditures Organization" };
function mock(rows: Row[], change?: (raw: FloridaProcessedRawEvidence, req: FloridaCommitteeRegistryRequest) => void) {
  const calls: { req: FloridaCommitteeRegistryRequest; savedFirst: boolean | undefined }[] = [];
  return { calls, request: async (req: FloridaCommitteeRegistryRequest, options?: { savedFirst?: boolean }) => {
    calls.push({ req: structuredClone(req), savedFirst: options?.savedFirst });
    const body = req.method === "POST"
      ? `<html><body>Search for Committee by Name<input name=ComName value="${req.financeFields!.comName}"><table><tr><td>Committee</td><td>Type</td><td>Status</td></tr>${rows.map(row => `<tr><td><a href="ComDetail.asp?account=${row.id}">${row.name}</a></td><td>${row.type}</td><td>${row.status}</td></tr>`).join("")}</table></body></html>`
      : (() => { const row = rows.find(row => row.id === new URL(req.url).searchParams.get("account"))!;
        return `<html><body>Committee Tracking System<table><tr><td colspan=2><font size=+1><b>${row.name}</b></font></td></tr><tr><td>Type:</td><td>${descriptions[row.type]}</td></tr><tr><td>Status:</td><td>${row.status}</td></tr><tr><td>Address:</td><td>Actual payer address<br>Actual payer city</td></tr><tr><td>Chairperson:</td><td>Full Published Name</td></tr></table><input name=account value="${row.id}"></body></html>`; })();
    const bytesRaw = Buffer.from(body), seconds = calls.length;
    const raw: FloridaProcessedRawEvidence = { bytesRaw, sha256: createHash("sha256").update(bytesRaw).digest("hex"),
      url: req.url, method: req.method, financeFields: req.financeFields, status: 200, contentType: "text/html",
      startedAt: new Date(Date.UTC(2026, 9, 11, 20, 0, seconds)).toISOString(), completedAt: new Date(Date.UTC(2026, 9, 11, 20, 0, seconds, 500)).toISOString() };
    change?.(raw, req);
    return raw;
  } };
}
const label = `${current.name} (${current.type})`;

describe("Florida outside payer discovery leads", () => {
  it("retains duplicate occurrences and Special-date leads without supplying election authority", () => {
    const rows = leads();
    const result = selectFloridaOutsidePayerLeads({ rows, localContext: local });
    expect(result.map(row => row.occurrence)).toEqual([0, 1]);
    expect(result[0].date).toBe("2026-03-23");
    expect(result[0]).not.toBe(rows[0]);
    expect(result[0]).not.toHaveProperty("reportYear");
  });
  it.each([
    "TEXT MESSAGES; PRO-JOHN EXAMPLE, HD-88",
    "TEXT MESSAGES; PRO-JOHN OTHER EXAMPLE, HD-87",
    "TEXT MESSAGES; PRO-JOHN EXAMPLE AND JANE OTHER, HD-87",
    "Independent expenditure supporting candidates",
    "DIGITAL ADVERTISING TO SUPPORT JOHN EXAMPLE OSCEOLA COUNTY SCHOOL BOARD DISTRICT 1",
  ])("ignores unmatched or ineligible target %s", purpose => {
    expect(selectFloridaOutsidePayerLeads({ rows: leads(purpose), localContext: local })).toEqual([]);
  });
  it.each([["MON", "525.00"], ["IEC R", "525.00"], ["IEC", "-525.00"], ["IEC", "0.00"]])("ignores type/sign %s %s", (type, amount) => {
    expect(selectFloridaOutsidePayerLeads({ rows: leads(undefined, type, amount), localContext: local })).toEqual([]);
  });
  it.each([{ district: "087" }, { district: "121" }, { electionDate: "2026-08-18" }, { officeScope: "county_school_board" }, { candidateName: "John Example Jr." }])("preserves actual local context mismatch %#", change => {
    expect(selectFloridaOutsidePayerLeads({ rows: leads(), localContext: { ...local, ...change } })).toEqual([]);
  });
});

describe("Florida exact annotated outside payer source", () => {
  it("replays captured identity and rejects changed or unused packet evidence", async () => {
    const result = await createFloridaOutsidePayerSource(mock([current])).load({ payerLabel: label });
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(await verifyFloridaOutsidePayerIdentity(result)).toEqual(result);
    for (const mode of ["hash", "order", "extra"]) {
      const evidence = structuredClone(result.rawSource);
      if (mode === "hash") evidence[0].sha256 = "a".repeat(64);
      if (mode === "order") evidence.reverse();
      if (mode === "extra") evidence.push(evidence[0]);
      expect(await verifyFloridaOutsidePayerIdentity({ payerLabel: label, rawSource: evidence })).toMatchObject({ status: "preserve" });
    }
  });
  it("acquires all exact-name classes; annotation binds legal-name parentheses and numeric owner", async () => {
    const source = mock([{ ...current, id: "90000", type: "CCE", status: "Closed" }, current]);
    const result = await createFloridaOutsidePayerSource(source).load({ payerLabel: label });
    expect(result).toMatchObject({ status: "resolved", authority: "payer_identity_only", owner: { committeeId: "90001", address: "Actual payer address" } });
    expect(source.calls).toHaveLength(8);
    expect(source.calls.filter(call => call.req.method === "GET")).toHaveLength(4);
    expect(source.calls.filter(call => call.req.phase === "opening").every(call => call.savedFirst)).toBe(true);
    expect(source.calls.filter(call => call.req.phase === "closing").every(call => call.savedFirst === false)).toBe(true);
    if (result.status === "resolved") expect(result.sourceMetadata.every(meta => !Object.hasOwn(meta, "bytesRaw"))).toBe(true);
  });
  it("does not use Active status to choose between same-annotation accounts", async () => {
    const result = await createFloridaOutsidePayerSource(mock([{ ...current, id: "90000", status: "Closed" }, current])).load({ payerLabel: label });
    expect(result).toMatchObject({ status: "preserve", diagnostics: ["full annotated payer account is absent or ambiguous"] });
  });
  it("supports exact IXO annotation independently of PAC scope", async () => {
    const result = await createFloridaOutsidePayerSource(mock([{ ...current, type: "IXO" }])).load({ payerLabel: `${current.name} (IXO)` });
    expect(result).toMatchObject({ status: "resolved", payerType: "IXO" });
  });
  it("refresh bypasses saved openings", async () => {
    const source = mock([current]);
    await createFloridaOutsidePayerSource({ ...source, refresh: true }).load({ payerLabel: label });
    expect(source.calls.every(call => call.savedFirst === false)).toBe(true);
  });
  it.each(["Example Committee (ECO)", "Example Committee PAC", "Example Committee (Florida)", "Example Committee (PAC) extra"])("rejects unsupported/full label %s", async payerLabel => {
    expect(await createFloridaOutsidePayerSource(mock([current])).load({ payerLabel })).toMatchObject({ status: "preserve" });
  });
  it.each(["hash", "filter", "timing", "detail", "query", "status"])("preserves invalid/changed evidence %s", async kind => {
    const source = mock([current], (raw, req) => {
      if (kind === "hash") raw.sha256 = "a".repeat(64);
      if (kind === "filter" && req.method === "POST") raw.financeFields = { ...raw.financeFields, Status: "Active" };
      if (kind === "timing" && req.phase === "closing") raw.startedAt = "2026-01-01T00:00:00Z";
      if (kind === "status") raw.status = 500;
      if (req.phase === "closing" && ((kind === "detail" && req.method === "GET") || (kind === "query" && req.method === "POST"))) {
        raw.bytesRaw = Buffer.from(Buffer.from(raw.bytesRaw).toString().replace(kind === "detail" ? "Full Published Name" : "Active", "Changed"));
        raw.sha256 = createHash("sha256").update(raw.bytesRaw).digest("hex");
      }
    });
    expect(await createFloridaOutsidePayerSource(source).load({ payerLabel: label })).toMatchObject({ status: "preserve" });
  });
});
