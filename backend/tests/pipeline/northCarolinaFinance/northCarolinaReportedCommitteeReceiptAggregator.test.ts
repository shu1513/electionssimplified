import { describe, expect, it } from "vitest";
import {
  aggregateNorthCarolinaReportedCommitteeReceipts,
  type NorthCarolinaReportedCommitteeReceiptResult,
} from "../../../src/pipeline/northCarolinaFinance/northCarolinaReportedCommitteeReceiptAggregator.js";
import {
  NCSBE_COVER_SECTIONS,
  parseNcsbeDate,
  type NcsbeDocumentRow,
} from "../../../src/pipeline/northCarolinaFinance/northCarolinaNcsbeParsers.js";
import type {
  NorthCarolinaReportedReceipt,
  NorthCarolinaReportedReceiptSource,
} from "../../../src/pipeline/northCarolinaFinance/northCarolinaReportedReceiptSource.js";

// Synthetic unit inputs exercise aggregation contracts, never financial proof.
const receiver = "STA-AA11BB-C-001";
const otherReceiver = "STA-ZZ99YY-C-001";
function inventory(overrides: Partial<NcsbeDocumentRow> = {}): NcsbeDocumentRow {
  return { committeeName: "Synthetic Receiver", sboeId: receiver, reportYear: 2028,
    documentType: "Disclosure Report", reportType: "First Quarter", isAmendment: false,
    imageReceiptDate: parseNcsbeDate("04/10/2028"), dataImportDate: parseNcsbeDate("04/10/2028"),
    periodStartDate: parseNcsbeDate("01/01/2028"), periodEndDate: parseNcsbeDate("03/31/2028"),
    dataLink: "11", imageLink: null, ...overrides };
}
function receipt(overrides: Partial<NorthCarolinaReportedReceipt> = {}, sourceFields: Partial<NorthCarolinaReportedReceipt["sourceFields"]> = {}): NorthCarolinaReportedReceipt {
  return {
    groupId: 9, occurDate: parseNcsbeDate("02/02/2028"), orgName: "Synthetic Source A", isOrg: true,
    amountCents: 125, sumToDateCents: 990000, profession: null, employersName: null,
    isAggregated: false, receiptTypeDesc: "Other Political Committees (such as PACs)", receiptTypeCode: "CPCM",
    accountAbbr: "SYNTH", formOfPaymentDesc: "Check", purpose: null,
    ...overrides,
    sourceFields: { GroupID: 9, OccurDate: "02/02/2028", IsPrior: " ", OrgName: "Synthetic Source A",
      Street1: "", Street2: "", City: "", State: "", FullZip: "", CountryName: "", OutsideUSPostalCode: "",
      Profession: null, EmployersName: null, Purpose: null, ReceiptTypeDesc: "Other Political Committees (such as PACs)",
      AccountAbbr: "SYNTH", FormOfPaymentDesc: "Check", Description: null, Amount: "1.25", SumToDate: "9900",
      ...sourceFields },
  };
}
function report(receipts: NorthCarolinaReportedReceipt[] = [], reportId = "11"): NorthCarolinaReportedReceiptSource {
  const sum = (code: string) => receipts.filter((row) => row.receiptTypeCode === code).reduce((total, row) => total + row.amountCents, 0);
  return {
    reportId, exportUrl: `https://cf.ncsbe.gov/CFOrgLkup/ReportDetail?handler=Export&RID=${reportId}&TP=ALL&sid=&cn=`,
    detail: { cover: { reportId, boeId: receiver, orgName: "Synthetic Receiver", entityTypeDesc: null,
      fullReportName: null, reportVersion: null, beginDate: parseNcsbeDate("01/01/2028"),
      endDate: parseNcsbeDate("03/31/2028"), filedDate: parseNcsbeDate("04/10/2028") },
    summarySections: [...NCSBE_COVER_SECTIONS].map(([sequence, section]) => ({ sequence, section,
      periodCents: sequence === 30 ? sum("PPTY") : sequence === 35 ? sum("CPCM") : 0,
      cycleCents: 1234567 })) }, receipts,
  };
}
function run(receipts: NorthCarolinaReportedReceipt[] = [receipt()]) {
  return aggregateNorthCarolinaReportedCommitteeReceipts({ receivingCommitteeId: receiver, electionYear: 2028,
    inventoryRows: [inventory()], reports: [report(receipts)] });
}
function qualified(result: NorthCarolinaReportedCommitteeReceiptResult) {
  expect(result.status).toBe("qualified");
  if (result.status !== "qualified") throw Error("Expected qualified synthetic result");
  return result;
}

describe("aggregateNorthCarolinaReportedCommitteeReceipts", () => {
  it("uses native committee/party roles and exact positive amounts, never IsOrg or cumulative fields", () => {
    const result = qualified(run([receipt({ isOrg: false }), receipt({ receiptTypeCode: "PPTY", amountCents: 400 })]));
    expect(result.positiveGrossCents).toBe(525);
    expect(result.positiveOccurrenceCount).toBe(2);
    expect(result.groups.map((group) => [group.reportedClass, group.positiveGrossCents])).toEqual([["PPTY", 400], ["CPCM", 125]]);
    expect(result.classControls).toMatchObject([{ signedSourceCents: 125, coverPeriodCents: 125 }, { signedSourceCents: 400, coverPeriodCents: 400 }]);
    expect(result.metric).toBe("reported_itemized_committee_monetary_receipts_before_returns");
  });

  it("excludes unrelated native roles without name, organization, payment, or prior inference", () => {
    const rows = ["IND ", "DON ", "OUTS", "NFPC", "RFND", "CORP", "UNKNOWN", null].map((receiptTypeCode) =>
      receipt({ receiptTypeCode, amountCents: -300, isOrg: true }, { OrgName: null, IsPrior: "X", FormOfPaymentDesc: "Unknown" }));
    const result = qualified(run(rows));
    expect(result.positiveGrossCents).toBe(0);
    expect(result.groups).toEqual([]);
    expect(result.diagnostics.excludedOtherClassOccurrenceCount).toBe(8);
  });

  it("excludes explicit in-kind and aggregated rows before unknown relevant fields", () => {
    const result = qualified(run([
      receipt({}, { FormOfPaymentDesc: "In Kind", IsPrior: "X", OrgName: null }),
      receipt({ isAggregated: true, amountCents: -25 }, { FormOfPaymentDesc: "Unknown", IsPrior: "X", OrgName: null }),
      receipt(),
    ]));
    expect(result.positiveGrossCents).toBe(125);
    expect(result.classControls[0]).toMatchObject({ sourceOccurrenceCount: 3, signedSourceCents: 225,
      positiveOccurrenceCount: 1, excludedInKindOccurrenceCount: 1, excludedInKindSignedCents: 125,
      excludedAggregatedOccurrenceCount: 1, excludedAggregatedSignedCents: -25 });
  });

  it.each(["Cash", "Check", "Credit Card", "Electronic Funds Transfer"])("accepts source-proven monetary spelling %s", (payment) => {
    expect(qualified(run([receipt({}, { FormOfPaymentDesc: payment })])).positiveGrossCents).toBe(125);
  });

  it.each([null, "", "N/A", "check", "MoneyOrder", "Draft", "CreditDebit", "CreditCard", "EFT", "InKind"])("holds unsupported relevant payment %s", (payment) => {
    expect(run([receipt({}, { FormOfPaymentDesc: payment })])).toEqual({ status: "held", reason: "payment_type" });
  });

  it("holds eligible prior and negative monetary rows without returning partial money", () => {
    expect(run([receipt(), receipt({}, { IsPrior: "X" })])).toEqual({ status: "held", reason: "prior_receipt" });
    expect(run([receipt(), receipt({ amountCents: -25 })])).toEqual({ status: "held", reason: "negative_monetary_receipt" });
    expect(run([receipt({}, { IsPrior: null })])).toEqual({ status: "held", reason: "prior_receipt" });
  });

  it("preserves every equal occurrence, within and across current reports", () => {
    const shared = receipt();
    const result = qualified(aggregateNorthCarolinaReportedCommitteeReceipts({ receivingCommitteeId: receiver, electionYear: 2028,
      inventoryRows: [inventory(), inventory({ dataLink: "12", reportType: "Second Quarter", periodStartDate: parseNcsbeDate("04/01/2028"), periodEndDate: parseNcsbeDate("06/30/2028") })],
      reports: [report([shared, shared]), report([shared], "12")] }));
    expect(result.positiveGrossCents).toBe(375);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.positiveOccurrenceCount).toBe(3);
    expect(result.coveredPeriods).toHaveLength(2);
  });

  it("groups only literal class/name with NFC, whitespace, and case normalization", () => {
    const result = qualified(run([
      receipt({}, { OrgName: "  Synthetic Café  " }),
      receipt({}, { OrgName: "synthetic cafe\u0301" }),
      receipt({}, { OrgName: "Synthetic Cafe" }),
      receipt({}, { OrgName: "Synthetic Café Inc." }),
      receipt({}, { OrgName: "Synthetic-Café" }),
      receipt({ receiptTypeCode: "PPTY" }, { OrgName: "Synthetic Café" }),
    ]));
    expect(result.groups).toHaveLength(5);
    const combined = result.groups.find((group) => group.reportedClass === "CPCM" && group.normalizedName === "SYNTHETIC CAFÉ")!;
    expect(combined).toMatchObject({ displayName: "Synthetic Café", positiveOccurrenceCount: 2, positiveGrossCents: 250 });
  });

  it.each([null, "", "  ", "...", "Synthetic\u0000Name"])("holds unusable relevant name %s", (name) => {
    expect(run([receipt({}, { OrgName: name })])).toEqual({ status: "held", reason: "reported_name" });
  });

  it("returns every group and closes source, class, group, and positive occurrence counts", () => {
    const result = qualified(run(Array.from({ length: 31 }, (_, index) => receipt({}, { OrgName: `Synthetic Group ${index}` }))));
    expect(result.groups).toHaveLength(31);
    expect(result.positiveOccurrenceCount).toBe(31);
    expect(result.positiveGrossCents).toBe(3875);
    expect(result.classControls[0]).toMatchObject({ positiveGrossCents: 3875, signedSourceCents: 3875, coverPeriodCents: 3875 });
    expect(result.diagnostics.sourceOccurrenceCount).toBe(31);
  });

  it("qualifies explicit zero only with complete current reports and typed controls", () => {
    expect(qualified(run([]))).toMatchObject({ positiveGrossCents: 0, positiveOccurrenceCount: 0, groups: [], diagnostics: { reportCount: 1 } });
    const zero = qualified(run([receipt({ amountCents: 0 }, { OrgName: null })]));
    expect(zero.classControls[0]!.zeroOccurrenceCount).toBe(1);
    expect(zero.groups).toEqual([]);
    expect(aggregateNorthCarolinaReportedCommitteeReceipts({ receivingCommitteeId: receiver, electionYear: 2028, inventoryRows: [], reports: [] }))
      .toEqual({ status: "held", reason: "no_current_reports" });
  });

  it("requires exactly the selected current report set, with no missing, extra, or duplicate output", () => {
    for (const reports of [[], [report(), report([], "12")], [report(), report()]]) {
      expect(aggregateNorthCarolinaReportedCommitteeReceipts({ receivingCommitteeId: receiver, electionYear: 2028,
        inventoryRows: [inventory()], reports })).toEqual({ status: "held", reason: "current_report_set" });
    }
  });

  it("reruns canonical amendment selection rather than adding original and amendment", () => {
    const rows = [inventory(), inventory({ dataLink: "12", isAmendment: true, imageReceiptDate: parseNcsbeDate("04/20/2028"), dataImportDate: parseNcsbeDate("04/20/2028") })];
    const input = { receivingCommitteeId: receiver, electionYear: 2028, inventoryRows: rows, reports: [report([receipt()], "12")] };
    expect(qualified(aggregateNorthCarolinaReportedCommitteeReceipts(input)).positiveGrossCents).toBe(125);
    expect(aggregateNorthCarolinaReportedCommitteeReceipts({ ...input, reports: [report([receipt()]), ...input.reports] }))
      .toEqual({ status: "held", reason: "current_report_set" });
  });

  it("holds current image-only and ambiguous lineage rather than using older money", () => {
    const base = inventory();
    const input = { receivingCommitteeId: receiver, electionYear: 2028, inventoryRows: [base], reports: [report()] };
    expect(aggregateNorthCarolinaReportedCommitteeReceipts({ ...input, inventoryRows: [base, inventory({ dataLink: null, isAmendment: true, imageReceiptDate: parseNcsbeDate("04/20/2028") })] }))
      .toEqual({ status: "held", reason: "current_image_only" });
    expect(aggregateNorthCarolinaReportedCommitteeReceipts({ ...input, inventoryRows: [base, inventory({ dataLink: "12" })] }))
      .toEqual({ status: "held", reason: "current_lineage" });
    expect(aggregateNorthCarolinaReportedCommitteeReceipts({ ...input, inventoryRows: [inventory({ isAmendment: null })] }))
      .toEqual({ status: "held", reason: "current_lineage" });
  });

  it("uses inventory receiving SID authority and ignores known cover metadata mismatch", () => {
    const source = report([receipt()]);
    source.detail.cover.boeId = otherReceiver;
    source.detail.cover.orgName = "Different synthetic cover label";
    source.detail.cover.beginDate = parseNcsbeDate("12/31/2024");
    const result = qualified(aggregateNorthCarolinaReportedCommitteeReceipts({ receivingCommitteeId: receiver, electionYear: 2028,
      inventoryRows: [inventory(), inventory({ sboeId: otherReceiver, dataLink: "99" })], reports: [source] }));
    expect(result.positiveGrossCents).toBe(125);
    expect(result.diagnostics).toMatchObject({ excludedOtherReceiverInventoryRowCount: 1,
      coverIdentityMetadataDisagreementReportCount: 1, coverPeriodDisagreementReportCount: 1 });
    expect(aggregateNorthCarolinaReportedCommitteeReceipts({ receivingCommitteeId: receiver, electionYear: 2028,
      inventoryRows: [inventory({ sboeId: null })], reports: [source] })).toEqual({ status: "held", reason: "inventory_identity" });
    source.detail.cover.reportId = "12";
    expect(aggregateNorthCarolinaReportedCommitteeReceipts({ receivingCommitteeId: receiver, electionYear: 2028,
      inventoryRows: [inventory()], reports: [source] })).toEqual({ status: "held", reason: "report_identity" });
  });

  it("holds invalid relevant periods and selected periods crossing the declared window", () => {
    for (const row of [
      inventory({ periodStartDate: parseNcsbeDate("") }),
      inventory({ periodEndDate: parseNcsbeDate("01/01/3028") }),
      inventory({ periodStartDate: parseNcsbeDate("01/01/2029") }),
      inventory({ periodStartDate: parseNcsbeDate("12/31/2026") }),
      inventory({ periodEndDate: parseNcsbeDate("01/01/2029") }),
      inventory({ reportYear: 2010, periodStartDate: parseNcsbeDate("03/01/2028"), periodEndDate: parseNcsbeDate("02/01/2028") }),
    ]) expect(aggregateNorthCarolinaReportedCommitteeReceipts({ receivingCommitteeId: receiver, electionYear: 2028,
      inventoryRows: [row], reports: [report()] })).toEqual({ status: "held", reason: "inventory_period" });
  });

  it("keeps unrelated historical invalid dates and excluded report forms outside the scope", () => {
    const irrelevant = [
      inventory({ reportYear: 2010, periodStartDate: parseNcsbeDate(""), periodEndDate: parseNcsbeDate(""), dataLink: "98", sboeId: null }),
      inventory({ reportType: "48-Hour Notice", periodEndDate: parseNcsbeDate(""), dataLink: "97", sboeId: null }),
      inventory({ reportType: "Independent Expenditure Report", periodEndDate: parseNcsbeDate(""), dataLink: "96", sboeId: null }),
      inventory({ documentType: "Correspondence", periodEndDate: parseNcsbeDate(""), dataLink: "95", sboeId: null }),
    ];
    const result = qualified(aggregateNorthCarolinaReportedCommitteeReceipts({ receivingCommitteeId: receiver, electionYear: 2028,
      inventoryRows: [inventory(), ...irrelevant], reports: [report()] }));
    expect(result.diagnostics).toMatchObject({ excludedNoTotalReportRowCount: 1,
      excludedOutsideLegReportRowCount: 1, excludedUndatedOutOfCycleRowCount: 1 });
  });

  it("does not invent transaction-date or overlap gates for reported Period money", () => {
    const rows = [inventory(), inventory({ dataLink: "12", reportType: "Organizational",
      periodStartDate: parseNcsbeDate("02/01/2028"), periodEndDate: parseNcsbeDate("04/30/2028") })];
    const result = qualified(aggregateNorthCarolinaReportedCommitteeReceipts({ receivingCommitteeId: receiver, electionYear: 2028,
      inventoryRows: rows, reports: [report([receipt({ occurDate: parseNcsbeDate("01/01/2020") })]), report([receipt()], "12")] }));
    expect(result.positiveGrossCents).toBe(250);
    expect(result.coveredPeriods).toHaveLength(2);
  });

  it("reconciles every signed typed class to its own actual Period control", () => {
    for (const sequence of [30, 35]) {
      const source = report([receipt({}, { FormOfPaymentDesc: "In Kind" }), receipt({ receiptTypeCode: "PPTY" })]);
      source.detail.summarySections.find((row) => row.sequence === sequence)!.periodCents += 1;
      expect(aggregateNorthCarolinaReportedCommitteeReceipts({ receivingCommitteeId: receiver, electionYear: 2028,
        inventoryRows: [inventory()], reports: [source] })).toEqual({ status: "held", reason: "typed_receipt_controls" });
    }
    const source = report();
    source.detail.summarySections = source.detail.summarySections.filter((row) => row.sequence !== 30);
    expect(aggregateNorthCarolinaReportedCommitteeReceipts({ receivingCommitteeId: receiver, electionYear: 2028,
      inventoryRows: [inventory()], reports: [source] })).toEqual({ status: "held", reason: "typed_receipt_controls" });
  });

  it("rejects unsafe cents and overflow across groups, classes, and reports", () => {
    expect(run([receipt({ amountCents: 1.5 })])).toEqual({ status: "held", reason: "unsafe_integer" });
    expect(run([receipt({ amountCents: Number.MAX_SAFE_INTEGER }), receipt({ amountCents: 1 })]))
      .toEqual({ status: "held", reason: "unsafe_integer" });
    expect(run([receipt({ amountCents: Number.MAX_SAFE_INTEGER }), receipt({ receiptTypeCode: "PPTY", amountCents: 1 })]))
      .toEqual({ status: "held", reason: "unsafe_integer" });
    const input = { receivingCommitteeId: receiver, electionYear: 2028,
      inventoryRows: [inventory(), inventory({ dataLink: "12", reportType: "Second Quarter" })],
      reports: [report([receipt({ amountCents: Number.MAX_SAFE_INTEGER })]), report([receipt({ amountCents: 1 })], "12")] };
    expect(aggregateNorthCarolinaReportedCommitteeReceipts(input)).toEqual({ status: "held", reason: "unsafe_integer" });
  });

  it("rejects invalid runtime receiving scope with fixed, non-identifying hold reasons", () => {
    for (const receivingCommitteeId of ["", "private synthetic invalid value", "STA-AA11BB-F-001"]) {
      expect(aggregateNorthCarolinaReportedCommitteeReceipts({ receivingCommitteeId, electionYear: 2028,
        inventoryRows: [inventory()], reports: [report()] })).toEqual({ status: "held", reason: "receiving_committee" });
    }
    for (const electionYear of [1999, 2101, 2028.5, NaN]) {
      expect(aggregateNorthCarolinaReportedCommitteeReceipts({ receivingCommitteeId: receiver, electionYear,
        inventoryRows: [inventory()], reports: [report()] })).toEqual({ status: "held", reason: "election_year" });
    }
  });
});
