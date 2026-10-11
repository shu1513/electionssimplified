import { beforeEach, describe, expect, it, vi } from "vitest";
import { MITN_EXPORT_HEADER as header } from "./mitnXlsxTestFixture.js";
import { michiganMitnExportRowsToLegacyContributionRows } from "../../../src/pipeline/michiganFinance/michiganMitnPublicSearchClient.js";
import { aggregateMichiganDirectContributions } from "../../../src/pipeline/michiganFinance/michiganDirectContributionAggregator.js";
import type { MichiganMitnFiling } from "../../../src/pipeline/michiganFinance/michiganMitnFilingPolicy.js";
const mocks = vi.hoisted(() => ({ manifest: vi.fn() }));
vi.mock("../../../src/pipeline/michiganFinance/michiganMitnFilingPolicy.js", async (load) => ({
  ...await load<object>(), fetchMichiganMitnFilingManifest: mocks.manifest,
}));
import { fetchMichiganMitnCurrentContributionRows, selectMichiganMitnCurrentContributionRows as select } from "../../../src/pipeline/michiganFinance/michiganMitnContributionPolicy.js";

function receipt(id = "a", amount = "100", changes: Record<string, string> = {}): string[] {
  const values: Record<string, string> = {
    "Record Type (1=Parent, 2=Child)": "1", "Receipt ID": id,
    "Filing Status (C=Complete,I=Incomplete)": "C", "Document Type": "Campaign Statements",
    "Document Statement Year": "2026", "Document Statement Type": "July CS",
    "Receiving Committee Name": "ALEX HAWKINS FOR MICHIGAN", "Receiving Committee ID#": "521495",
    "Receiving Committee Type": "Candidate", "Type of Contribution": "Direct",
    "Organization Name/Contributor Last Name": "UAW MICHIGAN VOLUNTARY POLITICAL ACTION COMMITTEE",
    "Date of Contribution": "07/01/2026", "Amount of Contribution": amount, ...changes,
  };
  return header.map((name) => values[name] ?? "");
}
function original(changes: Partial<MichiganMitnFiling> = {}): MichiganMitnFiling {
  return { documentType: "Campaign Statements", statementYear: 2026, documentName: "July CS",
    sequenceNumber: "original", refersToSequenceNumber: "", coverageBegin: "2026-01-01",
    coverageEnd: "2026-07-17", receivedDate: "2026-07-20", status: "Submitted", ...changes };
}
function amended(changes: Partial<MichiganMitnFiling> = {}): MichiganMitnFiling {
  return original({ documentType: "Amended Campaign Statements", sequenceNumber: "amendment",
    refersToSequenceNumber: "original", receivedDate: "2026-08-01", ...changes });
}
const input = (rows: string[][], filings: MichiganMitnFiling[] = [original()]) => ({
  committeeId: "0521495", statementYears: [2026], rawRows: [header, ...rows], filings,
});

describe("Michigan current contribution statements", () => {
  it("deduplicates identical original receipts after selecting their verified period", () => {
    expect(select(input([receipt(), receipt()]))).toEqual([header, receipt()]);
  });
  it("replaces the complete period so deleted PAC receipts do not survive", () => {
    const current = receipt("b", "250", { "Document Type": "Amended Campaign Statements" });
    const result = select(input([receipt("a", "100"), receipt("b", "200"), current], [original(), amended()]));
    expect(result).toEqual([header, current]);
    const aggregate = aggregateMichiganDirectContributions({
      committeeId: "0521495", electionYear: 2026,
      contributionRows: michiganMitnExportRowsToLegacyContributionRows(result),
      committeeRegistryRows: [{ committeeId: "508347", committeeType: "Independent",
        committeeName: "UAW MICHIGAN VOLUNTARY POLITICAL ACTION COMMITTEE", status: "Active" }],
    });
    expect(aggregate.summary.directContributionTotal).toBe(250);
    expect(aggregate.pacDonors).toEqual([expect.objectContaining({ committeeId: "508347", amount: 250, contributionCount: 1 })]);
  });
  it("allows a verified amendment with zero receipts to delete the whole original period", () => {
    expect(select(input([receipt()], [original(), amended()]))).toEqual([header]);
  });
  it("keeps separate original periods when another period is replaced", () => {
    const separate = receipt("c", "500", { "Document Statement Type": "Pre Election CS" });
    expect(select(input([receipt(), separate], [original(), amended(), original({ sequenceNumber: "other", documentName: "Pre Election CS" })]))).toEqual([header, separate]);
  });
  it("accepts multiple original immediate reports sharing the public period name", () => {
    const rows = [receipt("a", "100", { "Document Type": "Immediate Disclosure Reports", "Document Statement Type": "LATE CONTRIBUTION REPORT" }), receipt("b", "200", { "Document Type": "Immediate Disclosure Reports", "Document Statement Type": "LATE CONTRIBUTION REPORT" })];
    const first = original({ documentType: "Immediate Disclosure Reports", documentName: "LATE CONTRIBUTION REPORT" });
    expect(select(input(rows, [first, { ...first, sequenceNumber: "other" }]))).toEqual([header, ...rows]);
  });
  it("skips child allocations before validating parent receipt metadata", () => {
    const child = header.map((name) => name === "Record Type (1=Parent, 2=Child)" ? "2" : "");
    expect(select(input([child, receipt()]))).toEqual([header, receipt()]);
  });
  it("retains valid anonymous or unitemized contributions without inventing a donor", () => {
    const row = receipt("a", "100", { "Organization Name/Contributor Last Name": "" });
    expect(select(input([row]))).toEqual([header, row]);
  });
  it.each([
    ["missing manifest", []], ["pending filing", [original({ status: "Pending" })]],
    ["missing original", [amended()]],
    ["multiple originals with amendment", [original(), original({ sequenceNumber: "other" }), amended()]],
    ["multiple amendments", [original(), amended(), amended({ sequenceNumber: "other" })]],
    ["missing amendment reference", [original(), amended({ refersToSequenceNumber: "" })]],
    ["wrong amendment reference", [original(), amended({ refersToSequenceNumber: "other" })]],
    ["missing coverage", [original({ coverageBegin: "" }), amended()]],
    ["different coverage", [original(), amended({ coverageEnd: "2026-07-18" })]],
    ["older amendment", [original(), amended({ receivedDate: "2026-07-01" })]],
  ] as [string, MichiganMitnFiling[]][])('rejects %s and preserves the caller snapshot', (_, filings) => {
    expect(() => select(input([receipt()], filings))).toThrow();
  });
  it("rejects amended receipts absent a verified amendment", () => {
    expect(() => select(input([receipt("a", "100", { "Document Type": "Amended Campaign Statements" })]))).toThrow(/unverified amended/);
  });
  it("rejects conflicting current receipt amounts instead of choosing file order", () => {
    expect(() => select(input([receipt("a", "100"), receipt("a", "200")]))).toThrow(/conflicting current receipt/);
  });
  it.each([
    ["Receiving Committee ID#", "123"], ["Document Statement Year", "2025"],
    ["Receipt ID", ""], ["Record Type (1=Parent, 2=Child)", "3"],
    ["Document Type", "Unknown"], ["Date of Contribution", "02/30/2026"],
    ["Amount of Contribution", "oops"], ["Receiving Committee Name", ""],
    ["Document Statement Type", ""],
  ])("rejects malformed parent field %s", (name, value) => {
    expect(() => select(input([receipt("a", "100", { [name]: value })]))).toThrow();
  });
});

describe("fresh receipt manifest acquisition", () => {
  beforeEach(() => { mocks.manifest.mockReset(); mocks.manifest.mockResolvedValue([original()]); });
  const fetchFn = vi.fn();
  it("uses the exact receipt source ID and binds a fresh manifest to raw export bytes", async () => {
    const options = { committeeId: "0521495", statementYears: [2026], rawRows: [header, receipt()], rawCacheDir: "/tmp/test-mitn-receipts", fetchFn };
    await expect(fetchMichiganMitnCurrentContributionRows(options)).resolves.toEqual(options.rawRows);
    const call = mocks.manifest.mock.calls[0]![0];
    expect(call).toMatchObject({ committeeId: "521495", rawCacheDir: options.rawCacheDir, refresh: true, fetchFn });
    expect(call.exportFingerprint).toMatch(/^[a-f0-9]{64}$/);
    await fetchMichiganMitnCurrentContributionRows({ ...options, rawRows: [header, receipt("a", "200")] });
    expect(mocks.manifest.mock.calls[1]![0].exportFingerprint).not.toBe(call.exportFingerprint);
  });
  it("preserves a source ID whose official spelling includes leading zeros", async () => {
    const rawRows = [header, receipt("a", "100", { "Receiving Committee ID#": "0521495" })];
    await fetchMichiganMitnCurrentContributionRows({ committeeId: "521495", statementYears: [2026], rawRows, fetchFn });
    expect(mocks.manifest.mock.calls[0]![0].committeeId).toBe("0521495");
  });
  it("rejects inconsistent source ID spellings before registry acquisition", async () => {
    const rawRows = [header, receipt(), receipt("b", "200", { "Receiving Committee ID#": "0521495" })];
    await expect(fetchMichiganMitnCurrentContributionRows({ committeeId: "521495", statementYears: [2026], rawRows, fetchFn })).rejects.toThrow(/ambiguous receiving committee source IDs/);
    expect(mocks.manifest).not.toHaveBeenCalled();
  });
  it("accepts a complete header-only empty export without a manifest request", async () => {
    await expect(fetchMichiganMitnCurrentContributionRows({ committeeId: "0521495", statementYears: [2026], rawRows: [header], fetchFn })).resolves.toEqual([header]);
    expect(mocks.manifest).not.toHaveBeenCalled();
  });
  it("rejects partial header-only exports before acquisition", async () => {
    await expect(fetchMichiganMitnCurrentContributionRows({ committeeId: "0521495", statementYears: [2026], rawRows: [["Receipt ID"]], fetchFn })).rejects.toThrow(/required headers/);
    expect(mocks.manifest).not.toHaveBeenCalled();
  });
  it("propagates manifest acquisition failure instead of clearing existing PAC donors", async () => {
    mocks.manifest.mockRejectedValue(new Error("MiTN HTTP 503"));
    await expect(fetchMichiganMitnCurrentContributionRows({ committeeId: "0521495", statementYears: [2026], rawRows: [header, receipt()], fetchFn })).rejects.toThrow("MiTN HTTP 503");
  });
});
