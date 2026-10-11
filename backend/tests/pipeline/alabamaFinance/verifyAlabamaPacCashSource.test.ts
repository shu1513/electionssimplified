import { describe, expect, it } from "vitest";
import { verifyAlabamaPacCashSource, type AlabamaPacCashSourceInput, type AlabamaPacCashSourceRow } from "../../../src/pipeline/alabamaFinance/verifyAlabamaPacCashSource.js";
import type { AlabamaNativeContributionRow } from "../../../src/pipeline/alabamaFinance/alabamaFcpaClient.js";
const cash: AlabamaPacCashSourceRow = { committeeId: "25079", amountCents: 150_000, contributionDate: "09/17/2026", lastName: "Electric Cooperatives of Alabama PAC", firstName: "", contributionId: "1871301", filedDate: "10/02/2026", contributionType: "Cash (Itemized)", contributorType: "PAC", committeeType: "Principal Campaign Committee", committeeName: "", candidateName: "THOMAS JACKSON", amended: "N" };
const native: AlabamaNativeContributionRow = { TRANSACTIONID: 1871301, COMMITTEEID: 206, FILINGDATE: "10/02/2026", CONTRIBUTOR: "Electric Cooperatives of Alabama PAC", CITYSTATE: "Montgomery, AL", ZIP: "36124", CONTRIBUTIONTYPE: "Cash (Itemized)", DESCRIPTION: "", AMOUNT: 1500, TRANSACTIONDATE: "09/17/2026", RECIPIENTNAME: "THOMAS E ACTION JACKSON" };
function fixture(overrides: Partial<AlabamaPacCashSourceInput> = {}): AlabamaPacCashSourceInput {
  const filing = { ID: 175978, DESCRIPTION: "2026 ELECTION CYCLE Monthly Report", PERIODBEGIN: "09/01/2026", PERIODEND: "09/30/2026", DUEDATE: "10/02/2026", FILEDDATE: "10/02/2026 09:49 AM", AMENDED: "No", STATUS: "Filed" };
  return { cashRows: [{ ...cash }], committeeRegistryRows: [{ id: 206, committeeId: "25079", committeeType: "1", candidateFirstName: "THOMAS", candidateMiddleName: "E ACTION", candidateLastName: "JACKSON" }, { id: 33, committeeId: "24906", committeeType: "2", committeeName: cash.lastName }], fcpaCommitteeNumber: "25079", internalCommitteeId: 206, windowStart: "2023-01-01", windowEnd: "2026-12-31", nativeAllBefore: [{ ...native }], nativeAllAfter: [{ ...native }], nativePacBefore: [{ ...native }], nativePacAfter: [{ ...native }], filingsBefore: [{ ...filing }], filingsAfter: [{ ...filing }], coversCashCents: 150_000, authoritativeCoverCount: 1, ...overrides };
}
function preserve(input: AlabamaPacCashSourceInput) { const result = verifyAlabamaPacCashSource(input); expect(result.pacDonors).toBeUndefined(); expect(result.diagnostics.length).toBeGreaterThan(0); }
function sourceRows(rows: AlabamaNativeContributionRow[], cashRows: AlabamaPacCashSourceRow[], amount: number): AlabamaPacCashSourceInput {
  return fixture({ nativeAllBefore: rows, nativeAllAfter: structuredClone(rows), nativePacBefore: rows.filter((r) => r.TRANSACTIONID === native.TRANSACTIONID), nativePacAfter: structuredClone(rows.filter((r) => r.TRANSACTIONID === native.TRANSACTIONID)), cashRows, coversCashCents: amount });
}
describe("verifyAlabamaPacCashSource", () => {
  it("accepts exact current native/bulk identities and cover sum before donor aggregation", () => {
    expect(verifyAlabamaPacCashSource(fixture()).pacDonors?.[0]).toMatchObject({ committeeId: "24906", amount: 1500, contributionCount: 1 });
  });

  it("allows observed historical null non-itemized donors outside the term while retaining their raw fingerprints", () => {
    const historical = { ...native, TRANSACTIONID: 826354, TRANSACTIONDATE: "06/22/2018", CONTRIBUTOR: null, CONTRIBUTIONTYPE: "Cash (Non-Itemized)" };
    const input = sourceRows([native, historical], [cash], 150_000);
    expect(verifyAlabamaPacCashSource(input).pacDonors?.[0]?.amount).toBe(1500);
    preserve({ ...input, nativeAllAfter: [native, { ...historical, CONTRIBUTOR: "" }] });
    preserve(sourceRows([native, { ...historical, TRANSACTIONDATE: "06/32/2018" }], [cash], 150_000));
  });

  it("retains historical omitted donors while distinguishing absent and null metadata", () => {
    const { CONTRIBUTOR: _donor, ...withoutDonor } = native;
    const historical = { ...withoutDonor, TRANSACTIONID: 845793, TRANSACTIONDATE: "08/09/2018", CONTRIBUTIONTYPE: "Cash (Non-Itemized)" };
    const input = sourceRows([native, historical], [cash], 150_000);
    expect(verifyAlabamaPacCashSource(input).pacDonors?.[0]?.amount).toBe(1500);
    preserve({ ...input, nativeAllAfter: [native, { ...historical, CONTRIBUTOR: null }] });
    preserve(sourceRows([native, { ...historical, TRANSACTIONDATE: "08/32/2018" }], [cash], 150_000));
  });

  it.each([null, undefined])("preserves current unnamed non-itemized donors until an explicit anonymous identity contract is verified: %s", (CONTRIBUTOR) => {
    const anonymous = { ...native, TRANSACTIONID: 2, CONTRIBUTOR, CONTRIBUTIONTYPE: "Cash (Non-Itemized)", AMOUNT: 100 };
    const bulk = { ...cash, contributionId: "2", lastName: "", contributionType: "Cash (Non-Itemized)", contributorType: "Anonymous", amountCents: 10_000 };
    const result = verifyAlabamaPacCashSource(sourceRows([native, anonymous], [cash, bulk], 160_000));
    expect(result.pacDonors).toBeUndefined();
    expect(result.diagnostics).toContain("Unresolved Alabama current non-itemized donor identity");
  });
  it("does not equate latest bulk FiledDate with original native filing date or Amended flag", () => {
    expect(verifyAlabamaPacCashSource(fixture({ cashRows: [{ ...cash, filedDate: "07/07/2026", amended: "Y" }] })).pacDonors?.[0]?.amount).toBe(1500);
  });
  it.each(["CITYSTATE", "ZIP", "DESCRIPTION", "RECIPIENTNAME", "CONTRIBUTOR", "FILINGDATE"] as const)("preserves whole component on changed full-native %s metadata", (key) => {
    preserve(fixture({ nativeAllAfter: [{ ...native, [key]: "changed" }] }));
  });
  it("fingerprints all source keys, including unknown keys and source-omitted optional metadata", () => {
    preserve(fixture({ nativeAllAfter: [{ ...native, extraSourceField: "changed" } as AlabamaNativeContributionRow] }));
    const noDescription = { ...native }; delete noDescription.DESCRIPTION;
    preserve(fixture({ nativeAllAfter: [noDescription] }));
    expect(verifyAlabamaPacCashSource(fixture({ nativeAllBefore: [noDescription], nativeAllAfter: [noDescription], nativePacBefore: [noDescription], nativePacAfter: [noDescription] })).pacDonors?.[0]?.amount).toBe(1500);
  });
  it("requires full filing metadata and filtered PAC source to remain stable", () => {
    const input = fixture();
    preserve({ ...input, filingsAfter: [{ ...input.filingsAfter[0]!, AMENDED: "Yes" }] });
    preserve({ ...input, nativePacAfter: [] });
    preserve({ ...input, filingsAfter: [] });
  });
  it("accepts harmless array/object order changes while retaining every row's identity", () => {
    const other = { ...native, TRANSACTIONID: 2, CONTRIBUTOR: "BUSINESS LLC" };
    const input = sourceRows([native, other], [cash, { ...cash, contributionId: "2", lastName: "BUSINESS LLC", contributorType: "Group/Business/Corporation" }], 300_000);
    input.nativeAllAfter = [Object.fromEntries(Object.entries(other).reverse()) as AlabamaNativeContributionRow, native];
    expect(verifyAlabamaPacCashSource(input).pacDonors?.[0]?.amount).toBe(1500);
  });
  it("rejects repeated native, PAC, filing and cached IDs even if identical", () => {
    const input = fixture();
    preserve({ ...input, nativeAllBefore: [native, native], nativeAllAfter: [native, native] });
    preserve({ ...input, nativePacBefore: [native, native], nativePacAfter: [native, native] });
    preserve({ ...input, filingsBefore: [input.filingsBefore[0]!, input.filingsBefore[0]!], filingsAfter: [input.filingsBefore[0]!, input.filingsBefore[0]!] });
    preserve({ ...input, cashRows: [cash, cash] });
  });
  it("requires the PAC filter to be an identical subset of full-native rows", () => {
    preserve(fixture({ nativePacBefore: [{ ...native, ZIP: "different" }], nativePacAfter: [{ ...native, ZIP: "different" }] }));
    preserve(fixture({ nativePacBefore: [{ ...native, TRANSACTIONID: 2 }], nativePacAfter: [{ ...native, TRANSACTIONID: 2 }] }));
  });
  it("checks cash ID sets both ways, including a same-dollar removed/replacement gift", () => {
    preserve(fixture({ cashRows: [] }));
    preserve(fixture({ nativeAllBefore: [], nativeAllAfter: [], nativePacBefore: [], nativePacAfter: [] }));
    preserve(fixture({ cashRows: [{ ...cash, contributionId: "2" }] }));
  });
  it.each([{ amountCents: 149_999 }, { contributionDate: "09/18/2026" }, { contributionType: "Cash (Non-Itemized)" }, { lastName: "RENAMED PAC" }, { contributorType: "Group/Business/Corporation" }])("preserves same-ID source identity disagreement: %j", (change) => preserve(fixture({ cashRows: [{ ...cash, ...change }] })));
  it("checks both directions of native typed PAC membership", () => {
    preserve(fixture({ nativePacBefore: [], nativePacAfter: [] }));
    preserve(fixture({ cashRows: [{ ...cash, contributorType: "Other" }] }));
  });
  it("requires original full Individual MI/suffix and detects equal-money donor rename", () => {
    const person = { ...native, TRANSACTIONID: 2, CONTRIBUTOR: "Jane Q Doe JR", AMOUNT: 500 };
    const personalCash = { ...cash, contributionId: "2", amountCents: 50_000, firstName: "Jane", lastName: "Doe", contributorType: "Individual", middleName: "Q", suffix: "JR" };
    expect(verifyAlabamaPacCashSource(sourceRows([native, person], [cash, personalCash], 200_000)).pacDonors?.[0]?.amount).toBe(1500);
    const truncated: AlabamaPacCashSourceRow = { ...personalCash }; delete truncated.middleName; delete truncated.suffix;
    preserve(sourceRows([native, person], [cash, truncated], 200_000));
    preserve(sourceRows([native, person], [cash, { ...personalCash, lastName: "Changed" }], 200_000));
  });
  it.each([
    { id: 1645537, raw: "TriMed Billing Solutions  LLC", displayed: "TriMed Billing Solutions, LLC" },
    { id: 1857107, raw: "R.F. Barganier  LLC", displayed: "R.F. Barganier, LLC" },
  ])("accepts observed organization punctuation projection $id without changing raw source fingerprints", ({ id, raw, displayed }) => {
    const organization = { ...native, TRANSACTIONID: id, CONTRIBUTOR: displayed, AMOUNT: 500 };
    const bulk = { ...cash, contributionId: String(id), lastName: raw, amountCents: 50_000, contributorType: "Group/Business/Corporation" };
    expect(verifyAlabamaPacCashSource(sourceRows([native, organization], [cash, bulk], 200_000)).pacDonors?.[0]?.amount).toBe(1500);
    const changed = sourceRows([native, organization], [cash, bulk], 200_000);
    changed.nativeAllAfter = [native, { ...organization, CONTRIBUTOR: raw }];
    preserve(changed);
  });
  it.each([
    { raw: "TriMed Billing Solutions LLC", displayed: "TriMed Billing Services, LLC" },
    { raw: "TriMed Billing Solutions LLC", displayed: "Tri Med Billing Solutions, LLC" },
    { raw: "R.F. Barganier LLC", displayed: "R.G. Barganier, LLC" },
    { raw: "R.F. Barganier LLC", displayed: "RF Barganier, LLC" },
  ])("preserves changed organization words, letters or tokens: $displayed", ({ raw, displayed }) => {
    const organization = { ...native, TRANSACTIONID: 2, CONTRIBUTOR: displayed, AMOUNT: 500 };
    const bulk = { ...cash, contributionId: "2", lastName: raw, amountCents: 50_000, contributorType: "Group/Business/Corporation" };
    const result = verifyAlabamaPacCashSource(sourceRows([native, organization], [cash, bulk], 200_000));
    expect(result.pacDonors).toBeUndefined();
    expect(result.diagnostics[0]).toContain(`contribution 2, cached donor ${raw}, native donor ${displayed}`);
  });
  it("does not apply organization punctuation projection to an Individual or drop their suffix", () => {
    const person = { ...native, TRANSACTIONID: 2, CONTRIBUTOR: "Jane Q Doe JR", AMOUNT: 500 };
    const bulk = { ...cash, contributionId: "2", amountCents: 50_000, firstName: "Jane", middleName: "Q.", lastName: "Doe", suffix: "JR", contributorType: "Individual" };
    preserve(sourceRows([native, person], [cash, bulk], 200_000));
    preserve(sourceRows([native, { ...person, CONTRIBUTOR: "Jane Q. Doe" }], [cash, bulk], 200_000));
  });
  it("accepts explicitly empty original middle/suffix fields, never assumes they were empty", () => {
    const person = { ...native, TRANSACTIONID: 2, CONTRIBUTOR: "Jane Doe", AMOUNT: 0.29 };
    const personalCash = { ...cash, contributionId: "2", amountCents: 29, firstName: "Jane", lastName: "Doe", contributorType: "Individual", middleName: "", suffix: "" };
    expect(verifyAlabamaPacCashSource(sourceRows([native, person], [cash, personalCash], 150_029)).pacDonors?.[0]?.amount).toBe(1500);
  });
  it.each(["Refund", "ReturnContribution/Check", "Return Contribution/Check", "Unknown", "Non-Itemized Employee Payroll Contribution (Cash)"])("preserves unresolved native category %s instead of guessing an alias", (category) => {
    const row = { ...native, TRANSACTIONID: 2, CONTRIBUTIONTYPE: category };
    preserve(sourceRows([native, row], [cash], 150_000));
  });
  it.each(["Loan", "Interest", "Other (Itemized)", "Other (Non-Itemized)", "In-Kind (Itemized)"])("excludes verified native noncash %s without adding PAC or Raised", (category) => {
    const row = { ...native, TRANSACTIONID: 2, CONTRIBUTIONTYPE: category };
    expect(verifyAlabamaPacCashSource(sourceRows([native, row], [cash], 150_000)).pacDonors?.[0]?.amount).toBe(1500);
  });
  it("preserves positive returned, negative cash and native possible-return markers", () => {
    preserve(fixture({ cashRows: [{ ...cash, contributorType: "Returned (Cash Only)" }] }));
    const negative = { ...native, AMOUNT: -1500 };
    preserve(fixture({ nativeAllBefore: [negative], nativeAllAfter: [negative], nativePacBefore: [negative], nativePacAfter: [negative], cashRows: [{ ...cash, amountCents: -150_000 }] }));
    const returned = { ...native, DESCRIPTION: "Offset due to deletion of filed item" };
    preserve(fixture({ nativeAllBefore: [returned], nativeAllAfter: [returned], nativePacBefore: [returned], nativePacAfter: [returned] }));
  });
  it("requires safe exact cents and exact cover cash with no97–101percent tolerance", () => {
    preserve(fixture({ coversCashCents: 150_001 }));
    preserve(fixture({ coversCashCents: Number.MAX_SAFE_INTEGER + 1 }));
    const unsafe = { ...native, AMOUNT: 1500.001 };
    preserve(fixture({ nativeAllBefore: [unsafe], nativeAllAfter: [unsafe], nativePacBefore: [unsafe], nativePacAfter: [unsafe] }));
  });
  it("requires source-authoritative current cover even for empty cash", () => {
    const empty = fixture({ cashRows: [], nativeAllBefore: [], nativeAllAfter: [], nativePacBefore: [], nativePacAfter: [], coversCashCents: 0 });
    expect(verifyAlabamaPacCashSource(empty)).toEqual({ pacDonors: [], diagnostics: [] });
    preserve({ ...empty, authoritativeCoverCount: 0 });
    preserve({ ...empty, filingsBefore: [], filingsAfter: [] });
  });
  it("requires covers for every current filed report, including missing zero-cash covers", () => {
    const input = fixture();
    const second = { ...input.filingsBefore[0]!, ID: 175979, PERIODBEGIN: "08/01/2026", PERIODEND: "08/31/2026" };
    preserve({ ...input, filingsBefore: [...input.filingsBefore, second], filingsAfter: [...input.filingsAfter, second] });
    expect(verifyAlabamaPacCashSource({ ...input, filingsBefore: [...input.filingsBefore, second], filingsAfter: [...input.filingsAfter, second], authoritativeCoverCount: 2 }).pacDonors?.[0]?.amount).toBe(1500);
  });
  it("does not accept supplied unfiled or unknown status as a current authoritative cover", () => {
    const input = fixture();
    for (const STATUS of ["Unfiled", "Pending", null]) {
      const filing = { ...input.filingsBefore[0]!, STATUS };
      preserve({ ...input, filingsBefore: [filing], filingsAfter: [filing] });
    }
  });
  it("requires both public/internal namespaces to match the source registry", () => {
    preserve(fixture({ internalCommitteeId: 33 }));
    preserve(fixture({ fcpaCommitteeNumber: "206" }));
    const wrong = { ...native, COMMITTEEID: 33 };
    preserve(fixture({ nativeAllBefore: [wrong], nativeAllAfter: [wrong], nativePacBefore: [wrong], nativePacAfter: [wrong] }));
  });
  it("retains distinct equal gift IDs through whole-cash reconciliation", () => {
    const second = { ...native, TRANSACTIONID: 2 };
    expect(verifyAlabamaPacCashSource(fixture({ cashRows: [cash, { ...cash, contributionId: "2" }], nativeAllBefore: [native, second], nativeAllAfter: [native, second], nativePacBefore: [native, second], nativePacAfter: [native, second], coversCashCents: 300_000 })).pacDonors?.[0]).toMatchObject({ amount: 3000, contributionCount: 2 });
  });
});
