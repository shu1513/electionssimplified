import { DC_RECEIPT_HEADERS } from "../../../src/pipeline/districtOfColumbiaFinance/dcCommitteeNative.js";
import type { DcCommitteeReceiver } from "../../../src/pipeline/districtOfColumbiaFinance/dcCommitteeReceiver.js";
export const receiver: DcCommitteeReceiver = {
  linkId: "00000000-0000-4000-8000-000000000001",
  candidateId: "00000000-0000-4000-8000-000000000002",
  electionId: "00000000-0000-4000-8000-000000000003",
  electionYear: 2026,
  electionDate: "2026-11-03",
  receivingKey: "SYNTHETIC RECEIVER",
  legacyCommitteeName: "Synthetic Receiver",
  candidateAliases: ["Jordan A Example", "Jordan Example"],
  officeScope: "place",
  officeName: "Mayor",
  linkOfficeName: "Mayor",
  district: null,
  ballotTitle: "Mayor of the District of Columbia",
  canonicalDistrictName: "Washington city, District of Columbia",
  canonicalDistrictType: "place",
  activeCandidateOwnerCount: 1,
};
export function syntheticNative() {
  const registry = [
    {
      Id: 1,
      CommitteeId: 1,
      CommitteeKey: "PUBLIC-COMMITTEE-1",
      CandidateKey: "PUBLIC-PERSON-1",
      CommitteeName: "Synthetic Receiver",
      CandidateName: "Jordan A Example",
      ElectionYear: 2026,
      ElectionDescription: "Primary Election",
      Office: "Mayor",
      FilerTypeId: 2,
      CandidateApproved: true,
      CommitteeApproved: true,
      TerminationApproved: false,
    },
  ];
  const receipts: Record<string, unknown>[] = [
    ["Synthetic Labor PAC", "Labor Sponsored PAC", "A2", 12.34, "Check"],
    ["Synthetic Party", "Democratic", "A1", 5, "InKind"],
    ["Synthetic Authorized Committee", "Committee", "A4", 7, "Other"],
    ["Casey Donor", "Individual", "A", 1.25, "Cash"],
  ].map(
    (
      [ContributorName, ContributorType, ScheduleCode, Amount, TransactionType],
      i,
    ) => ({
      Id: i + 1,
      ScheduleMasterId: 2,
      CommitteeKey: "PUBLIC-COMMITTEE-1",
      CandidateKey: "PUBLIC-PERSON-1",
      CommitteeName: "Synthetic Receiver",
      CandidateName: "Jordan A Example",
      ElectionYear: 2026,
      FilingYear: 2026,
      ReportName: "October Report",
      Version: 1,
      TransactionDate: "2026-10-01T00:00:00",
      Amount,
      ScheduleCode,
      ScheduleGroup: "Contributions",
      FilerTypeId: 2,
      ContributorName,
      ContributorType,
      TransactionType,
      Street: "Synthetic Street",
      City: "Washington",
      State: "DC",
      ZipCode: "20001",
      Employer: "",
      EmployerAddress: "",
      Occupation: "",
    }),
  );
  const parents = [0, 1].map((Version) => ({
    ScheduleMasterId: Version + 1,
    CommitteeKey: "PUBLIC-COMMITTEE-1",
    CandidateKey: "PUBLIC-PERSON-1",
    FilingYear: 2026,
    FilerTypeReportId: 7,
    ReportName: "October Report",
    ReportStatus: Version ? " Amendment1" : " Original",
    FilerTypeId: 2,
    Section: 1,
  }));
  return { registry, receipts, parents };
}
export function syntheticCsv(receipts: Record<string, unknown>[]): Buffer {
  const quote = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = receipts.map((r) => {
    const individual = r.ContributorType === "Individual";
    const v: Record<string, unknown> = {
      "Committee Name": r.CommitteeName,
      "Candidate Name": r.CandidateName,
      "Contributor First Name": individual ? "Casey" : "",
      "Contributor Middle Name": individual ? "A" : "",
      "Contributor Last Name": individual ? "Donor" : "",
      "Contributor Organization Name": individual ? "" : r.ContributorName,
      "Contributor Street": r.Street,
      "Contributor City": r.City,
      "Contributor State": r.State,
      "Contributor ZipCode": r.ZipCode,
      "Contributor Type": r.ContributorType,
      "Contribution Type": r.TransactionType,
      "Employer Name": r.Employer,
      "Employer Address": r.EmployerAddress,
      Occupation: r.Occupation,
      "Receipt Date": String(r.TransactionDate)
        .slice(0, 10)
        .replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$2/$3/$1"),
      Amount: r.Amount,
    };
    return DC_RECEIPT_HEADERS.map((k) => quote(v[k])).join(",");
  });
  return Buffer.from(
    [
      "Principal Campaign Committee  Contributions Report",
      DC_RECEIPT_HEADERS.join(","),
      ...rows,
    ].join("\r\n") + "\r\n",
    "utf16le",
  );
}
/** All names, selectors and amounts in this helper are invented test data. */
export function syntheticTransport(data = syntheticNative()) {
  let filingYear = 2026,
    calls = 0;
  const response = (
    raw: Buffer | string,
    type: string,
    status = 200,
    location?: string,
  ) => {
    const body = typeof raw === "string" ? Buffer.from(raw) : raw;
    return new Response(body, {
      status,
      headers: {
        "content-type": type,
        "content-length": String(body.length),
        ...(location ? { location } : {}),
      },
    });
  };
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    const u = new URL(String(input)),
      path = u.pathname,
      fields = new URLSearchParams(String(init?.body ?? ""));
    const json = (rows: unknown[]) =>
      response(
        JSON.stringify({
          draw: Number(fields.get("draw")),
          recordsTotal: rows.length,
          recordsFiltered: rows.length,
          data: rows.slice(
            Number(fields.get("start")),
            Number(fields.get("start")) + Number(fields.get("length")),
          ),
        }),
        "application/json",
      );
    if (path === "/ContributionExpenditure/SearchRecipients/2")
      return json(data.registry);
    if (path === "/DataDownload/SubmitSearch")
      return response(
        "redirect",
        "text/html",
        302,
        "/DataDownload/SearchResults",
      );
    if (path === "/DataDownload/Search") return json(data.receipts);
    if (path === "/DataDownload/Export")
      return response(syntheticCsv(data.receipts), "application/text");
    if (path === "/FinancialReports/SubmitSearch") {
      filingYear = Number(fields.get("FilingYear"));
      return response(
        "redirect",
        "text/html",
        302,
        "/FinancialReports/SearchResults",
      );
    }
    if (path === "/FinancialReports/Search")
      return json(data.parents.filter((p) => p.FilingYear === filingYear));
    return response(
      "<!doctype html><html>Public synthetic form</html>",
      "text/html",
    );
  }) as typeof fetch;
  return { transport, calls: () => calls };
}
