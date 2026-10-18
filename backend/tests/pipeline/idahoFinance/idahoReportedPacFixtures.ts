import { type IdahoPacScope } from "../../../src/pipeline/idahoFinance/idahoReportedPacSource.js";
import type { IdahoPacReceiver } from "../../../src/pipeline/idahoFinance/idahoReportedPacReceiver.js";
export const pacGuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const pacScope: IdahoPacScope = { registrationGuid: pacGuid(1), electionYear: 2026 };
export const pacReceiver: IdahoPacReceiver = { link_id: pacGuid(30), candidate_id: pacGuid(31), election_id: pacGuid(32), election_year: 2026,
  registration_guid: pacScope.registrationGuid, link_source: "sunshine_grid", link_candidate_name: "SYNTHETIC CANDIDATE",
  link_filer_name: "Candidate, Synthetic", link_district: "1", link_office_name: "State Senator", candidate_name: "Synthetic Candidate",
  full_name: "Synthetic Candidate", office_scope: "state_upper", office_name: "State Senator", district_name: "Legislative District 1",
  legislative_district: 1, ballot_title: "State Senator", election_date: "2026-11-03" };
export function pacReceipt(id = 1, name = "Synthetic PAC", amount = 100, subtype = "ITMY", sourceEntityId = 10) {
  return { guid: pacGuid(100 + id), transactionId: id, transactionVersionId: amount < 0 ? 2 : 1,
    filerReportId: 100, filerReportVersionId: 2, filerReportGuid: pacGuid(20), filerRegistrationGuid: pacScope.registrationGuid,
    filerEntityId: 1000, filerName: "Synthetic Candidate", transactionAmount: amount, transactionDate: "10/01/2026",
    transactionTypeCode: "TCON", transactionSubTypeCode: subtype, transactionSourceTypeCode: "TPAC", sourceName: name,
    sourceEntityId, sourceEntityVersionId: 1, electionYear: 2026, isLegacyRecord: false,
    transactionStatusCode: amount < 0 ? "TAMD" : "TFIL", hasChild: false, childCount: 0, publicChildContributionResult: null, rowNo: id, totalRows: 3 };
}
export function idahoPacFixture() {
  const grid = { guid: pacScope.registrationGuid, entityGuid: pacGuid(2), filerEntityID: 1000, filerRegistrationId: 2000,
    filerName: "Candidate, Synthetic", firstName: "Synthetic", middleName: null, lastName: "Candidate", committeeName: "Synthetic Committee",
    office: "State Senator", districtType: "Legislative", cityDistrict: "Legislative District 1", jurisdiction: "Idaho State", seatZone: null,
    politicalParty: null, politicalPartyCode: null, electionYear: "2026", filingCycleId: 6, filerStatus: "Active", filerStatusCode: "ACTV",
    totalRaised: 130, totalSpent: 0, balanceOfFunds: 130, isLegacyRecord: false };
  const state = { rows: [pacReceipt(), pacReceipt(2, "Synthetic PAC", 50), pacReceipt(3, "Synthetic PAC", -20)],
    categoryCents: 13000, categoryUnavailable: false, status: 200, changedProfile: false, changedSummary: false,
    changedReceipts: false, reversedClosing: false, missingFiledSummary: false, profileDistrict: "Legislative, State Senator, Legislative District 1",
    receiptReads: 0, profileReads: 0, summaryReads: 0, categoryReads: 0 };
  const requests: { endpoint: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = new URL(String(input)), body = JSON.parse(String(options?.body)), endpoint = url.pathname.split("/").at(-1)!;
    requests.push({ endpoint, body }); let data: unknown, succeeded = true;
    if (endpoint === "GetCandidateDetails") data = { pageNumber: 0, pageSize: 0, totalItems: 1, items: [grid] };
    else if (endpoint === "GetFilerDetailsById") {
      state.profileReads++; data = { filerRegistrationID: 2000, entityID: state.changedProfile && state.profileReads % 2 === 0 ? 3000 : 1000,
        electionYear: 2026, filerTypeCode: "CAN", registrationStatus: "ACTIVE", officeSought: "State Senator", fullName: "Synthetic Candidate",
        officeDistrictTypeZone: state.profileDistrict, jurisdictionName: "Idaho State" };
    } else if (endpoint === "GetFinancialSummaryDetails") {
      state.summaryReads++; data = { totalContributions: state.changedSummary && state.summaryReads % 2 === 0 ? 131 : 130,
        totalLoansReceived: 0, totalExpenditures: 0, totalIEExpenditures: 0, endBalance: 130,
        filerReportGuid: state.missingFiledSummary ? null : pacGuid(20), lastFilingDate: "2026-10-10T00:00:00" };
    } else if (endpoint === "GetContributionsCategoriesDetails") {
      state.categoryReads++; succeeded = !state.categoryUnavailable;
      data = [{ transactionSourceTypeCode: "TPAC", transactionSourceType: "Political Committee", amount: state.categoryCents / 100 }];
    } else {
      state.receiptReads++; const rows = state.reversedClosing && state.receiptReads % 2 === 0 ? [...state.rows].reverse().map((r, i) => ({ ...r, rowNo: i + 1 })) : state.rows;
      data = { pageNumber: 0, pageSize: 0, totalItems: rows.length + Number(state.changedReceipts && state.receiptReads % 2 === 0), items: rows };
    }
    const response = new Response(state.status === 200 ? JSON.stringify({ succeeded, data: succeeded ? data : null,
      error: succeeded ? null : { code: 990, message: "The specified resource was not found." } }) : "native unavailable", {
      status: state.status, headers: { "content-type": state.status === 200 ? "application/json" : "text/plain" } });
    Object.defineProperty(response, "url", { value: url.href }); return response;
  }) as typeof fetch;
  return { grid, state, requests, fetchImpl };
}
