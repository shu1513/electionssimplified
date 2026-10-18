import { vi } from "vitest";

// All identities, names and financial rows below are synthetic unit fixtures.
export const guid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const envelope = (items: unknown[]) => ({ succeeded: true, data: { items, totalItems: items.length } });
export function nativeFixture() {
  let renamed = false;
  const registration = (n: number) => ({ guid: guid(n), filerEntityId: n, filerName: n === 1000 && renamed ? "Renamed synthetic filer" : `Synthetic filer ${n}`,
    electionId: 10, electionYear: 2026, electionCycle: "2026 Election Cycle", filerStatus: "Active",
    filerTypeCode: n === 1000 ? "CAN" : "PAC", filerSubTypeCode: null, filerSubTypeName: null,
    firstnameLastname: n === 1000 ? "Synthetic Candidate" : null, firstName: n === 1000 ? "Synthetic" : null,
    lastName: n === 1000 ? "Candidate" : null, committeeName: n === 2000 ? "Synthetic Committee" : null,
    officeSoughtName: n === 1000 ? "Governor" : null, districtName: null, town: null });
  const parent = (n: number) => ({ filerReportGuid: guid(n + 2), filerReportVersionID: 2, hasChild: true, isPaperFile: state.paperAmendment });
  const previous = (n: number) => ({ filerReportGuid: guid(n + 1), filerReportVersionID: 1 });
  const row = (id: number, receiver: number, older = false) => ({
    transactionId: id, transactionVersionId: 1, guid: guid(10000 + id), filerEntityId: receiver,
    filerRegistrationGuid: guid(receiver), filerName: `Synthetic filer ${receiver}`,
    filerReportGuid: guid(receiver + (older ? 1 : 2)), filerReportVersionId: older ? 1 : 2,
    transactionAmount: 75, transactionDate: "2026-10-11T00:00:00", electionCycle: "2026 Election Cycle",
    transactionSourceTypeCode: "TPAC", transactionSubTypeCode: "MTCB", sourceName: "Synthetic Committee",
    returnContributions: [], hasChild: false,
  });
  const state = {
    emptyReceiver: false, emptyIe: false, failReceipts: false, changeClosing: false, renameReceiverAfterReceipts: false, paperAmendment: false,
    receipts: [row(1, 1000), row(2, 1000, true), { ...row(3, 1000), transactionSourceTypeCode: "TBSN", sourceName: "Synthetic PAC Business" },
      { ...row(4, 1000), transactionAmount: 25, transactionSubTypeCode: "INKIND", sourceName: "SYNTHETIC COMMITTEE" },
      { ...row(5, 1000), transactionSubTypeCode: "LOAN" }],
    ie: [{ ...row(6, 2000), transactionAmount: 12000, transactionTypeCode: "TIE", transactionSubTypeCode: "TIE",
      transactionStatusCode: "TFIL", candidateMeasure: "Synthetic Candidate", stance: "Support", childCount: 0, returnExpenditures: [] },
      { ...row(7, 2000, true), transactionAmount: 90000, transactionTypeCode: "TIE", transactionSubTypeCode: "TIE",
        transactionStatusCode: "TFIL", candidateMeasure: "Synthetic Candidate", stance: "Support", childCount: 0, returnExpenditures: [] }],
  };
  let profileOrdinal = 0;
  const fetchImpl = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    const path = String(url), body = JSON.parse(String(options?.body));
    let result: unknown;
    let status = 200;
    if (path.endsWith("GetElectionLookupData")) result = { succeeded: true, data: [{ value: 10, name: "2026 Election Cycle" }] };
    else if (path.endsWith("GetFilingEntityDetails")) result = envelope([registration(1000), registration(2000)]);
    else if (path.endsWith("GetPublicContributionDetails")) { result = envelope(state.receipts); if (state.failReceipts) status = 503;
      if(state.renameReceiverAfterReceipts)renamed=true; }
    else if (path.endsWith("GetPublicExpenditureDetails")) result = envelope(state.emptyIe ? [] : state.ie);
    else if (path.endsWith("GetPublicFilerProfileFiling")) {
      const receiver = body.filerRegistrationGuid === guid(1000) ? 1000 : 2000;
      result = envelope(receiver === 1000 && state.emptyReceiver ? [] : [{ ...parent(receiver),
        ...(state.changeClosing ? { reportName: `Synthetic revision ${++profileOrdinal}` } : {}) }]);
    } else if (path.endsWith("GetPublicFilerProfileChildFilingDetails")) {
      result = envelope([previous(body.filerReportGuid === guid(1002) ? 1000 : 2000)]);
    } else throw new Error("Unexpected synthetic public endpoint");
    const response = new Response(JSON.stringify(result), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
    Object.defineProperty(response, "url", { value: path });
    return response;
  }) as unknown as typeof fetch;
  return { state, fetchImpl };
}
