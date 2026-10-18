import { vi } from "vitest";
import type { NorthDakotaReportedReceiver } from "../../../src/pipeline/northDakotaFinance/northDakotaReportedStore.js";
export const ndReportedTestReceiver: NorthDakotaReportedReceiver = {
  linkId: "11111111-1111-4111-8111-111111111111", candidateId: "22222222-2222-4222-8222-222222222222", electionId: "33333333-3333-4333-8333-333333333333",
  electionYear: 2026, electionDate: "2026-11-03", candidateName: "Jane Example", officeScope: "state_upper", canonicalOffice: "State Senator", canonicalDistrict: "1",
  entityId: "1010000002", committeeName: "Friends of Example", linkSource: "cfrs_registry", linkOffice: "State Senator", linkDistrict: "District 1",
};
const registry = [ { orgID: 2, entityId: "1010000002", orgName: "Friends of Example", candidateName: "Example, Jane", orgType: "Candidate/Candidate Committee", orgTypeCode: "101", orgStatus: "Active", election: "2026 Election - Statewide", office: "State Senator", district: "District 1" },{ orgID: 1, entityId: "1040000001", orgName: "Example IE Committee", candidateName: null, orgType: "Independent Expenditure Committee", orgTypeCode: "104", orgStatus: "Active" }];
const transaction = {
  transactionID: 1, entityID: "1040000001", orgID: 1, committeeName: "Example IE Committee", candidateName: null,
  transactionAmount: 100, transactionDate: "2026-09-01T00:00:00", entityTypeDesc: "Business or Organization", transactionTypeDesc: "Independent Expenditures",
  contributorPayeeName: "Example Vendor", contributorPayeeID: 99, transactionTotalYTD: "100.0000", orgType: "Independent Expenditure Committee",
  candidateNameAssocation: "Example, Jane", stanceDescription: "Support", electionYear: 2026, untouchedNativeField: "must be compared",
};
const charts = [
  { name: "By Recipient Type", totalAmount: 100, data: [{ description: "Business or Organization", amount: 100 }] },
  { name: "By Committee Type", totalAmount: 100, data: [{ description: "Independent Expenditure Committee", amount: 100 }] },
  { name: "By Purpose Type", totalAmount: 0, data: [] },
];
export function northDakotaReportedIeFixture(options: { changeClosing?: boolean; chartCents?: number; duplicate?: boolean; nativeCount?: number } = {}) {
  let currentCalls = 0;
  const calls: { url: string; body: any }[] = [];
  const fetchImpl = vi.fn(async (url: any, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null; calls.push({ url: String(url), body });
    let data: any;
    if (String(url).endsWith("getPublicCandidatesCommitteeDataList")) data = { totalRecords: registry.length, data: registry };
    else if (String(url).endsWith("getAllPublicTransactionDataList")) {
      if (body.transactionCategory !== "IE" || body.orgTypeCode !== "104") throw Error("unexpected_contribution_dependency");
      const current = body.transactionYear === "2026";
      if (current) currentCalls++;
      const row = { ...transaction, ...(options.changeClosing && currentCalls > 1 ? { untouchedNativeField: "changed" } : {}) };
      const rows = current ? options.duplicate ? [row, row] : [row] : [];
      data = { totalRecords: current ? options.nativeCount ?? rows.length : 0, data: rows };
    } else if (String(url).endsWith("getIndependentExpenditureChartData")) data = charts.map(s => ({ ...s, ...(s.name !== "By Purpose Type" && options.chartCents !== undefined ? { totalAmount: options.chartCents / 100 } : {}) }));
    else throw Error("unexpected_direct_dependency");
    return new Response(" " + JSON.stringify({ isSuccess: true, responseData: data }) + "\n", { headers: { "content-type": "application/json" } });
  });
  return { fetchImpl, calls };
}

export function northDakotaReportedCommitteeFixture(options: { badDonor?: boolean; truncatedFile?: boolean } = {}) {
  const candidates = [registry[0], { orgID: 3, entityId: "1020000003", orgName: "Example PAC", candidateName: null, orgType: "Committee/PAC", orgTypeCode: "102", orgStatus: "Active" }];
  const catalog = [["Reporting Schedules", 2026], ["Reporting Schedules", 2027], ["Contributions", 2025], ["Contributions", 2026], ["Filed reports", 2026]].map(([dataType, year], i) => ({ id: i + 1, dataType, year: String(year), s3ReportFilePath: `native-file-${i}` }));
  const conHeader = "RegistrantID,CommitteeName,CandidateName,TransactionType,TransactionCategory,TransactionDate,TransactionAmount,ContributorPayeeType,ContributorPayeeName,ContributorAddress,EmployerName,FiledDate";
  const scheduleHeader = "ElectionName,ReportingCycle,ReportingPeriodDescription,FormType,ReportType,BeginDate,Enddate,DueDate";
  const files = [
    scheduleHeader + "\n2026 Election - Statewide,2025 REPORTING CYCLE,2025 Year End Report,Campaign Financial Statement,Year End,2025-01-01,2025-12-31,2026-01-31\n",
    scheduleHeader + "\n2026 Election - Statewide,2026 Reporting Cycle,2026 Year End Report,Campaign Financial Statement,Year End,2026-01-01,2026-12-31,2027-01-31\n",
    conHeader + "\n",
    conHeader + `\n1010000002,Friends of Example,Jane Example,Contributions,Monetary,2026-09-01,100.0000,Committee/PAC,${options.badDonor ? "Different PAC" : "Example PAC"},,,2026-10-01\n`,
    "RegistrantID,CommitteeName,CandidateName,ReportName,ReportType,StartDate,EndDate,DueDate,FiledDate,ReportVersion\n1010000002,Friends of Example,Jane Example,Campaign Financial Statement,Pre-General,2026-01-01,2026-09-24,2026-10-02,2026-10-01,Original\n",
  ];
  const row = { ...transaction, transactionID: 2, entityID: "1010000002", orgID: 2, committeeName: "Friends of Example", candidateName: "Example, Jane",
    transactionTypeDesc: "Contributions", transactionCategoryDesc: "Monetary", entityTypeDesc: "Committee/PAC", contributorPayeeName: "Example PAC", employerName: null, filedDate: "2026-10-01", orgType: "Candidate/Candidate Committee" };
  const charts = [
    { name: "By Contributor Type", totalAmount: 100, data: [{ description: "Committee/PAC", amount: 100 }] },
    { name: "By Committee Type", totalAmount: 100, data: [{ description: "Candidate/Candidate Committee", amount: 100 }] },
    { name: "By Contribution Type", totalAmount: 100, data: [{ description: "Monetary", amount: 100 }] },
  ];
  const fetchImpl = vi.fn(async (url: any, init?: RequestInit) => {
    const u = new URL(String(url)), body = init?.body ? JSON.parse(String(init.body)) : null;
    if (u.hostname.endsWith("amazonaws.com")) {
      const text = files[Number(u.pathname.slice(1)) - 1]!;
      return new Response(text, { headers: { "content-type": "text/csv", "content-length": String(Buffer.byteLength(text) + (options.truncatedFile ? 1 : 0)) } });
    }
    let data: any;
    if (u.pathname.endsWith("getPublicCandidatesCommitteeDataList")) data = { totalRecords: candidates.length, data: candidates };
    else if (u.pathname.endsWith("getAllPublicTransactionDataList")) { if (body.transactionCategory !== "CON" || body.orgTypeCode !== undefined) throw Error("wrong_source_selector"); const rows = body.transactionYear === "2026" ? [row] : []; data = { totalRecords: rows.length, data: rows }; }
    else if (u.pathname.endsWith("getDataDownloadDataList")) data = { totalRecords: catalog.length, data: catalog };
    else if (u.pathname.includes("getDataDownloadfile/")) data = { fileUrl: `https://example.s3.us-gov-west-1.amazonaws.com/${u.pathname.split("/").at(-1)}?temporary=secret` };
    else if (u.pathname.endsWith("getContributionChartData")) data = charts;
    else throw Error("unexpected_ie_dependency");
    return new Response(JSON.stringify({ isSuccess: true, responseData: data }), { headers: { "content-type": "application/json" } });
  });
  return { fetchImpl };
}
