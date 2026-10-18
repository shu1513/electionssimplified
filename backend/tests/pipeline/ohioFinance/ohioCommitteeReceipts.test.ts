import { describe, expect, it } from "vitest";
import { createOhioCommitteeReceiptAccumulator, createOhioCommitteeRegistry, strictOhioCommitteeCents } from "../../../src/pipeline/ohioFinance/ohioCommitteeReceipts.js";
import { OHIO_SOS_PAC_COVER_FAMILY, type OhioSosContributionRow, type OhioSosCoverPageRow } from "../../../src/pipeline/ohioFinance/ohioSosBulkFiles.js";

function cover(change: Partial<OhioSosCoverPageRow> = {}): OhioSosCoverPageRow {
  return { committeeName: "Synthetic Candidate Committee", masterKey: "100", candidateFirstName: "Synthetic", candidateLastName: "Candidate",
    reportKey: "300", reportYear: 2026, reportDescription: "PRE-GENERAL", dateReportFiledIso: "2026-10-15", amountForwardCents: 0,
    totalContributionsCents: 10000, totalOtherIncomeCents: 0, totalFundsCents: 10000, totalExpendituresCents: 0, balanceOnHandCents: 10000,
    valueInkindReceivedCents: 0, valueInkindMadeCents: 0, outstandingLoansOwedCents: 0, outstandingDebtOwedCents: 0,
    outstandingLoansToCents: 0, valueIndependentExpendituresCents: 0, ...change };
}
function receipt(change: Partial<OhioSosContributionRow> = {}): OhioSosContributionRow {
  return { committeeName: "Synthetic Candidate Committee", masterKey: "100", reportYear: 2026, reportKey: "300", reportDescription: "PRE-GENERAL",
    shortDescription: "31-A Stmt of Contribution", contributorFirstName: null, contributorMiddleName: null, contributorLastName: null,
    contributorSuffix: null, nonIndividual: "Synthetic PAC", pacRegNo: "CP900", address: null, city: null, state: "OH", zip: null,
    fileDateIso: "2026-10-15", amountCents: 10000, eventDateIso: "2026-10-01", empOccupation: null, inkindDescription: null,
    otherIncomeType: null, rcvEvent: null, candidateFirstName: "Synthetic", candidateLastName: "Candidate", office: "HOUSE", district: "1", party: null, ...change };
}
function input(change: Record<string, unknown> = {}) {
  return { electionYear: 2026, candidateListRows: [], pacListRows: [{ committeeName: "Synthetic PAC", masterKey: "200", pacRegNo: "CP900", sponsor: null }],
    candidateCoverRows: [cover()], pacCoverRows: [], partyCoverRows: [], ...change };
}
function component(rows: OhioSosContributionRow[], change: Record<string, unknown> = {}) {
  const a = createOhioCommitteeReceiptAccumulator(input(change)); for (const r of rows) a.add(r, 2026); return a.finish().component("100");
}
describe("Ohio current committee-receipt authority", () => {
  it("preserves historical PAC registration information in the native cover mapper", () => {
    const row = OHIO_SOS_PAC_COVER_FAMILY.header.map(k => ({ COM_NAME: "Synthetic Historical PAC", MASTER_KEY: "201", REPORT_KEY: "301", RPT_YEAR: "2025", PAC_REG_NO: "CP901" })[k] ?? "");
    expect(OHIO_SOS_PAC_COVER_FAMILY.mapRow(row)).toMatchObject({ pacRegNo: "CP901", masterKey: "201" });
  });
  it("uses exact registry names and registrations, including historical PAC and party/campaign covers", () => {
    const registry = createOhioCommitteeRegistry(input({ pacCoverRows: [cover({ committeeName: "Synthetic Historical PAC", masterKey: "201", pacRegNo: "CP901" })],
      partyCoverRows: [cover({ committeeName: "Synthetic Party Committee", masterKey: "202" })] }));
    expect(registry.classify(receipt({ nonIndividual: "Changed Reported Label", pacRegNo: "CP - 900" }))).toMatchObject({ key: "committee:200", evidence: "registry_registration" });
    expect(registry.classify(receipt({ nonIndividual: "Synthetic Historical PAC", pacRegNo: null }))).toMatchObject({ key: "committee:201" });
    expect(registry.classify(receipt({ nonIndividual: "Synthetic Party Committee", pacRegNo: null }))).toMatchObject({ key: "committee:202" });
    expect(registry.classify(receipt({ nonIndividual: "Synthetic Candidate Committee", pacRegNo: null }))).toMatchObject({ key: "committee:100" });
  });
  it("retains reported PCE/local/federal classes without inventing a resolved native committee", () => {
    const registry = createOhioCommitteeRegistry(input());
    for (const declaration of ["PCE", "PCE ACCOUNT", "LOCAL", "LOCAL PAC", "FEDERAL PAC", "PAC", "FEC ID C00000999", "OH - 999", "179"])
      expect(registry.classify(receipt({ nonIndividual: "Synthetic Reported Group", pacRegNo: declaration }))).toMatchObject({ nativeCommitteeId: null, name: "Synthetic Reported Group" });
    expect(registry.classify(receipt({ nonIndividual: "Synthetic Business LLC", pacRegNo: null }))).toBeNull();
  });
  it("holds contradictory and malformed declarations instead of dropping known committee money", () => {
    const registry = createOhioCommitteeRegistry(input({ pacListRows: [{ committeeName: "Synthetic PAC", masterKey: "200", pacRegNo: "CP900", sponsor: null },
      { committeeName: "Other Synthetic PAC", masterKey: "201", pacRegNo: "CP901", sponsor: null }] }));
    expect(() => registry.classify(receipt({ pacRegNo: "CP901" }))).toThrow(/contradictory_committee_evidence/);
    expect(() => component([receipt({ nonIndividual: "Synthetic Unresolved", pacRegNo: "PEC" })])).toThrow(/unknown_committee_evidence/);
  });
  it("does not choose a legal identity from an ambiguous registry-name match", () => {
    const registry = createOhioCommitteeRegistry(input({ pacListRows: [{ committeeName: "Synthetic Shared Name", masterKey: "200", pacRegNo: "CP900", sponsor: null },
      { committeeName: "Synthetic Shared Name", masterKey: "201", pacRegNo: "CP901", sponsor: null }] }));
    expect(() => registry.classify(receipt({ nonIndividual: "Synthetic Shared Name", pacRegNo: null }))).toThrow(/ambiguous_committee_evidence/);
    expect(registry.classify(receipt({ nonIndividual: "Synthetic Shared Name", pacRegNo: "PCE" }))).toMatchObject({ nativeCommitteeId: null, evidence: "reported_marker" });
  });
  it("keeps repeated native occurrences and signs; cash and in-kind reconcile separately", () => {
    const r = component([receipt(), receipt(), receipt({ amountCents: -2000 }), receipt({ shortDescription: "31-J-1 In-Kind Cont Rcvd", amountCents: 5000 }),
      receipt({ nonIndividual: "Synthetic Business", pacRegNo: null, amountCents: 3000 })], { candidateCoverRows: [cover({ totalContributionsCents: 21000, valueInkindReceivedCents: 5000 })] });
    expect(r).toMatchObject({ totalCents: 23000, selectedRows: 4, receivingRows: 5, positiveCents: 25000, negativeCents: -2000 });
    expect(r.groups).toMatchObject([{ cents: 23000, rowCount: 4 }]);
  });
  it("retains cancellations but rejects a negative donor balance", () => {
    expect(component([receipt(), receipt({ amountCents: -10000 })], { candidateCoverRows: [cover({ totalContributionsCents: 0 })] }))
      .toMatchObject({ totalCents: 0, groups: [], selectedRows: 2, canceledGroupCount: 1, canceledRowCount: 2 });
    expect(() => component([receipt({ amountCents: -100 })], { candidateCoverRows: [cover({ totalContributionsCents: -100 })] })).toThrow(/negative_committee_balance/);
  });
  it("requires complete current report membership and cash/in-kind closure", () => {
    expect(() => component([receipt()], { candidateCoverRows: [cover({ totalContributionsCents: 9999 })] })).toThrow(/report_reconciliation_mismatch/);
    expect(() => component([receipt()], { candidateCoverRows: [cover({ valueInkindReceivedCents: 1 })] })).toThrow(/report_reconciliation_mismatch/);
    expect(() => component([receipt({ reportKey: "301" })], { candidateCoverRows: [cover({ totalContributionsCents: 0 })] })).toThrow(/receipt_report_missing_from_cover/);
    expect(() => component([receipt()], { candidateCoverRows: [cover(), cover({ reportKey: "301", totalContributionsCents: 0 })] })).toThrow(/ambiguous_report_period/);
  });
  it("never equates missing/unfiled reports with zero; a reconciled filed zero is scoped evidence", () => {
    expect(() => component([], { candidateCoverRows: [] })).toThrow(/no_filed_reports/);
    expect(() => component([], { candidateCoverRows: [cover({ totalContributionsCents: 0, dateReportFiledIso: null })] })).toThrow(/unavailable_report_cover/);
    expect(component([], { candidateCoverRows: [cover({ totalContributionsCents: 0 })] })).toMatchObject({ totalCents: 0, selectedRows: 0 });
  });
  it("excludes other income, but holds unsupported donor roles and unreadable donor amounts", () => {
    expect(component([receipt(), receipt({ shortDescription: "31-A-2 Other Income", amountCents: null })]).totalCents).toBe(10000);
    expect(() => component([receipt(), receipt({ shortDescription: "UNKNOWN", amountCents: 0 })])).toThrow(/unsupported_receipt_role/);
    expect(() => component([receipt(), receipt({ amountCents: null })])).toThrow(/invalid_receipt_money/);
    const a = createOhioCommitteeReceiptAccumulator(input()); expect(() => a.add(receipt(), 2024)).toThrow(/wrong_source_year/);
  });
  it("parses native cents exactly and refuses rounding or unsafe totals", () => {
    expect(strictOhioCommitteeCents("$1,234.5600")).toBe(123456); expect(strictOhioCommitteeCents("-.50")).toBe(-50);
    expect(strictOhioCommitteeCents("")).toBeNull();
    for (const value of [".145", "NaN", "9007199254740992.00", "--1"]) expect(() => strictOhioCommitteeCents(value)).toThrow();
  });
});
