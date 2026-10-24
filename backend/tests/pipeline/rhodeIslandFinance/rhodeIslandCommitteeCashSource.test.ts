import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertRhodeIslandCashPacket, loadRhodeIslandCashPacket, type RhodeIslandCashPacket } from "../../../src/pipeline/rhodeIslandFinance/rhodeIslandCommitteeCashSource.js";
import { getErtsArtifactPaths, storeErtsArtifact, type ErtsArtifactKey } from "../../../src/pipeline/rhodeIslandFinance/rhodeIslandErtsArtifactCache.js";
import { ertsContributionReportUrl, ertsExpenditureReportUrl } from "../../../src/pipeline/rhodeIslandFinance/rhodeIslandErtsClient.js";
import { ERTS_CF2_SUMMARY_LABELS, ERTS_CONTRIBUTION_EXPORT_COLUMNS } from "../../../src/pipeline/rhodeIslandFinance/rhodeIslandErtsParsers.js";
import { makeMinimalPdf } from "../../helpers/minimalPdf.js";

const context = { candidateId: "11111111-1111-4111-8111-111111111111", electionId: "22222222-2222-4222-8222-222222222222",
  electionYear: 2026, candidateName: "Jordan Example", officeScope: "statewide", officeName: "Governor", district: null,
  committeeId: "123", committeeName: "JORDAN EXAMPLE", searchLastName: "Example" };
const stamp = new Date("2026-10-24T09:00:00.000Z");
const window = { orgId: "123", beginIso: "2025-01-01", endIso: "2026-10-05" };
const pdfUrl = "https://ricampaignfinance.com/ExportDocs/123-RICF2-11-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.pdf";
let cacheDir: string;
async function metadata(key: ErtsArtifactKey, change: (value: any) => void) {
  const path = getErtsArtifactPaths({ cacheDir, key }).manifestPath;
  const value = JSON.parse(await readFile(path, "utf8")); change(value); await writeFile(path, JSON.stringify(value));
}
async function install(overrides: Record<string, string> = {}) {
  async function store(key: ErtsArtifactKey, body: string | Uint8Array, url: string) {
    await storeErtsArtifact({ cacheDir, key, body, url, retrievedAt: stamp, source: { organizationName: context.committeeName } });
  }
  await store({ type: "organization_search", query: "Example" }, '<table id="dgdOrgSearchResults"><tr><td>Organization Name</td><td>Address</td><td>City</td><td>State</td><td>Status</td></tr>' +
    '<tr><td><a href="javascript:__doPostBack(\'dgdOrgSearchResults$ctl02$lnkOrgID\',\'\')">JORDAN EXAMPLE</a></td><td>1 Example Way</td><td>Example</td><td>RI</td><td>Active</td></tr></table>',
  "https://www.ricampaignfinance.com/RIPublic/Contributions.aspx");
  await store({ type: "organization_filings", orgId: "123" }, '<table id="grdSearchResults"><tr><td>Report Type</td><td>Begin</td><td>End</td><td>Due</td><td>Status</td><td>Original Filed</td><td>Amended</td><td></td></tr>' +
    '<tr><td>2026 Report</td><td>01/01/2025</td><td>10/05/2026</td><td>10/06/2026</td><td>Received by BOE</td><td>Oct 6 2026 9:00AM</td><td>No</td><td><a href="https://secure.ricampaignfinance.com/RhodeIslandCF/Candidate/FilingAmendmentSelect.aspx?FilingID=11&amp;FormName=RICF2">View</a></td></tr></table>',
  "https://www.ricampaignfinance.com/RIPublic/Filings.aspx");
  await store({ type: "filing_versions", filingId: "11" }, '<table id="grdAmendments"><tr><td>Amendment</td><td>Desc</td><td>Date Filed</td><td></td></tr>' +
    `<tr><td></td><td><a href="${pdfUrl}">report</a></td><td>Oct 6 2026 9:00AM</td><td></td></tr></table>`,
  "https://secure.ricampaignfinance.com/RhodeIslandCF/Candidate/FilingAmendmentSelect.aspx?FilingID=11&FormName=RICF2");
  const values: Record<string, string> = { "4. Political Action Committees": "1000", "3. Political Parties": "500", "3. Total Cash": "1500", "5. Ending Cash Balance": "1500", ...overrides };
  const lines = ERTS_CF2_SUMMARY_LABELS.flatMap((label, i) => [{ text: label, x: 48, y: 700 - i * 20 }, { text: values[label] ?? "0", x: 300, y: 700 - i * 20 }]);
  await store({ type: "filing_pdf", filingId: "11", guid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }, makeMinimalPdf(lines), pdfUrl);
  await store({ type: "contribution_report", ...window }, '<table id="dgrReport"><tr><td>Summary Groupings</td><td>Total</td></tr><tr><td>PAC</td><td>$1,000.00</td></tr><tr><td>Party</td><td>$500.00</td></tr></table><table id="dgrContribution"><tr><td>rows</td></tr></table>',
    ertsContributionReportUrl({ orgId: "123", begin: "01/01/2025", end: "10/05/2026" }));
  const rows = ["PAC", "Party"].map((type, i) => {
    const values: Record<string, string> = { ContributionID: String(i + 1), ContDesc: type, ReceiptDate: "04/01/2026", DepositDate: "1/1/1900", Amount: i ? "500.0000" : "1000.0000", MPFMatchAmount: "0.0000", FullName: `Example ${type}`, TransType: "Contribution" };
    return ERTS_CONTRIBUTION_EXPORT_COLUMNS.map(c => values[c] ?? "").join(",");
  });
  await store({ type: "contribution_export", ...window }, [ERTS_CONTRIBUTION_EXPORT_COLUMNS.join(","), ...rows].join("\r\n") + "\r\n", "https://www.ricampaignfinance.com/RIPublic/Reporting/DownloadFile.aspx?path=example&file=example.csv");
  await store({ type: "expenditure_report", ...window }, '<span id="lblNoReportMsg">There were no reports found, please try your search again.</span>',
    ertsExpenditureReportUrl({ orgId: "123", begin: "01/01/2025", end: "10/05/2026" }));
}
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-24T10:00:00.000Z"));
  cacheDir = await mkdtemp(join(tmpdir(), "ri-cash-source-")); await install();
});
afterEach(async () => { vi.useRealTimers(); await rm(cacheDir, { recursive: true, force: true }); });
describe("verified Rhode Island cache packets", () => {
  it("mints only frozen source-backed packets and retains the acquisition clock", async () => {
    const p = await loadRhodeIslandCashPacket(context, cacheDir);
    expect(p).toMatchObject({ totalCents: 150_000, selectedOccurrences: 2, receivingRows: 2, observedAt: stamp.toISOString(), coverageThrough: "2026-10-05" });
    expect(() => assertRhodeIslandCashPacket(p)).not.toThrow();
    expect(() => assertRhodeIslandCashPacket({ ...p })).toThrow(/unverified_packet/);
    expect([p, p.context, p.summary, p.donors, ...p.donors, p.directBreakdowns, ...p.directBreakdowns].every(Object.isFrozen)).toBe(true);
  });
  it("qualifies reconciled PAC/Party lines while withholding conflicting overall direct cash", async () => {
    await install({ "3. Total Cash": "1501", "5. Ending Cash Balance": "1501" });
    const p = await loadRhodeIslandCashPacket(context, cacheDir);
    expect(p).toMatchObject({ totalCents: 150_000, selectedOccurrences: 2, summary: null, directBreakdowns: [] });
    expect(() => assertRhodeIslandCashPacket(p)).not.toThrow();
  });
  it("still holds a conflicting authoritative PAC line", async () => {
    await install({ "4. Political Action Committees": "1001" });
    await expect(loadRhodeIslandCashPacket(context, cacheDir)).rejects.toThrow(/cf2_committee_cash_mismatch/);
  });
  it("refuses caller-constructed totals", () => {
    expect(() => assertRhodeIslandCashPacket({ totalCents: 1 } as RhodeIslandCashPacket)).toThrow(/unverified_packet/);
  });
  it("allows an older immutable PDF only through its current version selection", async () => {
    await metadata({ type: "filing_pdf", filingId: "11", guid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }, m => { m.retrievedAt = "2026-01-01T00:00:00.000Z"; });
    expect((await loadRhodeIslandCashPacket(context, cacheDir)).observedAt).toBe(stamp.toISOString());
  });
  it.each(["2026-10-24T08:00:00.000Z", "2026-10-22T09:00:00.000Z", "2026-10-25T09:00:00.000Z"])("holds mixed, stale or future mutable source clocks", async clock => {
    await metadata({ type: "contribution_report", ...window }, m => { m.retrievedAt = clock; });
    await expect(loadRhodeIslandCashPacket(context, cacheDir)).rejects.toThrow(/mixed_acquisition_vintages|source_freshness/);
  });
  it("holds a source URL with different public query selectors", async () => {
    await metadata({ type: "contribution_report", ...window }, m => { m.url = m.url.replace("OrgID=123", "OrgID=456"); });
    await expect(loadRhodeIslandCashPacket(context, cacheDir)).rejects.toThrow(/artifact_source_scope/);
  });
  it("holds a manifest belonging to another receiving account", async () => {
    await metadata({ type: "expenditure_report", ...window }, m => { m.source.organizationName = "OTHER ACCOUNT"; });
    await expect(loadRhodeIslandCashPacket(context, cacheDir)).rejects.toThrow(/artifact_receiving_identity/);
  });
  it("holds missing or changed bytes rather than minting an empty packet", async () => {
    await writeFile(getErtsArtifactPaths({ cacheDir, key: { type: "contribution_export", ...window } }).filePath, "changed");
    await expect(loadRhodeIslandCashPacket(context, cacheDir)).rejects.toThrow(/stale/);
  });
});
