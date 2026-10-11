import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadIllinoisSbeVerifiedQuarterlyDataSet } from "../../../src/pipeline/illinoisFinance/illinoisSbeVerifiedQuarterlyDataSource.js";
import { ILLINOIS_SBE_COMMITTEE_REGISTRY_HEADER as REGISTRY } from "../../../src/pipeline/illinoisFinance/illinoisSbeLegalCommitteeDonorMatcher.js";
import { ILLINOIS_SBE_FILED_DOCUMENTS_HEADER as DOCS, ILLINOIS_SBE_D2_TOTALS_HEADER as TOTALS } from "../../../src/pipeline/illinoisFinance/illinoisSbeQuarterlyReportReader.js";
import type { IllinoisCandidateFinanceDueRow } from "../../../src/pipeline/illinoisFinance/illinoisCandidateFinanceBatchSync.js";
type Row = Record<string, string>;
const CANDIDATES = "ID LastName FirstName Address1 Address2 City State Zip Office DistrictType District ResidenceCounty PartyAffiliation RedactionRequested".split(" ");
const ELECTIONS = "ID CandidateID ElectionType ElectionYear IncChallOpen WonLost FairCampaign LimitsOff LimitsOffReason".split(" ");
const LINKS = ["ID", "CommitteeID", "CandidateID"];
const CASH = "CommitteeID,CommitteeName,ContributedBy,RcvdDate,Amount,LoanAmount,Occupation,Employer,Address1,Address2,City,State,Zip,D2Part,Description,VendorName,VendorAddress1,VendorAddress2,VendorCity,VendorState,VendorZip,DocName,Election,RptPdBegDate,RptPdEndDate,FiledRcvdDate".split(",");
const IE = "CommitteeID,ReceivedBy,ExpndDate,Amount,Address1,Address2,City,State,Zip,ExpendedByType,Purpose,Beneficiary,CandidateName,OfficeDistrict,SupportingOpposing,DocName,Election,RptPdBegDate,RptPdEndDate,RptRcvdDate,ExpendedBy".split(",");
const tsv = (header: readonly string[], rows: Row[]) => header.join("\t") + "\n" + rows.map((row) => header.map((key) => row[key] ?? "").join("\t")).join("\n") + "\n";
const csv = (header: readonly string[], rows: Row[]) => header.join(",") + "\n" + rows.map((row) => header.map((key) => JSON.stringify(row[key] ?? "")).join(",")).join("\n") + "\n";
const doc = (more: Row = {}): Row => ({ ID: "1013045", CommitteeID: "39503", FiledDocType: "  ", DocName: "Quarterly", Amend: "True", Archived: "False", RptPdBegDate: "2026-04-01 00:00:00", RptPdEndDate: "2026-06-30 00:00:00", RcvdDateTime: "2026-07-09 07:58:57", Source: "I", ...more });
const total = (more: Row = {}): Row => ({ ...Object.fromEntries(TOTALS.map((key) => [key, "0"])), ID: "589883", CommitteeID: "39503", FiledDocID: "1013045", Archived: "False", IndivContribI: "500", XferInI: "1000", TotalReceipts: "1500", EndFundsAvail: "900", TotalDebts: "10", ...more });
const gift = (more: Row = {}): Row => ({ CommitteeID: "39503", CommitteeName: "Balkema for State Senate", ContributedBy: "Community BancPac", RcvdDate: "6/12/2026", Amount: "500", D2Part: "Transfer In", DocName: "Quarterly", RptPdBegDate: "4/1/2026", RptPdEndDate: "6/30/2026", FiledRcvdDate: "7/9/2026", ...more });
const expense = (more: Row = {}): Row => ({ CommitteeID: "615", ReceivedBy: "Team Concept", ExpndDate: "9/9/2026", Amount: "66.50", ExpendedByType: "Independent Expenditure", Purpose: "Printing", CandidateName: "Balkema for State Senate", OfficeDistrict: "IL Senate Dist. 53", SupportingOpposing: "Supporting", DocName: "Quarterly", RptPdBegDate: "7/1/2026", RptPdEndDate: "9/30/2026", RptRcvdDate: "10/7/2026", ExpendedBy: "Kane County Republican Central Cmte", ...more });
const ieTotal = () => total({ ID: "594760", CommitteeID: "615", FiledDocID: "1023410", IndivContribI: "0", XferInI: "0", TotalReceipts: "0", IndependentExpI: "166.50" });
const due: IllinoisCandidateFinanceDueRow = { candidateId: "local", electionId: "general", candidateName: "Chris Balkema", electionYear: 2026, officeScope: "state_upper", officeName: "State Senator", district: "53", sbeCandidateId: "44444", sbeDistrictType: "Senate", sbeOffice: "State Senator", isAtLarge: false, committeeKey: "SBE:39503", committeeName: "Balkema for State Senate", sourceUrl: null, lastSyncedAt: null };
const temp: string[] = [];
afterEach(async () => { await Promise.all(temp.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "illinois-verified-quarterly-")); temp.push(dir);
  const docs = [doc(), doc({ ID: "1012431", Archived: "True", Amend: "False", RcvdDateTime: "2026-07-07 07:43:37" }), doc({ ID: "1023410", CommitteeID: "615", Amend: "False", RptPdBegDate: "2026-07-01 00:00:00", RptPdEndDate: "2026-09-30 00:00:00", RcvdDateTime: "2026-10-07 15:46:19.163000000" })];
  const gifts = [gift(), gift(), gift({ ContributedBy: "Local Future PAC", D2Part: "Individual Contribution", Amount: "250" }), gift({ ContributedBy: "Illinois Republican Party", D2Part: "Individual Contribution", Amount: "150" }), gift({ ContributedBy: "Acme Business", D2Part: "Individual Contribution", Amount: "100" }), gift({ Amount: "999", DocName: "A-1" }), gift({ Amount: "999", RcvdDate: "6/12/2024", RptPdBegDate: "4/1/2024", RptPdEndDate: "6/30/2024", FiledRcvdDate: "7/9/2024" })];
  const files = { registry: tsv(REGISTRY, [{ ID: "39503", Name: "Balkema for State Senate", TypeOfCommittee: "Candidate", Status: "A" }, { ID: "1028", Name: "Community BancPac", TypeOfCommittee: "Political Action", Status: "F" }, { ID: "777", Name: "Local Future PAC", TypeOfCommittee: "Political Action", Status: "A" }, { ID: "292", Name: "Illinois Republican Party", TypeOfCommittee: "Political Party", Status: "A" }, { ID: "615", Name: "Kane County Republican Central Cmte", TypeOfCommittee: "Political Party", Status: "A" }]), candidates: tsv(CANDIDATES, [{ ID: "44444", LastName: "Balkema", FirstName: "Chris", Office: "State Senator", DistrictType: "Senate", District: "53" }]), elections: tsv(ELECTIONS, [{ ID: "1", CandidateID: "44444", ElectionType: "GE", ElectionYear: "2026" }]), links: tsv(LINKS, [{ ID: "1", CandidateID: "44444", CommitteeID: "39503" }]), before: tsv(DOCS, docs), after: tsv(DOCS, docs), totals: tsv(TOTALS, [total(), ieTotal()]), cash: csv(CASH, gifts), ie: csv(IE, [expense(), expense({ Amount: "100", CandidateName: "Unlinked Person" })]) };
  await Promise.all(Object.entries(files).map(([name, body]) => writeFile(join(dir, name), body)));
  const config = { committeeRegistryPath: join(dir, "registry"), candidatesPath: join(dir, "candidates"), candidateElectionsPath: join(dir, "elections"), committeeCandidateLinksPath: join(dir, "links"), filedDocumentsPath: join(dir, "before"), afterFiledDocumentsPath: join(dir, "after"), d2TotalsPath: join(dir, "totals"), coverageYears: [2025, 2026], contributionCsvPathsByCommitteeId: { "39503": join(dir, "cash") }, outsideExpendituresCsvPath: join(dir, "ie"), outsideQueryWindow: { fromDate: "2025-01-01", toDate: "2026-12-31" } };
  const save = (name: string, body: string) => writeFile(join(dir, name), body);
  return { config, docs, gifts, save };
}

describe("Illinois verified Quarterly datasource", () => {
  it("retains equal gifts and source-typed PAC/party; matches one target after whole-report IE reconciliation", async () => {
    const f = await fixture(), ds = await loadIllinoisSbeVerifiedQuarterlyDataSet(f.config), data = ds.loadCandidateData(due);
    expect(data.pacDonors).toHaveLength(3); expect(data.pacDonors).toEqual(expect.arrayContaining([expect.objectContaining({ committeeId: "1028", totalAmount: 1000, contributionCount: 2 }), expect.objectContaining({ committeeId: "777", totalAmount: 250 }), expect.objectContaining({ committeeId: "292", totalAmount: 150, committeeType: "Political Party" })]));
    expect(data.directContributionRecords).toHaveLength(5); expect(data.d2ReportSummaries?.[0].totalReceipts).toBe(1500); expect(data.outsideExpenditureRecords).toHaveLength(1);
    expect(data.outsideExpenditureRecords?.[0]).toMatchObject({ amount: 66.5, sourceDocumentId: "1023410" });
    expect(data.outsideReportEvidence?.find((r) => r.filedDocId === "1023410")).toMatchObject({ receivedAt: "2026-10-07 15:46:19.163000000", fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });
  it("excludes an archived original without collapsing equal gifts", async () => {
    const f = await fixture(); await f.save("cash", csv(CASH, [...f.gifts, gift({ FiledRcvdDate: "7/7/2026" })]));
    expect((await loadIllinoisSbeVerifiedQuarterlyDataSet(f.config)).loadCandidateData(due).pacDonors?.find((d) => d.committeeId === "1028")?.totalAmount).toBe(1000);
  });
  it("rejects same-day archived/current ambiguity even with equal sums", async () => {
    const f = await fixture(); f.docs[1]!.RcvdDateTime = "2026-07-09 01:00:00"; await f.save("before", tsv(DOCS, f.docs)); await f.save("after", tsv(DOCS, f.docs));
    const d = (await loadIllinoisSbeVerifiedQuarterlyDataSet(f.config)).loadCandidateData(due); expect(d.pacDonors).toBeUndefined(); expect(d.diagnostics.join(" ")).toMatch(/ambiguous all-version/);
  });
  it("omits partial/invalid cash independently of valid Raised and positive IE", async () => {
    const f = await fixture(); await f.save("cash", csv(CASH, [gift()])); const d = (await loadIllinoisSbeVerifiedQuarterlyDataSet(f.config)).loadCandidateData(due);
    expect(d.pacDonors).toBeUndefined(); expect(d.directContributionRecords).toBeUndefined(); expect(d.d2ReportSummaries?.[0].totalReceipts).toBe(1500); expect(d.outsideExpenditureRecords).toHaveLength(1); expect(d.diagnostics.join(" ")).toMatch(/schedule mismatch/);
  });
  it("does not clear on missing/header-only cash; validated zero cash with a noncash row can clear", async () => {
    const f = await fixture(); await f.save("totals", tsv(TOTALS, [total({ IndivContribI: "0", XferInI: "0", TotalReceipts: "100" }), ieTotal()])); await f.save("cash", csv(CASH, [gift({ D2Part: "Loan", Amount: "100" })]));
    expect((await loadIllinoisSbeVerifiedQuarterlyDataSet(f.config)).loadCandidateData(due).pacDonors).toEqual([]);
    await f.save("cash", csv(CASH, [])); expect((await loadIllinoisSbeVerifiedQuarterlyDataSet(f.config)).loadCandidateData(due).pacDonors).toBeUndefined();
    expect((await loadIllinoisSbeVerifiedQuarterlyDataSet({ ...f.config, contributionCsvPathsByCommitteeId: undefined })).loadCandidateData(due).pacDonors).toBeUndefined();
  });
  it("requires exact receiving Candidate ownership, person, GE and seat", async () => {
    const f = await fixture(), ds = await loadIllinoisSbeVerifiedQuarterlyDataSet(f.config);
    for (const row of [{ ...due, committeeKey: "SBE:1028" }, { ...due, candidateName: "Christopher Balkema" }, { ...due, district: "54" }, { ...due, electionYear: 2025 }]) { const d = ds.loadCandidateData(row); expect(d.pacDonors).toBeUndefined(); expect(d.d2ReportSummaries).toBeUndefined(); expect(d.outsideExpenditureRecords).toBeUndefined(); }
  });
  it("invalidates only the changed IE filer between independent source snapshots", async () => {
    const f = await fixture(); await f.save("after", tsv(DOCS, f.docs.map((r) => r.ID === "1023410" ? { ...r, RcvdDateTime: "2026-10-08 15:46:19" } : r)));
    const d = (await loadIllinoisSbeVerifiedQuarterlyDataSet(f.config)).loadCandidateData(due); expect(d.pacDonors).toHaveLength(3); expect(d.d2ReportSummaries).toHaveLength(1); expect(d.outsideExpenditureRecords).toBeUndefined();
  });
  it("brackets D2-only summary sources without a cash export", async () => {
    const f = await fixture(); await f.save("after", tsv(DOCS, f.docs.map((r) => r.ID === "1013045" ? { ...r, RcvdDateTime: "2026-07-10 07:58:57" } : r)));
    const d = (await loadIllinoisSbeVerifiedQuarterlyDataSet({ ...f.config, contributionCsvPathsByCommitteeId: undefined })).loadCandidateData(due); expect(d.d2ReportSummaries).toBeUndefined(); expect(d.diagnostics.join(" ")).toMatch(/manifest changed/);
  });
  it("does not round fractional balances/Raised or suppress exact independent cash/IE", async () => {
    const f = await fixture(); await f.save("totals", tsv(TOTALS, [total({ EndFundsAvail: "900.0001" }), ieTotal()])); let d = (await loadIllinoisSbeVerifiedQuarterlyDataSet(f.config)).loadCandidateData(due); expect(d.pacDonors).toHaveLength(3); expect(d.d2ReportSummaries?.[0].cashOnHand).toBeNull(); expect(d.outsideExpenditureRecords).toHaveLength(1);
    await f.save("totals", tsv(TOTALS, [total({ TotalReceipts: "1500.0001" }), ieTotal()])); d = (await loadIllinoisSbeVerifiedQuarterlyDataSet(f.config)).loadCandidateData(due); expect(d.d2ReportSummaries).toBeUndefined(); expect(d.pacDonors).toHaveLength(3);
  });
  it("requires the unrelated beneficiary rows to reconcile a whole IE report", async () => {
    const f = await fixture(); await f.save("ie", csv(IE, [expense()])); const ds = await loadIllinoisSbeVerifiedQuarterlyDataSet(f.config); expect(ds.loadCandidateData(due).outsideExpenditureRecords).toBeUndefined(); expect(ds.diagnostics.outside.get("615")?.join(" ")).toMatch(/whole-report IE/);
  });
  it("fingerprints same-dollar beneficiary changes and retains only actual superseded source IDs", async () => {
    const f = await fixture(); f.docs.push(doc({ ID: "1020000", CommitteeID: "615", Archived: "True", RptPdBegDate: "2026-07-01 00:00:00", RptPdEndDate: "2026-09-30 00:00:00", RcvdDateTime: "2026-10-06 15:46:19" })); await f.save("before", tsv(DOCS, f.docs)); await f.save("after", tsv(DOCS, f.docs));
    const first = (await loadIllinoisSbeVerifiedQuarterlyDataSet(f.config)).acceptedIEReports.find((r) => r.filedDocId === "1023410")!; await f.save("ie", csv(IE, [expense({ CandidateName: "Another Person" }), expense({ Amount: "100", CandidateName: "Unlinked Person" })])); const second = (await loadIllinoisSbeVerifiedQuarterlyDataSet(f.config)).acceptedIEReports.find((r) => r.filedDocId === "1023410")!;
    expect(first.supersededDocumentIds).toEqual(["1020000"]); expect(first.fingerprint).not.toBe(second.fingerprint);
  });
  it.each([["2026-03-01 00:00:00", "2026-05-01 00:00:00"], ["2024-12-01 00:00:00", "2025-03-31 00:00:00"]])("does not emit partial Raised for overlapping/boundary report %s", async (start, end) => {
    const f = await fixture(); f.docs.push(doc({ ID: "1019999", RptPdBegDate: start, RptPdEndDate: end, RcvdDateTime: "2026-04-01 00:00:00" })); await f.save("before", tsv(DOCS, f.docs)); await f.save("after", tsv(DOCS, f.docs)); await f.save("totals", tsv(TOTALS, [total(), total({ ID: "599999", FiledDocID: "1019999", IndivContribI: "0", XferInI: "0", TotalReceipts: "500" }), ieTotal()]));
    const d = (await loadIllinoisSbeVerifiedQuarterlyDataSet(f.config)).loadCandidateData(due); expect(d.d2ReportSummaries).toBeUndefined(); expect(d.pacDonors).toBeUndefined();
  });
  it("omits a whole IE spender when another current quarter has missing D2 coverage", async () => {
    const f = await fixture(); f.docs.push(doc({ ID: "1021111", CommitteeID: "615", RptPdBegDate: "2026-04-01 00:00:00", RptPdEndDate: "2026-06-30 00:00:00" }));
    await f.save("before", tsv(DOCS, f.docs)); await f.save("after", tsv(DOCS, f.docs));
    const ds = await loadIllinoisSbeVerifiedQuarterlyDataSet(f.config);
    expect(ds.quarterlyManifest.unknownCommittees.has("615")).toBe(true);
    expect(ds.acceptedIEReports.some((r) => r.committeeId === "615")).toBe(false);
    expect(ds.loadCandidateData(due).outsideExpenditureRecords).toBeUndefined();
    expect(ds.diagnostics.outside.get("615")?.join(" ")).toMatch(/whole-spender|current D2 coverage/);
  });
  it("fingerprints native Beneficiary-only and address-only changes when money and target are unchanged", async () => {
    const f = await fixture(), load = async () => (await loadIllinoisSbeVerifiedQuarterlyDataSet(f.config)).acceptedIEReports.find((r) => r.filedDocId === "1023410")!.fingerprint;
    const first = await load();
    await f.save("ie", csv(IE, [expense({ Beneficiary: "Changed beneficiary" }), expense({ Amount: "100", CandidateName: "Unlinked Person" })]));
    const second = await load(); expect(second).not.toBe(first);
    await f.save("ie", csv(IE, [expense({ Beneficiary: "Changed beneficiary", Address1: "Changed payee address" }), expense({ Amount: "100", CandidateName: "Unlinked Person" })]));
    expect(await load()).not.toBe(second);
  });
  it("does not publish partial expense totals or fall back to an older cash balance", async () => {
    const f = await fixture(); f.docs.push(doc({ ID: "1010000", RptPdBegDate: "2026-01-01 00:00:00", RptPdEndDate: "2026-03-31 00:00:00", RcvdDateTime: "2026-04-01 00:00:00" }));
    await f.save("before", tsv(DOCS, f.docs)); await f.save("after", tsv(DOCS, f.docs));
    await f.save("totals", tsv(TOTALS, [total({ TotalExpend: "100.0001", EndFundsAvail: "900.0001", TotalDebts: "10.0001" }), total({ ID: "588000", FiledDocID: "1010000", IndivContribI: "0", XferInI: "0", TotalReceipts: "100", TotalExpend: "50", EndFundsAvail: "700", TotalDebts: "20" }), ieTotal()]));
    const d = (await loadIllinoisSbeVerifiedQuarterlyDataSet(f.config)).loadCandidateData(due);
    expect(d.d2ReportSummaries?.map((r) => r.totalReceipts)).toEqual([100, 1500]);
    expect(d.d2ReportSummaries?.every((r) => r.totalDisbursements === null && r.cashOnHand === null && r.debtsOwed === null)).toBe(true);
    expect(d.pacDonors).toHaveLength(3);
  });
  it("omits the outside replacement when a candidate-targeted row has no stance or an ambiguous target", async () => {
    const f = await fixture();
    await f.save("ie", csv(IE, [expense({ SupportingOpposing: "" }), expense({ Amount: "100", CandidateName: "Unlinked Person" })]));
    let d = (await loadIllinoisSbeVerifiedQuarterlyDataSet(f.config)).loadCandidateData(due);
    expect(d.outsideExpenditureRecords).toBeUndefined(); expect(d.diagnostics.join(" ")).toMatch(/Unresolved candidate-targeted/); expect(d.pacDonors).toHaveLength(3);
    await f.save("candidates", tsv(CANDIDATES, [{ ID: "44444", LastName: "Balkema", FirstName: "Chris", Office: "State Senator", DistrictType: "Senate", District: "53" }, { ID: "55555", LastName: "Balkema", FirstName: "Chris", Office: "State Senator", DistrictType: "Senate", District: "53" }]));
    await f.save("elections", tsv(ELECTIONS, [{ ID: "1", CandidateID: "44444", ElectionType: "GE", ElectionYear: "2026" }, { ID: "2", CandidateID: "55555", ElectionType: "GE", ElectionYear: "2026" }]));
    await f.save("ie", csv(IE, [expense({ CandidateName: "Chris Balkema" }), expense({ Amount: "100", CandidateName: "Unlinked Person" })]));
    d = (await loadIllinoisSbeVerifiedQuarterlyDataSet(f.config)).loadCandidateData(due);
    expect(d.outsideExpenditureRecords).toBeUndefined(); expect(d.diagnostics.join(" ")).toMatch(/Unresolved candidate-targeted/); expect(d.d2ReportSummaries).toHaveLength(1);
  });
  it("omits cash whose current schedule exceeds Raised without suppressing the independent summary", async () => {
    const f = await fixture(); await f.save("totals", tsv(TOTALS, [total({ TotalReceipts: "1200" }), ieTotal()]));
    const d = (await loadIllinoisSbeVerifiedQuarterlyDataSet(f.config)).loadCandidateData(due);
    expect(d.pacDonors).toBeUndefined(); expect(d.d2ReportSummaries?.[0].totalReceipts).toBe(1200);
    expect(d.diagnostics.join(" ")).toMatch(/exceed reported Raised/);
  });
  it("rejects a negative committee donor net without deduplicating equal gifts", async () => {
    const f = await fixture(); await f.save("cash", csv(CASH, f.gifts.map((r) => r.ContributedBy === "Local Future PAC" ? { ...r, Amount: "-250" } : r.ContributedBy === "Acme Business" ? { ...r, Amount: "600" } : r)));
    const d = (await loadIllinoisSbeVerifiedQuarterlyDataSet(f.config)).loadCandidateData(due);
    expect(d.pacDonors).toBeUndefined(); expect(d.d2ReportSummaries?.[0].totalReceipts).toBe(1500); expect(d.diagnostics.join(" ")).toMatch(/Negative/);
  });
  it.each([["candidates", CANDIDATES, { ID: "44444", LastName: "Balkema", FirstName: "Chris" }], ["elections", ELECTIONS, { ID: "1", CandidateID: "44444", ElectionType: "GE", ElectionYear: "2026" }], ["links", LINKS, { ID: "1", CommitteeID: "39503", CandidateID: "44444" }]] as const)("rejects duplicate identity primary IDs in %s", async (name, header, row) => {
    const f = await fixture(); await f.save(name, tsv(header, [row, row]));
    await expect(loadIllinoisSbeVerifiedQuarterlyDataSet(f.config)).rejects.toThrow("Duplicate " + name + " source ID");
  });
  it.each([{ ID: "1", CommitteeID: "not-a-number", CandidateID: "44444" }, { ID: "1", CommitteeID: "39503", CandidateID: "0" }])("rejects invalid source link identities %o", async (row) => {
    const f = await fixture(); await f.save("links", tsv(LINKS, [row]));
    await expect(loadIllinoisSbeVerifiedQuarterlyDataSet(f.config)).rejects.toThrow("Invalid links source ID");
  });
  it("retains independently verified positive IE when receiving committee D2 is unavailable", async () => {
    const f = await fixture(); await f.save("totals", tsv(TOTALS, [ieTotal()]));
    const d = (await loadIllinoisSbeVerifiedQuarterlyDataSet(f.config)).loadCandidateData(due);
    expect(d.pacDonors).toBeUndefined(); expect(d.d2ReportSummaries).toBeUndefined();
    expect(d.outsideExpenditureRecords).toEqual([expect.objectContaining({ sourceDocumentId: "1023410", amount: 66.5 })]);
    expect(d.diagnostics.join(" ")).toMatch(/current Quarterly coverage/);
  });
  it("requires independent snapshot and valid complete identity headers", async () => {
    const f = await fixture(); await expect(loadIllinoisSbeVerifiedQuarterlyDataSet({ ...f.config, afterFiledDocumentsPath: f.config.filedDocumentsPath })).rejects.toThrow("Independent after"); await f.save("candidates", "ID,Unknown\n1,x\n"); await expect(loadIllinoisSbeVerifiedQuarterlyDataSet(f.config)).rejects.toThrow();
  });
});
