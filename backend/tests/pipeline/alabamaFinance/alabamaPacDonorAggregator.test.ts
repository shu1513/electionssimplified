import { describe, expect, it } from "vitest";
import { aggregateAlabamaPacDonors } from "../../../src/pipeline/alabamaFinance/alabamaPacDonorAggregator.js";
import type { AlabamaCashRow } from "../../../src/pipeline/alabamaFinance/alabamaFcpaCsv.js";
import type { AlabamaCommitteeRegistryRow } from "../../../src/pipeline/alabamaFinance/alabamaFcpaClient.js";
const pac: AlabamaCommitteeRegistryRow = { id: 33, committeeId: "24906", committeeType: "2", committeeName: "Electric Cooperatives of Alabama PAC", committeeStatus: "Active" };
const pcc: AlabamaCommitteeRegistryRow = { id: 206, committeeId: "25079", committeeType: "1", candidateFirstName: "THOMAS", candidateMiddleName: "E ACTION", candidateLastName: "JACKSON" };
function gift(overrides: Partial<AlabamaCashRow> = {}): AlabamaCashRow {
  return { committeeId: "25079", amountCents: 150_000, contributionDate: "09/17/2026", lastName: "ELECTRIC COOPERATIVES OF ALABAMA PAC", firstName: "", contributionId: "1871301", filedDate: "10/02/2026", contributionType: "Cash (Itemized)", contributorType: "PAC", committeeType: "Principal Campaign Committee", committeeName: "", candidateName: "THOMAS JACKSON", amended: "N", ...overrides };
}
function aggregate(cashRows: readonly AlabamaCashRow[], registry: readonly AlabamaCommitteeRegistryRow[] = [pac, pcc]) {
  return aggregateAlabamaPacDonors({ cashRows, committeeRegistryRows: registry, fcpaCommitteeNumber: "25079", windowStart: "2023-01-01", windowEnd: "2026-12-31" });
}
function preserved(result: ReturnType<typeof aggregate>) { expect(result.pacDonors).toBeUndefined(); expect(result.diagnostics).not.toHaveLength(0); }
describe("aggregateAlabamaPacDonors", () => {
  it("retains actual Jackson gift with donor public ID and exact native registry link", () => {
    expect(aggregate([gift()])).toEqual({ diagnostics: [], pacDonors: [{ committeeId: "24906", committeeName: pac.committeeName, committeeType: "Political Action Committee", amount: 1500, contributionCount: 1, sourceUrl: "https://fcpa.alabamavotes.gov/page.request.do?page=page.acfPublicCommitteeDetails&type=cGFj&id=MzM%3D" }] });
  });
  it("counts equal gifts with different IDs and collapses only identical ID duplicates", () => {
    expect(aggregate([gift(), gift({ contributionId: "1871302" }), { ...gift() }]).pacDonors?.[0]).toMatchObject({ amount: 3000, contributionCount: 2 });
  });
  it.each([{ amountCents: 149_999 }, { lastName: "OTHER PAC" }, { contributorType: "Individual" }, { contributionDate: "09/18/2026" }, { amended: "Y" }])("preserves conflicting contribution ID: %j", (change) => preserved(aggregate([gift(), gift(change)])));
  it("retains dissolved PAC and normalized exact name, but does not strip PAC suffix", () => {
    expect(aggregate([gift({ lastName: "  Electric   Cooperatives of Alabama PAC " })], [{ ...pac, committeeStatus: "Dissolved" }, pcc]).pacDonors?.[0]?.amount).toBe(1500);
    preserved(aggregate([gift({ lastName: "Electric Cooperatives of Alabama" })]));
  });
  it("checks all-types/all-status name ambiguity before eligibility", () => {
    preserved(aggregate([gift()], [pac, { ...pcc, committeeName: pac.committeeName, committeeStatus: "Dissolved" }]));
    preserved(aggregate([gift()], [pac, { ...pac, id: 34, committeeId: "24907", committeeStatus: "Dissolved" }, pcc]));
  });
  it("preserves the whole component for one unknown or malformed explicit PAC donor", () => {
    preserved(aggregate([gift(), gift({ contributionId: "2", lastName: "UNREGISTERED PAC" })]));
    preserved(aggregate([gift({ firstName: "Joe" })]));
  });
  it("excludes known PCC, self, business, individual, in-kind and nonitemized cash", () => {
    expect(aggregate([
      gift({ contributionId: "1", lastName: "THOMAS E ACTION JACKSON" }), gift({ contributionId: "2", lastName: "SUPPORT PAC" }),
      gift({ contributionId: "3", contributorType: "Group/Business/Corporation" }), gift({ contributionId: "4", contributorType: "Individual", firstName: "Jane" }),
      gift({ contributionId: "5", contributionType: "In-Kind (Itemized)" }), gift({ contributionId: "6", contributionType: "Cash (Non-Itemized)" }),
      gift({ contributionId: "7", contributionType: "Non-Itemized Employee Payroll Contribution", contributorType: "" }),
    ], [pac, { ...pcc, committeeName: "SUPPORT PAC" }]).pacDonors).toEqual([]);
  });
  it("keeps source-typed party organization legally registered as PAC", () => {
    const party = { ...pac, committeeName: "County Republican Executive Committee" };
    expect(aggregate([gift({ lastName: party.committeeName })], [party, pcc]).pacDonors?.[0]?.amount).toBe(1500);
  });
  it.each([{ contributorType: "Returned (Cash Only)" }, { amountCents: -50_000, contributorType: "Group/Business/Corporation" }, { contributionType: "ReturnContribution/Check" }, { contributionType: "Refund" }, { contributionType: "Loan" }, { contributionType: "Other (Itemized)" }, { contributorType: "Unverified" }])("preserves all PACs on unresolved current cash: %j", (change) => preserved(aggregate([gift(), gift({ contributionId: "2", ...change })])));
  it("does not select currentness by Amended flags or source filing day", () => {
    expect(aggregate([gift({ amended: "Y", filedDate: "04/02/2026" })]).pacDonors?.[0]?.amount).toBe(1500);
  });
  it("applies inclusive transaction window and receiving identity before return gates", () => {
    expect(aggregate([gift({ contributionDate: "01/01/2023" }), gift({ contributionId: "2", contributionDate: "12/31/2026" }), gift({ contributionId: "3", contributionDate: "12/31/2022", contributorType: "Returned (Cash Only)" }), gift({ contributionId: "4", contributionDate: "01/01/2027", amountCents: -500 }), gift({ contributionId: "5", committeeId: "33927", contributorType: "Returned (Cash Only)" })]).pacDonors?.[0]).toMatchObject({ amount: 3000, contributionCount: 2 });
  });
  it.each([{ amountCents: Number.MAX_SAFE_INTEGER + 1 }, { amountCents: 0.5 }, { contributionId: "" }, { contributionDate: "02/30/2026" }])("preserves invalid identity/date/cents: %j", (change) => preserved(aggregate([gift(change)])));
  it("rejects unsafe sums within and across donors", () => {
    preserved(aggregate([gift({ amountCents: Number.MAX_SAFE_INTEGER }), gift({ contributionId: "2", amountCents: 1 })]));
    preserved(aggregate([gift({ amountCents: Number.MAX_SAFE_INTEGER }), gift({ contributionId: "2", amountCents: 1, lastName: "OTHER PAC" })], [pac, pcc, { ...pac, id: 34, committeeId: "24907", committeeName: "OTHER PAC" }]));
  });
  it("collapses identical registry duplicates but rejects conflicting identity metadata", () => {
    expect(aggregate([gift()], [pac, { ...pac }, pcc]).pacDonors?.[0]?.amount).toBe(1500);
    for (const changed of [{ ...pac, committeeName: "RENAMED" }, { ...pac, id: 34 }, { ...pac, committeeId: "24907" }]) preserved(aggregate([gift()], [pac, changed, pcc]));
    preserved(aggregate([gift()], []));
  });
  it("explicit zero requires caller-verified input and valid registry", () => {
    expect(aggregate([])).toEqual({ pacDonors: [], diagnostics: [] });
    expect(aggregate([gift({ amountCents: 0 })]).pacDonors).toEqual([]);
  });
});
