import { describe, expect, it } from "vitest";
import {
  COLORADO_RECEIPT_COLUMNS,
  coloradoReceiptXmlSnapshot,
  coloradoReceiptFiledMinute,
  parseColoradoCommitteeRegistry,
  parseColoradoNativeReceiptReport,
  parseColoradoNativeMajorNotice,
} from "../../../src/pipeline/coloradoFinance/coloradoNativeReceiptReports.js";
import {
  aggregateColoradoNativeReceipts,
  validateColoradoNativeReceiptClosure,
} from "../../../src/pipeline/coloradoFinance/coloradoNativeReceiptAggregation.js";
const bytes = (s: string) => new TextEncoder().encode(s);
const attr = (o: Record<string, string>) =>
  Object.entries(o)
    .map(
      ([k, v]) =>
        `${k}="${v.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")}"`,
    )
    .join(" ");
const csv = (rows: string[][]) =>
  bytes(
    rows
      .map((r) => r.map((v) => `"${v.replaceAll('"', '""')}"`).join(","))
      .join("\r\n") + "\r\n",
  );
const root = (
  name: string,
  body: string,
  metadata: Record<string, string> = {},
) =>
  bytes(
    `<Report xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="urn:one" Name="${name}" ${attr(metadata)}>${body}</Report>`,
  );
const RECEIVER = "Example Candidate Committee",
  ID = "123456";
const registryColumns = [
  "JurisdictionName",
  "CommitteeType",
  "CommitteeName",
  "CandidateName",
  "RegAgentName",
  "ReportingSchedule",
  "OrganizationStatus",
];
function registryPair(
  names = ["Example Political Committee"],
  jurisdiction = "ALL COUNTIES",
) {
  const metadata = {
    JurisdictionSelection: jurisdiction,
    ActiveOnlySelection: "All Statuses on Oct 23, 2026",
    OfficeSelection: "Political Committee",
  };
  const rows = names.map((name) => [
    jurisdiction,
    "Political Committee",
    name,
    "",
    "Example Agent",
    "Frequent",
    "Terminated",
  ]);
  return {
    xml: root(
      "rpt_CF_COMM_001",
      `<Group1 JurisdictionName="${jurisdiction}">${rows.map((r) => `<Detail ${attr(Object.fromEntries(registryColumns.slice(1).map((k, i) => [k, r[i + 1]!])))} />`).join("")}</Group1>`,
      metadata,
    ),
    csv: csv([
      Object.keys(metadata),
      Object.values(metadata),
      [""],
      registryColumns,
      ...rows,
    ]),
    committeeType: "Political Committee",
    jurisdiction: "All Counties",
    asOf: "2026-10-23",
  };
}
const receiptRow = (o: Record<string, string> = {}) => ({
  ContributorName: "Example Political Committee",
  ContributorType: "",
  ContributorEmployer: "",
  ReceiptDate: "2026-10-14T00:00:00",
  ReceiptType: "Check",
  ContributorCity: "Example City",
  ContributorState: "CO",
  ContributorZIP: "00000",
  ContributorOccupation: "",
  ContributionType: "Monetary (Itemized)",
  ReferenceNumber: "",
  Amount: "100.00",
  AggregateAmount: "900.00",
  ...o,
});
function receiptPair(rows = [receiptRow()]) {
  const metadata = {
    Jurisdiction: "STATEWIDE",
    Election: "2026 NOVEMBER ELECTION",
    Committee: RECEIVER,
    ReportPeriod: "10/1/2026 - 10/14/2026",
    DueDate: "2026-10-19T23:59:59",
    FiledDate: "2026-10-16T08:40:43",
  };
  const canonicalCsv = (k: string, v: string) =>
    ["ReceiptDate", "DueDate", "FiledDate"].includes(k)
      ? v.slice(0, 10).split("-").slice(1).concat(v.slice(0, 4)).join("/")
      : v;
  return {
    xml: root(
      "rpt_CF_CONT_001",
      rows.map((r) => `<Details ${attr(r)}/>`).join(""),
      metadata,
    ),
    csv: csv([
      Object.keys(metadata),
      Object.entries(metadata).map(([k, v]) => canonicalCsv(k, v)),
      [""],
      COLORADO_RECEIPT_COLUMNS,
      ...rows.map((r) =>
        COLORADO_RECEIPT_COLUMNS.map((k) => canonicalCsv(k, r[k]!)),
      ),
    ]),
    receivingName: RECEIVER,
    year: 2026,
    start: "2026-10-01",
    end: "2026-10-14",
  };
}
const majorColumns = [
  "Textbox100",
  "Textbox252",
  "DateAccepted",
  "DonorName",
  "Textbox265",
  "DonorAddress",
  "Textbox256",
  "ContributionAmount",
  "Textbox119",
  "Description",
  "AggregateAmount",
  "EmployerName",
  "DonorOccupation",
  "ElectioneeringCommunication",
];
function majorPair(total = "100.00", withLoan = false) {
  const meta = {
    CommitteeName: RECEIVER,
    CommitteeCandidateName3: "Example City",
    CommitteeCandidateName4: "CO",
    CommitteeCandidateName5: "00000",
    CommitteeCandidateName8: ID,
    CommitteeCandidateName9: "Example election",
    CommitteeCandidateName13: "2026-10-14T00:00:00",
    CommitteeCandidateName11: total,
    txtRegAgtName: "Example Agent",
    CommitteeCandidateName14: "2026-10-15T00:02:43",
  };
  const row = Object.fromEntries(majorColumns.map((k) => [k, ""]));
  Object.assign(row, {
    DateAccepted: "2026-10-14T00:00:00",
    DonorName: "Example Political Committee",
    ContributionAmount: "100.00",
    AggregateAmount: "900.00",
    ElectioneeringCommunication: "No",
  });
  const loans = [
    "Textbox165",
    "LoanSourceAddress",
    "Textbox231",
    "LoanAmount",
    "InterestRate",
    "DateLoanReceived",
    "Name",
    "Address",
    "GuaranteedAmount",
  ];
  return {
    xml: root(
      "rpt_CF_FILE_005",
      `<FirstPage><Details ${attr(meta)}/></FirstPage><ScheduleA_Contributions><Details2 ${attr(row)}/></ScheduleA_Contributions><ScheduleC_Loans>${withLoan ? '<Details3 LoanAmount="1"/>' : ""}</ScheduleC_Loans>`,
    ),
    csv: csv([
      Object.keys(meta),
      Object.values(meta),
      [""],
      majorColumns,
      majorColumns.map((k) => row[k]!),
      [""],
      loans,
      loans.map(() => ""),
      [""],
    ]),
    receivingId: ID,
    receivingName: RECEIVER,
    date: "2026-10-14",
  };
}
const oneRegistry = () => parseColoradoCommitteeRegistry(registryPair());
describe("complete native Colorado receiving reports", () => {
  it("binds native local filing minutes without treating midnight as noon", () => {
    expect(coloradoReceiptFiledMinute("10/15/2026 12:02AM")).toBe("2026-10-15T00:02");
    expect(coloradoReceiptFiledMinute("10/15/2026 12:02 PM")).toBe("2026-10-15T12:02");
    expect(()=>coloradoReceiptFiledMinute("10/15/2026 13:02 PM")).toThrow("receipt_history_filed_clock");
  });
  it("retains inactive registry occurrences and validates county caption case", () => {
    expect(
      parseColoradoCommitteeRegistry(
        registryPair([
          "Example Political Committee",
          "Example Political Committee",
        ]),
      ),
    ).toHaveLength(2);
    expect(() =>
      parseColoradoCommitteeRegistry({
        ...registryPair(),
        jurisdiction: "FEDERAL",
      }),
    ).toThrow("receipt_registry_scope");
    expect(() =>
      parseColoradoCommitteeRegistry({
        ...registryPair(),
        committeeType: "Business",
      }),
    ).toThrow("receipt_registry_class");
  });
  it("compares every registry field, including non-name suffixes", () => {
    const p = registryPair();
    expect(() =>
      parseColoradoCommitteeRegistry({
        ...p,
        csv: bytes(
          new TextDecoder().decode(p.csv).replace("Terminated", "Active"),
        ),
      }),
    ).toThrow("receipt_csv_xml_population");
  });
  it("owns signed cash amounts without summing cumulative aggregates or dropping repeats", () => {
    const p = receiptPair([
      receiptRow(),
      receiptRow(),
      receiptRow({
        Amount: "-20.00",
        ContributionType: "Returned Contributions",
      }),
    ]);
    const report = parseColoradoNativeReceiptReport(p),
      result = aggregateColoradoNativeReceipts({
        reports: [report],
        registry: oneRegistry(),
        notices: [],
      });
    expect(report.rows).toHaveLength(3);
    expect(result.groups[0]).toMatchObject({
      cashCents: 18000,
      occurrences: 3,
    });
  });
  it("closes nonitemized placeholder dates without admitting named nonitemized cash", () => {
    const report = parseColoradoNativeReceiptReport(
      receiptPair([
        receiptRow({
          ContributionType: "Monetary (Non-Itemized)",
          ReceiptDate: "2025-01-01T00:00:00",
        }),
      ]),
    );
    expect(report.nonitemizedCents).toBe(10000);
    expect(
      aggregateColoradoNativeReceipts({
        reports: [report],
        registry: oneRegistry(),
        notices: [],
      }).groups,
    ).toEqual([]);
    expect(() =>
      parseColoradoNativeReceiptReport(
        receiptPair([receiptRow({ ReceiptDate: "2025-01-01T00:00:00" })]),
      ),
    ).toThrow("receipt_date_outside_period");
  });
  it("holds wrong receivers, invalid signs, unknown kinds and non-cent amounts", () => {
    expect(() =>
      parseColoradoNativeReceiptReport({
        ...receiptPair(),
        receivingName: "Other Committee",
      }),
    ).toThrow("receipt_report_scope");
    expect(() =>
      parseColoradoNativeReceiptReport(
        receiptPair([
          receiptRow({
            Amount: "20",
            ContributionType: "Returned Contributions",
          }),
        ]),
      ),
    ).toThrow("receipt_kind_sign");
    expect(() =>
      parseColoradoNativeReceiptReport(
        receiptPair([receiptRow({ ContributionType: "NSF" })]),
      ),
    ).toThrow("receipt_unqualified_kind");
    expect(() =>
      parseColoradoNativeReceiptReport(
        receiptPair([receiptRow({ Amount: "0.001" })]),
      ),
    ).toThrow("invalid_source_cents");
  });
  it("does not promote individuals, corporations, trailing-comma or name-token hints", () => {
    const report = parseColoradoNativeReceiptReport(
      receiptPair([
        receiptRow({ ContributorType: "Individual" }),
        receiptRow({ ContributorType: "Corporation" }),
        receiptRow({ ContributorName: "Example Political Committee, " }),
        receiptRow({ ContributorName: "Unknown Political PAC" }),
      ]),
    );
    const p = aggregateColoradoNativeReceipts({
      reports: [report],
      registry: oneRegistry(),
      notices: [],
    });
    expect(p.groups).toEqual([]);
    expect(p.controls).toMatchObject({
      individualRows: 1,
      unmatchedRows: 3,
      cashCents: 0,
    });
  });
  it("keeps full filed clocks across observations even when CSV date projections match", () => {
    const p = receiptPair(),
      changed = bytes(
        new TextDecoder().decode(p.xml).replace("08:40:43", "08:40:44"),
      );
    expect(
      parseColoradoNativeReceiptReport({ ...p, xml: changed }).filed,
    ).toContain("08:40:44");
    expect(coloradoReceiptXmlSnapshot(p.xml)).not.toBe(
      coloradoReceiptXmlSnapshot(changed),
    );
    const schema = bytes(
      new TextDecoder().decode(p.xml).replace("urn:one", "urn:two"),
    );
    expect(coloradoReceiptXmlSnapshot(p.xml)).toBe(
      coloradoReceiptXmlSnapshot(schema),
    );
  });
  it("validates notice totals, receiving IDs and the complete empty-loan suffix", () => {
    expect(parseColoradoNativeMajorNotice(majorPair()).rows).toHaveLength(1);
    expect(() => parseColoradoNativeMajorNotice(majorPair("200.00"))).toThrow(
      "receipt_major_total",
    );
    expect(() =>
      parseColoradoNativeMajorNotice({ ...majorPair(), receivingId: "654321" }),
    ).toThrow("receipt_major_identity");
    expect(() =>
      parseColoradoNativeMajorNotice(majorPair("100.00", true)),
    ).toThrow("receipt_major_definition");
    const p = majorPair();
    expect(() =>
      parseColoradoNativeMajorNotice({
        ...p,
        csv: bytes(new TextDecoder().decode(p.csv) + '"extra"\r\n'),
      }),
    ).toThrow("receipt_major_csv_suffix");
  });
  it("counts a covered notice once and cannot reuse one receipt for two notices", () => {
    const report = parseColoradoNativeReceiptReport(receiptPair()),
      notice = parseColoradoNativeMajorNotice(majorPair());
    expect(
      aggregateColoradoNativeReceipts({
        reports: [report],
        registry: oneRegistry(),
        notices: [notice],
      }).controls,
    ).toMatchObject({ cashCents: 10000, coveredNotices: 1 });
    expect(() =>
      aggregateColoradoNativeReceipts({
        reports: [report],
        registry: oneRegistry(),
        notices: [notice, notice],
      }),
    ).toThrow("receipt_uncovered_major_notice");
  });
  it("validates the entire stored group set before any display cap", () => {
    const report = parseColoradoNativeReceiptReport(receiptPair()),
      p = aggregateColoradoNativeReceipts({
        reports: [report],
        registry: oneRegistry(),
        notices: [],
      });
    expect(() =>
      validateColoradoNativeReceiptClosure({
        ...p,
        groups: [
          ...p.groups,
          { ...p.groups[0]!, key: "UNEXPECTED", name: "Unexpected" },
        ],
      }),
    ).toThrow("receipt_stored_group_closure");
    expect(() =>
      validateColoradoNativeReceiptClosure({
        ...p,
        controls: { ...p.controls, cashCents: 0 },
      }),
    ).toThrow("receipt_stored_group_closure");
  });
});
