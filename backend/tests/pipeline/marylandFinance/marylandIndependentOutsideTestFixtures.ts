import {
  decodeMarylandPublishedOutsideReport,
  buildMarylandPublicReportInventoryRequest,
} from "../../../src/pipeline/marylandFinance/marylandPublicReportClient.js";
const id = (n: number) =>
  `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
const owner = id(1),
  other = id(2),
  payer = id(3),
  report = id(4),
  parent = id(5);
const person = (name: string, committee: string) =>
  `<h3>${name}</h3>Democratic<div class="candidate"><dl><dt>Status</dt><dd>Active</dd><dt>Committee Name</dt><dd>${committee}</dd></dl></div>`;
const rosterHtml = `<h1>2026 Gubernatorial General Election State Candidates List</h1><details><summary>State Senator, by District</summary><h2>Legislative District 1</h2>${person("Jane A. Example", "Example, Jane For Senate")}</details><details><summary>House of Delegates, by District</summary><h2>Legislative District 2</h2>${person("John B. Other", "Other For House")}</details>`;
const electionDatesHtml = `<h1>Offices up for Election in 2026</h1><dt>General Election</dt><dd><dl><dt>Election Day</dt><dd>November 3, 2026 7AM–8PM</dd></dl></dd>`;
function book(payerGuid = payer, reportGuid = report, version = 1) {
  const base = {
    reportGuid,
    reportVersionId: version,
    reportName: "Published IE report",
    reportVersion: "Original",
    reportVersionCode: "RPTFLD",
    reportType: "Transaction Detail Report",
    reportTypeCode: "FPCFTDR",
    filingEntityId: 7,
    filerRegistrationGuid: payerGuid,
    committeeType: "Independent Expenditure Committee",
    committeeTypeCode: "IEC",
    officeSought: null,
    officeSoughtId: null,
    jurisdiction: null,
    jurisdictionId: null,
    reportingCycle: "2023-2026",
    reportingCycleId: 12023,
    reportingYear: 2026,
    startDate: "2026-08-19T00:00:00",
    endDate: "2026-10-18T00:00:00",
    dueDate: "2026-10-23T00:00:00",
    filedDate: "2026-10-22T12:00:00",
    zeroActivity: false,
    hasChild: false,
    childResults: null as unknown,
    isActive: true,
  };
  if (version > 1)
    Object.assign(base, {
      reportVersion: "Amended",
      reportVersionCode: "RPTAMD",
      hasChild: true,
      childResults: [1, version].map((v) => ({
        filerReportGuid: reportGuid,
        filerReportVersionID: v,
        totalRows: 2,
        reportName: base.reportName,
        reportType: "Disclosure Report",
        startDate: base.startDate,
        endDate: base.endDate,
        dueDate: base.dueDate,
        filedDate: base.filedDate,
        isCompleted: true,
        generateStatus: "Complete",
        generateStatusCode: "GRCOMP",
        reportStatus: `Version ${v}`,
        isPaperFile: false,
      })),
    });
  return decodeMarylandPublishedOutsideReport(
    base,
    buildMarylandPublicReportInventoryRequest({
      filerRegistrationGuid: payerGuid,
      electionCycleId: "12023",
      pageNumber: 1,
    }),
  );
}
function fixture() {
  const row = {
    candidateMeasureGuid: id(40),
    candidateGuid: owner,
    candidateBallotIssueName: "Example, Jane For Senate",
    electionYear: 2026,
    filerRegistrationGuid: payer,
    filingEntityId: 7,
    reportGuId: report,
    reportVersionId: 1,
    transactionGuid: parent,
    parentTransactionGuid: null,
    transactionVersionID: 1,
    transactionId: 8,
    transactionDate: "2026-10-01T00:00:00",
    transactionAmount: 100,
    amountApplied: 60,
    positionCode: "STSUPP",
    isActive: true,
    isCandidateActivity: true,
    expenditureTypeCode: "TIEXP",
    committeeName: "Synthetic outside payer",
    committeeTypeCode: "IEC",
    electionCycleId: 12023,
  };
  const second = {
    ...row,
    candidateMeasureGuid: id(41),
    candidateGuid: other,
    candidateBallotIssueName: "Other For House",
    amountApplied: 40,
  };
  const registration = (guid: string, name: string, committeeName: string) => [
    {
      filerRegistrationGuid: guid,
      registrationDocumentGuid: id(20),
      filingEntityId: 9,
      candidateName: name,
      committeeName,
      committeeTypeCode: "CC",
      officeSought: "State Senator",
      officeSoughtId: 12,
      jurisdictionId: 1,
      partyAffiliation: "Democrat",
      electionYears: "2026",
      electionTypeCodes: "GBRELEC",
      isActive: true,
      accountStatus: "Active",
      accountStatusCode: "FACT",
      registrationTerminatedDate: null,
    },
  ];
  const control = {
    detail: {
      guid: parent,
      transactionAmount: 100,
      transactionSubTypeCode: "TIEXP",
      transactionDate: row.transactionDate,
    },
    allocations: [
      {
        filerRegistrationGuid: owner,
        candidateMeasureTitle: row.candidateBallotIssueName,
        isSupport: true,
        amount: 60,
      },
      {
        filerRegistrationGuid: other,
        candidateMeasureTitle: second.candidateBallotIssueName,
        isSupport: true,
        amount: 40,
      },
    ],
    returns: [] as Record<string, unknown>[],
    captures: [],
    startedAt: "2026-10-26T00:00:00.000Z",
    completedAt: "2026-10-26T00:00:01.000Z",
  };
  return {
    context: {
      candidateId: id(30),
      electionId: id(31),
      candidateName: "Jane A. Example",
      party: "Democratic",
      officeScope: "state_upper",
      officeName: "State Senator",
      districtGeoidCompact: "24001",
      electionYear: 2026,
      electionDate: "2026-11-03",
      electionStage: "general",
    },
    rows: [row, second],
    previousRows: [] as (typeof row)[],
    registry: new Map([
      [
        owner,
        registration(owner, "EXAMPLE, JANE A.", row.candidateBallotIssueName),
      ],
      [
        other,
        registration(other, "OTHER, JOHN B.", second.candidateBallotIssueName),
      ],
    ]),
    rosterHtml,
    electionDatesHtml,
    reports: new Map([[payer, [book()]]]),
    controls: new Map([[parent, control]]),
  };
}

export { fixture, id, book, owner, other, payer, report, parent };
